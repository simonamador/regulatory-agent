import { type Corpus, type Finding, audit } from "@rqaudit/core";
import { z } from "zod";

export type Leaf = { id: string; context: string };

// Deterministic, no LLM (SPEC §10). One paragraph per line, marked "(b)", "(1)", "(i)" or "(A)" for levels 1–4.
// A lowercase marker is a roman numeral (level 3) under a level-2 paragraph, else a level-1 letter.
function level(label: string, depth: number) {
  if (/^\d+$/.test(label)) return 2;
  if (/^[A-Z]+$/.test(label)) return 4;
  return /^[ivxl]+$/.test(label) && depth >= 2 ? 3 : 1;
}

// Leaf paragraphs, (a) excluded; a leaf's context is its ancestors' text plus its own (tests/gold/obligations.json).
export function parseRegulation(text: string): Leaf[] {
  const path: { label: string; line: string }[] = [];
  const nodes: (Leaf & { parent: string | null })[] = [];
  for (const line of text.split(/\r?\n/)) {
    const label = /^\(([A-Za-z0-9]+)\) /.exec(line)?.[1];
    if (label === undefined) continue;
    path.splice(level(label, path.length) - 1);
    const parent = path.length === 0 ? null : path.map((p) => `(${p.label})`).join("");
    path.push({ label, line });
    nodes.push({ id: path.map((p) => `(${p.label})`).join(""), context: path.map((p) => p.line).join("\n"), parent });
  }
  const parents = new Set(nodes.map((n) => n.parent));
  return nodes.filter((n) => !parents.has(n.id) && !n.id.startsWith("(a)")).map(({ id, context }) => ({ id, context }));
}

// The requirements a finding is about: core ids (TRIGGER:<id> included), unverified tails, a requirement subject,
// the requirement of an interpretation, and every approved requirement for an UNKNOWN consistency or
// scenario_conflict, since all of them were in that solve (SPEC §10).
export function concerns(f: Finding, corpus: Corpus): string[] {
  const interpretation = corpus.interpretations.find((i) => i.id === f.subject)?.requirement_id;
  const solvedTogether = f.status === "UNKNOWN" && f.subject === null;
  const ids = [
    ...f.core.map((id) => id.replace(/^TRIGGER:/, "")),
    ...f.unverified.map((u) => u.requirement),
    f.subject,
    interpretation,
    ...(solvedTogether ? corpus.requirements.filter((r) => r.status === "approved").map((r) => r.id) : []),
  ];
  return corpus.requirements.map((r) => r.id).filter((id) => ids.includes(id));
}

// Witness summary in ticks: mode runs [from, to) and the ticks where each signal is true.
function summary(witness: Finding["witness"]) {
  if (witness === null) return null;
  const modes: { mode: string; from: number; to: number }[] = [];
  witness.forEach(({ mode }, k) => {
    const last = modes.at(-1);
    if (last?.mode === mode) last.to = k + 1;
    else modes.push({ mode, from: k, to: k + 1 });
  });
  const signals = Object.keys(witness[0]?.signals ?? {});
  const true_at = Object.fromEntries(signals.map((s) => [s, witness.flatMap((row, k) => (row.signals[s] ? [k] : []))]));
  return { modes, true_at };
}

// One tool: the model sees name, description and the parameters schema; `call` validates the arguments with it.
const tool = <T extends object>(name: string, description: string, parameters: z.ZodType<T>, run: (args: T) => unknown) => ({
  name,
  description,
  parameters,
  call: async (raw: unknown) => run(parameters.parse(raw)),
});

// The agent's tools (SPEC §10). search_requirements never exposes source or formal: mapping must be semantic.
export function agentTools(corpus: Corpus, leaves: Leaf[]) {
  const visible = ({ id, text, status }: Corpus["requirements"][number]) => ({ id, text, status });
  return [
    tool("get_regulation", "Every leaf paragraph of the regulation, with its context (ancestors' text plus its own).",
      z.strictObject({}), () => leaves),
    tool("search_requirements", "Product requirements whose text contains any term of the query (case-insensitive).",
      z.strictObject({ query: z.string() }), ({ query }) => {
        const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== "");
        return corpus.requirements.filter((r) => terms.some((t) => r.text.toLowerCase().includes(t))).map(visible);
      }),
    tool("get_requirement", "One product requirement, with its formal reading.", z.strictObject({ id: z.string() }), ({ id }) => {
      const r = corpus.requirements.find((x) => x.id === id);
      return r === undefined ? { error: `Unknown requirement ${id}` } : { ...visible(r), formal: r.formal };
    }),
    tool("run_audit", "Runs the formal audit of the corpus and returns the findings that touch the given requirement ids.",
      z.strictObject({ requirement_ids: z.array(z.string()) }), async ({ requirement_ids }) =>
        (await audit(corpus))
          .filter((f) => concerns(f, corpus).some((id) => requirement_ids.includes(id)))
          .map(({ check, status, subject, scenario, core, unverified, witness }) =>
            ({ check, status, subject, scenario, core, unverified, witness: summary(witness) }))),
  ];
}
