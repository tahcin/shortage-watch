// The source scout: when an agent needs data that is not yet in Zetaris (the openFDA NDC directory for an
// ingredient, which says which packages can actually be ordered, by whom, in what vial, and their DEA
// schedule), it registers a new REST table and a flattening view in Zetaris at run time, snapshots it to
// Parquet, and queries the snapshot. A listing is reused for a day, then registered fresh.

import type { Evidence } from "../evidence.js";
import { lit, query, runSql, ZetarisError } from "../zetaris/client.js";

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

export async function registerNdcSource(ingredient: string, opts: { sample?: boolean } = {}): Promise<{ table: string; created: boolean; sql: string[] }> {
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
    endpoint "https://api.fda.gov/drug/ndc.json?search=${search}&limit=1000",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ()`);
  await run(`CREATE SCHEMASTORE VIEW ${view} WITH CONTAINER fda AS
SELECT r.product_ndc, r.labeler_name, r.brand_name, r.generic_name, r.dosage_form, r.application_number, r.marketing_category,
       r.listing_expiration_date, r.dea_schedule,
       concat_ws('; ', transform(r.active_ingredients, a -> concat(a.name, ' ', a.strength))) AS strength,
       concat_ws(' | ', transform(r.packaging, p -> p.package_ndc)) AS package_ndcs,
       concat_ws(' | ', transform(r.packaging, p -> p.description)) AS package_descriptions
FROM openfda_rest.${name} LATERAL VIEW explode(results) AS r`);
  if (existing) await runSql(`DROP LIGHTNING DATABASE TABLE FDA_FILES.${snap}`).catch(() => undefined);
  await run(`CREATE LIGHTNING FILESTORE TABLE ${snap} FROM FDA_FILES FORMAT PARQUET OPTIONS (
  path "file:///home/zetaris/customer-data/shared/snapshots/${snap}/${stampNow()}",
  sourceTable "fda.${view}"
)`);
  try {
    await query(`SELECT count(*) AS n FROM fda_files.${snap}`);
    return { table: `fda_files.${snap}`, created: true, sql: statements };
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

type ListingRow = { product_ndc: string; labeler_name: string; brand_name: string; dosage_form: string; application_number: string; dea_schedule: string | null; strength: string; package_ndcs: string; package_descriptions: string; listing_expiration_date: string };

/** "25 VIAL in 1 CARTON (42571-414-87)  / 2 mL in 1 VIAL (42571-414-75)" -> 2 mL, VIAL. */
export function parsePackage(description: string): { volume_ml: number | null; container: string | null } {
  const inner = description.split("/").pop() ?? description;
  const m = inner.match(/([\d.]+)\s*mL in 1 ([A-Z][A-Z ,-]*?)\s*(?:\(|$)/i);
  if (!m) return { volume_ml: null, container: null };
  return { volume_ml: Number(m[1]), container: m[2]!.trim().toUpperCase() };
}

/** Every manufacturer package listed under these applications (and our own product), one row per package. */
export async function listingPackages(table: string, applications: string[], productNdcs: string[] = []): Promise<{ packages: Pkg[]; evidence: Evidence[] }> {
  const conds = [
    ...(applications.length ? [`application_number IN (${applications.map(lit).join(", ")})`] : []),
    ...(productNdcs.length ? [`product_ndc IN (${productNdcs.map(lit).join(", ")})`] : []),
  ];
  if (!conds.length) return { packages: [], evidence: [] };
  const { rows } = await query<ListingRow>(`SELECT * FROM ${table} WHERE ${conds.join(" OR ")}`, 1000);
  const keep = rows.filter((r) => !isRepackager(r.labeler_name));
  const packages = keep.flatMap((r) => {
    const ndcs = String(r.package_ndcs ?? "").split(" | ");
    const descs = String(r.package_descriptions ?? "").split(" | ");
    return ndcs.map((ndc, i) => ({
      ndc: ndc.trim(),
      product_ndc: r.product_ndc,
      labeler: r.labeler_name,
      application_number: r.application_number,
      strength: r.strength,
      description: (descs[i] ?? "").trim(),
      dea_schedule: r.dea_schedule ?? null,
      ...parsePackage(descs[i] ?? ""),
    })).filter((p) => p.ndc);
  });
  return {
    packages,
    evidence: keep.map((r) => ({
      id: `ndc-${r.product_ndc}`,
      source: "fda-ndc" as const,
      summary: `openFDA NDC directory: ${r.brand_name} ${r.strength} (${r.dosage_form}) by ${r.labeler_name}, ${r.application_number}${r.dea_schedule ? `, DEA schedule ${r.dea_schedule}` : ""}; packages: ${String(r.package_ndcs).split(" | ").map((n, i) => `${n} (${(String(r.package_descriptions).split(" | ")[i] ?? "").split("/").pop()?.trim()})`).join("; ").slice(0, 400)}; listing valid to ${r.listing_expiration_date}`,
      data: { ...r },
      link: `https://api.fda.gov/drug/ndc.json?search=product_ndc:%22${r.product_ndc}%22`,
    })),
  };
}
