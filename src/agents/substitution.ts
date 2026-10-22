import type { Evidence } from "../evidence.js";
import { chatJson } from "../llm/meterless.js";
import { equivalentsFor, ingredientKey, substituteStatus, type SubstituteCheck } from "../tools/fda.js";
import { orderableProducts, registerNdcSource } from "../tools/scout.js";
import { evidenceBlock, memoryBlock, SYSTEM_BASE } from "./prompts.js";
import type { AgentContext, ItemCase, SubstituteFacts, SubstitutionPlan } from "./types.js";

/** Tools only: Orange Book equivalents, their own shortage and recall status, and orderable NDCs via the scout. */
export async function gatherSubstituteFacts(c: ItemCase, ctx: AgentContext): Promise<SubstituteFacts> {
  const item = c.item;
  const eq = await equivalentsFor(item);
  ctx.store.addAll(eq.evidence);
  const checks = new Map<string, SubstituteCheck>();
  for (const e of eq.equivalents.slice(0, 12)) {
    const s = await substituteStatus(e);
    ctx.store.addAll(s.evidence);
    checks.set(s.check.appl, s.check);
  }
  ctx.trace.log({
    item_id: item.item_id,
    agent_name: "Substitution",
    action: "find_equivalents",
    input_summary: `Orange Book: ${eq.own ? `${eq.own.ingredient} ${eq.own.strength} (${eq.own.df_route})` : "own product not found"}`,
    output_summary: `${eq.equivalents.length} therapeutically equivalent products from other applications; status: ${[...checks.values()].map((k) => `${k.appl} ${k.verdict}`).join(", ") || "none"}`,
    evidence_ids: eq.evidence.map((e) => e.id),
    status: eq.own ? "ok" : "info",
  });

  // Which safe equivalents can actually be ordered? That needs the NDC directory, which is not a
  // standing Zetaris source: the scout registers it for this ingredient on demand.
  const safe = [...checks.values()].filter((k) => k.verdict === "clear" || k.verdict === "listed_available").map((k) => k.appl);
  let orderable: SubstituteFacts["orderable"] = [];
  if (safe.length) {
    const ingredient = ingredientKey(item.generic_name);
    const src = await registerNdcSource(ingredient);
    ctx.trace.log({
      item_id: item.item_id,
      agent_name: "SourceScout",
      action: src.created ? "register_zetaris_source" : "reuse_zetaris_source",
      input_summary: `Need orderable NDCs for ${safe.length} safe equivalents of ${ingredient}; no standing source has them`,
      output_summary: `${src.created ? "Registered" : "Reused"} Zetaris REST table ${src.table} over the openFDA NDC directory`,
      target_agent: "Substitution",
      status: "ok",
      sql: src.sql.join(";\n"),
    });
    const o = await orderableProducts(src.table, safe);
    ctx.store.addAll(o.evidence);
    orderable = o.rows;
  }
  return { own: eq.own, equivalents: eq.equivalents, checks, orderable };
}

type SubstitutionReply = {
  recommendation: SubstitutionPlan["recommendation"];
  substitutes: Array<{ application: string; reason: string; evidence_ids: string[]; orderable_ndcs: string[] }>;
  claims: Array<{ text: string; evidence_ids: string[] }>;
  confidence: number;
};

