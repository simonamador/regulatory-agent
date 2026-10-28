import { type ReactNode, useEffect, useState } from "react";
import { type AgentReport, type Audit, type Evals, type Health, getAgentReport, getEvals, getHealth, postAudit } from "./api";
import { Conflict } from "./Conflict";
import { Correction } from "./Correction";
import { EvalTables } from "./EvalTables";
import { Regulation } from "./Regulation";
import { Trace } from "./Trace";

// One section of the storyboard: a folio letter on the grid's left column, the content on the right.
// Below md the grid collapses to one column, folio above content.
function Section({ folio, title, children }: { folio: string; title: string; children: ReactNode }) {
  return (
    <section className="border-t border-ink pt-6 pb-16 md:grid md:grid-cols-12 md:gap-x-8">
      <div className="mb-4 md:col-span-2 md:mb-0">
        <div className="text-[4rem] leading-[0.8] font-bold tracking-tighter md:text-[7rem]">{folio}</div>
      </div>
      <div className="min-w-0 md:col-span-10">
        <h2 className="mb-6 text-2xl font-bold tracking-tight">{title}</h2>
        {children}
      </div>
    </section>
  );
}

function SolverStatus({ health }: { health: Health | null }) {
  if (health === null) return <p className="mt-4 text-xs text-muted">Warming up the solver instance…</p>;
  const served = `${health.audits_served} ${health.audits_served === 1 ? "audit" : "audits"} served`;
  return <p className="mt-4 text-xs text-muted">{`Solver instance ready · ${health.rss_mb} MB resident · ${served}`}</p>;
}

export function App() {
  const [report, setReport] = useState<AgentReport | null>(null);
  const [evals, setEvals] = useState<Evals | null>(null);
  const [base, setBase] = useState<Audit | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(String(e));
  const loadReport = () => getAgentReport().then(setReport, fail);
  const loadHealth = () => getHealth().then(setHealth, fail);

  // The health call warms the solver instance up (lazily, on serverless); the base audit follows it.
  useEffect(() => {
    void loadReport();
    getEvals().then(setEvals, fail);
    loadHealth()
      .then(() => postAudit("base"))
      .then(setBase, fail)
      .finally(() => void loadHealth());
  }, []);

  return (
    <main className="mx-auto max-w-[1360px] px-4 py-8 font-sans md:px-10 md:py-12">
      <header className="mb-12 md:grid md:grid-cols-12 md:gap-x-8">
        <div className="mb-4 text-sm font-bold md:col-span-2 md:mb-0">rqaudit</div>
        <div className="md:col-span-10">
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl">21 CFR 862.1355</h1>
          <p className="mt-2 text-lg text-muted">
            Integrated continuous glucose monitoring system: impact assessment of the regulation on the product requirements.
          </p>
          <SolverStatus health={health} />
        </div>
      </header>
      {error !== null && <p className="mb-8 border border-red p-4 text-red">{error}</p>}
      <Section folio="a" title="Design conflict">
        {base === null ? <p>Running the live audit…</p> : <Conflict audit={base} />}
      </Section>
      <Section folio="b" title="Correction">
        {base === null ? <p>Waiting for the base audit…</p> : <Correction base={base} onError={fail} onAudited={loadHealth} />}
      </Section>
      <Section folio="c" title="Regulation">
        {report === null ? <p>Loading the agent report…</p> : <Regulation key={report.file} report={report} onReload={loadReport} onError={fail} />}
      </Section>
      <Section folio="d" title="Evals">
        {evals === null ? <p>Loading runs…</p> : <EvalTables evals={evals} />}
      </Section>
      <Section folio="e" title="Agent trace">
        {report === null ? <p>Loading the agent report…</p> : <Trace key={report.file} report={report} />}
      </Section>
    </main>
  );
}
