import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Evidence, MemoryRow, OrderLine, RunResult, Status, TraceLine } from "./types";

const AGENT_LABEL: Record<string, string> = {
  Orchestrator: "Run",
  Planner: "Planner",
  Investigator: "Investigator",
  SourceScout: "Source scout",
  Substitution: "Substitution",
  EvidenceCritic: "Evidence critic",
  Writer: "Writer",
  Memory: "Memory",
};

const ACTION_TEXT: Record<OrderLine["action"], string> = {
  order_substitute: "Order a substitute",
  escalate: "Escalate to the pharmacy team: no interchangeable product is available",
  add_second_supplier: "Add a second supplier",
  expedite_or_reorder: "Reorder or chase your open order",
  watch: "Watch",
  no_action: "No action needed",
};

function daysClass(d: number | null) {
  if (d === null) return "days";
  if (d < 7) return "days urgent";
  if (d < 14) return "days soon";
  return "days ok";
}

function sourceLabel(e: Evidence) {
  switch (e.source) {
    case "hospital": return "Your stock";
    case "fda-shortage": return "FDA shortage list";
    case "fda-recall": return "FDA recall";
    case "orange-book": return "FDA Orange Book";
    case "fda-ndc": return "FDA product listing";
    default: return e.source;
  }
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bMg\b/g, "mg").replace(/\bMl\b/g, "mL");
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [trace, setTrace] = useState<TraceLine[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryRow[]>([]);
  const [evidence, setEvidence] = useState<Record<string, Evidence>>({});
  const [items, setItems] = useState(6);
  const [toast, setToast] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(() => fetch("/api/status").then((r) => r.json()).then(setStatus).catch(() => undefined), []);
  const loadMemory = useCallback(() => fetch("/api/memory").then((r) => r.json()).then(setMemory).catch(() => undefined), []);
  const loadEvidence = useCallback((runId: string) => fetch(`/api/runs/${runId}/evidence`).then((r) => (r.ok ? r.json() : [])).then((list: Evidence[]) => setEvidence(Object.fromEntries(list.map((e) => [e.id, e])))).catch(() => undefined), []);

  const listen = useCallback(() => {
    const es = new EventSource("/api/runs/live");
    es.addEventListener("trace", (ev) => setTrace((t) => [...t, JSON.parse((ev as MessageEvent).data) as TraceLine]));
    es.addEventListener("result", (ev) => {
      const r = JSON.parse((ev as MessageEvent).data) as RunResult;
      setResult(r);
      setRunning(false);
      loadEvidence(r.run_id);
      loadMemory();
      loadStatus();
      es.close();
    });
    es.addEventListener("error", (ev) => {
      const data = (ev as MessageEvent).data;
      if (data) { setError(JSON.parse(data).message); setRunning(false); es.close(); }
    });
    es.addEventListener("idle", () => es.close());
    return es;
  }, [loadEvidence, loadMemory, loadStatus]);

  useEffect(() => {
    loadMemory();
    // If a check is already running (opened in another tab, or the page was refreshed), follow it live;
    // otherwise show the most recent finished check.
    fetch("/api/status").then((r) => r.json()).then((st: Status) => {
      setStatus(st);
      if (st.running) {
        setRunning(true);
        setTrace([]);
        listen();
      } else {
        fetch("/api/runs/latest").then((r) => (r.ok ? r.json() : null)).then((r: RunResult | null) => {
          if (r) { setResult(r); setTrace(r.trace ?? []); loadEvidence(r.run_id); }
        });
      }
    }).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" }); }, [trace.length]);

  async function start() {
    setError(null);
    setTrace([]);
    setResult(null);
    setRunning(true);
    const r = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    if (!r.ok && r.status !== 409) { setError((await r.json()).error ?? "Could not start"); setRunning(false); return; }
    listen();
  }

  async function remember(kind: string, subject: string, item: string, note?: string) {
    await fetch("/api/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, subject, ...(item ? { item } : {}), ...(note ? { note } : {}) }) });
    setToast("Saved. The agents will apply this on every future check.");
    setTimeout(() => setToast(null), 3500);
    loadMemory();
    loadStatus();
  }

  const progress = useMemo(() => {
    const planned = trace.find((t) => t.action === "plan_investigation");
    const done = new Set(trace.filter((t) => t.agent_name === "EvidenceCritic" && t.verdict !== "revise").map((t) => t.item_id));
    const total = planned ? Number(planned.output_summary.match(/investigating the first (\d+)/)?.[1] ?? 0) : 0;
    return { done: done.size, total };
  }, [trace]);

  const decisions = memory.filter((m) => m.source === "buyer_decision");
  const runNotes = memory.filter((m) => m.source.startsWith("run:")).slice(0, 4);
  const urgent = result?.lines.filter((l) => ["order_substitute", "add_second_supplier", "escalate"].includes(l.action)).length ?? 0;

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" /><path d="M8 17h6l2-5 3 10 2-5h3" /></svg>
          </span>
          <div>
            <h1>Shortage Watch</h1>
            <p className="lede">Finds the drugs your hospital is about to run short of, explains why from FDA records, and tells you what to order instead.</p>
          </div>
        </div>
        <div className="status">
          <StatusPill ok={status?.zetaris.reachable !== false} label={status ? (status.mode === "sample" ? "Recorded sample run" : "Your stock and FDA data, via Zetaris") : "Checking data"} />
          <StatusPill ok={!!status && ["online", "sample", "fallback"].includes(status.llm.status)} label={status ? (status.llm.provider === "meterless" ? `Nemotron via Meterless (${status.llm.status})` : status.mode === "sample" ? "Model replies replayed" : "Nemotron via NVIDIA (backup)") : "Checking models"} />
          <StatusPill ok label={`${status?.memory.decisions ?? 0} saved decisions`} tone="memory" />
        </div>
      </header>

      <section className="action">
        <div>
          <h2>{result ? `This week: ${urgent} ${urgent === 1 ? "drug needs" : "drugs need"} a different order` : "Check this week's orders"}</h2>
          <p>{result ? `Checked ${new Date(result.finished_at).toLocaleString([], { weekday: "long", hour: "2-digit", minute: "2-digit" })}. Every line below is backed by the records it cites.` : "The agents read your stock levels, the FDA shortage and recall lists, and the FDA's list of interchangeable products."}</p>
        </div>
        <div className="run">
          <label>
            Drugs to check
            <select value={items} onChange={(e) => setItems(Number(e.target.value))} disabled={running}>
              {[4, 6, 8, 10].map((n) => <option key={n} value={n}>{n} most at risk</option>)}
            </select>
          </label>
          <button className="primary" onClick={start} disabled={running}>{running ? `Checking${progress.total ? ` ${progress.done} of ${progress.total}` : ""}...` : result ? "Check again" : "Check this week's orders"}</button>
        </div>
      </section>
      {error && <div className="alert">The check stopped: {error}</div>}

      <main className="grid">
        <section className="results" aria-label="Order list">
          {!result && !running && <EmptyState />}
          {running && !result && <Waiting trace={trace} />}
          {result?.lines.map((l) => <OrderCard key={l.item_id} line={l} evidence={evidence} onRemember={remember} />)}
        </section>

        <aside className="side">
          <div className="panel feed">
            <h3>How the agents worked</h3>
            <p className="hint">Each step reads real records through Zetaris. The evidence critic can send work back.</p>
            <div className="feed-list" ref={feedRef}>
              {trace.length === 0 && <p className="muted">Steps appear here while a check runs.</p>}
              {trace.map((t, i) => <FeedRow key={i} t={t} />)}
            </div>
          </div>

          <div className="panel memory">
            <h3>What Shortage Watch remembers</h3>
            {decisions.length === 0 && <p className="muted">No saved decisions yet. Use the buttons on a result to teach it your rules.</p>}
            <ul>
              {decisions.map((m) => <li key={m.id}><span className="dot" />{m.content.replace(/^Buyer decision: /, "")}</li>)}
            </ul>
            {runNotes.length > 0 && (
              <details>
                <summary>From earlier checks ({runNotes.length})</summary>
                <ul className="notes">{runNotes.map((m) => <li key={m.id}>{m.content}</li>)}</ul>
              </details>
            )}
            <p className="fine">Stored in Meterless H-MEM with an append-only audit ledger.</p>
          </div>
        </aside>
      </main>

      <footer>
        <p>Sample hospital stock and usage on real FDA-listed products. FDA data from openFDA (drug shortages, enforcement reports, NDC directory) and the FDA Orange Book. Decision support only: a pharmacist reviews every order.</p>
      </footer>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function StatusPill({ ok, label, tone }: { ok: boolean; label: string; tone?: "memory" }) {
  return <span className={`pill ${tone ?? ""} ${ok ? "" : "bad"}`}><i />{label}</span>;
}

function EmptyState() {
  return (
    <div className="empty">
      <h3>Nothing checked yet</h3>
      <p>Press "Check this week's orders". In a few minutes you get a short list: which drugs are running low, whether the FDA lists them as short, and an interchangeable product you can order instead.</p>
    </div>
  );
}

function Waiting({ trace }: { trace: TraceLine[] }) {
  const last = [...trace].reverse().find((t) => t.agent_name !== "Memory");
  return (
    <div className="empty waiting">
      <div className="spinner" aria-hidden />
      <h3>Checking your stock against the FDA</h3>
      <p>{last ? `${AGENT_LABEL[last.agent_name] ?? last.agent_name}: ${last.output_summary.slice(0, 180)}` : "Starting..."}</p>
    </div>
  );
}

function FeedRow({ t }: { t: TraceLine }) {
  const cls = t.status === "needs_revision" ? "revise" : t.status === "blocked" || t.status === "error" ? "block" : t.agent_name === "Memory" ? "mem" : t.agent_name === "SourceScout" ? "scout" : "";
  const what = t.agent_name === "EvidenceCritic" && t.verdict === "revise" ? `Sent back to ${t.target_agent}: ${t.output_summary.replace(/^revise: /, "")}` : t.output_summary;
  return (
    <div className={`feed-row ${cls}`}>
      <div className="who">{AGENT_LABEL[t.agent_name] ?? t.agent_name}{t.item_id !== null ? <span className="item">#{t.item_id}</span> : null}</div>
      <div className="what">{what.slice(0, 260)}</div>
      {t.model_routed && <div className="model">{t.model_routed}{t.latency_ms ? `, ${(t.latency_ms / 1000).toFixed(1)}s` : ""}</div>}
    </div>
  );
}

function OrderCard({ line, evidence, onRemember }: { line: OrderLine; evidence: Record<string, Evidence>; onRemember: (kind: string, subject: string, item: string, note?: string) => void }) {
  const [open, setOpen] = useState(false);
  const drugName = titleCase(line.drug.split(/\s+(?=[A-Z]{2,})/)[0] ?? line.drug);
  const strength = line.drug.replace(/^[a-z ]+\s/i, "").replace(/^[A-Z ]+(?=\d)/, "").trim();
  const ev = line.evidence_ids.map((id) => evidence[id]).filter(Boolean);
  const blocked = line.status === "blocked";
  return (
    <article className={`card ${blocked ? "blocked" : line.action}`}>
      <div className="card-top">
        <div>
          <h3>{drugName} <span className="strength">{strength}</span></h3>
          <p className="supplier">Current supplier: {line.current_supplier}</p>
        </div>
        <span className={daysClass(line.days_of_cover)}>{line.days_of_cover ?? "?"} days left</span>
      </div>

      {blocked ? (
        <div className="verdict block">Needs a manual check: the evidence did not hold up, so the agents made no recommendation.</div>
      ) : (
        <div className={`verdict ${line.action}`}>
          <strong>{ACTION_TEXT[line.action]}</strong>
          {line.order.map((o) => (
            <div key={o.application} className="order">
              {titleCase(o.supplier)} ({o.application}){o.ndcs.length ? `: NDC ${o.ndcs.slice(0, 3).join(", ")}` : ""}
            </div>
          ))}
        </div>
      )}

      <p className="headline">{line.headline}</p>
      {line.why && <p className="why">{line.why}</p>}

      <div className="card-actions">
        <button className="link" onClick={() => setOpen(!open)}>{open ? "Hide evidence" : `See the evidence (${ev.length || line.evidence_ids.length})`}</button>
        {!blocked && line.order.map((o) => (
          <button key={o.application} className="ghost" onClick={() => onRemember("avoid_supplier", titleCase(o.supplier).split(" ")[0]!, "")}>Never use {titleCase(o.supplier).split(" ")[0]}</button>
        ))}
        {!blocked && line.action !== "no_action" && (
          <button className="ghost" onClick={() => onRemember("already_ordered", `${drugName} ${strength}`.trim(), drugName, "Do not recommend another order until stock is back.")}>Already ordered</button>
        )}
      </div>

      {open && (
        <ul className="evidence">
          {blocked && line.blocked_reasons.map((r, i) => <li key={`b${i}`} className="reason">{r}</li>)}
          {ev.map((e) => (
            <li key={e.id}>
              <span className="src">{sourceLabel(e)}</span>
              <span>{e.summary}</span>
              {e.link && <a href={e.link} target="_blank" rel="noreferrer">Open record</a>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