/** Ranks the safe substitutes and explains the recommendation. Never proposes anything outside the tool results. */
export async function proposeSubstitutes(c: ItemCase, ctx: AgentContext, feedback?: string[]): Promise<SubstitutionPlan> {
  const item = c.item;
  const facts = c.facts!;
  const evidence: Evidence[] = [
    ctx.store.get(`stock-${item.item_id}`)!,
    ...ctx.store.all().filter((e) => {
      if (e.source !== "orange-book" && e.source !== "fda-ndc") return false;
      const appls = facts.equivalents.concat(facts.own ? [facts.own] : []).map((r) => `${r.appl_type === "A" ? "ANDA" : "NDA"}${r.appl_no}`);
      return appls.some((a) => e.id.startsWith(`ob-${a}-`) || String(e.data.application_number ?? "") === a);
    }),
    ...[...facts.checks.values()].flatMap((k) => [...k.shortage.map((s) => `shortage-${s.package_ndc}`), ...k.recalls.map((r) => `recall-${r.recall_number}`)]).map((id) => ctx.store.get(id)).filter((e): e is Evidence => !!e),
  ].slice(0, 60);
  const statusList = [...facts.checks.values()].map((k) => `${k.appl}: ${k.verdict}`).join("\n") || "none";

  const { value, receipt } = await chatJson<SubstitutionReply>(
    [
      { role: "system", content: SYSTEM_BASE },
      {
        role: "user",
        content: `You are the Substitution agent. Our item: ${item.generic_name} ${item.strength}, supplier ${item.labeler}, ${item.application_number}, ${item.days_of_cover} days of cover.
Investigator's finding: ${c.investigation?.risk}: ${c.investigation?.headline}

Therapeutically equivalent products (FDA Orange Book) and their supply status (clear = not on the shortage list; listed_available = on the list but marked available; constrained = limited or unavailable; recalled = class I or II recall):
${statusList}

Evidence:
${evidenceBlock(evidence)}

Saved buyer decisions (respect them; never recommend a supplier the buyer has ruled out):
${memoryBlock(ctx.memories)}
${feedback?.length ? `\nThe Evidence Critic sent your last answer back. Fix these problems:\n- ${feedback.join("\n- ")}\n` : ""}
Recommend "switch" (order a substitute instead), "split" (keep current supplier and add a substitute), "keep_current", or "no_safe_substitute".
Only list substitutes whose status is clear or listed_available, prefer clear, and list their orderable package NDCs exactly as they appear in the fda-ndc evidence.
Reply as {"recommendation":string,"substitutes":[{"application":string,"reason":string,"evidence_ids":[string],"orderable_ndcs":[string]}],"claims":[{"text":string,"evidence_ids":[string]}],"confidence":number}.`,
      },
    ],
    { tier: "deep", maxTokens: 2500 },
  );

  const byAppl = new Map(facts.equivalents.map((r) => [`${r.appl_type === "A" ? "ANDA" : "NDA"}${r.appl_no}`, r]));
  const plan: SubstitutionPlan = {
    item_id: item.item_id,
    recommendation: value.recommendation,
    substitutes: (value.substitutes ?? []).map((s) => {
      const ob = byAppl.get(String(s.application).toUpperCase());
      return {
        application: String(s.application).toUpperCase(),
        applicant: ob?.applicant_full_name || ob?.applicant || "unknown",
        te_code: ob?.te_code ?? "",
        status: facts.checks.get(String(s.application).toUpperCase())?.verdict ?? "constrained",
        orderable_ndcs: (s.orderable_ndcs ?? []).map(String),
        reason: String(s.reason ?? ""),
        evidence_ids: (s.evidence_ids ?? []).map(String),
      };
    }),
    claims: (value.claims ?? []).map((cl) => ({ text: String(cl.text), evidence_ids: (cl.evidence_ids ?? []).map(String) })),
    confidence: Number(value.confidence ?? 0.5),
  };
  ctx.trace.log(
    {
      item_id: item.item_id,
      agent_name: "Substitution",
      action: feedback?.length ? "revise_substitutes" : "propose_substitutes",
      input_summary: `${facts.equivalents.length} equivalents, ${facts.orderable.length} orderable NDC listings${feedback?.length ? `; critic feedback: ${feedback.join("; ")}` : ""}`,
      output_summary: `${plan.recommendation}: ${plan.substitutes.map((s) => `${s.applicant} ${s.application} (${s.status})`).join(", ") || "no substitutes"}`,
      target_agent: "EvidenceCritic",
      evidence_ids: [...plan.substitutes.flatMap((s) => s.evidence_ids), ...plan.claims.flatMap((cl) => cl.evidence_ids)],
      confidence: plan.confidence,
      retry_count: c.retries,
      status: "ok",
    },
    receipt,
  );
  return plan;
}
