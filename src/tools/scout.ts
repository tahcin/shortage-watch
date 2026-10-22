// The source scout: when an agent needs data that is not yet in Zetaris (the openFDA NDC listing for an
// ingredient, which says which packages can actually be ordered), it registers a new REST table and a
// flattening view in Zetaris at run time, then queries it. Reuses the table if it already exists.

import type { Evidence } from "../evidence.js";
import { lit, query, runSql, ZetarisError } from "../zetaris/client.js";

export type NdcRow = { product_ndc: string; labeler_name: string; brand_name: string; dosage_form: string; strength: string; application_number: string; marketing_category: string; package_ndcs: string; package_descriptions: string; listing_expiration_date: string };

export function slug(ingredient: string): string {
  return ingredient.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

export async function registerNdcSource(ingredient: string): Promise<{ table: string; created: boolean; sql: string[] }> {
  const name = `ndc_${slug(ingredient)}`;
  const search = encodeURIComponent(`generic_name:"${ingredient}"`).replace(/%3A/g, ":");
  const statements = [
    `CREATE LIGHTNING REST TABLE ${name} FROM OPENFDA_REST REQUEST(
    endpoint "https://api.fda.gov/drug/ndc.json?search=${search}&limit=100",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ()`,
    `CREATE SCHEMASTORE VIEW ${name}_v2 WITH CONTAINER fda AS
SELECT r.product_ndc, r.labeler_name, r.brand_name, r.dosage_form, r.application_number, r.marketing_category, r.listing_expiration_date,
       concat_ws('; ', transform(r.active_ingredients, a -> concat(a.name, ' ', a.strength))) AS strength,
       concat_ws(' | ', transform(r.packaging, p -> p.package_ndc)) AS package_ndcs,
       concat_ws(' | ', transform(r.packaging, p -> p.description)) AS package_descriptions
FROM openfda_rest.${name} LATERAL VIEW explode(results) AS r`,
  ];
  let created = false;
  for (const sql of statements) {
    try {
      await runSql(sql);
      created = true;
    } catch (err) {
      if (!(err instanceof ZetarisError && /already exists|duplicate/i.test(err.message))) throw err;
    }
  }
  // Query the listing through a Parquet snapshot so later steps do not call openFDA again.
  const snap = `${name}_s2`;
  const { rows: listed } = await query<{ name: string }>("SHOW LIGHTNING TABLES FDA_FILES");
  if (!listed.some((t) => t.name === snap)) {
    const snapSql = `CREATE LIGHTNING FILESTORE TABLE ${snap} FROM FDA_FILES FORMAT PARQUET OPTIONS (
  path "file:///home/zetaris/customer-data/shared/snapshots/${snap}/${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}",
  sourceTable "fda.${name}_v2"
)`;
    await runSql(snapSql).catch(() => undefined);
    statements.push(snapSql);
  }
  try {
    await query(`SELECT count(*) AS n FROM fda_files.${snap}`);
    return { table: `fda_files.${snap}`, created, sql: statements };
  } catch {
    await runSql(`DROP LIGHTNING DATABASE TABLE FDA_FILES.${snap}`).catch(() => undefined);
    return { table: `fda.${name}_v2`, created, sql: statements };
  }
}

/** Orderable NDC products for these application numbers, from the scout's table. */
export async function orderableProducts(table: string, applications: string[]): Promise<{ rows: NdcRow[]; evidence: Evidence[] }> {
  if (!applications.length) return { rows: [], evidence: [] };
  const { rows } = await query<NdcRow>(`SELECT * FROM ${table} WHERE application_number IN (${applications.map(lit).join(", ")})`, 200);
  return {
    rows,
    evidence: rows.map((r) => ({
      id: `ndc-${r.product_ndc}`,
      source: "fda-ndc" as const,
      summary: `openFDA NDC directory: ${r.brand_name} ${r.strength} (${r.dosage_form}) by ${r.labeler_name}, ${r.application_number}, packages ${String(r.package_ndcs).slice(0, 120)}; listing valid to ${r.listing_expiration_date}`,
      data: { ...r },
      link: `https://api.fda.gov/drug/ndc.json?search=product_ndc:%22${r.product_ndc}%22`,
    })),
  };
}
