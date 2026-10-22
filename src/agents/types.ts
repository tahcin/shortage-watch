import type { Claim, EvidenceStore } from "../evidence.js";
import type { Trace } from "../trace.js";
import type { Item } from "../tools/hospital.js";
import type { ObRow, SubstituteCheck } from "../tools/fda.js";
import type { NdcRow } from "../tools/scout.js";

export type Risk = "supply_risk" | "recall" | "low_stock_only" | "no_risk";

export type Investigation = {
  item_id: number;
  risk: Risk;
  headline: string;
  claims: Claim[];
  needs_substitute: boolean;
  confidence: number;
  /** Set in code: our own package, product or application is limited or unavailable on the FDA list. */
  own_constrained: boolean;
  own_recalled: boolean;
};

export type SubstituteOption = {
  application: string;
  applicant: string;
  te_code: string;
  status: SubstituteCheck["verdict"];
  orderable_ndcs: string[];
  reason: string;
  evidence_ids: string[];
};

export type SubstitutionPlan = {
  item_id: number;
  recommendation: "switch" | "split" | "keep_current" | "no_safe_substitute";
  substitutes: SubstituteOption[];
  claims: Claim[];
  confidence: number;
};

export type CriticVerdict = {
  verdict: "approve" | "revise" | "block";
  target_agent: "investigator" | "substitution" | null;
  reasons: string[];
  blocked_claims: string[];
};

/** Everything the substitution step needs, gathered by tools before the model is asked anything. */
export type SubstituteFacts = {
  own: ObRow | null;
  equivalents: ObRow[];
  checks: Map<string, SubstituteCheck>;
  orderable: NdcRow[];
  /** Every product under the safe applications, before the strength filter (the critic uses it to name wrong-strength NDCs). */
  orderableAll: NdcRow[];
};

export type Memory = {
  id: string;
  content: string;
  /** Structured meaning the critic can enforce in code; free notes are only shown to the agents. */
  kind?: "avoid_supplier" | "prefer_supplier" | "already_ordered" | "note";
  subject?: string;
};

export type AgentContext = {
  store: EvidenceStore;
  trace: Trace;
  memories: Memory[];
};

export type ItemCase = {
  item: Item;
  investigation?: Investigation;
  facts?: SubstituteFacts;
  substitution?: SubstitutionPlan;
  critic?: CriticVerdict;
  retries: number;
  status: "pending" | "approved" | "blocked";
};
