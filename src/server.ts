// Web server for the Shortage Watch screen: starts runs, streams the agents' trace live (Server-Sent
// Events), and reads or writes the buyer's saved decisions in H-MEM.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { config } from "./config.js";
import { normaliseBaseUrl, runtimeStatus } from "./llm/meterless.js";
import { BuyerMemory, type Decision } from "./memory/buyerMemory.js";
import { runShortageWatch, type RunResult } from "./orchestrator.js";
import type { TraceLine } from "./trace.js";
import { query } from "./zetaris/client.js";

const app = Fastify({ logger: false });
if (config.sampleMode) rmSync(path.join(config.root, "logs", "sample-memory"), { recursive: true, force: true });
const memory = new BuyerMemory();

type LiveRun = { id: string | null; lines: TraceLine[]; result: RunResult | null; error: string | null; listeners: Set<(event: string, data: unknown) => void>; startedAt: string };
let current: LiveRun | null = null;

function broadcast(run: LiveRun, event: string, data: unknown) {
  for (const fn of run.listeners) fn(event, data);
}

app.get("/api/status", async () => {
  const llm = config.sampleMode
    ? { status: "sample", models: [] as string[] }
    : config.llm.provider === "nvidia"
      ? { status: "fallback", models: [config.llm.nvidiaModelFast, config.llm.nvidiaModelDeep] }
      : await runtimeStatus(config.llm.meterlessBaseUrl, config.llm.meterlessToken);
  let sources: Record<string, number> | null = null;
  if (!config.sampleMode) {
    try {
      const counts = await Promise.all([
        query<{ n: string }>("SELECT count(*) AS n FROM hospital_pg.formulary"),
        query<{ n: string }>("SELECT count(*) AS n FROM fda.orange_book_v"),
      ]);
      sources = { formulary: Number(counts[0].rows[0]?.n ?? 0), orange_book: Number(counts[1].rows[0]?.n ?? 0) };
    } catch {
      sources = null;
    }
  }
  return {
    mode: config.sampleMode ? "sample" : "live",
    zetaris: { url: config.zetaris.restUrl, reachable: config.sampleMode ? null : sources !== null, sources },
    llm: { provider: config.llm.provider, base_url: config.llm.provider === "meterless" ? normaliseBaseUrl(config.llm.meterlessBaseUrl) : "https://integrate.api.nvidia.com/v1", status: llm.status, nemotron: llm.models.filter((m) => m.startsWith("nvidia/")).slice(0, 6) },
    memory: { decisions: memory.all().filter((m) => m.source === "buyer_decision").length },
    running: current && !current.result && !current.error ? current.id : null,
  };
});

app.post<{ Body: { items?: number; refreshFda?: boolean } }>("/api/runs", async (req, reply) => {
  if (current && !current.result && !current.error) return reply.code(409).send({ error: "A run is already in progress", run_id: current.id });
  const run: LiveRun = { id: null, lines: [], result: null, error: null, listeners: new Set(), startedAt: new Date().toISOString() };
  current = run;
  runShortageWatch({
    maxItems: Math.min(Math.max(Number(req.body?.items ?? 20), 1), 30),
    refreshFda: !!req.body?.refreshFda,
    memory,
    onTrace: (line) => {
      run.id ??= line.run_id;
      run.lines.push(line);
      broadcast(run, "trace", line);
    },
  })
    .then((result) => { run.result = result; broadcast(run, "result", result); })
    .catch((err) => { run.error = err instanceof Error ? err.message : String(err); broadcast(run, "error", { message: run.error }); });
  return { started: true };
});

app.get("/api/runs/live", (req, reply) => {
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const run = current;
  if (!run) { send("idle", {}); reply.raw.end(); return; }
  for (const l of run.lines) send("trace", l);
  if (run.result) send("result", run.result);
  if (run.error) send("error", { message: run.error });
  run.listeners.add(send);
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
  req.raw.on("close", () => { clearInterval(ping); run.listeners.delete(send); });
});

/** The most recent finished run on disk (so the page has something to show before the first run). */
app.get("/api/runs/latest", async (_req, reply) => {
  if (current?.result) return { ...current.result, trace: current.lines };
  if (!existsSync(config.logsDir)) return reply.code(404).send({ error: "no runs yet" });
  const files = readdirSync(config.logsDir).filter((f) => f.endsWith(".result.json")).sort();
  const last = files.at(-1);
  if (!last) return reply.code(404).send({ error: "no runs yet" });
  const result = JSON.parse(readFileSync(path.join(config.logsDir, last), "utf8")) as RunResult & { evidence: unknown[] };
  const trace = readFileSync(result.trace_file.replace(/^.*\/logs\//, `${config.logsDir}/`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { ...result, trace };
});

app.get<{ Params: { runId: string } }>("/api/runs/:runId/evidence", async (req, reply) => {
  const file = path.join(config.logsDir, `run-${req.params.runId.replace(/[^\w-]/g, "")}.result.json`);
  if (!existsSync(file)) return reply.code(404).send({ error: "unknown run" });
  return (JSON.parse(readFileSync(file, "utf8")) as { evidence: unknown[] }).evidence;
});

app.get("/api/memory", async () => {
  return memory.current().map((m) => ({ id: m.id, content: m.content, layer: m.layer, source: m.source, confidence: m.confidence, tags: m.tags, created: new Date(m.timestamp).toISOString() }))
    .sort((a, b) => b.created.localeCompare(a.created));
});

app.post<{ Body: Decision }>("/api/memory", async (req, reply) => {
  const d = req.body;
  if (!d?.kind || !d?.subject) return reply.code(400).send({ error: "kind and subject are required" });
  const rec = memory.remember({ kind: d.kind, subject: String(d.subject).slice(0, 120), item: d.item ? String(d.item).slice(0, 80) : undefined, note: d.note ? String(d.note).slice(0, 300) : undefined });
  return { id: rec.id, content: rec.content };
});

const webDist = path.join(config.root, "web", "dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html")));
}

const port = Number(process.env.PORT ?? 5180);
await app.listen({ port, host: "127.0.0.1" });
console.log(`Shortage Watch on http://127.0.0.1:${port} (${config.sampleMode ? "sample" : "live"} mode)`);
