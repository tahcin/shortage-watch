// Buyer memory on the Meterless H-MEM engine (vendored reference implementation, Apache-2.0).
//
// What it does for the user: a buyer's decisions ("never use Hikma", "already ordered 2 weeks of
// morphine") are stored once and change every later run. Before a run, H-MEM ranks the saved memories
// against each item and re-injects the relevant ones into the agents' context; the trace records why each
// memory was chosen. After a run, its recommendations are remembered too, so the next session knows what
// was already advised. Every write lands in the H-MEM trust ledger (append-only), which is the audit trail.

import path from "node:path";
import { HMEM, type MemoryRecord } from "../../vendor/meterless-hmem/src/index.ts";
import type { Memory } from "../agents/types.js";
import type { OrderLine } from "../agents/writer.js";
import { config } from "../config.js";
import type { Item } from "../tools/hospital.js";
import type { Trace } from "../trace.js";

export type DecisionKind = "avoid_supplier" | "prefer_supplier" | "already_ordered" | "note";

export type Decision = { kind: DecisionKind; subject: string; item?: string; note?: string };

function sentence(d: Decision): string {
  const forItem = d.item ? ` for ${d.item}` : "";
  switch (d.kind) {
    case "avoid_supplier": return `Buyer decision: never use ${d.subject}${forItem}.${d.note ? ` Reason: ${d.note}` : ""}`;
    case "prefer_supplier": return `Buyer decision: prefer ${d.subject}${forItem} when it is a safe equivalent.${d.note ? ` Reason: ${d.note}` : ""}`;
    case "already_ordered": return `Buyer decision: already ordered ${d.subject}${forItem}.${d.note ? ` ${d.note}` : ""}`;
    default: return `Buyer note${forItem}: ${d.subject}${d.note ? `. ${d.note}` : ""}`;
  }
}

const tag = (r: MemoryRecord, prefix: string) => r.tags.find((t) => t.startsWith(`${prefix}:`))?.slice(prefix.length + 1);

export class BuyerMemory {
  readonly hmem: HMEM;
  readonly dir: string;

  constructor(buyer = "default", dir?: string) {
    // Sample mode keeps its own memory, reset on every start, so a replay begins from the recorded state.
    this.dir = dir ?? (config.sampleMode ? path.join(config.root, "logs", "sample-memory", buyer) : path.join(config.root, "data", "memory", buyer));
    this.hmem = new HMEM({ persistDir: this.dir, actor: `buyer:${buyer}` });
  }

  /** Stores a buyer decision as a long-term preference with provenance. */
  remember(d: Decision, ref?: string): MemoryRecord {
    const rec = this.hmem.add({
      content: sentence(d),
      type: "preference",
      layer: "long_term",
      tags: [`kind:${d.kind}`, `subject:${d.subject}`, ...(d.item ? [`item:${d.item}`] : [])],
      confidence: 0.95,
      source: "buyer_decision",
      provenance: { origin: "user_correction", learnedAt: Date.now(), label: "Decision recorded by the buyer in Shortage Watch", ...(ref ? { refs: [ref] } : {}) },
    });
    this.hmem.store.persist();
    return rec;
  }

  /** The buyer takes a decision back. H-MEM deletes it and records the deletion in its trust ledger. */
  forget(memoryId: string): boolean {
    const id = memoryId.replace(/^memory-/, "");
    const rec = this.hmem.store.all().find((m) => m.id === id && m.source === "buyer_decision");
    if (!rec) return false;
    this.hmem.store.delete(id, "removed by the buyer in Shortage Watch");
    this.hmem.store.persist();
    return true;
  }

  /** Feedback from the buyer on a recommendation the agents made (helpful, not helpful, wrong). */
  feedback(memoryId: string, kind: "helpful" | "not_helpful" | "wrong"): void {
    this.hmem.feedback(memoryId, kind);
    this.hmem.store.persist();
  }

  all(): MemoryRecord[] {
    return this.hmem.store.all();
  }

  /** Current memories only: superseded run notes are kept for the audit trail but not shown. */
  current(): MemoryRecord[] {
    return this.hmem.store.all().filter((m) => !m.supersededBy);
  }

  /**
   * What the agents get before a run. Buyer decisions are few and binding, so every current one is
   * re-injected. Run notes are many, so H-MEM ranks them against each item and only the best current
   * note per drug is re-injected. The trace records why each memory was chosen.
   */
  recallForRun(items: Item[], trace?: Trace): Memory[] {
    const picked = new Map<string, Memory>();
    const toMemory = (m: MemoryRecord): Memory => ({
      id: `memory-${m.id}`,
      content: m.content,
      kind: (tag(m, "kind") as Memory["kind"]) ?? "note",
      subject: tag(m, "subject"),
    });
    for (const m of this.current().filter((r) => r.source === "buyer_decision")) {
      picked.set(m.id, toMemory(m));
      trace?.log({ item_id: null, agent_name: "Memory", action: "reinject_decision", input_summary: "binding buyer decision (H-MEM long-term layer)", output_summary: m.content, evidence_ids: [`memory-${m.id}`], status: "info" });
    }
    for (const i of items) {
      const q = `${i.generic_name} ${i.labeler} ${i.strength}`;
      const r = this.hmem.query(q, { topN: 5 });
      const best = r.memories.find((x) => x.memory.source.startsWith("run:") && !x.memory.supersededBy && x.memory.tags.includes(`item:${i.generic_name}`));
      if (!best || picked.has(best.memory.id)) continue;
      picked.set(best.memory.id, toMemory(best.memory));
      trace?.log({
        item_id: i.item_id,
        agent_name: "Memory",
        action: "reinject_memory",
        input_summary: `H-MEM query: "${q.slice(0, 80)}"`,
        output_summary: `${best.memory.content} (relevance ${best.relevance.toFixed(2)}, ${best.memory.layer} layer)`.slice(0, 400),
        evidence_ids: [`memory-${best.memory.id}`],
        status: "info",
      });
    }
    return [...picked.values()];
  }

  /** Remembers what this run recommended, in the working layer, so the next session has continuity. */
  rememberRun(runId: string, lines: OrderLine[]): void {
    for (const l of lines.filter((x) => ["check_recall", "order_substitute", "add_second_supplier", "escalate", "reorder_market_tight", "expedite_or_reorder"].includes(x.action))) {
      const itemTag = `item:${l.generic_name}`;
      // The newest note for a drug supersedes the older ones (H-MEM penalises superseded records in retrieval).
      const previous = this.hmem.store.all().filter((m) => m.source.startsWith("run:") && m.tags.includes(itemTag) && !m.supersededBy);
      const rec = this.hmem.add({
        content: `Last check advised ${l.action.replace(/_/g, " ")} for ${l.drug} (${l.days_of_cover} days of cover)${l.order.length ? `: ${l.order.map((o) => `${o.supplier} ${o.application}`).join(", ")}` : ""}.`,
        type: "factual",
        layer: "working",
        tags: ["kind:note", itemTag, `run:${runId}`],
        confidence: 0.8,
        source: `run:${runId}`,
        provenance: { origin: "plan_completion", learnedAt: Date.now(), label: "Shortage Watch run outcome", refs: [runId] },
        ...(previous.length ? { supersedes: previous[previous.length - 1]!.id } : {}),
      });
      for (const p of previous) this.hmem.store.update(p.id, { supersededBy: rec.id });
    }
    this.hmem.store.persist();
  }
}
