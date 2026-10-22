import type { Claim, Evidence } from "../evidence.js";
import { chatJson } from "../llm/meterless.js";
import { sameConcentration } from "../tools/fda.js";
import { evidenceBlock, SYSTEM_BASE } from "./prompts.js";
import type { AgentContext, CriticVerdict, ItemCase } from "./types.js";

export type Problem = { agent: "investigator" | "substitution"; reason: string; claim?: string };

/**
 * Deterministic checks. These never depend on a model: a claim citing evidence that was never fetched,
 * an unsafe or unorderable substitute, a ruled-out supplier, or a wrong days-of-cover number fails here.
 */
export function codeChecks(c: ItemCase, ctx: AgentContext): Problem[] {
  const problems: Problem[] = [];
  const inv = c.investigation;
  const sub = c.substitution;
  const checkClaims = (claims: Claim[], agent: Problem["agent"]) => {
    for (const cl of claims) {
      if (!cl.evidence_ids.length) problems.push({ agent, reason: `Claim cites no evidence: "${cl.text}"`, claim: cl.text });
      const missing = ctx.store.normalise(cl);
      if (missing.length) problems.push({ agent, reason: `Claim cites evidence that was never fetched (${missing.join(", ")}): "${cl.text}"`, claim: cl.text });
      // Any "N days" figure must match the hospital's days of cover within half a day.
      for (const m of cl.text.matchAll(/(\d+(?:\.\d+)?)\s*days?\s+(?:of\s+(?:cover|stock|supply)|left|remaining)/gi)) {
        const n = Number(m[1]);
        const cover = c.item.days_of_cover;
        const aboutChange = /\b(add|adds|would|after|extra|additional|another|once|when|bring|raise|extend)\b/i.test(cl.text);
        if (cover !== null && !aboutChange && Math.abs(n - cover) > 0.5) {
          problems.push({ agent, reason: `Says ${n} days but the hospital database shows ${cover} days of cover: "${cl.text}"`, claim: cl.text });
        }
      }
    }
  };
  if (inv) {
    checkClaims(inv.claims, "investigator");
    if ((inv.own_constrained || inv.own_recalled) && (inv.risk === "no_risk" || inv.risk === "low_stock_only")) {
      problems.push({ agent: "investigator", reason: `Our own product is ${inv.own_recalled ? "under an ongoing FDA recall" : "listed as unavailable or limited on the FDA shortage list"}, but the risk was rated "${inv.risk}".` });
    }
  }
  if (sub && c.facts) {
    checkClaims(sub.claims, "substitution");
    const known = new Map(c.facts.equivalents.map((r) => [`${r.appl_type === "A" ? "ANDA" : "NDA"}${r.appl_no}`, r]));
    for (const s of sub.substitutes) {
      ctx.store.normalise({ text: "", evidence_ids: s.evidence_ids });
      const ob = known.get(s.application);
      const check = c.facts.checks.get(s.application);
      if (!ob) problems.push({ agent: "substitution", reason: `${s.application} is not a therapeutic equivalent found in the Orange Book for this product.` });
      else if (!/^A/.test(ob.te_code ?? "")) problems.push({ agent: "substitution", reason: `${s.application} has TE code ${ob.te_code}, which is not an A-rated equivalent.` });
      if (!check || !(check.verdict === "clear" || check.verdict === "listed_available")) problems.push({ agent: "substitution", reason: `${s.applicant} ${s.application} is ${check?.verdict ?? "unchecked"} on FDA data, so it is not a safe, orderable substitute.` });
      // Every package must be one of THIS application's own listings, at our concentration (wrong strength is a dosing error).
      for (const p of s.packages) {
        const listed = check?.packages.find((x) => x.pkg.ndc === p.ndc);
        if (!listed) problems.push({ agent: "substitution", reason: `NDC ${p.ndc} is not one of ${s.application}'s own listings at our concentration.` });
        else if (!sameConcentration(listed.pkg.strength, c.item.strength)) problems.push({ agent: "substitution", reason: `NDC ${p.ndc} is ${listed.pkg.strength}, but our product is ${c.item.strength}: wrong strength, not a substitute.` });
      }
      if (!s.packages.length) problems.push({ agent: "substitution", reason: `${s.application} has no orderable package listed.` });
      for (const m of ctx.memories.filter((mm) => mm.kind === "avoid_supplier" && mm.subject)) {
        const names = [s.applicant, ...s.packages.map((p) => p.labeler)];
        if (names.some((n) => n.toLowerCase().includes(m.subject!.toLowerCase()))) {
          problems.push({ agent: "substitution", reason: `The buyer ruled out ${m.subject} (saved decision ${m.id}), but ${s.application} (${s.applicant}) was recommended.` });
        }
      }
    }
    if ((sub.recommendation === "switch" || sub.recommendation === "split") && !sub.substitutes.length) {
      problems.push({ agent: "substitution", reason: `Recommended "${sub.recommendation}" but listed no substitute.` });
    }
  }
  return problems;
}

type ReviewReply = { unsupported: Array<{ claim: string; agent: "investigator" | "substitution"; why: string }> };

