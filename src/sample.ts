import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// Sample mode: a live run with RECORD_SAMPLE=true saves every Zetaris result and model reply under
// samples/<scenario>/, keyed by a hash of the request. SAMPLE_MODE=true replays them, so a judge can run
// the whole agent loop with no credentials. Nothing secret is ever written: only SQL text, rows and replies.

const recording = (process.env.RECORD_SAMPLE ?? "").toLowerCase() === "true";

function fileFor(key: string): string {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return path.join(config.samplesDir, config.sampleScenario, `${id}.json`);
}

export async function record(key: string, value: unknown): Promise<void> {
  if (!recording) return;
  const file = fileFor(key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ key: key.slice(0, 400), value }, null, 1));
}

const PACE_MS = Number(process.env.SAMPLE_PACE_MS ?? 250);

/** Replays a recorded answer, with a short pause so the screen shows the agents working step by step. */
export async function replay<T>(key: string): Promise<T> {
  await new Promise((r) => setTimeout(r, key.startsWith("llm:") ? PACE_MS * 4 : PACE_MS));
  const file = fileFor(key);
  if (!existsSync(file)) {
    throw new Error(`Sample mode: no recorded answer for this request (${key.slice(0, 120)}...). Record the scenario with RECORD_SAMPLE=true first.`);
  }
  return (JSON.parse(readFileSync(file, "utf8")) as { value: T }).value;
}

export const sampleState = { recording };

let runCount = 0;

/**
 * The "as of" time for a run: when it started. Day counts (when stock runs out, the stockout gap) are
 * computed from it, so a replay on another day gives the same answers as the recorded run.
 */
export async function runClock(): Promise<number> {
  const key = `clock:run-${++runCount}`;
  if (config.sampleMode) return replay<number>(key);
  const now = Date.now();
  await record(key, now);
  return now;
}

