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
import { runClock, runItemLimit } from "./sample.js";
import { Trace } from "./trace.js";
import { BOARD_SQL, riskBoard } from "./tools/board.js";
import { coverTable } from "./tools/hospital.js";
import { ensureFdaSnapshots } from "./tools/snapshot.js";

export type RunOptions = { refreshFda?: boolean; maxItems?: number; concurrency?: number; memory?: BuyerMemory | null; onTrace?: Parameters<Trace["onLine"]>[0] };
export type RunResult = { run_id: string; mode: "live" | "sample"; provider: string; started_at: string; finished_at: string; as_of: string; must_check: number; checked: number; board_ms: number; lines: OrderLine[]; trace_file: string; result_file: string; evidence_count: number };

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
  const ctx: AgentContext = { store, trace, memories: [], asOf: await runClock() };
  const started = new Date().toISOString();

  const provider = config.llm.provider === "meterless" ? "Meterless Nightshift" : "NVIDIA API (fallback)";
  trace.log({ item_id: null, agent_name: "Orchestrator", action: "start_run", input_summary: "weekly shortage check", output_summary: config.sampleMode ? "Sample mode: replaying recorded Zetaris results and model replies" : `Live: Zetaris at ${config.zetaris.restUrl}, models via ${provider}`, status: "info" });

  await ensureFdaSnapshots(trace, { force: opts.refreshFda });
  const cover = await coverTable();
  store.addAll(cover.evidence);
  trace.log({ item_id: null, agent_name: "Orchestrator", action: "load_hospital_stock", input_summary: "hospital_pg.formulary + days_of_cover + purchase_orders via Zetaris", output_summary: `${cover.items.length} items; ${cover.items.filter((i) => (i.days_of_cover ?? 99) < 14).length} under 14 days of cover`, evidence_ids: cover.evidence.map((e) => e.id), status: "ok" });

  // One federated Zetaris query across four sources: the Planner works from this.
  const board = await riskBoard();
  store.addAll(board.evidence);
  trace.log({ item_id: null, agent_name: "Orchestrator", action: "risk_board", input_summary: "one Zetaris SQL statement joining hospital_pg (Postgres), FDA shortage and recall snapshots (Parquet) and the FDA Orange Book (CSV file)", output_summary: `${board.rows.length} items in ${board.ms} ms; our own package short on FDA data: ${board.rows.filter((b) => b.fda_status && !/^available$/i.test(b.fda_status)).map((b) => b.generic_name).join(", ") || "none"}; under an ongoing recall: ${board.rows.filter((b) => b.recall_number).map((b) => b.generic_name).join(", ") || "none"}`, evidence_ids: board.evidence.map((e) => e.id), status: "ok", sql: BOARD_SQL });

  if (memory) {
    ctx.memories = memory.recallForRun(cover.items, trace);
    for (const m of ctx.memories) store.add({ id: m.id, source: "memory", summary: `Saved in H-MEM: ${m.content}`, data: { kind: m.kind, subject: m.subject } });
    trace.log({ item_id: null, agent_name: "Memory", action: "load_buyer_memory", input_summary: `H-MEM store ${memory.dir.replace(config.root, ".")}`, output_summary: `${ctx.memories.filter((m) => m.kind && m.kind !== "note").length} buyer decision(s) and ${ctx.memories.filter((m) => !m.kind || m.kind === "note").length} note(s) from earlier runs re-injected into the agents' context (${ctx.memories.filter((m) => m.kind === "avoid_supplier").length} supplier exclusion(s) enforced in code and by the critic)`, evidence_ids: ctx.memories.map((m) => m.id), status: "info" });
  }

  const { planned, mustCheck } = await plan(cover.items, board.rows, ctx, await runItemLimit(opts.maxItems ?? 20));
  const cases: ItemCase[] = planned.map((c) => ({ item: c.item, retries: 0, status: "pending" }));

  const work = async (c: ItemCase) => {
    // A provider failure on one item is retried once from the start before the item is reported as failed.
    for (let attempt = 1; ; attempt++) {
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
        return;
      } catch (err) {
        if (attempt < 2) {
          trace.log({ item_id: c.item.item_id, agent_name: "Orchestrator", action: "step_retry", input_summary: c.item.generic_name, output_summary: `Retrying this item from the start after: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`, status: "needs_revision" });
          Object.assign(c, { retries: 0, status: "pending", investigation: undefined, facts: undefined, substitution: undefined, critic: undefined });
          await new Promise((r) => setTimeout(r, 20_000));
          continue;
        }
        c.status = "blocked";
        c.critic = { verdict: "block", target_agent: null, reasons: [`Step failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)], blocked_claims: [] };
        trace.log({ item_id: c.item.item_id, agent_name: "Orchestrator", action: "step_failed", input_summary: c.item.generic_name, output_summary: c.critic.reasons[0]!, status: "error" });
        return;
      }
    }
  };

  // Small concurrency: NVIDIA's free endpoints allow about 40 requests a minute.
  const queue = [...cases];
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 3) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) await work(c);
  });
  await Promise.all(workers);

  const lines = await writeOrderList(cases, ctx);
  if (memory) {
    memory.rememberRun(runId, lines);
    trace.log({ item_id: null, agent_name: "Memory", action: "remember_run", input_summary: `${lines.length} order lines`, output_summary: "Stored this run's recommendations in H-MEM (working layer) for the next session", status: "info" });
  }
  const finished = new Date().toISOString();
  const result: RunResult = { run_id: runId, mode: config.sampleMode ? "sample" : "live", provider, started_at: started, finished_at: finished, as_of: new Date(ctx.asOf ?? Date.now()).toISOString(), must_check: mustCheck, checked: cases.length, board_ms: board.ms, lines, trace_file: trace.file, result_file: "", evidence_count: store.all().length };
  result.result_file = trace.writeResult({ ...result, evidence: store.all() });
  trace.log({ item_id: null, agent_name: "Orchestrator", action: "finish_run", input_summary: `${cases.length} items`, output_summary: `${lines.length} drugs checked: ${lines.filter((l) => l.action === "escalate").length} to escalate, ${lines.filter((l) => l.action === "order_substitute" || l.action === "add_second_supplier").length} with a substitute to order, ${lines.filter((l) => l.action === "expedite_or_reorder").length} to reorder, ${lines.filter((l) => l.status === "blocked").length} blocked; ${store.all().length} evidence records`, status: "info" });
  return result;
}
