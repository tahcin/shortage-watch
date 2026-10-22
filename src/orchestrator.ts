import { randomUUID } from "node:crypto";
import { review } from "./agents/critic.js";
import { investigate } from "./agents/investigator.js";
import { plan } from "./agents/planner.js";
import { gatherSubstituteFacts, proposeSubstitutes } from "./agents/substitution.js";
import type { AgentContext, ItemCase } from "./agents/types.js";
import { writeOrderList, type OrderLine } from "./agents/writer.js";
import { config } from "./config.js";
import { EvidenceStore } from "./evidence.js";
import { BuyerMemory } from "./memory/buyerMemory.js";
import { Trace } from "./trace.js";
import { coverTable } from "./tools/hospital.js";
import { ensureFdaSnapshots } from "./tools/snapshot.js";

export type RunOptions = { refreshFda?: boolean; maxItems?: number; concurrency?: number; memory?: BuyerMemory | null; onTrace?: Parameters<Trace["onLine"]>[0] };
export type RunResult = { run_id: string; mode: "live" | "sample"; started_at: string; finished_at: string; lines: OrderLine[]; trace_file: string; result_file: string; evidence_count: number };

/**
 * One full run. Not a fixed chain: per item, the Evidence Critic can send work back to the Investigator
 * or the Substitution agent with reasons (up to two retries), or block claims that never hold up.
 */
export async function runShortageWatch(opts: RunOptions = {}): Promise<RunResult> {
  const runId = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 6)}`;
  const trace = new Trace(runId);
  if (opts.onTrace) trace.onLine(opts.onTrace);
  const store = new EvidenceStore();
  const memory = opts.memory === undefined ? new BuyerMemory() : opts.memory;
  const ctx: AgentContext = { store, trace, memories: [] };
  const started = new Date().toISOString();

  trace.log({ item_id: null, agent_name: "Orchestrator", action: "start_run", input_summary: `max ${opts.maxItems ?? 8} items, ${ctx.memories.length} saved buyer decisions loaded`, output_summary: config.sampleMode ? "Sample mode: replaying recorded Zetaris results and model replies" : `Live: Zetaris at ${config.zetaris.restUrl}, models via ${config.llm.provider === "meterless" ? "Meterless Nightshift" : "NVIDIA API (fallback)"}`, status: "info" });

  await ensureFdaSnapshots(trace, { force: opts.refreshFda });
  const cover = await coverTable();
  store.addAll(cover.evidence);
  trace.log({ item_id: null, agent_name: "Orchestrator", action: "load_hospital_stock", input_summary: "hospital_pg.formulary + days_of_cover + purchase_orders via Zetaris", output_summary: `${cover.items.length} items; ${cover.items.filter((i) => (i.days_of_cover ?? 99) < 14).length} under 14 days of cover`, evidence_ids: cover.evidence.map((e) => e.id), status: "ok" });

  if (memory) {
    ctx.memories = memory.recallForRun(cover.items, trace);
    for (const m of ctx.memories) store.add({ id: m.id, source: "hospital", summary: `Saved in H-MEM: ${m.content}`, data: { kind: m.kind, subject: m.subject } });
    trace.log({ item_id: null, agent_name: "Memory", action: "load_buyer_memory", input_summary: `H-MEM store ${memory.dir.replace(config.root, ".")}`, output_summary: `${ctx.memories.length} saved decisions re-injected into the agents' context (${ctx.memories.filter((m) => m.kind === "avoid_supplier").length} supplier exclusions enforced by the critic)`, evidence_ids: ctx.memories.map((m) => m.id), status: "info" });
  }

  const chosen = await plan(cover.items, ctx, opts.maxItems ?? 8);
  const cases: ItemCase[] = chosen.map((c) => ({ item: c.item, retries: 0, status: "pending" }));

  const work = async (c: ItemCase) => {
    try {
      c.investigation = await investigate(c, ctx);
      if (c.investigation.needs_substitute) {
        c.facts = await gatherSubstituteFacts(c, ctx);
        c.substitution = await proposeSubstitutes(c, ctx);
      }
      for (;;) {
        c.critic = await review(c, ctx);
        if (c.critic.verdict === "approve") { c.status = "approved"; break; }
        if (c.critic.verdict === "block") { c.status = "blocked"; break; }
        c.retries++;
        if (c.critic.target_agent === "investigator") {
          c.investigation = await investigate(c, ctx, c.critic.reasons);
          if (c.investigation.needs_substitute) {
            c.facts ??= await gatherSubstituteFacts(c, ctx);
            c.substitution = await proposeSubstitutes(c, ctx);
          } else {
            c.substitution = undefined;
          }
        } else {
          c.substitution = await proposeSubstitutes(c, ctx, c.critic.reasons);
        }
      }
    } catch (err) {
      c.status = "blocked";
      c.critic = { verdict: "block", target_agent: null, reasons: [`Step failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)], blocked_claims: [] };
      trace.log({ item_id: c.item.item_id, agent_name: "Orchestrator", action: "step_failed", input_summary: c.item.generic_name, output_summary: c.critic.reasons[0]!, status: "error" });
    }
  };

  // Small concurrency: NVIDIA's free endpoints allow about 40 requests a minute.
  const queue = [...cases];
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) await work(c);
  });
  await Promise.all(workers);

  const lines = await writeOrderList(cases, ctx);
  if (memory && !config.sampleMode) {
    memory.rememberRun(runId, lines);
    trace.log({ item_id: null, agent_name: "Memory", action: "remember_run", input_summary: `${lines.length} order lines`, output_summary: "Stored this run's recommendations in H-MEM (working layer) for the next session", status: "info" });
  }
  const finished = new Date().toISOString();
  const result: RunResult = { run_id: runId, mode: config.sampleMode ? "sample" : "live", started_at: started, finished_at: finished, lines, trace_file: trace.file, result_file: "", evidence_count: store.all().length };
  result.result_file = trace.writeResult({ ...result, evidence: store.all() });
  trace.log({ item_id: null, agent_name: "Orchestrator", action: "finish_run", input_summary: `${cases.length} items`, output_summary: `${lines.filter((l) => l.action === "order_substitute" || l.action === "add_second_supplier").length} substitute orders, ${lines.filter((l) => l.status === "blocked").length} blocked; ${store.all().length} evidence records`, status: "info" });
  return result;
}
