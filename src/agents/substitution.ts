import { config } from "../config.js";
import type { Evidence } from "../evidence.js";
import { chatJson } from "../llm/meterless.js";
import { equivalentsFor, ingredientKey, makerKey, sameConcentration, substituteStatuses, type SubstituteCheck } from "../tools/fda.js";
import { listingPackages, registerNdcSource, type Pkg } from "../tools/scout.js";
import { evidenceBlock, memoryBlock, SYSTEM_BASE } from "./prompts.js";
import type { AgentContext, ItemCase, OrderPackage, SubstituteFacts, SubstitutionPlan } from "./types.js";

const applOf = (r: { appl_type: string; appl_no: string }) => `${r.appl_type === "A" ? "ANDA" : "NDA"}${r.appl_no}`;

/** Closest presentation first: same container, same fill volume, sold by the applicant itself. */
function rankPackages(pkgs: Pkg[], own: Pkg | null, applicant: string): Pkg[] {
  const score = (p: Pkg) =>
    (own?.container && p.container === own.container ? 2 : 0) +
    (own?.volume_ml != null && p.volume_ml === own.volume_ml ? 2 : 0) +
    (makerKey(p.labeler) === makerKey(applicant) ? 1 : 0);
  return [...pkgs].sort((a, b) => score(b) - score(a));
}

function verdictText(k: SubstituteCheck): string {
  switch (k.verdict) {
    case "clear": return "none of its packages at our concentration is on the FDA shortage list";
    case "listed_available": return "on the FDA shortage list, but at least one package at our concentration is listed as Available";
    case "constrained": return "every package at our concentration is listed as limited or unavailable";
    case "recalled": return "under an ongoing class I or II recall";
    default: return "no current NDC listing at our concentration, so it cannot be ordered";
  }
}

/** Tools only: Orange Book equivalents, their orderable packages via the scout, and each package's FDA status. */
export async function gatherSubstituteFacts(c: ItemCase, ctx: AgentContext): Promise<SubstituteFacts> {
  const item = c.item;
  const eq = await equivalentsFor(item);
  ctx.store.addAll(eq.evidence);

  // Which equivalents can actually be ordered, in what package? That is the openFDA NDC directory, which
  // is not a standing Zetaris source: the scout registers it for this ingredient on demand.
  const ingredient = ingredientKey(item.generic_name);
  const src = await registerNdcSource(ingredient, { sample: config.sampleMode });
  ctx.trace.log({
    item_id: item.item_id,
    agent_name: "SourceScout",
    action: src.created ? "register_zetaris_source" : "reuse_zetaris_source",
    input_summary: `Need our own package details and orderable packages for ${eq.equivalents.length} Orange Book equivalents of ${ingredient}; no standing Zetaris source has them`,
    output_summary: src.created ? `Registered a new Zetaris REST source over the openFDA NDC directory for ${ingredient} and snapshotted it as ${src.table}` : `Reused today's Zetaris snapshot ${src.table} of the openFDA NDC directory`,
    target_agent: "Substitution",
    status: "ok",
    ...(src.sql.length ? { sql: src.sql.join(";\n") } : {}),
  });

  const appls = [...new Set(eq.equivalents.map(applOf))];
  const listing = await listingPackages(src.table, appls, [item.product_ndc]);
  const ownPackage = listing.packages.find((p) => p.ndc === item.package_ndc) ?? listing.packages.find((p) => p.product_ndc === item.product_ndc) ?? null;
  if (!eq.equivalents.length) {
    ctx.store.addAll(listing.evidence.filter((e) => String(e.data.product_ndc) === item.product_ndc));
    ctx.trace.log({ item_id: item.item_id, agent_name: "Substitution", action: "find_equivalents", input_summary: `Orange Book: ${eq.own ? `${eq.own.ingredient} ${eq.own.strength} (${eq.own.df_route})` : "own product not found"}`, output_summary: "No therapeutically equivalent product from another application", evidence_ids: eq.evidence.map((e) => e.id), status: "info" });
    return { own: eq.own, equivalents: [], checks: new Map(), ownPackage };
  }
  const byAppl = new Map<string, Pkg[]>();
  let otherStrengths = 0;
  for (const p of listing.packages) {
    if (!appls.includes(p.application_number)) continue;
    if (!sameConcentration(p.strength, item.strength)) { otherStrengths++; continue; }
    byAppl.set(p.application_number, [...(byAppl.get(p.application_number) ?? []), p]);
  }
  for (const [a, pk] of byAppl) {
    const ob = eq.equivalents.find((r) => applOf(r) === a);
    byAppl.set(a, rankPackages(pk, ownPackage, ob?.applicant_full_name || ob?.applicant || ""));
  }
  const keepProducts = new Set([...[...byAppl.values()].flat().map((p) => p.product_ndc), item.product_ndc]);
  ctx.store.addAll(listing.evidence.filter((e) => keepProducts.has(String(e.data.product_ndc))));

  const st = await substituteStatuses(eq.equivalents, byAppl, eq.own);
  ctx.store.addAll(st.evidence);
  for (const k of st.checks.values()) {
    // The status check is done in code, so it becomes evidence the agents (and the buyer) can cite.
    ctx.store.add({
      id: `status-${k.appl}`,
      source: "fda-shortage",
      summary: `Checked ${k.applicant} ${k.appl}: ${k.packages.length} package(s) at our concentration in the FDA product listing${k.packages.length ? ` (${k.packages.slice(0, 4).map((x) => `${x.pkg.ndc} by ${x.pkg.labeler}: ${x.availability ? `FDA shortage list "${x.availability}"` : "not on the FDA shortage list"}`).join("; ")})` : ""}; ${k.recalls.length ? `${k.recalls.length} ongoing recall(s)` : "no ongoing recall on these products"}. Result: ${verdictText(k)}.${k.preservative_note ? ` ${k.preservative_note}` : ""}`,
      data: { appl: k.appl, verdict: k.verdict, packages: k.packages.length },
    });
  }
  const counts = [...st.checks.values()].reduce<Record<string, number>>((m, k) => ({ ...m, [k.verdict]: (m[k.verdict] ?? 0) + 1 }), {});
  ctx.trace.log({
    item_id: item.item_id,
    agent_name: "Substitution",
    action: "find_equivalents",
    input_summary: `Orange Book: ${eq.own ? `${eq.own.ingredient} ${eq.own.strength} (${eq.own.df_route})` : "own product not found"}; NDC directory via Zetaris`,
    output_summary: `${st.checks.size} equivalent applications: ${Object.entries(counts).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ")}; ${otherStrengths} package(s) at other strengths excluded`,
    evidence_ids: [...st.checks.keys()].map((a) => `status-${a}`),
    status: "ok",
  });
  return { own: eq.own, equivalents: eq.equivalents, checks: st.checks, ownPackage };
}

