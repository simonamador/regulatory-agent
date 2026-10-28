import { type ReactNode, useEffect, useState } from "react";
import { type AgentReport, type Audit, type Evals, getAgentReport, getEvals, postAudit } from "./api";
import { Conflict } from "./Conflict";
import { Correction } from "./Correction";
import { EvalTables } from "./EvalTables";
import { Regulation } from "./Regulation";
import { Trace } from "./Trace";

// One section of the storyboard: a folio letter on the grid's left column, the content on the right.
function Section({ folio, title, children }: { folio: string; title: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-12 gap-x-8 border-t border-ink pt-6 pb-16">
      <div className="col-span-2">
        <div className="text-[7rem] leading-[0.8] font-bold tracking-tighter">{folio}</div>
      </div>
      <div className="col-span-10">
        <h2 className="mb-6 text-2xl font-bold tracking-tight">{title}</h2>
        {children}
      </div>
    </section>
  );
}

export function App() {
  const [report, setReport] = useState<AgentReport | null>(null);
  const [evals, setEvals] = useState<Evals | null>(null);
  const [base, setBase] = useState<Audit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(String(e));
  const loadReport = () => getAgentReport().then(setReport, fail);

  useEffect(() => {
    void loadReport();
    getEvals().then(setEvals, fail);
    postAudit("base").then(setBase, fail);
  }, []);

  return (
    <main className="mx-auto max-w-[1360px] px-10 py-12 font-sans">
      <header className="mb-12 grid grid-cols-12 gap-x-8">
        <div className="col-span-2 text-sm font-bold">rqaudit</div>
        <div className="col-span-10">
          <h1 className="text-5xl font-bold tracking-tight">21 CFR 862.1355</h1>
          <p className="mt-2 text-lg text-muted">
            Integrated continuous glucose monitoring system: impact assessment of the regulation on the product requirements.
          </p>
        </div>
      </header>
      {error !== null && <p className="mb-8 border border-red p-4 text-red">{error}</p>}
      <Section folio="a" title="Regulation">
        {report === null ? <p>Loading the agent report…</p> : <Regulation key={report.file} report={report} onReload={loadReport} onError={fail} />}
      </Section>
      <Section folio="b" title="Design conflict">
        {base === null ? <p>Running the live audit…</p> : <Conflict audit={base} />}
      </Section>
      <Section folio="c" title="Correction">
        {base === null ? <p>Waiting for the base audit…</p> : <Correction base={base} onError={fail} />}
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
