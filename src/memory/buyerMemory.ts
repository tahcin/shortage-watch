// Buyer memory on the Meterless H-MEM engine (vendored reference implementation, Apache-2.0).
//
// What it does for the user: a buyer's decisions ("never switch to Hikma", "already ordered 2 weeks of
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
    case "avoid_supplier": return `Buyer decision: never switch to ${d.subject}${forItem}.${d.note ? ` Reason: ${d.note}` : ""}`;
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
    this.dir = dir ?? path.join(config.root, "data", "memory", buyer);
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

  /** Feedback from the buyer on a recommendation the agents made (helpful, not helpful, wrong). */
  feedback(memoryId: string, kind: "helpful" | "not_helpful" | "wrong"): void {
    this.hmem.feedback(memoryId, kind);
    this.hmem.store.persist();
  }

  all(): MemoryRecord[] {
    return this.hmem.store.all();
  }

  /** Ranked retrieval for this run's items; returns the memories to re-inject, with the reason each was picked. */
  recallForRun(items: Item[], trace?: Trace): Memory[] {
    const picked = new Map<string, Memory>();
    const queries = [
      "buyer decisions about suppliers and substitutes",
      ...items.map((i) => `${i.generic_name} ${i.labeler} ${i.strength} substitute order`),
    ];
    for (const q of queries) {
      const r = this.hmem.query(q, { topN: 5 });
      for (const m of r.memories) {
        if (picked.has(m.memory.id)) continue;
        picked.set(m.memory.id, {
          id: `memory-${m.memory.id}`,
          content: m.memory.content,
          kind: (tag(m.memory, "kind") as Memory["kind"]) ?? "note",
          subject: tag(m.memory, "subject"),
        });
        trace?.log({
          item_id: null,
          agent_name: "Memory",
          action: "reinject_memory",
          input_summary: `H-MEM query: "${q.slice(0, 80)}"`,
          output_summary: `${m.memory.content} (relevance ${m.relevance.toFixed(2)}, ${m.memory.layer}, ${r.trace.retrievalReason})`.slice(0, 400),
          evidence_ids: [`memory-${m.memory.id}`],
          status: "info",
        });
      }
    }
    return [...picked.values()];
  }

  /** Remembers what this run recommended, in the working layer, so the next session has continuity. */
  rememberRun(runId: string, lines: OrderLine[]): void {
    for (const l of lines.filter((x) => x.action === "order_substitute" || x.action === "add_second_supplier" || x.action === "expedite_or_reorder")) {
      this.hmem.add({
        content: `Run ${runId.slice(0, 15)} advised ${l.action.replace(/_/g, " ")} for ${l.drug} (${l.days_of_cover} days of cover)${l.order.length ? `: ${l.order.map((o) => `${o.supplier} ${o.application}`).join(", ")}` : ""}.`,
        type: "factual",
        layer: "working",
        tags: ["kind:note", `item:${l.drug.split(" ")[0]}`, `run:${runId}`],
        confidence: 0.8,
        source: `run:${runId}`,
        provenance: { origin: "plan_completion", learnedAt: Date.now(), label: "Shortage Watch run outcome", refs: [runId] },
      });
    }
    this.hmem.store.persist();
  }
}
