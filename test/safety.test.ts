import { describe, expect, it } from "vitest";
import { codeChecks } from "../src/agents/critic.js";
import { comparablePresentation } from "../src/agents/substitution.js";
import type { AgentContext, ItemCase } from "../src/agents/types.js";
import { EvidenceStore } from "../src/evidence.js";
import { normaliseBaseUrl, parseConnectLink, extractJson } from "../src/llm/meterless.js";
import { ingredientKey, parseConcentration, sameConcentration, type ObRow, type SubstituteCheck } from "../src/tools/fda.js";
import type { Item } from "../src/tools/hospital.js";
import type { Pkg } from "../src/tools/scout.js";
import type { Trace } from "../src/trace.js";

describe("strength matching (a wrong strength is a dosing error)", () => {
  it("reads the strength formats used by openFDA and the Orange Book", () => {
    expect(parseConcentration("MIDAZOLAM HYDROCHLORIDE 1 mg/mL")).toEqual({ value: 1, unit: "mg/ml" });
    expect(parseConcentration("EQ 1MG BASE/ML")).toEqual({ value: 1, unit: "mg/ml" });
    expect(parseConcentration("8MG/20ML (0.4MG/ML)")).toEqual({ value: 0.4, unit: "mg/ml" });
    expect(parseConcentration("1%")).toEqual({ value: 10, unit: "mg/ml" });
    expect(parseConcentration("DEXTROSE MONOHYDRATE 25 g/50mL")).toEqual({ value: 500, unit: "mg/ml" });
    expect(parseConcentration("HEPARIN SODIUM 5000 [USP'U]/mL")).toEqual({ value: 5000, unit: "u/ml" });
  });

  it("treats different vial sizes of the same concentration as equal", () => {
    expect(sameConcentration("METOPROLOL TARTRATE 5 mg/5mL", "1MG/ML")).toBe(true);
    expect(sameConcentration("ALBUTEROL SULFATE 1.25 mg/3mL", "0.042%")).toBe(true);
  });

  it("never treats a different concentration as equal", () => {
    expect(sameConcentration("HYDROMORPHONE HYDROCHLORIDE 1 mg/mL", "2MG/ML")).toBe(false);
    expect(sameConcentration("HYDROMORPHONE HYDROCHLORIDE 1 mg/mL", ".5 mg/.5mL")).toBe(true);
    expect(sameConcentration("MORPHINE SULFATE 50 mg/mL", "10MG/ML")).toBe(false);
    expect(sameConcentration("POTASSIUM CHLORIDE 2 meq/mL", "2 mg/mL")).toBe(false);
  });

  it("keeps salt names when the salt is the drug", () => {
    expect(ingredientKey("sodium bicarbonate")).toBe("sodium bicarbonate");
    expect(ingredientKey("midazolam")).toBe("midazolam");
    expect(ingredientKey("dexamethasone sodium phosphate")).toBe("dexamethasone");
  });
});

const item: Item = {
  item_id: 16, generic_name: "hydromorphone", strength: "HYDROMORPHONE HYDROCHLORIDE 1 mg/mL", dosage_form: "INJECTION", route: "INTRAVENOUS",
  package_ndc: "63323-852-25", product_ndc: "63323-852", labeler: "Fresenius Kabi USA, LLC", application_number: "NDA019034", therapeutic_class: "",
  is_critical: true, on_hand_units: 50, avg_daily_use: 9.6, days_of_cover: 5.2, open_orders: [],
};
const ob = (appl_no: string, applicant: string, te_code = "AP"): ObRow => ({ ingredient: "HYDROMORPHONE HYDROCHLORIDE", df_route: "INJECTABLE;INJECTION", trade_name: "HYDROMORPHONE", applicant, applicant_full_name: applicant, strength: "1MG/ML", appl_type: "A", appl_no, product_no: "003", te_code, type: "RX" });
const pkg = (ndc: string, strength: string, labeler = "Hikma Pharmaceuticals USA Inc."): Pkg => ({ ndc, product_ndc: ndc.split("-").slice(0, 2).join("-"), labeler, application_number: "ANDA216899", strength, description: "1 mL in 1 VIAL", volume_ml: 1, container: "VIAL", dea_schedule: "CII" });
const hikmaCheck = (): SubstituteCheck => ({
  appl: "ANDA216899",
  applicant: "HIKMA",
  packages: [{ pkg: pkg("0641-6169-10", "HYDROMORPHONE HYDROCHLORIDE 1 mg/mL"), availability: null }],
  shortage: [],
  recalls: [],
  verdict: "clear",
  preservative_note: null,
});

