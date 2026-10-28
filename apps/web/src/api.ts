// Shapes of the storyboard API (apps/api/src/server.ts).
export type Verdict =
  | "CONFLICT" | "DEAD" | "NOT_FORMALIZED" | "CONSISTENT_BOUNDED" | "NO_REQUIREMENT" | "OUT_OF_SCOPE" | "NEEDS_REVIEW";
type Requirement = { id: string; text: string; status: string };
export type Core = { check: string; scenario: string | null; core: string[] };
export type Obligation = {
  paragraph: string;
  category: string | null;
  quote: string | null;
  implemented_by: string[];
  rationale: string | null;
  verdict: Verdict;
  reasons: string[];
  contributions: { requirement: string; verdict: Verdict; finding_ref: string | null }[];
};
type Summary = Record<string, number | null>;
export type AgentReport = {
  file: string;
  model: string;
  leaves: { id: string; context: string }[];
  requirements: Requirement[];
  live_available: boolean;
  runs: {
  run: number;
  status: string;
  latency_ms: number;
  tokens: { prompt: number; completion: number };
  turns: number;
  tool_calls: number;
  temperature: number | null;
  temperature_error: string | null;
  reasoning_effort: string | null;
  trace: { turn: number; tool: string; arguments: unknown; latency_ms: number }[];
  obligations: Obligation[];
  design_conflicts: Core[];
  }[];
};
export type Timeline = {
  tick_s: number;
  ticks: number;
  mode: (string | null)[];
  signals: Record<string, (boolean | null)[]>;
  rows: { requirement: string; kind: "forbidden" | "required"; response: string; ticks: number[] }[];
};
export type Audit = {
  snapshot: string;
  snapshots: string[];
  audit_ms: number;
  load_findings: { subject: string | null; message: string | null }[];
  requirements: Requirement[];
  conflicts: (Core & { timeline: Timeline })[];
  regression: null | { introduced: Core[]; resolved: Core[]; persistent: Core[]; changed_requirements: string[] };
};
export type Evals = {
  eval: {
    run_id: string;
    protocol_version: number;
    model: string;
    rescore_run_id: string | null;
    audit_latency_ms: { cold_first_audit_ms: number; audits: number; warmup_audits: number; p50: number; p95: number };
    rows: { variant: string; run: number; precision: number | null; recall: number | null; f1: number | null; core_exact: number | null; fpr_sat: number | null }[];
  };
  agent: { run_id: string; at_run_time: Summary; rescored: Summary; gold_at_run_time: string | null; gold_rescored: string | null };
};

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.url}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
const post = (url: string, body?: object) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

export type Health = { ready: boolean; rss_mb: number; audits_served: number };
export const getHealth = () => fetch("/api/health").then((r) => json<Health>(r));
export const getAgentReport = () => fetch("/api/agent-report").then((r) => json<AgentReport>(r));
export const getEvals = () => fetch("/api/evals").then((r) => json<Evals>(r));
export const postAudit = (snapshot: string) => post("/api/audit", { snapshot }).then((r) => json<Audit>(r));
export const postAgentRun = () => post("/api/agent-run").then((r) => json<{ run_id: string }>(r));

// null is shown as an em dash, never as a number.
export const fixed = (x: number | null | undefined, digits = 3) => (x === null || x === undefined ? "—" : x.toFixed(digits));
export const seconds = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(2)} s`);
