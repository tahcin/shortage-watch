import type { Claim, EvidenceStore } from "../evidence.js";
import type { Trace } from "../trace.js";
import type { Item } from "../tools/hospital.js";
import type { ObRow, SubstituteCheck } from "../tools/fda.js";
import type { Pkg } from "../tools/scout.js";

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
  /** From our own FDA shortage record, when listed: "January 2027" etc. */
  next_delivery: string | null;
  estimated_recovery: string | null;
  /** Context, not our risk: other presentations from our maker, and other makers of the drug. */
  maker_constrained: number;
  market_constrained: number;
  market_total: number;
};

export type OrderPackage = { ndc: string; labeler: string; description: string; fda_status: string };

export type SubstituteOption = {
  application: string;
  applicant: string;
  te_code: string;
  status: SubstituteCheck["verdict"];
  /** Filled in code from the substitute's own listings at our concentration, closest presentation first. */
  packages: OrderPackage[];
  notes: string[];
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
  /** Our own package as listed in the NDC directory (volume, container, DEA schedule), when found. */
  ownPackage: Pkg | null;
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
  /** Buyer decisions that changed this item's outcome (shown on the card). */
  memory_applied?: string[];
};
