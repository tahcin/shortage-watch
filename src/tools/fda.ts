import { orangeBookLink, recallLink, type Evidence } from "../evidence.js";
import { lit, query } from "../zetaris/client.js";
import { RECALLS, SHORTAGES } from "./snapshot.js";
import type { Item } from "./hospital.js";

export type MatchType = "same_package" | "same_product" | "same_application" | "same_ingredient";

export type ShortageRow = {
  generic_name: string;
  package_ndc: string;
  presentation: string;
  company_name: string;
  availability: string;
  shortage_reason: string | null;
  update_date: string;
  related_info: string | null;
  related_info_link: string | null;
  match: MatchType;
};

/** The first word(s) of the generic name that identify the active ingredient, for broad matching. */
export function ingredientKey(genericName: string): string {
  const stop = new Set(["sodium", "hydrochloride", "sulfate", "citrate", "tartrate", "bromide", "chloride", "phosphate", "succinate", "tromethamine", "methylsulfate", "lactate", "injection", "oral", "suspension", "solution"]);
  const words = genericName.toLowerCase().split(/\s+/).filter(Boolean);
  const head = words.filter((w) => !stop.has(w));
  // "sodium bicarbonate", "potassium chloride", "magnesium sulfate": keep the salt when it IS the drug.
  if (head.length === 0 || (words.length === 2 && ["sodium", "potassium", "magnesium"].includes(words[0]!))) return words.join(" ");
  return head[0]!;
}

function appNo(application: string): { type: string; no: string } | null {
  const m = application.toUpperCase().match(/^(ANDA|NDA|BLA)(\d+)$/);
  return m ? { type: m[1] === "ANDA" ? "A" : "N", no: m[2]!.padStart(6, "0") } : null;
}

const shortageEvidence = (r: ShortageRow): Evidence => ({
  id: `shortage-${r.package_ndc}`,
  source: "fda-shortage",
  summary: `FDA shortage list: ${r.presentation || r.generic_name} from ${r.company_name} is "${r.availability}"${r.shortage_reason ? ` (reason: ${r.shortage_reason})` : ""}, updated ${r.update_date}${r.related_info ? `; note: ${r.related_info.slice(0, 200)}` : ""}`,
  data: { ...r },
  link: r.related_info_link || "https://dps.fda.gov/drugshortages",
});

/** Shortage records touching this item: its package, product, application, or the same ingredient. */
export async function shortageFor(item: Item): Promise<{ rows: ShortageRow[]; evidence: Evidence[] }> {
  const key = ingredientKey(item.generic_name);
  const { rows } = await query(`
SELECT generic_name, package_ndc, presentation, company_name, availability, shortage_reason, update_date, related_info, related_info_link,
  CASE WHEN package_ndc = ${lit(item.package_ndc)} THEN 'same_package'
       WHEN array_contains(product_ndcs, ${lit(item.product_ndc)}) THEN 'same_product'
       WHEN array_contains(application_numbers, ${lit(item.application_number)}) THEN 'same_application'
       ELSE 'same_ingredient' END AS match
FROM ${SHORTAGES}
WHERE package_ndc = ${lit(item.package_ndc)}
   OR array_contains(product_ndcs, ${lit(item.product_ndc)})
   OR array_contains(application_numbers, ${lit(item.application_number)})
   OR lower(generic_name) LIKE ${lit(`${key}%`)}`, 500);
  const typed = rows.map((r) => ({ ...r, match: r.match as MatchType }) as ShortageRow);
  // One evidence record per package keeps the trace readable.
  return { rows: typed, evidence: typed.map(shortageEvidence) };
}

export type RecallRow = { recall_number: string; classification: string; reason_for_recall: string; product_description: string; recalling_firm: string; recall_initiation_date: string; report_date: string };

/** Ongoing FDA recalls touching any of these NDCs or applications. */
export async function recallsFor(ndcs: string[], applications: string[]): Promise<{ rows: RecallRow[]; evidence: Evidence[] }> {
  const conds = [
    ...ndcs.filter(Boolean).flatMap((n) => [`array_contains(product_ndcs, ${lit(n)})`, `array_contains(package_ndcs, ${lit(n)})`]),
    ...applications.filter(Boolean).map((a) => `array_contains(application_numbers, ${lit(a)})`),
  ];
  if (!conds.length) return { rows: [], evidence: [] };
  const { rows } = await query<RecallRow>(`
SELECT recall_number, classification, reason_for_recall, product_description, recalling_firm, recall_initiation_date, report_date
FROM ${RECALLS} WHERE ${conds.join(" OR ")}`, 200);
  return {
    rows,
    evidence: rows.map((r) => ({
      id: `recall-${r.recall_number}`,
      source: "fda-recall",
      summary: `FDA recall ${r.recall_number} (${r.classification}, ongoing) by ${r.recalling_firm}: ${String(r.reason_for_recall).slice(0, 220)}`,
      data: { ...r },
      link: recallLink(r.recall_number),
    })),
  };
}

export type ObRow = { ingredient: string; df_route: string; trade_name: string; applicant: string; applicant_full_name: string; strength: string; appl_type: string; appl_no: string; product_no: string; te_code: string | null; type: string };

