import type { Evidence } from "../evidence.js";
import { chatJson } from "../llm/meterless.js";
import { equivalentsFor, ingredientKey, sameConcentration, substituteStatus, type SubstituteCheck } from "../tools/fda.js";
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
    // The status check is done in code, so record it as evidence the agents can cite.
    ctx.store.add({
      id: `status-${s.check.appl}`,
      source: "fda-shortage",
      summary: `Checked ${s.check.appl} (${e.applicant_full_name || e.applicant}) against this run's FDA shortage and recall snapshots: ${s.check.shortage.length ? `${s.check.shortage.length} shortage-list entries (${s.check.shortage.map((x) => x.availability).join(", ")})` : "not on the shortage list"}; ${s.check.recalls.length ? `${s.check.recalls.length} ongoing recall(s)` : "no ongoing recall"}. Status: ${s.check.verdict}.`,
      data: { ...s.check, shortage: s.check.shortage.length, recalls: s.check.recalls.length },
    });
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
  let orderableAll: SubstituteFacts["orderable"] = [];
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
    // Same application can cover several strengths: keep only products at our concentration.
    const keep = new Set(o.rows.filter((r) => sameConcentration(r.strength, item.strength)).map((r) => r.product_ndc));
    ctx.store.addAll(o.evidence.filter((e) => keep.has(String(e.data.product_ndc))));
    orderable = o.rows.filter((r) => keep.has(r.product_ndc));
    orderableAll = o.rows;
    ctx.trace.log({ item_id: item.item_id, agent_name: "SourceScout", action: "filter_orderable", input_summary: `${o.rows.length} NDC products under the safe applications`, output_summary: `${orderable.length} at the same concentration as ours (${item.strength}); ${o.rows.length - orderable.length} other strengths excluded`, target_agent: "Substitution", status: "ok" });
  }
  return { own: eq.own, equivalents: eq.equivalents, checks, orderable, orderableAll };
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
    ...[...facts.checks.values()].map((k) => ctx.store.get(`status-${k.appl}`)).filter((e): e is Evidence => !!e),
  ].slice(0, 35);
  // Buyer decisions bind: suppliers the buyer ruled out are removed in code before the model sees them.
  const avoided = ctx.memories.filter((m) => m.kind === "avoid_supplier" && m.subject);
  const byApplicant = new Map(facts.equivalents.map((r) => [`${r.appl_type === "A" ? "ANDA" : "NDA"}${r.appl_no}`, r.applicant_full_name || r.applicant]));
  // Computed fresh on every attempt; the substitute checks themselves are never rewritten.
  const excluded: string[] = [];
  const ruledOut = new Set<string>();
  for (const [appl, k] of facts.checks) {
    const who = byApplicant.get(appl) ?? "";
    const rule = avoided.find((m) => who.toLowerCase().includes(m.subject!.toLowerCase()));
    if (rule && (k.verdict === "clear" || k.verdict === "listed_available")) {
      excluded.push(`${who} ${appl} (${rule.id})`);
      ruledOut.add(appl);
    }
  }
  if (excluded.length) {
    ctx.trace.log({ item_id: item.item_id, agent_name: "Memory", action: "apply_buyer_decision", input_summary: avoided.map((m) => m.content).join("; ").slice(0, 200), output_summary: `Excluded ${excluded.join(", ")} because the buyer ruled this supplier out`, target_agent: "Substitution", evidence_ids: avoided.map((m) => m.id), status: "ok" });
  }
  const statusList = [...facts.checks.values()].map((k) => `${k.appl}: ${ruledOut.has(k.appl) ? "ruled out by the buyer" : k.verdict}`).join("\n") || "none";
  const safeCount = [...facts.checks.values()].filter((k) => !ruledOut.has(k.appl) && (k.verdict === "clear" || k.verdict === "listed_available")).length;
  if (safeCount === 0) {
    // Nothing safe to recommend: code decides, the model is not asked to invent an alternative.
    const plan: SubstitutionPlan = {
      item_id: item.item_id,
      recommendation: "no_safe_substitute",
      substitutes: [],
      claims: [{
        text: excluded.length
          ? `The only safe therapeutically equivalent supplier${excluded.length > 1 ? "s are" : " is"} ${excluded.map((e) => e.replace(/ \(memory-[^)]+\)/, "")).join(", ")}, which the buyer has ruled out; every other equivalent is short or recalled.`
          : facts.equivalents.length
          ? `All ${facts.equivalents.length} therapeutically equivalent products in the Orange Book are themselves short or recalled.`
          : `The FDA Orange Book lists no therapeutically equivalent product from another application for ${item.generic_name} ${item.strength} (${facts.own?.df_route ?? item.dosage_form}).`,
        // Cite everything the statement rests on: our Orange Book record, every equivalent's status check,
        // and the buyer decision that ruled a supplier out.
        evidence_ids: [
          ...(facts.own ? [`ob-${facts.own.appl_type === "A" ? "ANDA" : "NDA"}${facts.own.appl_no}-${facts.own.product_no}`] : [`stock-${item.item_id}`]),
          ...[...facts.checks.keys()].map((a) => `status-${a}`).filter((id) => ctx.store.has(id)),
          ...avoided.filter((m) => excluded.some((e) => e.includes(m.id))).map((m) => m.id),
        ],
      }],
      confidence: 0.9,
    };
    ctx.trace.log({ item_id: item.item_id, agent_name: "Substitution", action: "no_safe_substitute", input_summary: `${facts.equivalents.length} equivalents, none clear of shortage or recall`, output_summary: plan.claims[0]!.text, target_agent: "EvidenceCritic", evidence_ids: plan.claims[0]!.evidence_ids, status: "ok" });
    return plan;
  }

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
Only list substitutes whose status is clear or listed_available, prefer clear, list at most 3 substitutes and at most 4 orderable package NDCs each, exactly as they appear in the ndc- evidence.
When you say a product is therapeutically equivalent, cite its Orange Book record AND ours; when you say its supply is clear, cite its status- record.
Reply as {"recommendation":string,"substitutes":[{"application":string,"reason":string,"evidence_ids":[string],"orderable_ndcs":[string]}],"claims":[{"text":string,"evidence_ids":[string]}],"confidence":number}.`,
      },
    ],
    { tier: "fast", maxTokens: 2500 },
  );

  const byAppl = new Map(facts.equivalents.map((r) => [`${r.appl_type === "A" ? "ANDA" : "NDA"}${r.appl_no}`, r]));
  const plan: SubstitutionPlan = {
    item_id: item.item_id,
    recommendation: value.recommendation,
    substitutes: (value.substitutes ?? []).slice(0, 3).map((s) => {
      const ob = byAppl.get(String(s.application).toUpperCase());
      return {
        application: String(s.application).toUpperCase(),
        applicant: ob?.applicant_full_name || ob?.applicant || "unknown",
        te_code: ob?.te_code ?? "",
        status: facts.checks.get(String(s.application).toUpperCase())?.verdict ?? "constrained",
        orderable_ndcs: (s.orderable_ndcs ?? []).map(String).slice(0, 4),
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
