import { chatJson } from "../llm/meterless.js";
import { SYSTEM_BASE } from "./prompts.js";
import type { AgentContext, ItemCase, OrderPackage } from "./types.js";

export type Gap = { runs_out: string; next_supply: string; next_supply_label: "next delivery" | "estimated recovery"; gap_days: number; units_to_bridge: number };

export type OrderLine = {
  item_id: number;
  drug: string;
  current_supplier: string;
  days_of_cover: number | null;
  risk: string;
  action: "order_substitute" | "add_second_supplier" | "escalate" | "expedite_or_reorder" | "already_ordered" | "watch" | "no_action";
  headline: string;
  why: string;
  order: Array<{ supplier: string; application: string; packages: OrderPackage[]; notes: string[] }>;
  open_orders: string[];
  gap: Gap | null;
  dea_schedule: string | null;
  market_note: string | null;
  evidence_ids: string[];
  confidence: number;
  status: "approved" | "blocked";
  blocked_reasons: string[];
  memory_applied: string[];
  writer_checked: boolean;
};

type WriterReply = { lines: Array<{ item_id: number; headline: string; why: string }> };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "January 2027" -> 1 Jan 2027 (the earliest the FDA record allows). */
function monthStart(text: string | null): Date | null {
  const m = text?.toLowerCase().match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/);
  return m ? new Date(Date.UTC(Number(m[2]), MONTHS.indexOf(m[1]!), 1)) : null;
}

/** The stockout gap, in code: when we run out, when the FDA record says supply returns, and what bridges it. */
function gapFor(c: ItemCase): Gap | null {
  const inv = c.investigation;
  if (!inv || c.item.days_of_cover === null) return null;
  const label = inv.next_delivery ? "next delivery" : inv.estimated_recovery ? "estimated recovery" : null;
  const back = monthStart(inv.next_delivery ?? inv.estimated_recovery);
  if (!label || !back) return null;
  const runsOut = new Date(Date.now() + c.item.days_of_cover * 86_400_000);
  const gapDays = Math.max(0, Math.round((back.getTime() - runsOut.getTime()) / 86_400_000));
  return { runs_out: fmt(runsOut), next_supply: (inv.next_delivery ?? inv.estimated_recovery)!, next_supply_label: label, gap_days: gapDays, units_to_bridge: Math.ceil(gapDays * c.item.avg_daily_use) };
}

/** Numbers and month-year dates in the Writer's text must appear in what the line rests on. */
function unsupportedTokens(text: string, corpus: string): string[] {
  const hay = corpus.toLowerCase().replace(/,/g, "");
  const tokens = [
    ...[...text.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) => m[0]),
    ...[...text.toLowerCase().matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/g)].map((m) => m[0]),
  ];
  return [...new Set(tokens)].filter((t) => !hay.includes(t.toLowerCase().replace(/,/g, "")));
}

