// FDA snapshots inside Zetaris. The openFDA REST tables are live, but every query against them makes
// Zetaris call openFDA again (seconds per query, and openFDA allows 1,000 calls a day without a key).
// So each run starts by materialising the live views into Parquet in Zetaris platform storage
// (CREATE LIGHTNING FILESTORE TABLE ... sourceTable), then the agents query the snapshot in milliseconds.
// A snapshot younger than MAX_AGE_HOURS is reused; its capture time is recorded in the trace.

import type { Trace } from "../trace.js";
import { query, runSql } from "../zetaris/client.js";

const MAX_AGE_HOURS = 6;
const ROOT = "file:///home/zetaris/customer-data/shared/snapshots";

export const SNAPSHOTS = {
  shortages: { table: "shortages_snap", source: "fda.shortages_current_v" },
  recalls: { table: "recalls_snap", source: "fda.recalls_ongoing_v" },
} as const;

export const SHORTAGES = `fda_files.${SNAPSHOTS.shortages.table}`;
export const RECALLS = `fda_files.${SNAPSHOTS.recalls.table}`;

type Listed = { name: string; source_table: string };

/** Capture time encoded in the snapshot path (…/<table>/<yyyymmddhhmm>). */
function capturedAt(path: string): Date | null {
  const m = path.match(/\/(\d{12})$/);
  if (!m) return null;
  const s = m[1]!;
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
}

export async function ensureFdaSnapshots(trace: Trace, opts: { force?: boolean } = {}): Promise<Record<string, { captured: string; rows: number; refreshed: boolean }>> {
  const { rows: listed } = await query<Listed>("SHOW LIGHTNING TABLES FDA_FILES");
  const out: Record<string, { captured: string; rows: number; refreshed: boolean }> = {};
  for (const [key, snap] of Object.entries(SNAPSHOTS)) {
    const existing = listed.find((t) => t.name === snap.table);
    const when = existing ? capturedAt(existing.source_table) : null;
    const fresh = when && Date.now() - when.getTime() < MAX_AGE_HOURS * 3_600_000;
    let refreshed = false;
    let captured = when;
    if (!fresh || opts.force) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
      if (existing) await runSql(`DROP LIGHTNING DATABASE TABLE FDA_FILES.${snap.table}`);
      const sql = `CREATE LIGHTNING FILESTORE TABLE ${snap.table} FROM FDA_FILES FORMAT PARQUET OPTIONS (
  path "${ROOT}/${snap.table}/${stamp}",
  sourceTable "${snap.source}"
)`;
      await runSql(sql);
      refreshed = true;
      captured = capturedAt(`/${stamp}`);
      trace.log({ item_id: null, agent_name: "SourceScout", action: "snapshot_fda_source", input_summary: `live openFDA view ${snap.source}`, output_summary: `Materialised into Zetaris platform storage as fda_files.${snap.table} (Parquet)`, status: "ok", sql });
    }
    const { rows } = await query<{ n: string }>(`SELECT count(*) AS n FROM fda_files.${snap.table}`);
    out[key] = { captured: captured?.toISOString() ?? "unknown", rows: Number(rows[0]?.n ?? 0), refreshed };
  }
  trace.log({
    item_id: null,
    agent_name: "SourceScout",
    action: "fda_snapshot_status",
    input_summary: `snapshots reused when under ${MAX_AGE_HOURS} hours old`,
    output_summary: Object.entries(out).map(([k, v]) => `${k}: ${v.rows} rows captured ${v.captured}${v.refreshed ? " (refreshed now)" : " (reused)"}`).join("; "),
    status: "info",
  });
  return out;
}
