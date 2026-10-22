// FDA snapshots inside Zetaris. The openFDA REST tables are live, but every query against them makes
// Zetaris call openFDA again (seconds per query, and openFDA allows 1,000 calls a day without a key).
// So each run starts by materialising the live views into Parquet in Zetaris platform storage
// (CREATE LIGHTNING FILESTORE TABLE ... sourceTable), then the agents query the snapshot in milliseconds.
// A snapshot younger than MAX_AGE_HOURS is reused; its capture time is recorded in the trace.

import type { Trace } from "../trace.js";
import { config } from "../config.js";
import { query, runSql } from "../zetaris/client.js";

const MAX_AGE_HOURS = 6;
const ROOT = "file:///home/zetaris/customer-data/shared/snapshots";

// cap: how many rows the paged REST tables can return (zetaris/setup: 2 and 3 pages of 1,000). A snapshot
// that reaches its cap may be missing records, and the trace says so.
export const SNAPSHOTS = {
  shortages: { table: "shortages_snap", source: "fda.shortages_current_v", cap: 2000 },
  recalls: { table: "recalls_snap", source: "fda.recalls_ongoing_v", cap: 3000 },
} as const;

const capNote = (key: keyof typeof SNAPSHOTS, rows: number) => (rows >= SNAPSHOTS[key].cap ? ` WARNING: reached the ${SNAPSHOTS[key].cap}-row paging cap, add a page in zetaris/setup` : "");

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

async function readable(table: string): Promise<number | null> {
  try {
    const { rows } = await query<{ n: string }>(`SELECT count(*) AS n FROM fda_files.${table}`);
    const n = Number(rows[0]?.n ?? 0);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function build(snap: { table: string; source: string }, existing: boolean, trace: Trace): Promise<{ stamp: string; rows: number }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12) + String(attempt).padStart(0, "");
    const path = `${ROOT}/${snap.table}/${stamp.slice(0, 12)}${attempt > 1 ? `-${attempt}` : ""}`;
    if (existing || attempt > 1) await runSql(`DROP LIGHTNING DATABASE TABLE FDA_FILES.${snap.table}`).catch(() => undefined);
    const sql = `CREATE LIGHTNING FILESTORE TABLE ${snap.table} FROM FDA_FILES FORMAT PARQUET OPTIONS (
  path "${path}",
  sourceTable "${snap.source}"
)`;
    // A retried CREATE can report "already exists" when the first attempt succeeded server-side, so the
    // only test that counts is whether the snapshot reads back with rows.
    await runSql(sql).catch(() => undefined);
    const rows = await readable(snap.table);
    if (rows) {
      trace.log({ item_id: null, agent_name: "SourceScout", action: "snapshot_fda_source", input_summary: `live openFDA view ${snap.source}`, output_summary: `Materialised ${rows} rows into Zetaris platform storage as fda_files.${snap.table} (Parquet)${attempt > 1 ? ` on attempt ${attempt}` : ""}`, status: "ok", sql });
      return { stamp: stamp.slice(0, 12), rows };
    }
    trace.log({ item_id: null, agent_name: "SourceScout", action: "snapshot_retry", input_summary: snap.source, output_summary: `Snapshot attempt ${attempt} did not read back (openFDA call from Zetaris failed); retrying`, status: "needs_revision" });
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
  throw new Error(`Could not snapshot ${snap.source} after 3 attempts (openFDA unreachable from Zetaris).`);
}

export async function ensureFdaSnapshots(trace: Trace, opts: { force?: boolean } = {}): Promise<Record<string, { captured: string; rows: number; refreshed: boolean }>> {
  const { rows: listed } = await query<Listed>("SHOW LIGHTNING TABLES FDA_FILES");
  if (config.sampleMode) {
    // Sample mode replays the recorded snapshots as they were; no clock-based refresh.
    const out: Record<string, { captured: string; rows: number; refreshed: boolean }> = {};
    for (const [key, snap] of Object.entries(SNAPSHOTS)) {
      const t = listed.find((x) => x.name === snap.table);
      out[key] = { captured: (t && capturedAt(t.source_table.replace(/-\d$/, ""))?.toISOString()) || "recorded", rows: (await readable(snap.table)) ?? 0, refreshed: false };
    }
    trace.log({ item_id: null, agent_name: "SourceScout", action: "fda_snapshot_status", input_summary: "sample mode", output_summary: Object.entries(out).map(([k, v]) => `${k}: ${v.rows} rows captured ${v.captured} (recorded)`).join("; "), status: "info" });
    return out;
  }
  const out: Record<string, { captured: string; rows: number; refreshed: boolean }> = {};
  for (const [key, snap] of Object.entries(SNAPSHOTS)) {
    const existing = listed.find((t) => t.name === snap.table);
    const when = existing ? capturedAt(existing.source_table.replace(/-\d$/, "")) : null;
    const fresh = !!when && Date.now() - when.getTime() < MAX_AGE_HOURS * 3_600_000;
    const reusable = fresh && !opts.force ? await readable(snap.table) : null;
    if (reusable) {
      out[key] = { captured: when!.toISOString(), rows: reusable, refreshed: false };
    } else {
      const b = await build(snap, !!existing, trace);
      out[key] = { captured: capturedAt(`/${b.stamp}`)!.toISOString(), rows: b.rows, refreshed: true };
    }
  }
  trace.log({
    item_id: null,
    agent_name: "SourceScout",
    action: "fda_snapshot_status",
    input_summary: `snapshots reused when under ${MAX_AGE_HOURS} hours old and readable`,
    output_summary: Object.entries(out).map(([k, v]) => `${k}: ${v.rows} rows captured ${v.captured}${v.refreshed ? " (refreshed now)" : " (reused)"}${capNote(k as keyof typeof SNAPSHOTS, v.rows)}`).join("; "),
    status: Object.entries(out).some(([k, v]) => capNote(k as keyof typeof SNAPSHOTS, v.rows)) ? "needs_revision" : "info",
  });
  return out;
}