type SubstitutionReply = {
  recommendation: SubstitutionPlan["recommendation"];
  substitutes: Array<{ application: string; reason: string }>;
  claims: Array<{ text: string; evidence_ids: string[] }>;
  confidence: number;
};

/** Ranks the safe, orderable substitutes and explains why. The model never sees options the buyer ruled out. */
export async function proposeSubstitutes(c: ItemCase, ctx: AgentContext, feedback?: string[]): Promise<SubstitutionPlan> {
  const item = c.item;
  const facts = c.facts!;
  const ownObId = facts.own ? `ob-${applOf(facts.own)}-${facts.own.product_no}` : null;

  // Buyer decisions bind: a supplier the buyer ruled out (as Orange Book applicant or as package labeler)
  // is removed in code and never offered to the model.
  const avoided = ctx.memories.filter((m) => m.kind === "avoid_supplier" && m.subject);
  const ruledOut = new Map<string, string>();
  for (const k of facts.checks.values()) {
    const names = [k.applicant, ...k.packages.map((x) => x.pkg.labeler)].map((n) => n.toLowerCase());
    const rule = avoided.find((m) => names.some((n) => n.includes(m.subject!.toLowerCase())));
    if (rule && (k.verdict === "clear" || k.verdict === "listed_available")) ruledOut.set(k.appl, rule.id);
  }
  if (ruledOut.size) {
    c.memory_applied = [...new Set(avoided.filter((m) => [...ruledOut.values()].includes(m.id)).map((m) => m.content.replace(/^Buyer decision: /, "")))];
    ctx.trace.log({ item_id: item.item_id, agent_name: "Memory", action: "apply_buyer_decision", input_summary: avoided.map((m) => m.content).join("; ").slice(0, 200), output_summary: `Removed ${[...ruledOut.keys()].map((a) => `${facts.checks.get(a)!.applicant} ${a}`).join(", ")} before ranking, because the buyer ruled this supplier out`, target_agent: "Substitution", evidence_ids: [...new Set(ruledOut.values())], status: "ok" });
  }

  const candidates = [...facts.checks.values()].filter((k) => !ruledOut.has(k.appl) && (k.verdict === "clear" || k.verdict === "listed_available"));
  const describe = (k: SubstituteCheck) => `${k.applicant} ${k.appl} (${ruledOut.has(k.appl) ? "on FDA data it could be used, but the buyer ruled this supplier out" : verdictText(k)})`;

  if (!candidates.length) {
    // Nothing safe and orderable: code decides and says exactly why; the model is not asked to invent one.
    const plan: SubstitutionPlan = {
      item_id: item.item_id,
      recommendation: "no_safe_substitute",
      substitutes: [],
      claims: [{
        text: facts.checks.size
          ? `The Orange Book lists ${facts.checks.size} therapeutically equivalent application(s) for this product: ${[...facts.checks.values()].map(describe).join("; ")}. None can be recommended.`
          : `The FDA Orange Book lists no therapeutically equivalent product from another application for ${item.generic_name} ${item.strength}.`,
        evidence_ids: [
          ...(ownObId ? [ownObId] : [`stock-${item.item_id}`]),
          ...[...facts.checks.keys()].map((a) => `status-${a}`),
          ...[...new Set(ruledOut.values())],
        ].filter((id) => ctx.store.has(id)),
      }],
      confidence: 0.9,
    };
    ctx.trace.log({ item_id: item.item_id, agent_name: "Substitution", action: "no_safe_substitute", input_summary: `${facts.checks.size} equivalents, none safe and orderable`, output_summary: plan.claims[0]!.text.slice(0, 600), target_agent: "EvidenceCritic", evidence_ids: plan.claims[0]!.evidence_ids, status: "ok" });
    return plan;
  }

  const obIds = (appl: string) => ctx.store.all().filter((e) => e.id.startsWith(`ob-${appl}-`)).map((e) => e.id);
  const ndcIds = (k: SubstituteCheck) => [...new Set(k.packages.map((x) => `ndc-${x.pkg.product_ndc}`))].filter((id) => ctx.store.has(id));
  const evidence: Evidence[] = [
    ctx.store.get(`stock-${item.item_id}`)!,
    ...(ownObId && ctx.store.get(ownObId) ? [ctx.store.get(ownObId)!] : []),
    ...candidates.flatMap((k) => [`status-${k.appl}`, ...obIds(k.appl).slice(0, 1)].map((id) => ctx.store.get(id)).filter((e): e is Evidence => !!e)),
  ];

  const { value, receipt } = await chatJson<SubstitutionReply>(
    [
      { role: "system", content: SYSTEM_BASE },
      {
        role: "user",
        content: `You are the Substitution agent. Our item: ${item.generic_name} ${item.strength}, supplier ${item.labeler}, ${item.days_of_cover} days of cover.
Investigator's finding: ${c.investigation?.risk}: ${c.investigation?.headline}

Safe, orderable therapeutic equivalents (FDA Orange Book, checked against the FDA shortage and recall lists by package):
${candidates.map((k) => `- ${k.appl} ${k.applicant}: ${verdictText(k)}; ${k.packages.length} package(s)${k.preservative_note ? `; ${k.preservative_note}` : ""}`).join("\n")}
${ruledOut.size ? `(${ruledOut.size} other option(s) were removed because the buyer ruled out that supplier.)\n` : ""}
Evidence:
${evidenceBlock(evidence)}

Saved buyer decisions:
${memoryBlock(ctx.memories)}
${feedback?.length ? `\nThe Evidence Critic sent your last answer back. Fix these problems:\n- ${feedback.join("\n- ")}\n` : ""}
Recommend "switch" (order a substitute instead), "split" (keep the current supplier and add a substitute), or "keep_current".
Pick at most 3 applications from the list above, best first (prefer "none on the shortage list" over "listed but available", and products without a preservative difference). Say why in one sentence each.
When you say a product is equivalent, cite its Orange Book record and ours; when you describe its supply, cite its status- record. Do not say a product "is available" unless a record says Available; say "not on the FDA shortage list" instead.
Reply as {"recommendation":string,"substitutes":[{"application":string,"reason":string}],"claims":[{"text":string,"evidence_ids":[string]}],"confidence":number}.`,
      },
    ],
    { tier: "fast", maxTokens: 2500 },
  );

  const byAppl = new Map(candidates.map((k) => [k.appl, k]));
  // The model may write "ANDA090315 ONESOURCE SPECIALTY PTE LTD": keep only the application number.
  const applNo = (v: unknown) => { const t = String(v ?? "").toUpperCase(); const m = t.match(/\b(ANDA|NDA|BLA)\s*0*(\d{1,6})\b/); return m ? `${m[1]}${m[2]!.padStart(6, "0")}` : t.replace(/\s/g, ""); };
  const proposed = (value.substitutes ?? []).map((s) => ({ ...s, application: applNo(s.application) }));
  const unknown = proposed.filter((s) => !byAppl.has(s.application));
  if (unknown.length) {
    ctx.trace.log({ item_id: item.item_id, agent_name: "CodeGuard", action: "guard_remove_unsafe_substitute", input_summary: `${proposed.length} substitutes proposed by the model`, output_summary: `Removed ${unknown.map((s) => s.application).join(", ")}: not one of the safe, orderable equivalents`, target_agent: "Substitution", status: "needs_revision" });
  }
  const pkgLine = (k: SubstituteCheck): OrderPackage[] => k.packages.slice(0, 4).map((x) => ({ ndc: x.pkg.ndc, labeler: x.pkg.labeler, description: (x.pkg.description.split("/").pop() ?? x.pkg.description).replace(/\s*\([^)]*\)\s*$/, "").trim(), fda_status: x.availability ?? "not on the FDA shortage list" }));
  const plan: SubstitutionPlan = {
    item_id: item.item_id,
    recommendation: value.recommendation === "switch" || value.recommendation === "split" || value.recommendation === "keep_current" ? value.recommendation : "split",
    substitutes: proposed.filter((s) => byAppl.has(s.application)).slice(0, 3).map((s) => {
      const k = byAppl.get(s.application)!;
      const ob = facts.equivalents.find((r) => applOf(r) === k.appl);
      const top = k.packages[0]?.pkg;
      const own = facts.ownPackage;
      const notes = [
        ...(k.preservative_note ? [k.preservative_note] : []),
        ...(own && top && (own.container !== top.container || own.volume_ml !== top.volume_ml) && top.volume_ml != null ? [`Closest package is ${top.volume_ml} mL ${String(top.container ?? "").toLowerCase()}; ours is ${own.volume_ml ?? "?"} mL ${String(own.container ?? "").toLowerCase()}.`] : []),
      ];
      return {
        application: k.appl,
        applicant: k.applicant,
        te_code: ob?.te_code ?? "",
        status: k.verdict,
        packages: pkgLine(k),
        notes,
        reason: String(s.reason ?? ""),
        evidence_ids: [`status-${k.appl}`, ...obIds(k.appl).slice(0, 1), ...(ownObId ? [ownObId] : []), ...ndcIds(k)].filter((id) => ctx.store.has(id)),
      };
    }),
    claims: (value.claims ?? []).map((cl) => ({ text: String(cl.text), evidence_ids: (cl.evidence_ids ?? []).map(String) })),
    confidence: Number(value.confidence ?? 0.5),
  };
  if (!plan.substitutes.length && plan.recommendation !== "keep_current") {
    // The model may rank, but it may not silently drop every option code has verified as safe and
    // orderable. Fall back to code's ranking (not on the shortage list first, no preservative difference
    // first) and replace its claims with a statement of those checks.
    const ranked = [...candidates].sort((a, b) => Number(b.verdict === "clear") - Number(a.verdict === "clear") || Number(!!a.preservative_note) - Number(!!b.preservative_note)).slice(0, 3);
    plan.recommendation = "split";
    plan.substitutes = ranked.map((k) => ({
      application: k.appl,
      applicant: k.applicant,
      te_code: facts.equivalents.find((r) => applOf(r) === k.appl)?.te_code ?? "",
      status: k.verdict,
      packages: pkgLine(k),
      notes: k.preservative_note ? [k.preservative_note] : [],
      reason: `Ranked by code: FDA-rated equivalent at our concentration, ${verdictText(k)}.`,
      evidence_ids: [`status-${k.appl}`, ...obIds(k.appl).slice(0, 1), ...(ownObId ? [ownObId] : []), ...ndcIds(k)].filter((id) => ctx.store.has(id)),
    }));
    plan.claims = [{
      text: `${ranked.length} FDA-rated equivalent application(s) at our concentration are safe to order on their own packages: ${ranked.map((k) => `${k.applicant} ${k.appl} (${verdictText(k)})`).join("; ")}.`,
      evidence_ids: [...new Set(plan.substitutes.flatMap((s) => s.evidence_ids.filter((id) => !id.startsWith("ndc-"))))],
    }];
    ctx.trace.log({ item_id: item.item_id, agent_name: "CodeGuard", action: "guard_keep_verified_substitutes", input_summary: `model picked none of ${candidates.length} verified options`, output_summary: `Kept code's top ${ranked.length}: ${ranked.map((k) => `${k.applicant} ${k.appl}`).join(", ")}`, target_agent: "Substitution", status: "needs_revision" });
  }

  ctx.trace.log(
    {
      item_id: item.item_id,
      agent_name: "Substitution",
      action: feedback?.length ? "revise_substitutes" : "propose_substitutes",
      input_summary: `${candidates.length} safe, orderable equivalents${feedback?.length ? `; critic feedback: ${feedback.join("; ")}` : ""}`,
      output_summary: `${plan.recommendation}: ${plan.substitutes.map((s) => `${s.applicant} ${s.application} (${s.packages.length} package(s), first ${s.packages[0]?.ndc ?? "none"})`).join(", ") || "no substitutes"}`,
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
