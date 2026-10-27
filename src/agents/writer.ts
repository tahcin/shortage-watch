import { chatJson } from "../llm/meterless.js";
import { drugLabel, supplierKey, supplierMatches } from "../tools/format.js";
import type { PurchaseOrder } from "../tools/hospital.js";
import { SYSTEM_BASE } from "./prompts.js";
import type { AgentContext, ItemCase, OrderPackage } from "./types.js";

export type Gap = {
  runs_out: string;
  next_supply: string;
  next_supply_label: "next delivery" | "estimated recovery";
  /** The FDA month has already ended: the date cannot be relied on. */
  next_supply_passed: boolean;
  gap_days: number | null;
  units_to_bridge: number | null;
  /** Units on open purchase orders due before supply returns (backordered and overdue orders are not counted). */
  incoming_units: number;
};

export type OrderLine = {
  item_id: number;
  drug: string;
  generic_name: string;
  current_supplier: string;
  /** Our own package, as the buyer knows it: NDC and presentation. */
  our_package: string;
  days_of_cover: number | null;
  risk: string;
  action: "check_recall" | "order_substitute" | "add_second_supplier" | "escalate" | "reorder_market_tight" | "expedite_or_reorder" | "already_ordered" | "watch" | "no_action";
  headline: string;
  why: string;
  order: Array<{ supplier: string; supplier_key: string; application: string; packages: OrderPackage[]; notes: string[]; to_bridge: string | null }>;
  open_orders: string[];
  gap: Gap | null;
  recall: { number: string; classification: string } | null;
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

const DAY = 86_400_000;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;

/** "January 2027" -> 31 Jan 2027: a buyer plans for the latest day the FDA month allows. */
function monthEnd(text: string | null): Date | null {
  const m = text?.toLowerCase().match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/);
  return m ? new Date(Date.UTC(Number(m[2]), MONTHS.indexOf(m[1]!) + 1, 0)) : null;
}

type PoState = "incoming" | "overdue" | "backordered" | "undated";
function poState(o: PurchaseOrder, today: number): PoState {
  if (/backorder/i.test(o.status)) return "backordered";
  if (!o.expected_on) return "undated";
  return Date.parse(o.expected_on) < today ? "overdue" : "incoming";
}

/**
 * The stockout gap, in code: when stock runs out counting open orders that are due in time, when the FDA
 * record says supply returns (end of that month), and how many units bridge the difference.
 */
export function gapFor(c: ItemCase, asOf: number): Gap | null {
  const inv = c.investigation;
  if (!inv || !(c.item.avg_daily_use > 0)) return null;
  const label = inv.next_delivery ? "next delivery" : inv.estimated_recovery ? "estimated recovery" : null;
  const nextSupply = inv.next_delivery ?? inv.estimated_recovery;
  const back = monthEnd(nextSupply);
  if (!label || !back || !nextSupply) return null;
  const today = dayStart(asOf);
  const incoming = c.item.open_orders.filter((o) => poState(o, today) === "incoming" && Date.parse(o.expected_on!) <= back.getTime()).reduce((n, o) => n + o.ordered_units, 0);
  const runsOut = today + ((c.item.on_hand_units + incoming) / c.item.avg_daily_use) * DAY;
  const passed = back.getTime() < today;
  const gapDays = passed ? null : Math.max(0, Math.round((back.getTime() - runsOut) / DAY));
  return {
    runs_out: fmt(new Date(runsOut)),
    next_supply: nextSupply,
    next_supply_label: label,
    next_supply_passed: passed,
    gap_days: gapDays,
    units_to_bridge: gapDays === null ? null : Math.ceil(gapDays * c.item.avg_daily_use),
    incoming_units: incoming,
  };
}

/** "PO-SAMPLE-006: 40 units from Cardinal, open, expected 2026-10-16 (overdue by 6 days)". */
function describePo(o: PurchaseOrder, today: number): string {
  const state = poState(o, today);
  const late = state === "overdue" ? ` (overdue by ${Math.round((today - Date.parse(o.expected_on!)) / DAY)} days: chase the wholesaler)` : state === "backordered" ? " (backordered: not counted as incoming)" : "";
  return `${o.po_id}: ${o.ordered_units} units from ${o.wholesaler}, ${o.status}, expected ${o.expected_on ?? "unknown"}${late}`;
}

