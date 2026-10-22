import { chatJson } from "../llm/meterless.js";
import type { Item } from "../tools/hospital.js";
import { memoryBlock, SYSTEM_BASE } from "./prompts.js";
import type { AgentContext } from "./types.js";

export const MUST_INVESTIGATE_DAYS = 14;

type PlannerReply = { plan: Array<{ item_id: number; reason: string }>; note?: string };

/**
 * Chooses which items to investigate and in what order. Code guarantees the floor (every item under
 * 14 days of cover, critical items first); the model may add items it judges risky and must say why.
 */
export async function plan(items: Item[], ctx: AgentContext, maxItems: number): Promise<Array<{ item: Item; reason: string; source: "rule" | "planner" }>> {
  const table = items
    .map((i) => `${i.item_id} | ${i.generic_name} ${i.strength} | ${i.labeler} | ${i.days_of_cover ?? "n/a"} days | ${i.avg_daily_use}/day | critical=${i.is_critical} | orders: ${i.open_orders.map((o) => `${o.status} ${o.ordered_units} due ${o.expected_on}`).join(", ") || "none"}`)
    .join("\n");

  const { value, receipt } = await chatJson<PlannerReply>(
    [
      { role: "system", content: SYSTEM_BASE },
      {
        role: "user",
        content: `You are the Planner. Today's stock position (item_id | product | supplier | days of cover | average daily use | critical | open purchase orders):
${table}

Saved buyer decisions:
${memoryBlock(ctx.memories)}

Every item under ${MUST_INVESTIGATE_DAYS} days of cover will be investigated anyway. Pick up to 5 MORE items worth investigating this week despite having more cover (for example a backordered purchase order, a critical drug with thin cover, or a saved buyer decision that asks to watch it), and give a one-line reason for each.
Reply as {"plan":[{"item_id":number,"reason":string}],"note":string}.`,
      },
    ],
    { tier: "fast", maxTokens: 1500 },
  );

  const byId = new Map(items.map((i) => [i.item_id, i]));
  const chosen = new Map<number, { item: Item; reason: string; source: "rule" | "planner" }>();
  for (const i of items) {
    if (i.days_of_cover !== null && i.days_of_cover < MUST_INVESTIGATE_DAYS) {
      chosen.set(i.item_id, { item: i, reason: `${i.days_of_cover} days of cover left (under ${MUST_INVESTIGATE_DAYS})`, source: "rule" });
    }
  }
  for (const p of value.plan ?? []) {
    const item = byId.get(Number(p.item_id));
    if (item && !chosen.has(item.item_id)) chosen.set(item.item_id, { item, reason: String(p.reason).slice(0, 200), source: "planner" });
  }
  // Most urgent first: rule items by days of cover (critical drugs win ties), then the planner's additions.
  const ordered = [...chosen.values()].sort(
    (a, b) => Number(a.source === "planner") - Number(b.source === "planner") || (a.item.days_of_cover ?? 999) - (b.item.days_of_cover ?? 999) || Number(b.item.is_critical) - Number(a.item.is_critical),
  );

  ctx.trace.log(
    {
      item_id: null,
      agent_name: "Planner",
      action: "plan_investigation",
      input_summary: `${items.length} formulary items with days of cover`,
      output_summary: `${ordered.length} items to investigate (${ordered.filter((o) => o.source === "rule").length} by the under-${MUST_INVESTIGATE_DAYS}-days rule, ${ordered.filter((o) => o.source === "planner").length} added by the planner); investigating the first ${Math.min(maxItems, ordered.length)}. ${value.note ?? ""}`.trim(),
      evidence_ids: ordered.map((o) => `stock-${o.item.item_id}`),
      status: "ok",
    },
    receipt,
  );
  return ordered.slice(0, maxItems);
}
