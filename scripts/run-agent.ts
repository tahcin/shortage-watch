// Command-line run: npm run agent -- --items 8   (SAMPLE_MODE=true replays a recorded run, no credentials needed)

import { runShortageWatch } from "../src/orchestrator.js";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
};

const colour: Record<string, string> = { ok: "\x1b[32m", needs_revision: "\x1b[33m", blocked: "\x1b[31m", error: "\x1b[31m", info: "\x1b[36m" };

const result = await runShortageWatch({
  maxItems: Number(arg("items", "8")),
  refreshFda: process.argv.includes("--refresh-fda"),
  concurrency: Number(arg("concurrency", "2")),
  onTrace: (l) => {
    const model = l.model_routed ? ` \x1b[2m[${l.model_routed}${l.latency_ms ? `, ${(l.latency_ms / 1000).toFixed(1)}s` : ""}]\x1b[0m` : "";
    console.log(`${colour[l.status] ?? ""}${l.agent_name.padEnd(15)}\x1b[0m ${l.item_id !== null ? `#${l.item_id} ` : ""}${l.action}: ${l.output_summary.slice(0, 220)}${model}`);
  },
});

console.log(`\nOrder list (${result.mode} run ${result.run_id}):`);
for (const l of result.lines) {
  console.log(`\n- ${l.drug} | ${l.current_supplier} | ${l.days_of_cover ?? "?"} days | ${l.action.toUpperCase()}${l.status === "blocked" ? " (BLOCKED)" : ""}`);
  console.log(`  ${l.headline}`);
  if (l.why) console.log(`  ${l.why}`);
  for (const o of l.order) console.log(`  order: ${o.supplier} ${o.application} NDC ${o.ndcs.join(", ")}`);
  if (l.blocked_reasons.length) console.log(`  blocked: ${l.blocked_reasons.join(" | ").slice(0, 300)}`);
}
console.log(`\nTrace: ${result.trace_file}\nResult: ${result.result_file}`);
