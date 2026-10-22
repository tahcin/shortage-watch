import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codeChecks } from "../src/agents/critic.js";
import { proposeSubstitutes } from "../src/agents/substitution.js";
import type { AgentContext, ItemCase } from "../src/agents/types.js";
import { EvidenceStore } from "../src/evidence.js";
import { BuyerMemory } from "../src/memory/buyerMemory.js";
import type { Item } from "../src/tools/hospital.js";
import type { TraceLine } from "../src/trace.js";

// The user-facing Meterless H-MEM feature end to end: a decision saved in a real H-MEM store changes
// what the Substitution step may recommend, and the critic enforces it.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const item: Item = {
  item_id: 16, generic_name: "hydromorphone", strength: "HYDROMORPHONE HYDROCHLORIDE 1 mg/mL", dosage_form: "INJECTION", route: "INTRAVENOUS",
  package_ndc: "63323-852-25", product_ndc: "63323-852", labeler: "Fresenius Kabi USA, LLC", application_number: "NDA019034", therapeutic_class: "",
  is_critical: true, on_hand_units: 50, avg_daily_use: 9.6, days_of_cover: 5.2, open_orders: [],
};

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "hmem-"));
  dirs.push(dir);
  const memory = new BuyerMemory("test", dir);
  const lines: TraceLine[] = [];
  const store = new EvidenceStore();
  const ctx: AgentContext = { store, trace: { log: (l: TraceLine) => { lines.push(l); return l; } } as never, memories: [] };
  const c: ItemCase = {
    item, retries: 0, status: "pending",
    facts: {
      own: null,
      equivalents: [{ ingredient: "HYDROMORPHONE HYDROCHLORIDE", df_route: "INJECTABLE;INJECTION", trade_name: "HYDROMORPHONE", applicant: "HIKMA", applicant_full_name: "HIKMA PHARMACEUTICALS USA INC", strength: "1MG/ML", appl_type: "A", appl_no: "216899", product_no: "003", te_code: "AP", type: "RX" }],
      checks: new Map([["ANDA216899", { appl: "ANDA216899", applicant: "HIKMA PHARMACEUTICALS USA INC", packages: [{ pkg: { ndc: "0641-6169-10", product_ndc: "0641-6169", labeler: "Hikma Pharmaceuticals USA Inc.", application_number: "ANDA216899", strength: "1 mg/mL", description: "1 mL in 1 VIAL", volume_ml: 1, container: "VIAL", dea_schedule: "CII" }, availability: null }], shortage: [], recalls: [], verdict: "clear" as const, preservative_note: null }]]),
      ownPackage: null,
    },
  };
  return { memory, ctx, c, lines };
}

describe("buyer memory on Meterless H-MEM", () => {
  it("persists a decision and re-injects it on the next run", () => {
    const { memory } = setup();
    memory.remember({ kind: "avoid_supplier", subject: "Hikma" });
    const reopened = new BuyerMemory("test", memory.dir);
    const recalled = reopened.recallForRun([item]);
    expect(recalled.some((m) => m.kind === "avoid_supplier" && m.subject === "Hikma")).toBe(true);
  });

  it("removes a ruled-out supplier before ranking and says why", async () => {
    const { memory, ctx, c, lines } = setup();
    memory.remember({ kind: "avoid_supplier", subject: "Hikma" });
    ctx.memories = memory.recallForRun([item]);
    // Hikma is the only safe equivalent, so no model call is needed: code returns no_safe_substitute.
    const plan = await proposeSubstitutes(c, ctx);
    expect(plan.recommendation).toBe("no_safe_substitute");
    expect(plan.substitutes).toHaveLength(0);
    expect(plan.claims[0]!.text).toMatch(/ruled this supplier out/);
    expect(c.memory_applied).toEqual(["never switch to Hikma."]);
    expect(lines.some((l) => l.action === "apply_buyer_decision")).toBe(true);
  });

  it("the critic rejects a ruled-out supplier even if one slipped through", () => {
    const { memory, ctx, c } = setup();
    memory.remember({ kind: "avoid_supplier", subject: "Hikma" });
    ctx.memories = memory.recallForRun([item]);
    c.substitution = { item_id: 16, recommendation: "split", confidence: 0.8, claims: [], substitutes: [{ application: "ANDA216899", applicant: "HIKMA PHARMACEUTICALS USA INC", te_code: "AP", status: "clear", packages: [{ ndc: "0641-6169-10", labeler: "Hikma", description: "1 mL vial", fda_status: "not on the FDA shortage list" }], notes: [], reason: "", evidence_ids: [] }] };
    expect(codeChecks(c, ctx).some((p) => /ruled out Hikma/.test(p.reason))).toBe(true);
  });

  it("writes every decision to the append-only H-MEM ledger", () => {
    const { memory } = setup();
    const rec = memory.remember({ kind: "avoid_supplier", subject: "Hikma" });
    const history = memory.hmem.ledger.history(rec.id);
    expect(history.length).toBeGreaterThan(0);
  });
});
