// Meterless Runtime as an OpenAI-compatible provider (Meterless Runtime 1.4, provider contract v4,
// from meterless.ai/engines.html "POWER: Add Meterless as a provider"). Meterless Nightshift is this
// app's primary AI provider: every model call in the demo goes through it, and its receipt records which
// model (NVIDIA Nemotron lanes) actually answered.

import { config } from "../config.js";
import { record, replay } from "../sample.js";

export const METERLESS_APP_ID = "shortage-watch";
const PLACEHOLDER_TOKEN = "rt-local";
const TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 5;

// At most LLM_MAX_INFLIGHT model calls at once across all agents, so a run stays inside NVIDIA's
// free-tier rate limit (Nightshift may race a request across lanes, which doubles upstream calls).
const MAX_INFLIGHT = Math.max(1, Number(process.env.LLM_MAX_INFLIGHT ?? 2));
let inflight = 0;
const waiting: Array<() => void> = [];
async function acquireSlot(): Promise<() => void> {
  if (inflight >= MAX_INFLIGHT) await new Promise<void>((r) => waiting.push(r));
  inflight++;
  return () => {
    inflight--;
    waiting.shift()?.();
  };
}

/** Normalises a pasted Runtime URL to <scheme>://<host>/v1 (never /v1/v1). */
export function normaliseBaseUrl(input: string): string {
  let s = input.trim();
  if (!s) return "http://127.0.0.1:8088/v1";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  return `${u.protocol}//${u.host}/v1`;
}