function ctx(): AgentContext {
  const store = new EvidenceStore();
  store.add({ id: "stock-16", source: "hospital", summary: "5.2 days of cover", data: {} });
  store.add({ id: "shortage-63323-852-25", source: "fda-shortage", summary: "Available", data: { match: "same_package", availability: "Available" } });
  store.add({ id: "ob-ANDA216899-003", source: "orange-book", summary: "Hikma 1MG/ML AP", data: {} });
  store.add({ id: "status-ANDA216899", source: "fda-shortage", summary: "Hikma not on the shortage list", data: {} });
  return { store, trace: { log: () => undefined } as unknown as Trace, memories: [] };
}

function caseWith(ndcs: string[], extra: Partial<ItemCase> = {}): ItemCase {
  return {
    item,
    retries: 0,
    status: "pending",
    investigation: { item_id: 16, risk: "supply_risk", headline: "", claims: [{ text: "Stock covers 5.2 days of cover.", evidence_ids: ["stock-16"] }], needs_substitute: true, confidence: 0.8, own_constrained: true, own_recalled: false, next_delivery: null, estimated_recovery: null, maker_constrained: 0, market_constrained: 0, market_total: 0 },
    facts: { own: null, equivalents: [ob("216899", "HIKMA")], checks: new Map([["ANDA216899", hikmaCheck()]]), ownPackage: null },
    substitution: { item_id: 16, recommendation: "split", confidence: 0.8, claims: [], substitutes: [{ application: "ANDA216899", applicant: "HIKMA", te_code: "AP", status: "clear", packages: ndcs.map((n) => ({ ndc: n, labeler: "Hikma", description: "1 mL in 1 VIAL", fda_status: "not on the FDA shortage list" })), notes: [], reason: "AP-rated, not short", evidence_ids: ["ob-ANDA216899-003", "status-ANDA216899"] }] },
    ...extra,
  };
}

