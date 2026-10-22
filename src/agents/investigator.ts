import type { Evidence } from "../evidence.js";
import { chatJson } from "../llm/meterless.js";
import { recallsFor, shortageFor, type ShortageRow } from "../tools/fda.js";
import { evidenceBlock, memoryBlock, SYSTEM_BASE } from "./prompts.js";
import type { AgentContext, Investigation, ItemCase, Risk } from "./types.js";

type InvestigatorReply = { headline: string; claims: Array<{ text: string; evidence_ids: string[] }>; confidence: number };

const constrained = (r: ShortageRow) => !/^available$/i.test(r.availability ?? "");

/** Gathers shortage and recall evidence for one item through Zetaris, then asks the model to classify and explain the risk. */
export async function investigate(c: ItemCase, ctx: AgentContext, feedback?: string[]): Promise<Investigation> {
  const item = c.item;
  const shortage = await shortageFor(item);
  const recalls = await recallsFor([item.package_ndc, item.product_ndc]);
  ctx.store.addAll([...shortage.evidence, ...recalls.evidence]);
  // A search that finds nothing is still evidence: record it so "not on the list" claims can cite it.
  const searched: Evidence[] = [];
  if (!shortage.rows.some((r) => r.match === "same_package" || r.match === "same_product")) {
    searched.push({ id: `search-shortage-${item.item_id}`, source: "fda-shortage", summary: `Searched this run's FDA shortage list snapshot for our package NDC ${item.package_ndc} and product ${item.product_ndc}: not on the list.`, data: { item_id: item.item_id, found: 0 } });
  }
  if (!recalls.rows.length) {
    searched.push({ id: `search-recall-${item.item_id}`, source: "fda-recall", summary: `Searched this run's FDA ongoing-recall snapshot for our package NDC ${item.package_ndc} and product ${item.product_ndc}: no ongoing recall.`, data: { item_id: item.item_id, found: 0 } });
  }
  ctx.store.addAll(searched);

  const own = shortage.rows.filter((r) => r.match === "same_package" || r.match === "same_product");
  const maker = shortage.rows.filter((r) => r.match === "same_maker");
  const market = shortage.rows.filter((r) => r.match === "same_ingredient");
  // A market summary is evidence too, so "other makers are short" can be cited.
  if (maker.length || market.length) {
    searched.push({
      id: `market-${item.item_id}`,
      source: "fda-shortage",
      summary: `FDA shortage list context for ${item.generic_name}: ${maker.length ? `${maker.filter(constrained).length} of ${maker.length} other ${item.labeler} presentations listed limited or unavailable; ` : ""}${market.filter(constrained).length} of ${market.length} presentations from other makers listed limited or unavailable. These are not our package.`,
      data: { item_id: item.item_id, maker: maker.length, market: market.length },
    });
    ctx.store.addAll(searched.slice(-1));
  }
  ctx.trace.log({
    item_id: item.item_id,
    agent_name: "Investigator",
    action: "query_sources",
    input_summary: `${item.generic_name} ${item.strength}, our package NDC ${item.package_ndc} (${item.labeler})`,
    output_summary: `Our package or product on the FDA shortage list: ${own.length ? own.map((r) => `"${r.availability}"`).join(", ") : "no"}; other ${item.labeler.split(" ")[0]} presentations constrained: ${maker.filter(constrained).length}/${maker.length}; other makers constrained: ${market.filter(constrained).length}/${market.length}; ongoing recalls on our product: ${recalls.rows.length}`,
    evidence_ids: [...shortage.evidence, ...recalls.evidence].map((e) => e.id),
    status: "ok",
  });

  const cover = ctx.store.get(`stock-${item.item_id}`);
  const ownEv = shortage.evidence.filter((e) => e.data.match === "same_package" || e.data.match === "same_product");
  const evidence: Evidence[] = [cover!, ...searched, ...ownEv, ...recalls.evidence, ...shortage.evidence.filter((e) => !ownEv.includes(e)).slice(0, 12)];
  const ownConstrained = own.some(constrained);
  // Risk is decided in code from OUR package and product; the model explains it.
  const risk: Risk = recalls.rows.length ? "recall" : ownConstrained ? "supply_risk" : (item.days_of_cover ?? 99) < 14 ? "low_stock_only" : "no_risk";
  const { value, receipt } = await chatJson<InvestigatorReply>(
    [
      { role: "system", content: SYSTEM_BASE },
      {
        role: "user",
        content: `You are the Investigator. Explain this item's risk to the buyer, citing evidence ids.
Item: ${item.generic_name} ${item.strength}, our supplier ${item.labeler}, our package NDC ${item.package_ndc}, ${item.days_of_cover} days of cover.
Risk (decided from our own package and product on the FDA lists): ${risk}.
Shortage rows for other presentations of our maker, or for other makers, are market context, not our product: say so if you mention them.

Evidence:
${evidenceBlock(evidence)}

Saved buyer decisions:
${memoryBlock(ctx.memories)}
${feedback?.length ? `\nThe Evidence Critic sent your last answer back. Fix these problems:\n- ${feedback.join("\n- ")}\n` : ""}
Write a headline (max 12 words) and 1 to 3 claims. Cite every record a sentence rests on (for example both the stock record and the shortage record). If our package is listed, give its availability, the manufacturer's reason, and the next delivery or estimated recovery exactly as the record says.
Reply as {"headline":string,"claims":[{"text":string,"evidence_ids":[string]}],"confidence":number between 0 and 1}.`,
      },
    ],
    { tier: "fast", maxTokens: 2000 },
  );

  const ownRow = own.find(constrained) ?? own[0];
  const info = String(ownRow?.related_info ?? "");
  const pick = (label: RegExp) => info.split(/;\s*/).map((p) => p.split(":")).find(([k]) => label.test(k ?? ""))?.slice(1).join(":").trim() || null;
  const inv: Investigation = {
    item_id: item.item_id,
    risk,
    headline: String(value.headline ?? ""),
    claims: (value.claims ?? []).map((cl) => ({ text: String(cl.text), evidence_ids: (cl.evidence_ids ?? []).map(String) })),
    // Substitutes are for our own supply problems (constrained or recalled), never for ordinary low stock.
    needs_substitute: ownConstrained || recalls.rows.length > 0,
    confidence: Number(value.confidence ?? 0.5),
    own_constrained: ownConstrained,
    own_recalled: recalls.rows.length > 0,
    next_delivery: pick(/next delivery/i),
    estimated_recovery: pick(/estimated recovery/i),
    maker_constrained: maker.filter(constrained).length,
    market_constrained: market.filter(constrained).length,
    market_total: market.length,
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