const obEvidence = (r: ObRow, note: string): Evidence => ({
  id: `ob-${r.appl_type === "A" ? "ANDA" : "NDA"}${r.appl_no}-${r.product_no}`,
  source: "orange-book",
  summary: `Orange Book: ${r.trade_name} ${r.strength} (${r.df_route}) by ${r.applicant_full_name || r.applicant}, application ${r.appl_type === "A" ? "ANDA" : "NDA"}${r.appl_no}, TE code ${r.te_code ?? "none"}${note}`,
  data: { ...r },
  link: orangeBookLink(r.appl_no, r.product_no, r.appl_type),
});

export type Concentration = { value: number; unit: "mg/ml" | "meq/ml" | "u/ml" | "mg" | "meq" | "u" };

const MASS: Record<string, number> = { g: 1000, gm: 1000, mg: 1, mcg: 0.001, ug: 0.001 };
const VOLUME: Record<string, number> = { ml: 1, l: 1000 };

/**
 * Parses a strength string into a comparable concentration, so "1 mg/mL", "EQ 1MG BASE/ML", "1%",
 * "8MG/20ML (0.4MG/ML)" and "MIDAZOLAM HYDROCHLORIDE 1 mg/mL" can be compared as numbers.
 */
export function parseConcentration(raw: string): Concentration | null {
  let s = raw.toLowerCase().split(";")[0]!;
  const paren = s.match(/\(([^)]*\/[^)]*)\)/);
  if (paren) s = paren[1]!;
  s = s.replace(/\[usp'u\]|usp units|units|unit|iu/g, "u").replace(/,/g, "");
  const pct = s.match(/([\d.]+)\s*%/);
  if (pct) return { value: Number(pct[1]) * 10, unit: "mg/ml" };
  const m = s.match(/([\d.]+)\s*(g|gm|mg|mcg|ug|meq|u)\b[^/\d]*(?:\/\s*([\d.]*)\s*(ml|l)\b)?/);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2]!;
  const perVol = m[4] ? (m[3] ? Number(m[3]) : 1) * VOLUME[m[4]]! : null;
  if (unit === "meq") return perVol ? { value: amount / perVol, unit: "meq/ml" } : { value: amount, unit: "meq" };
  if (unit === "u") return perVol ? { value: amount / perVol, unit: "u/ml" } : { value: amount, unit: "u" };
  const mg = amount * MASS[unit]!;
  return perVol ? { value: mg / perVol, unit: "mg/ml" } : { value: mg, unit: "mg" };
}

export function sameConcentration(a: string, b: string): boolean {
  const x = parseConcentration(a);
  const y = parseConcentration(b);
  if (!x || !y || x.unit !== y.unit) return false;
  return Math.abs(x.value - y.value) <= 0.02 * Math.max(x.value, y.value);
}

/** The item's own Orange Book row, then therapeutically equivalent products from other applications. */
export async function equivalentsFor(item: Item): Promise<{ own: ObRow | null; equivalents: ObRow[]; evidence: Evidence[] }> {
  const app = appNo(item.application_number);
  let ownRows: ObRow[] = [];
  if (app) {
    ({ rows: ownRows } = await query<ObRow>(`SELECT * FROM fda.orange_book_v WHERE appl_no = ${lit(app.no)} AND appl_type = ${lit(app.type)}`, 50));
  }
  const own = ownRows.find((r) => sameConcentration(r.strength, item.strength)) ?? (ownRows.length === 1 ? ownRows[0]! : null);
  if (!own) return { own: null, equivalents: [], evidence: [] };

  // Same ingredient and dosage form/route; same concentration is checked in code so other vial sizes count.
  const { rows: candidates } = await query<ObRow>(`
SELECT * FROM fda.orange_book_v
WHERE ingredient = ${lit(own.ingredient)} AND df_route = ${lit(own.df_route)}
  AND te_code LIKE 'A%' AND type = 'RX' AND NOT (appl_no = ${lit(own.appl_no)} AND appl_type = ${lit(own.appl_type)})`, 300);
  const rows = candidates.filter((r) => sameConcentration(r.strength, own.strength));
  return {
    own,
    equivalents: rows,
    evidence: [obEvidence(own, " (our current product)"), ...rows.map((r) => obEvidence(r, ""))],
  };
}

export type SubstituteCheck = { appl: string; shortage: ShortageRow[]; recalls: RecallRow[]; verdict: "clear" | "listed_available" | "constrained" | "recalled" };

/** Is this equivalent itself short or recalled? Uses the application number, which both FDA sources carry. */
export async function substituteStatus(eq: ObRow): Promise<{ check: SubstituteCheck; evidence: Evidence[] }> {
  const appl = `${eq.appl_type === "A" ? "ANDA" : "NDA"}${eq.appl_no}`;
  const { rows } = await query(`
SELECT generic_name, package_ndc, presentation, company_name, availability, shortage_reason, update_date, related_info, related_info_link, 'same_application' AS match
FROM ${SHORTAGES} WHERE array_contains(application_numbers, ${lit(appl)})`, 100);
  const shortage = rows as unknown as ShortageRow[];
  const recalls = await recallsFor([], [appl]);
  const constrained = shortage.some((s) => !/^available$/i.test(s.availability));
  const recalled = recalls.rows.some((r) => /class i(i)?$/i.test(r.classification.trim()));
  const verdict: SubstituteCheck["verdict"] = recalled ? "recalled" : constrained ? "constrained" : shortage.length ? "listed_available" : "clear";
  return { check: { appl, shortage, recalls: recalls.rows, verdict }, evidence: [...shortage.map(shortageEvidence), ...recalls.evidence] };
}