const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", single: "1", both: "2" };

/** Numbers (also written as words) and month-year dates in the Writer's text must appear in what the line rests on. */
function unsupportedTokens(text: string, corpus: string): string[] {
  const hay = corpus.toLowerCase().replace(/,/g, "");
  const words = text.toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?=\s+(?:[a-z-]+\s+){0,2}(?:supplier|maker|manufacturer|substitute|option|product|application|package|equivalent|vial|presentation)s?\b)/g, (w) => NUMBER_WORDS[w] ?? w);
  const tokens = [
    ...[...words.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) => m[0]),
    ...[...words.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/g)].map((m) => m[0]),
  ];
  return [...new Set(tokens)].filter((t) => !hay.includes(t.toLowerCase().replace(/,/g, "")));
}

/** Text that contradicts the action code chose ("add a second supplier" on an escalate line, and so on). */
function contradictsAction(text: string, action: OrderLine["action"]): string | null {
  const t = text.toLowerCase();
  const says: Array<[RegExp, OrderLine["action"][]]> = [
    [/second supplier/, ["add_second_supplier"]],
    [/\b(switch to|order (a |the )?substitute|order .* instead)\b/, ["order_substitute"]],
    [/\bescalat/, ["escalate"]],
    [/\bquarantin|check (your |the )?lots?\b/, ["check_recall"]],
    [/\bno action\b|\bnothing to do\b/, ["no_action"]],
    [/\b(therapeutic equivalent|substitute|alternative) (does not|doesn.t) exist|\bno (therapeutic )?equivalent exists\b/, []],
  ];
  for (const [re, allowed] of says) if (re.test(t) && !allowed.includes(action)) return `"${t.match(re)![0]}" does not fit the action ${action}`;
  return null;
}

const ACTION_TEXT: Record<OrderLine["action"], string> = {
  check_recall: "check our lots against the recall and quarantine affected stock",
  order_substitute: "order the listed substitute instead",
  add_second_supplier: "keep the current supplier and add a second one",
  escalate: "escalate to the pharmacy team: the FDA Orange Book lists no interchangeable product that can be recommended",
  reorder_market_tight: "reorder now: most other makers' presentations are listed limited or unavailable",
  expedite_or_reorder: "reorder or expedite: low stock, no supply problem on our package",
  already_ordered: "already ordered by the buyer: watch only",
  watch: "watch",
  no_action: "no action needed",
};

