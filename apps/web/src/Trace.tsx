import { useState } from "react";
import { type AgentReport, fixed, seconds } from "./api";

const th = "border-b border-ink py-2 pr-6 text-left text-xs font-bold uppercase tracking-wide";
const td = "border-b border-rule py-1.5 pr-6 align-top";

export function Trace({ report }: { report: AgentReport }) {
  const [runIndex, setRunIndex] = useState(0);
  const run = report.runs[runIndex];
  if (run === undefined) return <p>The agent report has no runs.</p>;
  return (
    <div className="space-y-10">
      <table className="w-full text-sm">
        <thead>
          <tr>{["Run", "Status", "Turns", "Tool calls", "Tokens in", "Tokens out", "Latency", "Reasoning effort", "Temperature"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {report.runs.map((r, i) => (
            <tr key={r.run} className={i === runIndex ? "font-bold" : ""}>
              <td className={td}>
                <button className="underline" onClick={() => setRunIndex(i)}>{`Run ${r.run}`}</button>
              </td>
              <td className={td}>{r.status}</td>
              <td className={td}>{r.turns}</td>
              <td className={td}>{r.tool_calls}</td>
              <td className={td}>{r.tokens.prompt}</td>
              <td className={td}>{r.tokens.completion}</td>
              <td className={td}>{seconds(r.latency_ms)}</td>
              <td className={td}>{r.reasoning_effort ?? "—"}</td>
              <td className={td} title={r.temperature_error ?? undefined}>{r.temperature === null ? "not supported" : fixed(r.temperature, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <h3 className="mb-4 text-lg font-bold">{`Tool calls of run ${run.run}`}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr>{["Turn", "Tool", "Arguments", "Latency"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {run.trace.map((call, i) => (
              <tr key={i}>
                <td className={td}>{call.turn}</td>
                <td className={`${td} font-bold`}>{call.tool}</td>
                <td className={`${td} break-all text-muted`}>{JSON.stringify(call.arguments)}</td>
                <td className={td}>{`${Math.round(call.latency_ms)} ms`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
