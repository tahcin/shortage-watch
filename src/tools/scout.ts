// The source scout: when an agent needs data that is not yet in Zetaris (the openFDA NDC directory for an
// ingredient, which says which packages can actually be ordered, by whom, in what vial, and their DEA
// schedule), it registers a new REST table and a flattening view in Zetaris at run time, snapshots it to
// Parquet, and queries the snapshot. A listing is reused for a day, then registered fresh.

import { query, runSql, ZetarisError } from "../zetaris/client.js";

/** Repackagers and relabelers: a buyer orders from the manufacturer, so their listings are skipped. */
const REPACKAGER = /repack|relabel|medication solutions|distribution|healthfirst|hf acquisition|henry schein|purchasing solutions|general injectables|cardinal health 107|nucare|proficient rx|quality care|asclemed|enovachem|fagron|direct.?rx|bryant ranch|pd-rx|preferred pharmaceuticals|a-s medication/i;

export function isRepackager(labeler: string): boolean {
  return REPACKAGER.test(labeler);
}

export function slug(ingredient: string): string {
  return ingredient.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

const MAX_AGE_HOURS = 24;
const stampNow = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const stampAge = (path: string) => {
  const m = path.match(/\/(\d{12})$/);
  if (!m) return Infinity;
  const s = m[1]!;
  return (Date.now() - Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12))) / 3_600_000;
};

/** openFDA returns at most this many products per request; a listing that reaches it may be incomplete. */
const NDC_LIMIT = 1000;

export async function registerNdcSource(ingredient: string, opts: { sample?: boolean } = {}): Promise<{ table: string; created: boolean; sql: string[]; rows?: number; truncated?: boolean }> {
  const name = `ndc_${slug(ingredient)}`;
  const search = encodeURIComponent(`generic_name:"${ingredient}"`).replace(/%3A/g, ":");
  const view = `${name}_view`;
  const snap = `${name}_snapshot`;
  const statements: string[] = [];
  let created = false;
  const run = async (sql: string) => {
    statements.push(sql);
    try {
      await runSql(sql);
      created = true;
    } catch (err) {
      if (!(err instanceof ZetarisError && /already exists|duplicate/i.test(err.message))) throw err;
    }
  };

  const { rows: listed } = await query<{ name: string; source_table: string }>("SHOW LIGHTNING TABLES FDA_FILES");
  const existing = listed.find((t) => t.name === snap);
  if (existing && (opts.sample || stampAge(existing.source_table) < MAX_AGE_HOURS)) {
    return { table: `fda_files.${snap}`, created: false, sql: [] };
  }

  await run(`CREATE LIGHTNING REST TABLE ${name} FROM OPENFDA_REST REQUEST(
    endpoint "https://api.fda.gov/drug/ndc.json?search=${search}&limit=${NDC_LIMIT}",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ()`);
  // Some ingredients have no DEA-scheduled product, so openFDA's JSON has no dea_schedule field at all and
  // the view must not reference it.
  const viewSql = (dea: string) => `CREATE SCHEMASTORE VIEW ${view} WITH CONTAINER fda AS
SELECT r.product_ndc, r.labeler_name, r.brand_name, r.generic_name, r.dosage_form, r.application_number, r.marketing_category,
       r.listing_expiration_date, ${dea} AS dea_schedule,
       concat_ws('; ', transform(r.active_ingredients, a -> concat(a.name, ' ', a.strength))) AS strength,
       concat_ws(' | ', transform(r.packaging, p -> p.package_ndc)) AS package_ndcs,
       concat_ws(' | ', transform(r.packaging, p -> p.description)) AS package_descriptions
FROM openfda_rest.${name} LATERAL VIEW explode(results) AS r`;
  try {
    await run(viewSql("r.dea_schedule"));
  } catch (err) {
    if (!(err instanceof ZetarisError && /FIELD_NOT_FOUND|dea_schedule/i.test(err.message))) throw err;
    await runSql(`DROP SCHEMASTORE VIEW ${view} FROM fda`).catch(() => undefined);
    await run(viewSql("CAST(NULL AS STRING)"));
  }
  if (existing) await runSql(`DROP LIGHTNING DATABASE TABLE FDA_FILES.${snap}`).catch(() => undefined);
  await run(`CREATE LIGHTNING FILESTORE TABLE ${snap} FROM FDA_FILES FORMAT PARQUET OPTIONS (
  path "file:///home/zetaris/customer-data/shared/snapshots/${snap}/${stampNow()}",
  sourceTable "fda.${view}"
)`);
  try {
    const { rows } = await query<{ n: string }>(`SELECT count(*) AS n FROM fda_files.${snap}`);
    const n = Number(rows[0]?.n ?? 0);
    return { table: `fda_files.${snap}`, created: true, sql: statements, rows: n, truncated: n >= NDC_LIMIT };
  } catch {
    // The snapshot did not read back (openFDA call failed inside Zetaris): query the live view instead.
    await runSql(`DROP LIGHTNING DATABASE TABLE FDA_FILES.${snap}`).catch(() => undefined);
    return { table: `fda.${view}`, created, sql: statements };
  }
}

export type Pkg = {
  ndc: string;
  product_ndc: string;
  labeler: string;
  application_number: string;
  strength: string;
  description: string;
  volume_ml: number | null;
  container: string | null;
  dea_schedule: string | null;
};


/** "25 VIAL in 1 CARTON (42571-414-87)  / 2 mL in 1 VIAL (42571-414-75)" -> 2 mL, VIAL. */
export function parsePackage(description: string): { volume_ml: number | null; container: string | null } {
  const inner = description.split("/").pop() ?? description;
  const m = inner.match(/([\d.]+)\s*mL in 1 ([A-Z][A-Z ,-]*?)\s*(?:\(|$)/i);
  if (!m) return { volume_ml: null, container: null };
  return { volume_ml: Number(m[1]), container: m[2]!.trim().toUpperCase() };
}
