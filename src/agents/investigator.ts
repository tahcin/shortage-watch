import type { Evidence } from "../evidence.js";
import { chatJson } from "../llm/meterless.js";
import { recallsFor, shortageFor, type ShortageRow } from "../tools/fda.js";
import { evidenceBlock, memoryBlock, SYSTEM_BASE } from "./prompts.js";
import type { AgentContext, Investigation, ItemCase, Risk } from "./types.js";

type InvestigatorReply = { risk: Risk; headline: string; claims: Array<{ text: string; evidence_ids: string[] }>; needs_substitute: boolean; confidence: number };

const constrained = (r: ShortageRow) => !/^available$/i.test(r.availability ?? "");

/** Gathers shortage and recall evidence for one item through Zetaris, then asks the model to classify and explain the risk. */
export async function investigate(c: ItemCase, ctx: AgentContext, feedback?: string[]): Promise<Investigation> {
  const item = c.item;
  const shortage = await shortageFor(item);
  const recalls = await recallsFor([item.package_ndc, item.product_ndc], [item.application_number]);
  ctx.store.addAll([...shortage.evidence, ...recalls.evidence]);
  // A search that finds nothing is still evidence: record it so "not on the list" claims can cite it.
  const searched: Evidence[] = [];
  if (!shortage.rows.some((r) => r.match !== "same_ingredient")) {
    searched.push({ id: `search-shortage-${item.item_id}`, source: "fda-shortage", summary: `Searched this run's FDA shortage list snapshot for NDC ${item.package_ndc}, product ${item.product_ndc} and application ${item.application_number}: no entry for our product.`, data: { item_id: item.item_id, found: 0 } });
  }
  if (!recalls.rows.length) {
    searched.push({ id: `search-recall-${item.item_id}`, source: "fda-recall", summary: `Searched this run's FDA ongoing-recall snapshot for NDC ${item.package_ndc}, product ${item.product_ndc} and application ${item.application_number}: no ongoing recall.`, data: { item_id: item.item_id, found: 0 } });
  }
  ctx.store.addAll(searched);

  const own = shortage.rows.filter((r) => r.match !== "same_ingredient");
  const market = shortage.rows.filter((r) => r.match === "same_ingredient");
  ctx.trace.log({
    item_id: item.item_id,
    agent_name: "Investigator",
    action: "query_sources",
    input_summary: `${item.generic_name} ${item.strength}, NDC ${item.package_ndc}, ${item.application_number}`,
    output_summary: `FDA shortage list: ${own.length} rows for our product or application (${own.filter(constrained).length} constrained), ${market.length} rows for the same ingredient from other makers (${market.filter(constrained).length} constrained); ongoing recalls: ${recalls.rows.length}`,
    evidence_ids: [...shortage.evidence, ...recalls.evidence].map((e) => e.id),
    status: "ok",
  });

  const cover = ctx.store.get(`stock-${item.item_id}`);
  const evidence: Evidence[] = [cover!, ...searched, ...shortage.evidence.slice(0, 25), ...recalls.evidence];
  const { value, receipt } = await chatJson<InvestigatorReply>(
    [
      { role: "system", content: SYSTEM_BASE },
      {
        role: "user",
        content: `You are the Investigator. Decide how at risk this item is and explain why, citing evidence ids.
Item: ${item.generic_name} ${item.strength}, our supplier ${item.labeler}, NDC ${item.package_ndc}, application ${item.application_number}.

Evidence:
${evidenceBlock(evidence)}

Saved buyer decisions:
${memoryBlock(ctx.memories)}
${feedback?.length ? `\nThe Evidence Critic sent your last answer back. Fix these problems:\n- ${feedback.join("\n- ")}\n` : ""}
Risk levels: "supply_risk" (our product or this drug is on the FDA shortage list as unavailable or limited), "recall" (an ongoing recall touches our product), "low_stock_only" (few days of cover but no FDA supply problem), "no_risk".
"needs_substitute" is true when our own product is unavailable, limited, or recalled AND cover is short.
Reply as {"risk":string,"headline":string,"claims":[{"text":string,"evidence_ids":[string]}],"needs_substitute":boolean,"confidence":number between 0 and 1}.`,
      },
    ],
    { tier: "fast", maxTokens: 2000 },
  );

  const RISKS: Risk[] = ["supply_risk", "recall", "low_stock_only", "no_risk"];
  // The model must pick one of the four levels; anything else falls back to what the FDA rows say.
  let risk: Risk = RISKS.includes(value.risk) ? value.risk : recalls.rows.length ? "recall" : own.some(constrained) ? "supply_risk" : (item.days_of_cover ?? 99) < 14 ? "low_stock_only" : "no_risk";
  // "Low stock" only means something under two weeks of cover.
  if (risk === "low_stock_only" && (item.days_of_cover ?? 0) >= 14) risk = "no_risk";
  // Code floor: if FDA lists our own product or application as limited or unavailable (or recalled),
  // the risk is a supply risk whatever the model said; the critic only checks wording after this.
  if (recalls.rows.length && risk !== "recall") risk = "recall";
  else if (own.some(constrained) && (risk === "no_risk" || risk === "low_stock_only")) risk = "supply_risk";
  const inv: Investigation = {
    item_id: item.item_id,
    risk,
    headline: String(value.headline ?? ""),
    claims: (value.claims ?? []).map((cl) => ({ text: String(cl.text), evidence_ids: (cl.evidence_ids ?? []).map(String) })),
    // Code floor: look for substitutes whenever our own product or application is constrained or recalled
    // and cover is under two weeks; the model can add cases but not remove these.
    needs_substitute: Boolean(value.needs_substitute) || ((own.some(constrained) || recalls.rows.length > 0) && (item.days_of_cover ?? 99) < 14),
    confidence: Number(value.confidence ?? 0.5),
    own_constrained: own.some(constrained),
    own_recalled: recalls.rows.length > 0,
  };
  ctx.trace.log(
    {
      item_id: item.item_id,
      agent_name: "Investigator",
      action: feedback?.length ? "revise_risk_assessment" : "assess_risk",
      input_summary: `${evidence.length} evidence records${feedback?.length ? `; critic feedback: ${feedback.join("; ")}` : ""}`,
      output_summary: `${inv.risk}: ${inv.headline}`,
      target_agent: inv.needs_substitute ? "Substitution" : "EvidenceCritic",
      evidence_ids: inv.claims.flatMap((cl) => cl.evidence_ids),
      confidence: inv.confidence,
      retry_count: c.retries,
      status: "ok",
    },
    receipt,
  );
  return inv;
}
