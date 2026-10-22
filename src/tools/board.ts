// The risk board: ONE Zetaris query that joins four sources in a single statement. The hospital's stock
// (Postgres over JDBC), the FDA shortage and recall snapshots (Parquet, materialised from openFDA REST),
// and the FDA Orange Book (CSV file). Zetaris federates them; the Planner reads the result.

import type { Evidence } from "../evidence.js";
import { query } from "../zetaris/client.js";
import { RECALLS, SHORTAGES } from "./snapshot.js";

export const BOARD_SQL = `WITH ob AS (
  SELECT concat(CASE appl_type WHEN 'A' THEN 'ANDA' ELSE 'NDA' END, appl_no) AS appl, ingredient, df_route, te_code
  FROM fda.orange_book_v
), own_ob AS (
  SELECT appl, first(ingredient) AS ingredient, first(df_route) AS df_route FROM ob GROUP BY appl
), eq AS (
  SELECT ingredient, df_route, count(DISTINCT appl) AS n FROM ob WHERE te_code LIKE 'A%' GROUP BY ingredient, df_route
), rec AS (
  SELECT ndc, first(recall_number) AS recall_number, first(classification) AS classification
  FROM ${RECALLS} LATERAL VIEW explode(package_ndcs) t AS ndc GROUP BY ndc
)
SELECT f.item_id, f.generic_name, f.labeler, f.package_ndc, f.is_critical,
       round(d.days_of_cover, 1) AS days_of_cover,
       s.availability AS fda_status, s.shortage_reason,
       r.recall_number, r.classification AS recall_class,
       greatest(coalesce(e.n, 0) - 1, 0) AS equivalents
FROM hospital_pg.formulary f
JOIN hospital_pg.days_of_cover d ON d.item_id = f.item_id
LEFT JOIN ${SHORTAGES} s ON s.package_ndc = f.package_ndc
LEFT JOIN rec r ON r.ndc = f.package_ndc
LEFT JOIN own_ob o ON o.appl = f.application_number
LEFT JOIN eq e ON e.ingredient = o.ingredient AND e.df_route = o.df_route
ORDER BY d.days_of_cover`;

export type BoardRow = {
  item_id: number;
  generic_name: string;
  labeler: string;
  package_ndc: string;
  is_critical: boolean;
  days_of_cover: number | null;
  fda_status: string | null;
  shortage_reason: string | null;
  recall_number: string | null;
  recall_class: string | null;
  equivalents: number;
};

export async function riskBoard(): Promise<{ rows: BoardRow[]; ms: number; evidence: Evidence[] }> {
  const { rows, ms } = await query<Record<string, unknown>>(BOARD_SQL, 1000);
  const typed: BoardRow[] = rows.map((r) => ({
    item_id: Number(r.item_id),
    generic_name: String(r.generic_name),
    labeler: String(r.labeler),
    package_ndc: String(r.package_ndc),
    is_critical: r.is_critical === true || r.is_critical === "true",
    days_of_cover: r.days_of_cover === null || r.days_of_cover === undefined ? null : Number(r.days_of_cover),
    fda_status: (r.fda_status as string) ?? null,
    shortage_reason: (r.shortage_reason as string) ?? null,
    recall_number: (r.recall_number as string) ?? null,
    recall_class: (r.recall_class as string) ?? null,
    equivalents: Number(r.equivalents ?? 0),
  }));
  return {
    rows: typed,
    ms,
    evidence: typed.map((b) => ({
      id: `board-${b.item_id}`,
      source: "hospital" as const,
      summary: `Risk board (one Zetaris query over hospital stock, FDA shortages, FDA recalls and the Orange Book): ${b.generic_name} (${b.labeler}, NDC ${b.package_ndc}) has ${b.days_of_cover ?? "n/a"} days of cover; our package on the FDA shortage list: ${b.fda_status ? `"${b.fda_status}"` : "no"}; ongoing recall on our package: ${b.recall_number ? `${b.recall_number} (${b.recall_class})` : "no"}; ${b.equivalents} Orange Book equivalent applications for this ingredient and dosage form.`,
      data: { ...b },
    })),
  };
}
