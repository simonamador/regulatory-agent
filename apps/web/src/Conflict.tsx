import type { CSSProperties } from "react";
import { type Audit, type Timeline, seconds } from "./api";

const cell = "h-7 border-l border-rule";

// One column per tick. Forbidden is solid black, required is outlined; red marks only the ticks where a response
// is both required and forbidden, which is the conflict itself.
function Grid({ t, scenario }: { t: Timeline; scenario: string | null }) {
  const ticks = Array.from({ length: t.ticks }, (_, k) => k);
  const minute = (k: number) => (k * t.tick_s) / 60;
  const has = (kind: string, response: string, k: number) => t.rows.some((r) => r.kind === kind && r.response === response && r.ticks.includes(k));
  const responses = [...new Set(t.rows.map((r) => r.response))];
  const clash = ticks.filter((k) => responses.some((s) => has("required", s, k) && has("forbidden", s, k)));
  // A tick never narrows below 0.75rem: on a phone the timeline scrolls inside its own box, not the page.
  const columns: CSSProperties = { gridTemplateColumns: `14rem repeat(${t.ticks}, minmax(0.75rem, 1fr))` };
  const label = "pr-3 text-xs font-bold self-center";

  return (
    <div className="mt-8 border-y border-ink text-xs">
      <div className="grid overflow-x-auto" style={columns}>
        <div className={label}>Minute</div>
        {ticks.map((k) => <div key={k} className="h-7 pt-1 text-[10px] text-muted">{minute(k) % 5 === 0 ? minute(k) : ""}</div>)}

        <div className={label}>{`Mode (${scenario ?? "no scenario"})`}</div>
        {ticks.map((k) => {
          const start = k === 0 || t.mode[k - 1] !== t.mode[k];
          return (
            <div key={k} className={`${cell} relative ${t.mode[k] === "WARMUP" ? "bg-fill" : ""} ${start ? "border-l-ink" : ""}`}>
              {start && <span className="absolute left-1 top-1.5 z-10 whitespace-nowrap font-bold">{t.mode[k] ?? "free"}</span>}
            </div>
          );
        })}

        {Object.entries(t.signals).map(([signal, values]) => [
          <div key={`${signal}-label`} className={label}>{signal}</div>,
          ...ticks.map((k) => <div key={`${signal}-${k}`} className={`${cell} ${values[k] === true ? "bg-ink" : ""}`} />),
        ])}

        {t.rows.map((r) => [
          <div key={`${r.requirement}-label`} className={label}>{`${r.requirement} ${r.kind === "forbidden" ? "forbids" : "requires"} ${r.response}`}</div>,
          ...ticks.map((k) => {
            const on = r.ticks.includes(k);
            const fill = r.kind === "forbidden" ? "bg-ink" : "border-2 border-ink";
            return <div key={`${r.requirement}-${k}`} className={`${cell} ${on ? fill : ""}`} />;
          }),
        ])}

        <div className={`${label} text-red`}>Required and forbidden</div>
        {ticks.map((k) => <div key={`clash-${k}`} className={`${cell} ${clash.includes(k) ? "bg-red" : ""}`} />)}
      </div>
      <p className="border-t border-rule py-2 text-muted">
        {clash.length === 0
          ? "No minute is both required and forbidden."
          : `Minutes ${minute(clash[0] ?? 0)}–${minute(clash.at(-1) ?? 0)}: the alert is required and forbidden at once.`}
      </p>
    </div>
  );
}

export function Conflict({ audit }: { audit: Audit }) {
  const texts = new Map(audit.requirements.map((r) => [r.id, r.text]));
  return (
    <div>
      <p className="text-sm text-muted">
        {`Live audit of the ${audit.snapshot} corpus with Z3, answered in ${seconds(audit.audit_ms)}: consistency, every scenario, vacuity and equivalence.`}
      </p>
      {audit.load_findings.map((f) => <p key={f.subject} className="mt-4 border border-red p-2 text-sm text-red">{`PARSE_ERROR ${f.subject ?? ""}: ${f.message ?? ""}`}</p>)}
      {audit.conflicts.length === 0 && <p className="mt-4">The audit found no design conflict.</p>}
      {audit.conflicts.map((c) => (
        <div key={`${c.check}-${c.scenario}`} className="mt-6">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-sm font-bold">{`${c.check} · ${c.scenario ?? "no scenario"} · UNSAT core`}</span>
            {c.core.map((id) => <span key={id} className="border border-red px-2 py-0.5 text-xs font-bold text-red">{id}</span>)}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-8">
            {c.core.filter((id) => texts.has(id)).map((id) => (
              <div key={id} className="border-t border-ink pt-2">
                <div className="text-sm font-bold">{id}</div>
                <p className="mt-1 text-base leading-snug">{texts.get(id)}</p>
              </div>
            ))}
          </div>
          <Grid t={c.timeline} scenario={c.scenario} />
        </div>
      ))}
    </div>
  );
}
