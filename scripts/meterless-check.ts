// Checks the Meterless Runtime connection the way the provider contract defines it, then sends one
// plain request and prints the receipt that names the model which answered.

import { config } from "../src/config.js";
import { autoDetect, chat, normaliseBaseUrl, runtimeStatus } from "../src/llm/meterless.js";

const base = normaliseBaseUrl(config.llm.meterlessBaseUrl);
const s = await runtimeStatus(base, config.llm.meterlessToken);
console.log(`Runtime ${base}: ${s.status}`);
console.log(`Routing modes: ${s.models.filter((m) => m.startsWith("meterless/")).join(", ")}`);
console.log(`NVIDIA models visible: ${s.models.filter((m) => m.startsWith("nvidia/")).join(", ") || "none"}`);
const wrong = await runtimeStatus(base, "wrong-token");
console.log(`With a wrong token: ${wrong.status} (expected: unauthorized)`);
console.log(`Auto-detect: ${JSON.stringify(await autoDetect(config.llm.meterlessToken))}`);
for (const tier of ["fast", "deep"] as const) {
  const r = await chat([{ role: "user", content: "Reply with one sentence confirming this connection works." }], { tier, maxTokens: 400 });
  console.log(`\n${tier} (${r.receipt.model_requested}) -> routed to ${r.receipt.model_routed} in ${r.receipt.latency_ms} ms, receipt ${r.receipt.receipt_id}`);
  console.log(r.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(-300));
}