/** The full review: code checks, then a model reads each claim against the evidence it cites. */
export async function review(c: ItemCase, ctx: AgentContext): Promise<CriticVerdict> {
  const problems = codeChecks(c, ctx);
  const claims = [
    ...(c.investigation?.claims ?? []).map((cl) => ({ ...cl, agent: "investigator" as const })),
    ...(c.substitution?.claims ?? []).map((cl) => ({ ...cl, agent: "substitution" as const })),
    ...(c.substitution?.substitutes ?? []).map((s) => ({ text: `${s.applicant} ${s.application}: ${s.reason}`, evidence_ids: s.evidence_ids, agent: "substitution" as const })),
  ];
  const cited = [...new Set(claims.flatMap((cl) => cl.evidence_ids))].map((id) => ctx.store.get(id)).filter((e): e is Evidence => !!e);

  let receipt;
  if (claims.length && !problems.length) {
    const r = await chatJson<ReviewReply>(
      [
        { role: "system", content: SYSTEM_BASE },
        {
          role: "user",
          content: `You are the Evidence Critic. For each claim, check that the evidence it cites actually says it. Flag only factual problems: overstatements (for example "unavailable" when the record says "limited"), wrong numbers, dates or suppliers, causes the record does not state, and products or NDCs that are not in the evidence. Reasonable conclusions that follow directly from the cited facts (for example "an open order gives short-term cover") are supported. Do not flag wording style.

Claims (agent: text [cited ids]):
${claims.map((cl, i) => `${i + 1}. ${cl.agent}: ${cl.text} [${cl.evidence_ids.join(", ")}]`).join("\n")}

Evidence:
${evidenceBlock(cited)}

Reply as {"unsupported":[{"claim":string,"agent":"investigator"|"substitution","why":string}]} with an empty list if every claim is supported.`,
        },
      ],
      { tier: "deep", maxTokens: 2000 },
    );
    receipt = r.receipt;
    for (const u of r.value.unsupported ?? []) problems.push({ agent: u.agent === "substitution" ? "substitution" : "investigator", reason: `Not supported by the cited evidence: "${u.claim}" (${u.why})`, claim: u.claim });
  }

  let verdict: CriticVerdict;
  if (!problems.length) {
    verdict = { verdict: "approve", target_agent: null, reasons: [], blocked_claims: [] };
  } else if (c.retries < 2) {
    const target = problems.some((p) => p.agent === "investigator") ? "investigator" : "substitution";
    verdict = { verdict: "revise", target_agent: target, reasons: problems.filter((p) => p.agent === target).map((p) => p.reason), blocked_claims: [] };
  } else if (problems.every((p) => p.claim)) {
    // Out of retries, but every problem is a single unsupported sentence: drop those sentences and keep
    // the rest of the finding (the spec's "block the claim, say why").
    const drop = new Set(problems.map((p) => p.claim));
    if (c.investigation) c.investigation.claims = c.investigation.claims.filter((cl) => !drop.has(cl.text));
    if (c.substitution) {
      c.substitution.claims = c.substitution.claims.filter((cl) => !drop.has(cl.text));
      // A substitute whose own justification did not hold up is dropped with it, not left on the order.
      const before = c.substitution.substitutes.length;
      c.substitution.substitutes = c.substitution.substitutes.filter((sub) => ![...drop].some((t) => t && (t.includes(sub.application) || t.startsWith(`${sub.applicant} `))));
      if (before && !c.substitution.substitutes.length && (c.substitution.recommendation === "switch" || c.substitution.recommendation === "split")) c.substitution.recommendation = "no_safe_substitute";
    }
    verdict = { verdict: "approve", target_agent: null, reasons: problems.map((p) => `Removed: ${p.reason}`), blocked_claims: [...drop] as string[] };
  } else {
    verdict = { verdict: "block", target_agent: null, reasons: problems.map((p) => p.reason), blocked_claims: problems.map((p) => p.claim).filter((x): x is string => !!x) };
  }
  ctx.trace.log(
    {
      item_id: c.item.item_id,
      agent_name: "EvidenceCritic",
      action: verdict.verdict === "approve" ? "approve" : verdict.verdict === "revise" ? "send_back" : "block_claims",
      input_summary: `${claims.length} claims, ${cited.length} cited evidence records, ${problems.length} problem(s) found by code checks${receipt ? " and model review" : ""}`,
      output_summary: verdict.verdict === "approve" ? (verdict.blocked_claims.length ? `Approved after removing ${verdict.blocked_claims.length} unsupported claim(s): ${verdict.reasons.join(" | ")}`.slice(0, 900) : "All claims supported; substitutes safe and orderable.") : `${verdict.verdict}: ${verdict.reasons.join(" | ")}`.slice(0, 900),
      target_agent: verdict.target_agent === "investigator" ? "Investigator" : verdict.target_agent === "substitution" ? "Substitution" : undefined,
      verdict: verdict.verdict,
      retry_count: c.retries,
      status: verdict.verdict === "approve" ? "ok" : verdict.verdict === "revise" ? "needs_revision" : "blocked",
    },
    receipt,
  );
  return verdict;
}
