import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { replay, record } from "../sample.js";

export type SqlResult = { headers: string[]; rows: unknown[][]; total: number; ms: number };

export class ZetarisError extends Error {
  constructor(message: string, readonly sql: string, readonly status?: number) {
    super(message);
    this.name = "ZetarisError";
  }
}

// Network drops (the tunnel to the laptop reconnecting) and openFDA hiccups inside Zetaris are retried.
const TRANSIENT = /connection refused|timed out|timeout|connection reset|503|502|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed/i;

/** Runs ONE SQL statement on Zetaris over REST (POST /sql-editor/sqls/run). */
export async function runSql(sql: string, opts: { limit?: number; timeoutMs?: number } = {}): Promise<SqlResult> {
  const key = `zetaris:${sql}:${opts.limit ?? 1000}`;
  if (config.sampleMode) {
    const saved = await replay<SqlResult | { error: string; status?: number }>(key);
    if ("error" in saved) throw new ZetarisError(saved.error, sql, saved.status);
    return saved;
  }

  const limit = opts.limit ?? 1000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${config.zetaris.restUrl.replace(/\/$/, "")}/sql-editor/sqls/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.zetaris.apiKey}`,
          "X-Org-ID": config.zetaris.orgId,
          "X-Request-ID": randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try { msg = (JSON.parse(text) as { msg?: string }).msg ?? text; } catch { /* plain text body */ }
        const zerr = new ZetarisError(msg.split("\n")[0]!.slice(0, 500), sql, res.status);
        // Record definite answers ("already exists", bad SQL) so sample mode replays the same path.
        if (!TRANSIENT.test(zerr.message)) await record(key, { error: zerr.message, status: res.status });
        throw zerr;
      }
      const body = JSON.parse(text) as { headers?: string[]; data?: unknown[][]; total?: number; timeUsed?: number };
      const result: SqlResult = { headers: body.headers ?? [], rows: body.data ?? [], total: body.total ?? 0, ms: body.timeUsed ?? 0 };
      await record(key, result);
      return result;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < 5 && TRANSIENT.test(msg)) {
        await new Promise((r) => setTimeout(r, 2500 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export function rowsAsObjects<T = Record<string, unknown>>(r: SqlResult): T[] {
  return r.rows.map((row) => Object.fromEntries(r.headers.map((h, i) => [h, row[i]])) as T);
}

export async function query<T = Record<string, unknown>>(sql: string, limit = 1000): Promise<{ rows: T[]; ms: number }> {
  const r = await runSql(sql, { limit });
  return { rows: rowsAsObjects<T>(r), ms: r.ms };
}

/** Quotes a value for use inside a Zetaris (Spark SQL) string literal. */
export function lit(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
