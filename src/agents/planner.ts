import { chatJson } from "../llm/meterless.js";
import type { BoardRow } from "../tools/board.js";
import type { Item } from "../tools/hospital.js";
import { memoryBlock, SYSTEM_BASE } from "./prompts.js";
import type { AgentContext } from "./types.js";

export const MUST_INVESTIGATE_DAYS = 14;

type PlannerReply = { order: Array<{ item_id: number; reason: string }>; add: Array<{ item_id: number; reason: string }> };

export type PlannedItem = { item: Item; reason: string; source: "rule" | "planner" };

const supplyFlag = (b: BoardRow) => !!b.recall_number || (!!b.fda_status && !/^available$/i.test(b.fda_status));

/**
 * Chooses what to investigate and in what order, from the risk board (one federated Zetaris query).
 * Code guarantees the floor: every item under 14 days of cover, and every item whose own package is
 * short or recalled on FDA data, is checked. The model orders them by urgency and may add items it
 * judges risky; its additions are checked too, and its order is the order of work.
 */
export async function plan(items: Item[], board: BoardRow[], ctx: AgentContext, maxItems: number): Promise<{ planned: PlannedItem[]; mustCheck: number }> {
  const byId = new Map(items.map((i) => [i.item_id, i]));
  const must = board.filter((b) => (b.days_of_cover !== null && b.days_of_cover < MUST_INVESTIGATE_DAYS) || supplyFlag(b));
  const others = board.filter((b) => !must.includes(b));
  const line = (b: BoardRow) => `${b.item_id} | ${b.generic_name} | ${b.labeler} | ${b.days_of_cover ?? "n/a"} days | critical=${b.is_critical} | FDA list: ${b.fda_status ?? "no"} | recall: ${b.recall_number ? `${b.recall_number} ${b.recall_class}` : "no"} | open orders: ${byId.get(b.item_id)?.open_orders.map((o) => o.status).join(", ") || "none"}`;

  const { value, receipt } = await chatJson<PlannerReply>(
    [
      { role: "system", content: SYSTEM_BASE },
      {
        role: "user",
        content: `You are the Planner. These items MUST be checked this week (under ${MUST_INVESTIGATE_DAYS} days of cover, or our own package is short or recalled on FDA data):
${must.map(line).join("\n")}

Other items (more cover, not flagged):
${others.slice(0, 20).map(line).join("\n")}

Saved buyer decisions:
${memoryBlock(ctx.memories)}

1. Order the MUST items by urgency (a supply problem on our own package plus little cover first; critical drugs before others), with a short reason each.
2. Add up to 3 other items worth checking (for example a critical drug with thin cover or a backordered order), with a reason each, or none.
Reply as {"order":[{"item_id":number,"reason":string}],"add":[{"item_id":number,"reason":string}]}.`,
      },
    ],
    { tier: "fast", maxTokens: 2500 },
  );

  const mustIds = new Set(must.map((b) => b.item_id));
  const planned: PlannedItem[] = [];
  const seen = new Set<number>();
  for (const o of value.order ?? []) {
    const id = Number(o.item_id);
    if (mustIds.has(id) && !seen.has(id) && byId.has(id)) { planned.push({ item: byId.get(id)!, reason: String(o.reason).slice(0, 200), source: "rule" }); seen.add(id); }
  }
  // Anything the model left out of its order is still checked (the floor is code).
  for (const b of must) if (!seen.has(b.item_id) && byId.has(b.item_id)) { planned.push({ item: byId.get(b.item_id)!, reason: supplyFlag(b) ? "our package is short or recalled on FDA data" : `${b.days_of_cover} days of cover`, source: "rule" }); seen.add(b.item_id); }
  for (const a of (value.add ?? []).slice(0, 3)) {
    const id = Number(a.item_id);
    if (!seen.has(id) && byId.has(id)) { planned.push({ item: byId.get(id)!, reason: String(a.reason).slice(0, 200), source: "planner" }); seen.add(id); }
  }

  const chosen = planned.slice(0, Math.max(maxItems, must.length));
  ctx.trace.log(
    {
      item_id: null,
      agent_name: "Planner",
      action: "plan_investigation",
      input_summary: `risk board of ${board.length} items; ${must.length} must be checked (${must.filter(supplyFlag).length} with our own package short or recalled)`,
      output_summary: `Checking ${chosen.length}: all ${must.length} that must be checked, in the planner's order of urgency, plus ${chosen.filter((p) => p.source === "planner").length} added by the planner (${chosen.filter((p) => p.source === "planner").map((p) => `${p.item.generic_name}: ${p.reason}`).join("; ") || "none"})`,
      evidence_ids: chosen.map((o) => `board-${o.item.item_id}`),
      status: "ok",
    },
    receipt,
  );
  return { planned: chosen, mustCheck: must.length };
}