/** Parses a connect link http://<host>:<port>/connect#k=<key>. Never log the key. */
export function parseConnectLink(link: string): { baseUrl: string; token: string } | null {
  try {
    const u = new URL(link.trim());
    const k = new URLSearchParams(u.hash.replace(/^#/, "")).get("k");
    if (!k) return null;
    return { baseUrl: `${u.protocol}//${u.host}/v1`, token: k };
  } catch {
    return null;
  }
}

export type RuntimeStatus = "online" | "unauthorized" | "offline";

export async function runtimeStatus(baseUrl: string, token: string): Promise<{ status: RuntimeStatus; models: string[] }> {
  try {
    const res = await fetch(`${normaliseBaseUrl(baseUrl)}/models`, {
      headers: { Authorization: `Bearer ${token}`, "meterless-app": METERLESS_APP_ID },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { status: "unauthorized", models: [] };
    if (!res.ok) return { status: "offline", models: [] };
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (body.data ?? []).map((m) => m.id);
    return { status: models.some((m) => m.startsWith("meterless/")) ? "online" : "offline", models };
  } catch {
    return { status: "offline", models: [] };
  }
}

/** Tries the documented ports and hosts; returns the first online or unauthorized runtime. */
export async function autoDetect(token: string): Promise<{ baseUrl: string; status: RuntimeStatus } | null> {
  for (const port of [8088, 8090, 8787, 11434]) {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const baseUrl = `http://${host}:${port}/v1`;
      const { status } = await runtimeStatus(baseUrl, token);
      if (status !== "offline") return { baseUrl, status };
    }
  }
  return null;
}

export type Receipt = {
  provider: "meterless" | "nvidia" | "sample";
  model_requested: string;
  model_routed: string | null;
  receipt_id: string | null;
  latency_ms: number;
  /** Set when Nightshift could not finish the call and NVIDIA answered directly. */
  fallback_from?: string;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export class LlmError extends Error {}

/** One chat completion. Returns the text and a receipt naming the model that actually answered. */
export async function chat(messages: ChatMessage[], opts: { tier: "fast" | "deep"; maxTokens?: number }): Promise<{ text: string; receipt: Receipt }> {
  const key = `llm:${opts.tier}:${JSON.stringify(messages)}`;
  if (config.sampleMode) {
    const saved = await replay<{ text: string; receipt: Receipt }>(key);
    return { text: saved.text, receipt: { ...saved.receipt, provider: "sample" } };
  }

  const started = Date.now();
  const release = await acquireSlot();
  let out: { text: string; receipt: Receipt };
  try {
    if (config.llm.provider === "nvidia") {
      out = await callProvider("nvidia", messages, opts, started);
    } else {
      try {
        out = await callProvider("meterless", messages, opts, started);
      } catch (err) {
        // Nightshift always runs Nemotron with reasoning on and cuts an upstream call off after about
        // 90 seconds (499), or returns an empty reply. Those calls, and only those, go to NVIDIA directly
        // with reasoning off; the receipt says so.
        if (!(err instanceof NightshiftGaveUp) || !config.llm.nvidiaApiKey) throw err;
        out = await callProvider("nvidia", messages, opts, started);
        out.receipt.fallback_from = `meterless ${err.requestId ?? ""}: ${err.message}`.trim();
      }
    }
  } finally {
    release();
  }
  await record(key, out);
  return out;
}

/** Nightshift could not finish the call (its ~90 s upstream cut-off, or an empty reply after reasoning). */
class NightshiftGaveUp extends LlmError {
  constructor(message: string, readonly requestId: string | null) { super(message); }
}

async function callProvider(provider: "meterless" | "nvidia", messages: ChatMessage[], opts: { tier: "fast" | "deep"; maxTokens?: number }, started: number): Promise<{ text: string; receipt: Receipt }> {
  const useNvidia = provider === "nvidia";
  const model = useNvidia
    ? opts.tier === "fast" ? config.llm.nvidiaModelFast : config.llm.nvidiaModelDeep
    : opts.tier === "fast" ? config.llm.modelFast : config.llm.modelDeep;
  let url: string;
  let headers: Record<string, string>;
  if (useNvidia) {
    url = "https://integrate.api.nvidia.com/v1/chat/completions";
    headers = { Authorization: `Bearer ${config.llm.nvidiaApiKey}`, "Content-Type": "application/json" };
  } else {
    const token = config.llm.meterlessToken;
    if (!token || token === PLACEHOLDER_TOKEN) throw new LlmError("Meterless Runtime token missing: paste it from Nightshift > Console into METERLESS_RUNTIME_TOKEN.");
    url = `${normaliseBaseUrl(config.llm.meterlessBaseUrl)}/chat/completions`;
    headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "meterless-app": METERLESS_APP_ID,
      "meterless-scope": "user",
    };
  }

  // Provider hiccups are retried: 429 (rate limit, with a longer wait), 5xx, or an empty reply. On
  // Nightshift, an abort (499) or an empty reply is not retried: the same prompt hits the same limit.
  let res!: Response;
  let raw = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(url, {
      method: "POST",
      headers,
      // Nemotron reasons before answering. Fast steps switch reasoning off (NVIDIA honours
      // chat_template_kwargs; Meterless receives reasoning_effort); every step gets enough tokens for the
      // reasoning AND the answer, otherwise the reply comes back empty.
      body: JSON.stringify({
        model,
        messages,
        max_tokens: Math.max(opts.maxTokens ?? 0, opts.tier === "fast" ? 4000 : 8000),
        temperature: 0.2,
        ...(useNvidia ? { chat_template_kwargs: { enable_thinking: opts.tier === "deep" } } : { reasoning_effort: opts.tier === "fast" ? "low" : "medium" }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    raw = await res.text();
    const empty = /empty_response/i.test(raw) || (res.ok && !/"content"\s*:\s*"[^"]/.test(raw) && !/"content"\s*:\s*"\\/.test(raw));
    if (!useNvidia && (res.status === 499 || /request_aborted/i.test(raw) || empty)) {
      const id = raw.match(/"request_id"\s*:\s*"([^"]+)"/)?.[1] ?? null;
      throw new NightshiftGaveUp(res.status === 499 ? "upstream call cut off at about 90 s" : "empty reply", id);
    }
    const rateLimited = res.status === 429 || /\b429\b|Too Many Requests/i.test(raw);
    const transient = rateLimited || [500, 502, 503, 504].includes(res.status) || empty;
    if (!transient || attempt === MAX_ATTEMPTS) break;
    await new Promise((r) => setTimeout(r, (rateLimited ? 15_000 : 4_000) * attempt));
  }
  if (res.status === 401 || res.status === 403) throw new LlmError(`${useNvidia ? "NVIDIA" : "Meterless Runtime"} rejected the token (unauthorized).`);
  if (!res.ok) throw new LlmError(`Model call failed (${res.status}): ${raw.slice(0, 300)}`);
  // Nemotron replies can contain raw control characters, so parse leniently.
  const body = JSON.parse(raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    meterless?: { routed_model?: string; receipt_id?: string };
  };
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    receipt: {
      provider,
      model_requested: model,
      model_routed: body.meterless?.routed_model ?? body.model ?? null,
      receipt_id: body.meterless?.receipt_id ?? null,
      latency_ms: Date.now() - started,
    },
  };
}

/** Strips reasoning blocks and returns the last complete JSON object in a reply, or null. */
export function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "");
  const candidates: string[] = [];
  const fenced = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]!);
  candidates.push(...fenced.reverse());
  // Walk back from the last closing brace to find a balanced object.
  for (let end = cleaned.lastIndexOf("}"); end >= 0; end = cleaned.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      const ch = cleaned[i];
      if (ch === "}") depth++;
      else if (ch === "{") depth--;
      if (depth === 0) { candidates.push(cleaned.slice(i, end + 1)); break; }
    }
    if (candidates.length > fenced.length + 3) break;
  }
  for (const c of candidates) {
    try { return JSON.parse(c) as T; } catch { /* try the next candidate */ }
  }
  return null;
}

/** Chat that must return JSON: retries once with a stricter instruction, then fails loudly. */
export async function chatJson<T>(messages: ChatMessage[], opts: { tier: "fast" | "deep"; maxTokens?: number }): Promise<{ value: T; receipt: Receipt; raw: string }> {
  const first = await chat(messages, opts);
  const v1 = extractJson<T>(first.text);
  if (v1) return { value: v1, receipt: first.receipt, raw: first.text };
  const retry = await chat([...messages, { role: "assistant", content: first.text }, { role: "user", content: "Reply again with ONLY the JSON object, no other text." }], opts);
  const v2 = extractJson<T>(retry.text);
  if (v2) return { value: v2, receipt: retry.receipt, raw: retry.text };
  throw new LlmError(`Model did not return valid JSON after a retry. Last reply started: ${retry.text.slice(0, 200)}`);
}
