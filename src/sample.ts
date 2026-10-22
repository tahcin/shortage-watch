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

export function replay<T>(key: string): T {
  const file = fileFor(key);
  if (!existsSync(file)) {
    throw new Error(`Sample mode: no recorded answer for this request (${key.slice(0, 120)}...). Record the scenario with RECORD_SAMPLE=true first.`);
  }
  return (JSON.parse(readFileSync(file, "utf8")) as { value: T }).value;
}

export const sampleState = { recording };
