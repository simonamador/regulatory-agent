import { useState } from "react";
import { type AgentReport, type Obligation, type Verdict, postAgentRun } from "./api";

// One accent: red is kept for conflicts; every other verdict is black, grey or outlined.
const CHIP: Record<Verdict, string> = {
  CONFLICT: "bg-red text-white border-red",
  DEAD: "bg-ink text-white border-ink",
  NOT_FORMALIZED: "border-ink text-ink",
  NEEDS_REVIEW: "border-ink border-dashed text-ink",
  CONSISTENT_BOUNDED: "bg-fill border-fill text-ink",
  NO_REQUIREMENT: "border-ink text-ink",
  OUT_OF_SCOPE: "border-rule text-muted",
};

function Chip({ verdict }: { verdict: Verdict }) {
  return <span className={`inline-block border px-2 py-0.5 text-[11px] font-bold tracking-wide ${CHIP[verdict]}`}>{verdict.replaceAll("_", " ")}</span>;
}

// The paragraph's context, the quote highlighted where it occurs. Ancestor lines are muted and clipped unless they hold it.
function Context({ context, quote }: { context: string; quote: string | null }) {
  const lines = context.split("\n");
  return (
    <div className="space-y-1 text-sm leading-snug">
      {lines.map((line, i) => {
        const at = quote === null || quote === "" ? -1 : line.indexOf(quote);
        const own = i === lines.length - 1;
        const className = own ? "text-ink" : at === -1 ? "line-clamp-1 text-muted" : "text-muted";
        if (at === -1 || quote === null) return <p key={i} className={className}>{line}</p>;
        return (
          <p key={i} className={className}>
            {line.slice(0, at)}
            <mark className="bg-ink px-0.5 text-white">{quote}</mark>
            {line.slice(at + quote.length)}
          </p>
        );
      })}
    </div>
  );
}

function Row({ o, context, texts }: { o: Obligation; context: string; texts: Map<string, string> }) {
  return (
    <li className="grid grid-cols-1 gap-y-3 border-t border-rule py-4 md:grid-cols-10 md:gap-x-6">
      <div className="text-sm font-bold md:col-span-1">{o.paragraph}</div>
      <div className="md:col-span-5">
        <Context context={context} quote={o.quote} />
        {o.rationale !== null && o.rationale !== "" && <p className="mt-2 text-xs text-muted">{o.rationale}</p>}
      </div>
      <div className="space-y-2 text-xs md:col-span-2">
        <div className="font-bold uppercase tracking-wide">{o.category ?? "no item"}</div>
        {o.implemented_by.length === 0 && <div className="text-muted">No requirement mapped</div>}
        {o.implemented_by.map((id) => (
          <div key={id}>
            <span className="font-bold">{id}</span> <span className="text-muted">{texts.get(id) ?? "unknown requirement"}</span>
          </div>
        ))}
      </div>
      <div className="space-y-1 md:col-span-2">
        <Chip verdict={o.verdict} />
        {o.reasons.length > 0 && <div className="text-xs text-muted">{o.reasons.join(", ")}</div>}
        {o.contributions.length > 1 &&
          o.contributions.map((c) => (
            <div key={c.requirement} className="text-xs text-muted">{`${c.requirement}: ${c.verdict.replaceAll("_", " ")}`}</div>
          ))}
      </div>
    </li>
  );
}

export function Regulation({ report, onReload, onError }: { report: AgentReport; onReload: () => Promise<void>; onError: (e: unknown) => void }) {
  const [runIndex, setRunIndex] = useState(0);
  const [filter, setFilter] = useState<Verdict | "ALL" | "IN_SCOPE">("IN_SCOPE");
  const [live, setLive] = useState(false);
  const run = report.runs[runIndex];
  if (run === undefined) return <p>The agent report has no runs.</p>;
  const contexts = new Map(report.leaves.map((l) => [l.id, l.context]));
  const texts = new Map(report.requirements.map((r) => [r.id, r.text]));
  const verdicts = [...new Set(run.obligations.map((o) => o.verdict))];
  const counts = verdicts.map((v) => [v, run.obligations.filter((o) => o.verdict === v).length] as const);
  const inScope = run.obligations.filter((o) => o.verdict !== "OUT_OF_SCOPE");
  const shown = filter === "IN_SCOPE" ? inScope : run.obligations.filter((o) => filter === "ALL" || o.verdict === filter);
  const runLive = () => {
    setLive(true);
    postAgentRun().then(onReload, onError).finally(() => setLive(false));
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end gap-8 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wide">Agent run</span>
          <select className="border border-ink px-2 py-1" value={runIndex} onChange={(e) => setRunIndex(Number(e.target.value))}>
            {report.runs.map((r, i) => <option key={r.run} value={i}>{`Run ${r.run} of ${report.runs.length} · ${r.status}`}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wide">Verdict</span>
          <select className="border border-ink px-2 py-1" value={filter} onChange={(e) => setFilter(e.target.value as Verdict | "ALL" | "IN_SCOPE")}>
            <option value="IN_SCOPE">{`Excluding out of scope (${inScope.length})`}</option>
            <option value="ALL">{`All (${run.obligations.length})`}</option>
            {counts.map(([v, n]) => <option key={v} value={v}>{`${v.replaceAll("_", " ")} (${n})`}</option>)}
          </select>
        </label>
        <div className="text-xs text-muted">{`${report.file} · ${report.model}`}</div>
        <div className="ml-auto flex flex-col items-end gap-1">
          <button
            className="border border-ink px-3 py-1 font-bold disabled:border-rule disabled:text-muted"
            disabled={!report.live_available || live}
            title={report.live_available ? "One real agent run, written to runs/" : "OPENAI_API_KEY is not set"}
            onClick={runLive}
          >
            {live ? "Running the agent…" : "Run agent live"}
          </button>
          {!report.live_available && <span className="text-xs text-muted">Runs locally, with an OpenAI API key</span>}
        </div>
      </div>
      <ul className="border-b border-rule">
        {shown.map((o) => <Row key={o.paragraph} o={o} context={contexts.get(o.paragraph) ?? ""} texts={texts} />)}
      </ul>
    </div>
  );
}
