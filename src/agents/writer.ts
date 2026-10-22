import { chatJson } from "../llm/meterless.js";
import { SYSTEM_BASE } from "./prompts.js";
import type { AgentContext, ItemCase } from "./types.js";

export type OrderLine = {
  item_id: number;
  drug: string;
  current_supplier: string;
  days_of_cover: number | null;
  risk: string;
  action: "order_substitute" | "add_second_supplier" | "escalate" | "expedite_or_reorder" | "watch" | "no_action";
  headline: string;
  why: string;
  order: Array<{ supplier: string; application: string; ndcs: string[] }>;
  evidence_ids: string[];
  confidence: number;
  status: "approved" | "blocked";
  blocked_reasons: string[];
  memory_applied: string[];
};

type WriterReply = { lines: Array<{ item_id: number; headline: string; why: string }> };

/** Turns approved findings into the buyer's order list. The action and order details come from code; the model writes the words. */
export async function writeOrderList(cases: ItemCase[], ctx: AgentContext): Promise<OrderLine[]> {
  const base: OrderLine[] = cases.map((c) => {
    const inv = c.investigation;
    const sub = c.substitution;
    const blocked = c.status === "blocked";
    const action: OrderLine["action"] = blocked
      ? "watch"
      : sub?.recommendation === "switch" && sub.substitutes.length
        ? "order_substitute"
        : sub?.recommendation === "split" && sub.substitutes.length
          ? "add_second_supplier"
          : (inv?.risk === "supply_risk" || inv?.risk === "recall") && (sub?.recommendation === "no_safe_substitute" || (sub && !sub.substitutes.length)) && (c.item.days_of_cover ?? 99) < 14
            ? "escalate"
            : inv?.risk === "low_stock_only"
            ? "expedite_or_reorder"
            : inv?.risk === "no_risk"
              ? "no_action"
              : "watch";
    return {
      item_id: c.item.item_id,
      drug: `${c.item.generic_name} ${c.item.strength}`,
      current_supplier: c.item.labeler,
      days_of_cover: c.item.days_of_cover,
      risk: inv?.risk ?? "unknown",
      action,
      headline: inv?.headline ?? "",
      why: "",
      order: (action === "order_substitute" || action === "add_second_supplier")
        ? (sub?.substitutes ?? []).map((s) => ({ supplier: s.applicant, application: s.application, ndcs: s.orderable_ndcs }))
        : [],
      evidence_ids: [...new Set([...(inv?.claims ?? []).flatMap((x) => x.evidence_ids), ...(sub?.substitutes ?? []).flatMap((s) => s.evidence_ids)])],
      confidence: Math.min(inv?.confidence ?? 0.5, sub?.confidence ?? 1),
      status: blocked ? "blocked" : "approved",
      blocked_reasons: blocked ? (c.critic?.reasons ?? []) : [],
      memory_applied: c.memory_applied ?? [],
    };
  });

  const approvedClaims = cases.map((c) => ({
    item_id: c.item.item_id,
    drug: `${c.item.generic_name} ${c.item.strength}`,
    days_of_cover: c.item.days_of_cover,
    action: base.find((b) => b.item_id === c.item.item_id)!.action,
    claims: [...(c.investigation?.claims ?? []), ...(c.substitution?.claims ?? [])].map((x) => x.text),
    substitutes: (c.substitution?.substitutes ?? []).map((s) => `${s.applicant} (${s.application})`),
    blocked: c.status === "blocked",
    buyer_rules_applied: c.memory_applied ?? [],
  }));

  const { value, receipt } = await chatJson<WriterReply>(
    [
      { role: "system", content: SYSTEM_BASE },
      {
        role: "user",
        content: `You are the Writer. For each item, write a headline (max 12 words) and a "why" (max 2 sentences) for a pharmacy buyer, using ONLY the approved claims below. Do not add facts. Never mention claim numbers, evidence ids or the word "claim". If an item is blocked, say the evidence did not hold up and it needs a manual check. If buyer_rules_applied is not empty, say in the "why" that the buyer's rule removed that supplier. If the action is "escalate", say plainly that no interchangeable product is available and the pharmacy team must decide (for example a different strength or a clinical alternative), without inventing one.
${JSON.stringify(approvedClaims, null, 1)}
Reply as {"lines":[{"item_id":number,"headline":string,"why":string}]}.`,
      },
    ],
    { tier: "deep", maxTokens: 3000 },
  );
  for (const l of value.lines ?? []) {
    const line = base.find((b) => b.item_id === Number(l.item_id));
    if (line) {
      const clean = (t: string) => t.replace(/\s*\((?:claims?|evidence)[^)]*\)/gi, "").replace(/\s+([.,])/g, "$1").trim();
      line.headline = clean(String(l.headline || line.headline));
      line.why = clean(String(l.why ?? ""));
    }
  }
  ctx.trace.log(
    {
      item_id: null,
      agent_name: "Writer",
      action: "write_order_list",
      input_summary: `${cases.length} reviewed items (${cases.filter((c) => c.status === "approved").length} approved, ${cases.filter((c) => c.status === "blocked").length} blocked)`,
      output_summary: base.map((b) => `${b.drug.split(" ")[0]}: ${b.action}`).join("; "),
      status: "ok",
    },
    receipt,
  );
  const rank: Record<OrderLine["action"], number> = { escalate: 0, order_substitute: 1, add_second_supplier: 2, expedite_or_reorder: 3, watch: 4, no_action: 5 };
  return base.sort((a, b) => rank[a.action] - rank[b.action] || (a.days_of_cover ?? 999) - (b.days_of_cover ?? 999));
}
