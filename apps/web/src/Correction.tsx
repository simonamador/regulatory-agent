import { useState } from "react";
import { type Audit, type Core, postAudit, seconds } from "./api";

function Findings({ title, findings }: { title: string; findings: Core[] }) {
  return (
    <div className="border-t border-ink pt-2">
      <div className="text-xs font-bold uppercase tracking-wide">{`${title} (${findings.length})`}</div>
      {findings.length === 0 && <p className="mt-1 text-sm text-muted">none</p>}
      {findings.map((f) => (
        <p key={`${f.check}-${f.scenario}-${f.core.join()}`} className="mt-1 text-sm">{`${f.check} · ${f.scenario ?? "no scenario"} · ${f.core.join(", ")}`}</p>
      ))}
    </div>
  );
}

// The regression against base, plus which requirement texts were edited: an edit with the same formal changes nothing.
function Regression({ base, result }: { base: Audit; result: Audit }) {
  if (result.regression === null) return null;
  const { resolved, introduced, persistent, changed_requirements } = result.regression;
  const before = new Map(base.requirements.map((r) => [r.id, r.text]));
  const edited = result.requirements.filter((r) => before.get(r.id) !== r.text);
  return (
    <div className="mt-6 space-y-6">
      {result.load_findings.map((f) => <p key={f.subject} className="border border-red p-2 text-sm text-red">{`PARSE_ERROR ${f.subject ?? ""}: ${f.message ?? ""}`}</p>)}
      <p className="text-sm text-muted">{`Live audit of ${result.snapshot}, answered in ${seconds(result.audit_ms)}, then the regression of every scenario against base.`}</p>
      <div className="grid grid-cols-3 gap-8">
        <Findings title="Resolved" findings={resolved} />
        <Findings title="Introduced" findings={introduced} />
        <Findings title="Persistent" findings={persistent} />
      </div>
      <div className="border-t border-ink pt-2">
        <div className="text-xs font-bold uppercase tracking-wide">Changed requirements (formal reading)</div>
        <p className="mt-1 text-sm">{changed_requirements.length === 0 ? "none" : changed_requirements.join(", ")}</p>
      </div>
      {edited.map((r) => (
        <div key={r.id} className="grid grid-cols-2 gap-8 border-t border-rule pt-2 text-sm">
          <div>
            <div className="text-xs font-bold">{`${r.id} in base`}</div>
            <p className="mt-1 text-muted">{before.get(r.id)}</p>
          </div>
          <div>
            <div className="text-xs font-bold">{`${r.id} in ${result.snapshot}`}</div>
            <p className="mt-1">{r.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Correction({ base, onError, onAudited }: { base: Audit; onError: (e: unknown) => void; onAudited: () => Promise<void> }) {
  const options = base.snapshots.filter((s) => s !== "base");
  const [snapshot, setSnapshot] = useState(options[0] ?? "");
  const [result, setResult] = useState<Audit | null>(null);
  const [running, setRunning] = useState(false);
  const run = () => {
    setRunning(true);
    postAudit(snapshot)
      .then(setResult, onError)
      .finally(() => {
        setRunning(false);
        void onAudited();
      });
  };
  return (
    <div>
      <div className="flex items-end gap-4 text-sm">
        <span className="pb-1 font-bold">base →</span>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold uppercase tracking-wide">Snapshot</span>
          <select className="border border-ink px-2 py-1" value={snapshot} onChange={(e) => setSnapshot(e.target.value)}>
            {options.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <button className="border border-ink bg-ink px-3 py-1 font-bold text-white disabled:bg-white disabled:text-muted" disabled={running} onClick={run}>
          {running ? "Running the audit…" : "Run audit"}
        </button>
      </div>
      {result !== null && <Regression base={base} result={result} />}
    </div>
  );
}
