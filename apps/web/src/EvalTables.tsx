import { type Evals, fixed, seconds } from "./api";

const th = "border-b border-ink py-2 pr-6 text-left text-xs font-bold uppercase tracking-wide";
const td = "border-b border-rule py-2 pr-6";

// Agent metrics in the order SPEC §10 lists them.
const AGENT_ROWS: [string, string, (x: number | null | undefined) => string][] = [
  ["category_accuracy", "Category accuracy", (x) => fixed(x)],
  ["mapping_precision", "Mapping precision", (x) => fixed(x)],
  ["mapping_recall", "Mapping recall", (x) => fixed(x)],
  ["gap_recall", "Gap recall", (x) => fixed(x)],
  ["valid_quote_rate", "Valid quotes", (x) => fixed(x)],
  ["invented_ids", "Invented ids", (x) => fixed(x, 0)],
  ["verdict_accuracy", "Verdict accuracy", (x) => fixed(x)],
  ["needs_review", "Needs review", (x) => fixed(x, 0)],
  ["agreement", "Agreement across runs", (x) => fixed(x)],
  ["valid_runs", "Valid runs", (x) => fixed(x, 0)],
  ["latency_ms", "Mean latency per run", seconds],
  ["tokens_in", "Tokens in", (x) => fixed(x, 0)],
  ["tokens_out", "Tokens out", (x) => fixed(x, 0)],
];

export function EvalTables({ evals }: { evals: Evals }) {
  const { eval: e, agent } = evals;
  const latency = e.audit_latency_ms;
  return (
    <div className="space-y-12">
      <div>
        <h3 className="text-lg font-bold">{`Variants A/B/C · protocol v${e.protocol_version}`}</h3>
        <p className="mb-4 text-sm text-muted">
          {`A: rule-based linter. B: the LLM judges alone. C: the LLM extracts, Z3 decides. ${e.model} · runs/${e.run_id}.json · rescore ${e.rescore_run_id ?? "none"}`}
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr>{["Variant", "Run", "Precision", "Recall", "F1", "Core exact", "False positive rate on SAT"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {e.rows.map((r) => (
              <tr key={`${r.variant}-${r.run}`}>
                <td className={`${td} font-bold`}>{r.variant}</td>
                <td className={td}>{r.run}</td>
                <td className={td}>{fixed(r.precision)}</td>
                <td className={td}>{fixed(r.recall)}</td>
                <td className={`${td} font-bold`}>{fixed(r.f1)}</td>
                <td className={td}>{fixed(r.core_exact)}</td>
                <td className={td}>{fixed(r.fpr_sat)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-sm text-muted">
          {`Audit latency: first audit ${seconds(latency.cold_first_audit_ms)}, then ${latency.warmup_audits} warm-up and ${latency.audits} measured: p50 ${seconds(latency.p50)}, p95 ${seconds(latency.p95)}.`}
        </p>
      </div>
      <div>
        <h3 className="text-lg font-bold">Regulatory agent</h3>
        <p className="mb-4 text-sm text-muted">
          {`runs/agent-${agent.run_id}.json, scored against the gold in force at run time and rescored against the current gold. Columns name each gold by its sha256 and the commit that introduced it.`}
        </p>
        <table className="w-full max-w-3xl text-sm">
          <thead>
            <tr>
              <th className={th}>Metric</th>
              {/* A sha256 is case-sensitive text: the label stays out of the header's uppercase. */}
              <th className={th}>Gold at run time <span className="block font-normal normal-case">{agent.gold_at_run_time ?? "not recorded (the run predates gold_sha256)"}</span></th>
              <th className={th}>Rescored <span className="block font-normal normal-case">{agent.gold_rescored ?? "not recorded"}</span></th>
            </tr>
          </thead>
          <tbody>
            {AGENT_ROWS.map(([key, name, format]) => (
              <tr key={key}>
                <td className={td}>{name}</td>
                <td className={td}>{format(agent.at_run_time[key])}</td>
                <td className={`${td} font-bold`}>{format(agent.rescored[key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
