import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Receipt } from "./llm/meterless.js";

export type TraceLine = {
  timestamp: string;
  run_id: string;
  mode: "live" | "sample";
  item_id: number | null;
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent?: string;
  evidence_ids?: string[];
  verdict?: string;
  confidence?: number;
  retry_count?: number;
  status: "ok" | "needs_revision" | "blocked" | "error" | "info";
  model_requested?: string;
  model_routed?: string | null;
  receipt_id?: string | null;
  latency_ms?: number;
  provider?: string;
  fallback_from?: string;
  sql?: string;
};

type Listener = (line: TraceLine) => void;

export class Trace {
  readonly file: string;
  private readonly listeners: Listener[] = [];
  readonly lines: TraceLine[] = [];

  constructor(readonly runId: string) {
    mkdirSync(config.logsDir, { recursive: true });
    this.file = path.join(config.logsDir, `run-${runId}.jsonl`);
  }

  onLine(fn: Listener): void {
    this.listeners.push(fn);
  }

  log(line: Omit<TraceLine, "timestamp" | "run_id" | "mode">, receipt?: Receipt): TraceLine {
    const full: TraceLine = {
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      mode: config.sampleMode ? "sample" : "live",
      ...line,
      ...(receipt ? { model_requested: receipt.model_requested, model_routed: receipt.model_routed, receipt_id: receipt.receipt_id, latency_ms: receipt.latency_ms, provider: receipt.provider, ...(receipt.fallback_from ? { fallback_from: receipt.fallback_from } : {}) } : {}),
    };
    this.lines.push(full);
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    for (const fn of this.listeners) fn(full);
    return full;
  }

  writeResult(result: unknown): string {
    const file = path.join(config.logsDir, `run-${this.runId}.result.json`);
    writeFileSync(file, JSON.stringify(result, null, 2));
    return file;
  }
}