/** Turns approved findings into the buyer's order list. Actions, orders and numbers come from code; the model writes the words, and code checks them. */
export async function writeOrderList(cases: ItemCase[], ctx: AgentContext): Promise<OrderLine[]> {
  const asOf = ctx.asOf ?? Date.now();
  const today = dayStart(asOf);
  const ordered = ctx.memories.filter((m) => m.kind === "already_ordered" && m.subject);
  const avoided = ctx.memories.filter((m) => m.kind === "avoid_supplier" && m.subject);
  const base: OrderLine[] = cases.map((c) => {
    const inv = c.investigation;
    const sub = c.substitution;
    const blocked = c.status === "blocked";
    const supplyProblem = inv?.risk === "supply_risk" || inv?.risk === "recall";
    const marketTight = !!inv && inv.market_total > 0 && inv.market_constrained / inv.market_total >= 0.5;
    const board = ctx.store.get(`board-${c.item.item_id}`)?.data as { recall_number?: string | null; recall_class?: string | null } | undefined;
    let action: OrderLine["action"] = blocked
      ? "watch"
      : inv?.risk === "recall"
        ? "check_recall"
        : sub?.recommendation === "switch" && sub.substitutes.length
          ? "order_substitute"
          : sub?.recommendation === "split" && sub.substitutes.length
            ? "add_second_supplier"
            : supplyProblem && (c.item.days_of_cover ?? 99) < 14
              ? "escalate"
              : inv?.risk === "low_stock_only"
                ? marketTight ? "reorder_market_tight" : "expedite_or_reorder"
                : supplyProblem
                  ? "watch"
                  : "no_action";
    const memoryApplied = [...(c.memory_applied ?? [])];
    // "Already ordered" is a buyer decision: no new reorder advice for that drug until the buyer clears it.
    const orderedRule = ordered.find((m) => m.subject!.trim().toLowerCase() === c.item.generic_name.trim().toLowerCase());
    if (orderedRule && (action === "expedite_or_reorder" || action === "reorder_market_tight" || action === "watch" || action === "no_action")) {
      action = "already_ordered";
      memoryApplied.push(orderedRule.content.replace(/^Buyer decision: /, ""));
    }
    const currentRuledOut = avoided.find((m) => supplierMatches(c.item.labeler, m.subject!));
    if (currentRuledOut) memoryApplied.push(`You ruled out ${currentRuledOut.subject}, which is the current supplier of this item: consider moving it.`);
    const own = c.facts?.ownPackage ?? null;
    const gap = supplyProblem ? gapFor(c, asOf) : null;
    const ownShortIds = ctx.store.all().filter((e) => e.source === "fda-shortage" && (e.data.match === "same_package" || e.data.match === "same_product") && String(e.data.package_ndc ?? "").startsWith(c.item.product_ndc)).map((e) => e.id);
    const showOrder = action === "order_substitute" || action === "add_second_supplier" || (action === "check_recall" && !!sub?.substitutes.length);
    return {
      item_id: c.item.item_id,
      drug: drugLabel(c.item),
      generic_name: c.item.generic_name,
      current_supplier: c.item.labeler,
      our_package: `NDC ${c.item.package_ndc}${own?.volume_ml != null ? `, ${own.volume_ml} mL ${String(own.container ?? "").toLowerCase()}` : ""}`,
      days_of_cover: c.item.days_of_cover,
      risk: inv?.risk ?? "unknown",
      action,
      headline: inv?.headline ?? "",
      why: "",
      order: showOrder
        ? (sub?.substitutes ?? []).map((s) => {
            const top = s.packages[0];
            const n = gap?.units_to_bridge && own?.volume_ml && top?.volume_ml ? Math.ceil((gap.units_to_bridge * own.volume_ml) / top.volume_ml) : null;
            return {
              supplier: s.applicant,
              supplier_key: supplierKey(s.applicant),
              application: s.application,
              packages: s.packages,
              notes: s.notes,
              to_bridge: n ? `About ${n.toLocaleString("en-US")} of NDC ${top!.ndc} (${top!.volume_ml} mL ${String(top!.container ?? "").toLowerCase()}) cover the gap${top!.volume_ml === own!.volume_ml ? "" : `: the same total volume as ${gap!.units_to_bridge!.toLocaleString("en-US")} of ours`}.` : null,
            };
          })
        : [],
      open_orders: c.item.open_orders.map((o) => describePo(o, today)),
      gap,
      recall: board?.recall_number ? { number: board.recall_number, classification: board.recall_class ?? "" } : null,
      dea_schedule: c.item.dea_schedule ?? own?.dea_schedule ?? null,
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
      action: ACTION_TEXT[b.action],
      approved_claims: [...(c.investigation?.claims ?? []), ...(c.substitution?.claims ?? [])].map((x) => x.text),
      substitutes: b.order.map((o) => o.supplier),
      stockout_gap: b.gap ? (b.gap.next_supply_passed ? `FDA ${b.gap.next_supply_label} ${b.gap.next_supply} has passed; confirm with the supplier` : `runs out about ${b.gap.runs_out}${b.gap.incoming_units ? ` counting ${b.gap.incoming_units} units on open orders` : ""}; FDA ${b.gap.next_supply_label} ${b.gap.next_supply}; about ${b.gap.gap_days} days without supply; about ${b.gap.units_to_bridge} units to bridge`) : null,
      recall: b.recall ? `${b.recall.number} (${b.recall.classification})` : null,
      market: b.action === "reorder_market_tight" ? b.market_note : null,
      buyer_rules_applied: b.memory_applied,
      blocked: b.status === "blocked",
    };
  });

  // One call per line keeps each call well inside Nightshift's ~90 s upstream limit (batches of five
  // with reasoning on ran past it). Calls run side by side, capped by the provider's in-flight limit.
  // A line whose call still fails falls back to its approved claims; the run never stops here.
  const replies: WriterReply["lines"] = [];
  const failedBatches: string[] = [];
  await Promise.all(input.map(async (line) => {
    const batch = [line];
    try {
      const r = await chatJson<WriterReply>(
        [
          { role: "system", content: SYSTEM_BASE },
          {
            role: "user",
            content: `You are the Writer. For each item, write a headline (max 12 words) saying what is happening to our supply, and a "why" (max 2 sentences) for a pharmacy buyer explaining why the action follows, using ONLY the facts given for that item. The screen already shows the action, so do not restate it in the headline, and never contradict it. Do not add facts, numbers or dates. Never mention claim numbers, evidence ids or the word "claim".
Rules: never say a product "is available" unless an approved claim says the FDA lists it as Available; otherwise say "not on the FDA shortage list". Never say an equivalent "does not exist": say what the FDA Orange Book lists. Count suppliers only from the substitutes list. If stockout_gap is given, use it. If recall is given, say which recall and that lots must be checked. If buyer_rules_applied is not empty, say the buyer's saved rule shaped the result. If blocked, say the evidence did not hold up and it needs a manual check.
${JSON.stringify(batch, null, 1)}
Reply as {"lines":[{"item_id":number,"headline":string,"why":string}]}.`,
          },
        ],
        { tier: "deep", maxTokens: 1500 },
      );
      replies.push(...(r.value.lines ?? []));
      ctx.trace.log({ item_id: line.item_id, agent_name: "Writer", action: "write_line", input_summary: `${line.drug}: ${line.approved_claims.length} approved claims`, output_summary: String(r.value.lines?.[0]?.headline ?? "").slice(0, 200), status: "ok" }, r.receipt);
    } catch (err) {
      failedBatches.push(`${line.drug.split(" ")[0]} (${err instanceof Error ? err.message.slice(0, 80) : "error"})`);
    }
  }));
  const value: WriterReply = { lines: replies };
  if (failedBatches.length) {
    ctx.trace.log({ item_id: null, agent_name: "Writer", action: "writer_fallback", input_summary: `${failedBatches.length} line(s) without a Writer reply`, output_summary: `Used the approved claims as the text for: ${failedBatches.join("; ")}`, status: "needs_revision" });
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
      b.gap ? `${b.gap.runs_out} ${b.gap.next_supply} ${b.gap.gap_days} ${b.gap.units_to_bridge} ${b.gap.incoming_units}` : "", ...b.memory_applied,
      b.recall ? `${b.recall.number} ${b.recall.classification}` : "", b.market_note ?? "", String(b.order.length),
    ].join(" \n ");
    const contradiction = l ? contradictsAction(`${headline} ${why}`, b.action) : null;
    const bad = l ? [...unsupportedTokens(`${headline} ${why}`, corpus), ...(contradiction ? [contradiction] : [])] : ["no Writer reply"];
    if (bad.length) {
      failures.push(`${b.drug.split(" ")[0]}: ${bad.join(", ")}`);
      b.headline = c.investigation?.headline || b.drug;
      b.why = [...(c.investigation?.claims ?? []), ...(c.substitution?.claims ?? [])].slice(0, 2).map((x) => x.text).join(" ");
    } else {
      b.headline = headline;
      // "Available" is a specific FDA status. For substitutes that are merely absent from the shortage
      // list, say exactly that.
      const anyAvailable = b.order.some((o) => o.packages.some((p) => /as available$/i.test(p.fda_status)));
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
  );
  ctx.trace.log({
    item_id: null,
    agent_name: "CodeGuard",
    action: "check_writer",
    input_summary: "every number and date in the Writer's text must appear in that line's records, and the text must not contradict the action",
    output_summary: failures.length ? `Replaced the Writer's text with the approved claims for ${failures.length} line(s): ${failures.join("; ")}` : `All ${base.length} lines passed: no number or date outside the cited records`,
    status: failures.length ? "needs_revision" : "ok",
  });
  const rank: Record<OrderLine["action"], number> = { escalate: 0, check_recall: 1, order_substitute: 2, add_second_supplier: 3, reorder_market_tight: 4, expedite_or_reorder: 5, already_ordered: 6, watch: 7, no_action: 8 };
  return base.sort((a, b) => rank[a.action] - rank[b.action] || (a.days_of_cover ?? 999) - (b.days_of_cover ?? 999));
}
