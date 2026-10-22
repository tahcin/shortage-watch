import { describe, expect, it, vi } from "vitest";

// The model's reply is set per test.
const reply: { value: unknown } = { value: null };
vi.mock("../src/llm/meterless.js", () => ({
  chatJson: vi.fn(async () => ({ value: reply.value, receipt: undefined, raw: "" })),
}));

const { proposeSubstitutes } = await import("../src/agents/substitution.js");
const { EvidenceStore } = await import("../src/evidence.js");
import type { AgentContext, ItemCase } from "../src/agents/types.js";
import type { TraceLine } from "../src/trace.js";

function setup() {
  const store = new EvidenceStore();
  store.add({ id: "stock-4", source: "hospital", summary: "midazolam 1 mg/mL, 7.4 days of cover", data: {} });
  store.add({ id: "status-ANDA203460", source: "fda-ndc", summary: "Checked FRESENIUS KABI USA LLC ANDA203460: not on the FDA shortage list", data: {} });
  const lines: TraceLine[] = [];
  const ctx: AgentContext = { store, trace: { log: (l: TraceLine) => { lines.push(l); return l; } } as never, memories: [] };
  const c: ItemCase = {
    item: { item_id: 4, generic_name: "midazolam", strength: "MIDAZOLAM 1 mg/mL", dosage_form: "INJECTION", route: "INTRAVENOUS", package_ndc: "0409-2305-17", product_ndc: "0409-2305", labeler: "Hospira, Inc.", application_number: "ANDA075243", therapeutic_class: "", is_critical: true, on_hand_units: 80, avg_daily_use: 10.8, days_of_cover: 7.4, open_orders: [] },
    retries: 0,
    status: "pending",
    facts: {
      own: null,
      equivalents: [{ ingredient: "MIDAZOLAM HYDROCHLORIDE", df_route: "INJECTABLE;INJECTION", trade_name: "MIDAZOLAM", applicant: "FRESENIUS KABI USA", applicant_full_name: "FRESENIUS KABI USA LLC", strength: "EQ 1MG BASE/ML", appl_type: "A", appl_no: "203460", product_no: "001", te_code: "AP", type: "RX" }],
      checks: new Map([["ANDA203460", { appl: "ANDA203460", applicant: "FRESENIUS KABI USA LLC", packages: [{ pkg: { ndc: "76045-001-20", product_ndc: "76045-001", labeler: "Fresenius Kabi USA, LLC", application_number: "ANDA203460", strength: "1 mg/mL", description: "2 mL in 1 VIAL", volume_ml: 2, container: "VIAL", dea_schedule: "CIV" }, availability: null }], shortage: [], recalls: [], verdict: "clear" as const, preservative_note: null }]]),
      ownPackage: null,
    },
  };
  return { c, ctx, lines };
}

describe("Substitution guard", () => {
  it("keeps code-verified substitutes when the model drops every option", async () => {
    const { c, ctx, lines } = setup();
    reply.value = { recommendation: "switch", substitutes: [], claims: [{ text: "No substitute is available.", evidence_ids: [] }], confidence: 0.4 };
    const plan = await proposeSubstitutes(c, ctx);
    expect(plan.recommendation).toBe("split");
    expect(plan.substitutes.map((s) => s.application)).toEqual(["ANDA203460"]);
    expect(plan.substitutes[0]!.packages[0]!.ndc).toBe("76045-001-20");
    // The model's unsupported "no substitute" sentence is replaced by a statement of the checks.
    expect(plan.claims.map((x) => x.text).join(" ")).not.toMatch(/No substitute/);
    expect(lines.some((l) => l.action === "guard_keep_verified_substitutes")).toBe(true);
  });

  it("reads the application number when the model adds the company name", async () => {
    const { c, ctx, lines } = setup();
    reply.value = { recommendation: "switch", substitutes: [{ application: "ANDA203460 FRESENIUS KABI USA LLC", reason: "AP rated, not on the shortage list." }], claims: [], confidence: 0.9 };
    const plan = await proposeSubstitutes(c, ctx);
    expect(plan.substitutes.map((s) => s.application)).toEqual(["ANDA203460"]);
    expect(plan.substitutes[0]!.reason).toMatch(/AP rated/);
    expect(lines.some((l) => l.action === "guard_keep_verified_substitutes" || l.action === "guard_remove_unsafe_substitute")).toBe(false);
  });
});
