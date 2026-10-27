import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// Sample mode: a live run with RECORD_SAMPLE=true saves every Zetaris result and model reply under
// samples/<scenario>/, keyed by a hash of the request. SAMPLE_MODE=true replays them, so a judge can run
// the whole agent loop with no credentials. Nothing secret is ever written: only SQL text, rows and replies.

const recording = (process.env.RECORD_SAMPLE ?? "").toLowerCase() === "true";
/**
 * Fill mode (SAMPLE_MODE=true with SAMPLE_FILL=true and RECORD_SAMPLE=true): replay what was recorded and
 * make only the missing MODEL calls live, recording them. Zetaris results are never invented: a Zetaris
 * request that was not recorded still fails. Used to complete a recording when the Zetaris host is offline.
 */
export const sampleFill = (process.env.SAMPLE_FILL ?? "").toLowerCase() === "true";

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

export const sampleState = { recording, fill: sampleFill };

/** A recorded answer, or undefined when there is none (no pause; for fill mode). */
export function recorded<T>(key: string): T | undefined {
  const file = fileFor(key);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { value: T }).value : undefined;
}

let runCount = 0;

/**
 * The "as of" time for a run: when it started. Day counts (when stock runs out, the stockout gap) are
 * computed from it, so a replay on another day gives the same answers as the recorded run.
 */
export async function runClock(): Promise<number> {
  const key = `clock:run-${++runCount}`;
  if (config.sampleMode && sampleFill && recorded<number>(key) === undefined) {
    // A run completed in fill mode is dated 30 minutes after the recorded run before it, so its day
    // counts match the recorded data rather than today's date.
    const previous = recorded<number>(`clock:run-${runCount - 1}`);
    const asOf = previous !== undefined ? previous + 30 * 60_000 : Date.now();
    await record(key, asOf);
    return asOf;
  }
  if (config.sampleMode) return replay<number>(key);
  const now = Date.now();
  await record(key, now);
  return now;
}

/**
 * How many items the run may check. A run completed in fill mode is limited to the items whose Zetaris
 * results were recorded, and that limit is recorded too, so a replay asks Zetaris for exactly the same.
 */
export async function runItemLimit(requested: number): Promise<number> {
  const key = `items:run-${runCount}`;
  if (config.sampleMode) {
    const pinned = recorded<number>(key);
    if (pinned !== undefined) return pinned;
    if (!sampleFill) return requested;
  }
  await record(key, requested);
  return requested;
}

/** Which run this is (1 for the first run since the server started). */
export const currentRun = () => runCount;