describe("evidence critic, code checks", () => {
  it("approves a safe, same-strength, orderable substitute", () => {
    expect(codeChecks(caseWith(["0641-6169-10"]), ctx())).toEqual([]);
  });

  it("catches a wrong-strength NDC and names both strengths", () => {
    const c = caseWith(["0641-6170-10"]);
    c.facts!.checks.get("ANDA216899")!.packages.push({ pkg: pkg("0641-6170-10", "HYDROMORPHONE HYDROCHLORIDE 2 mg/mL"), availability: null });
    const problems = codeChecks(c, ctx());
    expect(problems.some((p) => /wrong strength/.test(p.reason) && /2 mg\/mL/.test(p.reason))).toBe(true);
  });

  it("rejects an NDC that is not one of that application's own listings", () => {
    const problems = codeChecks(caseWith(["70069-816-10"]), ctx());
    expect(problems.some((p) => /not one of ANDA216899's own listings/.test(p.reason))).toBe(true);
  });

  it("rejects a substitute that is constrained on its own packages", () => {
    const c = caseWith(["0641-6169-10"]);
    c.facts!.checks.get("ANDA216899")!.verdict = "constrained";
    expect(codeChecks(c, ctx()).some((p) => /not a safe, orderable substitute/.test(p.reason))).toBe(true);
  });

  it("rejects a citation to evidence that was never fetched", () => {
    const c = caseWith(["0641-6169-10"]);
    c.investigation!.claims.push({ text: "It was recalled last week.", evidence_ids: ["recall-D-0000-2026"] });
    expect(codeChecks(c, ctx()).some((p) => /never fetched/.test(p.reason))).toBe(true);
  });

  it("resolves a partial citation only when exactly one record matches", () => {
    const store = ctx().store;
    expect(store.resolve("63323-852-25")).toBe("shortage-63323-852-25");
    expect(store.resolve("nothing-like-this")).toBeUndefined();
  });

  it("flags a wrong days-of-cover figure but not a calculated top-up", () => {
    const c = caseWith(["0641-6169-10"]);
    c.investigation!.claims = [{ text: "Only 9 days of cover left.", evidence_ids: ["stock-16"] }];
    expect(codeChecks(c, ctx()).some((p) => /hospital database shows 5.2/.test(p.reason))).toBe(true);
    c.investigation!.claims = [{ text: "The open order would add 6.3 days of cover.", evidence_ids: ["stock-16"] }];
    expect(codeChecks(c, ctx())).toEqual([]);
  });

  it("enforces a supplier the buyer ruled out", () => {
    const k = ctx();
    k.memories = [{ id: "memory-1", content: "never switch to Hikma", kind: "avoid_supplier", subject: "Hikma" }];
    expect(codeChecks(caseWith(["0641-6169-10"]), k).some((p) => /ruled out Hikma/.test(p.reason))).toBe(true);
  });

  it("does not let a constrained own product be rated low stock only", () => {
    const c = caseWith(["0641-6169-10"]);
    c.investigation!.risk = "low_stock_only";
    expect(codeChecks(c, ctx()).some((p) => /rated "low_stock_only"/.test(p.reason))).toBe(true);
  });
});

describe("Meterless provider contract", () => {
  it("normalises pasted runtime URLs to <host>/v1 and never /v1/v1", () => {
    expect(normaliseBaseUrl("127.0.0.1:8088")).toBe("http://127.0.0.1:8088/v1");
    expect(normaliseBaseUrl("http://127.0.0.1:8088/v1")).toBe("http://127.0.0.1:8088/v1");
    expect(normaliseBaseUrl("http://127.0.0.1:8088/v1/chat/completions")).toBe("http://127.0.0.1:8088/v1");
    expect(normaliseBaseUrl("http://localhost:8088/healthz")).toBe("http://localhost:8088/v1");
  });

  it("reads a connect link", () => {
    expect(parseConnectLink("http://192.168.1.5:8088/connect#k=abc123")).toEqual({ baseUrl: "http://192.168.1.5:8088/v1", token: "abc123" });
  });

  it("extracts the final JSON object after Nemotron's reasoning", () => {
    expect(extractJson<{ ok: boolean }>("Let me think {not json} ... </think>{\"ok\":true}")).toEqual({ ok: true });
  });
});

describe("presentation guard", () => {
  const pkg = (volume_ml: number | null, container: string | null): Pkg => ({ ndc: "x", product_ndc: "x", labeler: "x", application_number: "ANDA000001", strength: "", description: "", volume_ml, container, dea_schedule: null });
  it("rejects a 500 mL bag as a substitute for a 50 mL vial", () => {
    expect(comparablePresentation(pkg(500, "BAG"), pkg(50, "VIAL, SINGLE-DOSE"))).toBe(false);
  });
  it("keeps a 2 mL vial for a 5 mL vial, and a 20 mL vial for a 20 mL multi-dose vial", () => {
    expect(comparablePresentation(pkg(2, "VIAL"), pkg(5, "VIAL, SINGLE-DOSE"))).toBe(true);
    expect(comparablePresentation(pkg(20, "VIAL"), pkg(20, "VIAL, MULTI-DOSE"))).toBe(true);
  });
});
