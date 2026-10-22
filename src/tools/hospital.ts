import type { Evidence } from "../evidence.js";
import { query } from "../zetaris/client.js";

export type Item = {
  item_id: number;
  generic_name: string;
  strength: string;
  dosage_form: string;
  route: string;
  package_ndc: string;
  product_ndc: string;
  labeler: string;
  application_number: string;
  therapeutic_class: string;
  is_critical: boolean;
  on_hand_units: number;
  avg_daily_use: number;
  days_of_cover: number | null;
  open_orders: PurchaseOrder[];
};

export type PurchaseOrder = { po_id: string; wholesaler: string; ordered_units: number; ordered_on: string; expected_on: string | null; status: string };

const num = (v: unknown): number => (v === null || v === undefined || v === "" ? NaN : Number(v));
const bool = (v: unknown): boolean => v === true || v === "true" || v === "t";

/** Every formulary item with on-hand stock, 30-day average use, days of cover and open orders (hospital_pg via Zetaris). */
export async function coverTable(): Promise<{ items: Item[]; evidence: Evidence[] }> {
  const { rows } = await query(`
SELECT f.item_id, f.generic_name, f.strength, f.dosage_form, f.route, f.package_ndc, f.product_ndc, f.labeler,
       f.application_number, f.therapeutic_class, f.is_critical, d.on_hand_units, d.avg_daily_use, d.days_of_cover
FROM hospital_pg.formulary f
JOIN hospital_pg.days_of_cover d ON d.item_id = f.item_id
ORDER BY d.days_of_cover`);
  const { rows: poRows } = await query(`
SELECT item_id, po_id, wholesaler, ordered_units, ordered_on, expected_on, status
FROM hospital_pg.purchase_orders WHERE status <> 'received'`);

  const items: Item[] = rows.map((r) => {
    const days = num(r.days_of_cover);
    return {
      item_id: num(r.item_id),
      generic_name: String(r.generic_name ?? ""),
      strength: String(r.strength ?? ""),
      dosage_form: String(r.dosage_form ?? ""),
      route: String(r.route ?? ""),
      package_ndc: String(r.package_ndc ?? ""),
      product_ndc: String(r.product_ndc ?? ""),
      labeler: String(r.labeler ?? ""),
      application_number: String(r.application_number ?? ""),
      therapeutic_class: String(r.therapeutic_class ?? ""),
      is_critical: bool(r.is_critical),
      on_hand_units: num(r.on_hand_units),
      avg_daily_use: Math.round(num(r.avg_daily_use) * 10) / 10,
      days_of_cover: Number.isFinite(days) ? Math.round(days * 10) / 10 : null,
      open_orders: poRows
        .filter((p) => num(p.item_id) === num(r.item_id))
        .map((p) => ({
          po_id: String(p.po_id),
          wholesaler: String(p.wholesaler),
          ordered_units: num(p.ordered_units),
          ordered_on: String(p.ordered_on),
          expected_on: p.expected_on ? String(p.expected_on) : null,
          status: String(p.status),
        })),
    };
  });

  const evidence: Evidence[] = items.map((i) => ({
    id: `stock-${i.item_id}`,
    source: "hospital",
    summary: `${i.generic_name} ${i.strength} (${i.labeler}, NDC ${i.package_ndc}, ${i.application_number}${i.is_critical ? ", critical drug" : ""}): ${i.on_hand_units} units on hand, ${i.avg_daily_use}/day over 30 days, ${i.days_of_cover ?? "n/a"} days of cover${i.open_orders.length ? `; open orders: ${i.open_orders.map((o) => `${o.po_id} ${o.status} ${o.ordered_units} units from ${o.wholesaler}, expected ${o.expected_on}`).join("; ")}` : ""}`,
    data: { ...i },
  }));
  return { items, evidence };
}