/** Turns approved findings into the buyer's order list. Actions, orders and numbers come from code; the model writes the words, and code checks them. */
export async function writeOrderList(cases: ItemCase[], ctx: AgentContext): Promise<OrderLine[]> {
  const ordered = ctx.memories.filter((m) => m.kind === "already_ordered" && m.subject);
  const base: OrderLine[] = cases.map((c) => {
    const inv = c.investigation;
    const sub = c.substitution;
    const blocked = c.status === "blocked";
    const supplyProblem = inv?.risk === "supply_risk" || inv?.risk === "recall";
    let action: OrderLine["action"] = blocked
      ? "watch"
      : sub?.recommendation === "switch" && sub.substitutes.length
        ? "order_substitute"
        : sub?.recommendation === "split" && sub.substitutes.length
          ? "add_second_supplier"
          : supplyProblem && (c.item.days_of_cover ?? 99) < 14
            ? "escalate"
            : inv?.risk === "low_stock_only"
              ? "expedite_or_reorder"
              : supplyProblem
                ? "watch"
                : "no_action";
    const memoryApplied = [...(c.memory_applied ?? [])];
    // "Already ordered" is a buyer decision: no new reorder advice for that drug until the buyer clears it.
    const orderedRule = ordered.find((m) => m.subject!.toLowerCase().includes(c.item.generic_name.toLowerCase().split(" ")[0]!));
    if (orderedRule && (action === "expedite_or_reorder" || action === "watch" || action === "no_action")) {
      action = "already_ordered";
      memoryApplied.push(orderedRule.content.replace(/^Buyer decision: /, ""));
    }
    const ownShortIds = ctx.store.all().filter((e) => e.source === "fda-shortage" && (e.data.match === "same_package" || e.data.match === "same_product") && String(e.data.package_ndc ?? "").startsWith(c.item.product_ndc)).map((e) => e.id);
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
        ? (sub?.substitutes ?? []).map((s) => ({ supplier: s.applicant, application: s.application, packages: s.packages, notes: s.notes }))
        : [],
      open_orders: c.item.open_orders.map((o) => `${o.po_id}: ${o.ordered_units} units from ${o.wholesaler}, ${o.status}, expected ${o.expected_on ?? "unknown"}`),
      gap: supplyProblem ? gapFor(c) : null,
      dea_schedule: c.facts?.ownPackage?.dea_schedule ?? null,
      market_note: inv && inv.market_constrained ? `${inv.market_constrained} of ${inv.market_total} presentations from other makers are listed limited or unavailable.` : null,
      evidence_ids: [...new Set([
        `stock-${c.item.item_id}`,
        ...ownShortIds,
        ...(inv?.claims ?? []).flatMap((x) => x.evidence_ids),
        ...(sub?.claims ?? []).flatMap((x) => x.evidence_ids),
        ...(sub?.substitutes ?? []).flatMap((s) => s.evidence_ids),
        ...(ctx.store.has(`market-${c.item.item_id}`) ? [`market-${c.item.item_id}`] : []),
      ])].filter((id) => ctx.store.has(id)),
      confidence: Math.min(inv?.confidence ?? 0.5, sub?.confidence ?? 1),
      status: blocked ? "blocked" : "approved",
      blocked_reasons: blocked ? (c.critic?.reasons ?? []) : [],
      memory_applied: memoryApplied,
      writer_checked: false,
    };
  });

  const input = base.map((b) => {
    const c = cases.find((x) => x.item.item_id === b.item_id)!;
    return {
      item_id: b.item_id,
      drug: b.drug,
      days_of_cover: b.days_of_cover,
      action: b.action,
      approved_claims: [...(c.investigation?.claims ?? []), ...(c.substitution?.claims ?? [])].map((x) => x.text),
      substitutes: b.order.map((o) => o.supplier),
      stockout_gap: b.gap ? `runs out about ${b.gap.runs_out}; FDA ${b.gap.next_supply_label} ${b.gap.next_supply}; about ${b.gap.gap_days} days without supply; about ${b.gap.units_to_bridge} units to bridge` : null,
      buyer_rules_applied: b.memory_applied,
      blocked: b.status === "blocked",
    };
  });

  // Batches of five keep each call short (a reasoning model on twenty lines can run past the timeout).
  // A batch that still fails falls back to the approved claims for its lines; the run never stops here.
  const replies: WriterReply["lines"] = [];
  let receipt: Awaited<ReturnType<typeof chatJson<WriterReply>>>["receipt"] | undefined;
  const failedBatches: string[] = [];
  for (let i = 0; i < input.length; i += 5) {
    const batch = input.slice(i, i + 5);
    try {
      const r = await chatJson<WriterReply>(
        [
          { role: "system", content: SYSTEM_BASE },
          {
            role: "user",
            content: `You are the Writer. For each item, write a headline (max 12 words) and a "why" (max 2 sentences) for a pharmacy buyer, using ONLY the facts given for that item. Do not add facts, numbers or dates. Never mention claim numbers, evidence ids or the word "claim".
Rules: never say a product "is available" unless an approved claim says the FDA lists it as Available; otherwise say "not on the FDA shortage list". If stockout_gap is given, use it. If buyer_rules_applied is not empty, say the buyer's saved rule shaped the result. If the action is "escalate", say no interchangeable product can be recommended and the pharmacy team must decide, without inventing an alternative. If blocked, say the evidence did not hold up and it needs a manual check.
${JSON.stringify(batch, null, 1)}
Reply as {"lines":[{"item_id":number,"headline":string,"why":string}]}.`,
          },
        ],
        { tier: "deep", maxTokens: 3000 },
      );
      replies.push(...(r.value.lines ?? []));
      receipt = r.receipt;
    } catch (err) {
      failedBatches.push(`${batch.map((b) => b.drug.split(" ")[0]).join(", ")} (${err instanceof Error ? err.message.slice(0, 80) : "error"})`);
    }
  }
  const value: WriterReply = { lines: replies };
  if (failedBatches.length) {
    ctx.trace.log({ item_id: null, agent_name: "Writer", action: "writer_fallback", input_summary: `${failedBatches.length} batch(es) failed`, output_summary: `Used the approved claims as the text for: ${failedBatches.join("; ")}`, status: "needs_revision" });
  }

  // Code check on the Writer: every number and date it uses must appear in the line's own records and
  // facts. If not, its text is replaced by the approved claims themselves.
  const failures: string[] = [];
  for (const b of base) {
    const l = (value.lines ?? []).find((x) => Number(x.item_id) === b.item_id);
    const c = cases.find((x) => x.item.item_id === b.item_id)!;
    const clean = (t: string) => t.replace(/\s*\((?:claims?|evidence)[^)]*\)/gi, "").replace(/\s+([.,])/g, "$1").trim();
    const headline = clean(String(l?.headline || b.headline));
    const why = clean(String(l?.why ?? ""));
    const corpus = [
      b.drug, String(b.days_of_cover), ...b.evidence_ids.map((id) => ctx.store.get(id)?.summary ?? ""),
      ...(c.investigation?.claims ?? []).map((x) => x.text), ...(c.substitution?.claims ?? []).map((x) => x.text),
      b.gap ? `${b.gap.runs_out} ${b.gap.next_supply} ${b.gap.gap_days} ${b.gap.units_to_bridge}` : "", ...b.memory_applied,
    ].join(" \n ");
    const bad = l ? unsupportedTokens(`${headline} ${why}`, corpus) : ["no Writer reply"];
    if (bad.length) {
      failures.push(`${b.drug.split(" ")[0]}: ${bad.join(", ")}`);
      b.headline = c.investigation?.headline || b.drug;
      b.why = [...(c.investigation?.claims ?? []), ...(c.substitution?.claims ?? [])].slice(0, 2).map((x) => x.text).join(" ");
    } else {
      b.headline = headline;
      // "Available" is a specific FDA status. For substitutes that are merely absent from the shortage
      // list, say exactly that.
      const anyAvailable = b.order.some((o) => o.packages.some((p) => /^available$/i.test(p.fda_status)));
      b.why = b.order.length && !anyAvailable ? why.replace(/\b(are|is) available\b/gi, "$1 not on the FDA shortage list").replace(/\bavailable\b(?= (from|as))/gi, "not on the FDA shortage list") : why;
      b.writer_checked = true;
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
  ctx.trace.log({
    item_id: null,
    agent_name: "CodeGuard",
    action: "check_writer",
    input_summary: "every number and date in the Writer's text must appear in that line's records",
    output_summary: failures.length ? `Replaced the Writer's text with the approved claims for ${failures.length} line(s): ${failures.join("; ")}` : `All ${base.length} lines passed: no number or date outside the cited records`,
    status: failures.length ? "needs_revision" : "ok",
  });
  const rank: Record<OrderLine["action"], number> = { escalate: 0, order_substitute: 1, add_second_supplier: 2, expedite_or_reorder: 3, already_ordered: 4, watch: 5, no_action: 6 };
  return base.sort((a, b) => rank[a.action] - rank[b.action] || (a.days_of_cover ?? 999) - (b.days_of_cover ?? 999));
}
