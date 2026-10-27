import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  type Corpus,
  type Fact,
  type Vocabulary,
  consistency,
  equivalence,
  loadCorpus,
  scenarioConflict,
  vacuity,
} from "@rqaudit/core";
import { MODEL, PROMPTS, type Usage, extract, judge, preamble } from "./llm.js";

// CLI `pnpm eval` (SPEC §9 etapa 03): variants A/B/C over G01–G04 and the 72 mutations → runs/<run_id>.json.
const RUNS = 3; // B and C, for the agreement rate
const AUDITS = 50;
// v1 gave C the vocabulary but not B, rendered scenarios as `signal = value` lists and warmed up with one solve.
const PROTOCOL = {
  version: 2,
  reason:
    "Information parity between B and C: one vocabulary preamble (signals, modes, detection semantics) for extract and judge, " +
    "and scenarios rendered in natural language for A, B and C. Audit latency measured as the server runs: cold first audit, " +
    "one full warm-up audit, then measured audits.",
};
const BATCH = 8; // concurrent LLM calls

const root = new URL("../../../", import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const load = (name: string) => loadCorpus(fileURLToPath(new URL("corpus/", root)), name);

type Bound = "inclusive" | "exclusive";
type Gold = { id: string; corpus: string; scenario: string; expected_status: string; expected_core: string[] | null };
type Mutation = Gold & { t: number; D: number; bound: Bound; W: number; e: number; calEnd: number };
type Case = { id: string; corpus: Corpus; scenario: string; expected_status: string; expected_core: string[] };
export type Prediction = {
  id: string;
  status: string; // SAT | UNSAT | UNKNOWN | ERROR
  core: string[];
  expected_status: string;
  expected_core: string[];
  latency_ms: number;
  usage: Usage | null;
  message: string | null;
};

// Fixed templates: the only text that changes across mutations.
export const renderReq001 = (D: number, bound: Bound) =>
  `Upon detection of an occlusion, the pump shall activate the audible alarm ${
    bound === "inclusive" ? `within a maximum of ${D} seconds` : `in less than ${D} seconds`
  }, in any operating mode.`;
export const renderReq002 = (W: number) =>
  `During the first ${W} seconds of calibration mode, audible alarms shall remain disabled.`;

// Natural language, the same for every case and variant; `description` is not used because it hints at the answer.
// Intervals stay half-open: "from t=0 s to t=12 s" is [0, 12).
export function renderScenario(horizon: number, facts: Fact[]) {
  const sentences = facts.map((f) => {
    const span = f.to_s - f.from_s === 1 ? `at t=${f.from_s} s` : `from t=${f.from_s} s to t=${f.to_s} s`;
    if ("mode" in f) return `The pump is in ${f.mode.toLowerCase()} mode ${span}.`;
    const name = f.signal.replaceAll("_", " ");
    if (!f.value) return `No ${name} is detected ${span}.`;
    return `${/^[aeiou]/.test(name) ? "An" : "A"} ${name} is detected ${span}.`;
  });
  return [`The trace covers t=0 s to t=${horizon - 1} s. Anything not stated is unconstrained.`, ...sentences].join("\n");
}

function scenarioText({ corpus, scenario }: Case) {
  const found = corpus.scenarios.find((s) => s.id === scenario);
  if (found === undefined) throw new Error(`Unknown scenario ${scenario}`);
  return renderScenario(corpus.vocabulary.horizon_ticks, found.facts);
}

// SPEC §7: the base corpus with REQ-001 and REQ-002 replaced (text and formal) and scenario SCN built from the fields.
function mutate(base: Corpus, m: Mutation): Case {
  const requirements = base.requirements.map((r) => {
    if (r.formal === null) return r;
    if (r.id === "REQ-001")
      return { ...r, text: renderReq001(m.D, m.bound), formal: { ...r.formal, timing: { kind: "within" as const, s: m.D, bound: m.bound } } };
    if (r.id === "REQ-002")
      return { ...r, text: renderReq002(m.W), formal: { ...r.formal, scope: { ...r.formal.scope, window_s: { from: 0, to: m.W } } } };
    return r;
  });
  const facts = [
    { mode: "NORMAL", from_s: 0, to_s: m.e },
    { mode: "CALIBRATION", from_s: m.e, to_s: m.calEnd },
    { mode: "NORMAL", from_s: m.calEnd, to_s: base.vocabulary.horizon_ticks },
    { signal: "occlusion", value: true, from_s: m.t, to_s: m.t + 1 },
  ].filter((f) => f.from_s < f.to_s);
  const corpus = { ...base, requirements, scenarios: [...base.scenarios, { id: "SCN", description: m.id, facts }] };
  return { id: m.id, corpus, scenario: "SCN", expected_status: m.expected_status, expected_core: m.expected_core ?? [] };
}

const requirementIds = (ids: string[]) => [...new Set(ids.filter((id) => id.startsWith("REQ-")))].sort();

// Variant A: rule-based text linter, a baseline on purpose (not tuned).
const SIGNAL_WORDS: [string, RegExp][] = [
  ["occlusion", /occlusion/i],
  ["alarm", /alarm/i],
  ["bolus_delivered", /bolus/i],
  ["reservoir_empty", /reservoir/i],
  ["fault", /fault/i],
  ["pumping", /pumping|deliver fluid/i],
];
const MODE_WORDS: [string, RegExp][] = [
  ["CALIBRATION", /calibration/i],
  ["NORMAL", /normal/i],
];
const NEGATION = /\b(not|no|disabled|stop)\b/i;
const keywords = (words: [string, RegExp][], text: string) => words.filter(([, word]) => word.test(text)).map(([key]) => key);

// Conflict when two requirements the scenario activates by keyword talk about one signal with opposite polarity.
export function lint(requirements: { id: string; text: string }[], scenario: string) {
  const present = [...keywords(SIGNAL_WORDS, scenario), ...keywords(MODE_WORDS, scenario)];
  const active = requirements.flatMap(({ id, text }) => {
    const signals = keywords(SIGNAL_WORDS, text);
    const modes = keywords(MODE_WORDS, text);
    const activated = modes.every((m) => present.includes(m)) && [...signals, ...modes].some((k) => present.includes(k));
    return activated ? [{ id, signals, negative: NEGATION.test(text) }] : [];
  });
  const involved = new Set<string>();
  for (const a of active)
    for (const b of active) if (a.negative !== b.negative && a.signals.some((s) => b.signals.includes(s))) involved.add(a.id);
  return { conflict: involved.size > 0, involved_ids: [...involved].sort() };
}

async function variantB(c: Case): Promise<Prediction> {
  const texts = [...c.corpus.requirements, ...c.corpus.axioms].map(({ id, text }) => ({ id, text }));
  const { value, latency_ms, usage, message } = await judge(c.corpus.vocabulary, texts, scenarioText(c));
  const status = value === null ? "ERROR" : value.conflict ? "UNSAT" : "SAT";
  const expected = { expected_status: c.expected_status, expected_core: requirementIds(c.expected_core) };
  return { id: c.id, status, core: requirementIds(value?.involved_ids ?? []), ...expected, latency_ms, usage, message };
}

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) results.push(...(await Promise.all(items.slice(i, i + BATCH).map(run))));
  return results;
}

// Variant C: extract each distinct text once, then scenario_conflict on the extracted formals.
// Without a formal a requirement stays pending (NEEDS_REVIEW), and a pending one never enters the solver.
async function variantC(cases: Case[], vocabulary: Vocabulary) {
  const golds = new Map(cases.flatMap((c) => c.corpus.requirements.map((r) => [r.text, { id: r.id, gold: r.formal }] as const)));
  const replies = await inBatches([...golds.keys()], (text) => extract(vocabulary, text));
  const extractions = [...golds].map(([text, { id, gold }], i) => {
    const reply = replies[i];
    if (reply === undefined) throw new Error(`No extraction for ${id}`);
    return { requirement: id, text, gold, ...reply, exact: isDeepStrictEqual(reply.formal, gold) };
  });
  const formals = new Map(extractions.map((x) => [x.text, x.formal]));
  const predictions: Prediction[] = [];
  for (const c of cases) {
    const requirements = c.corpus.requirements.map((r) => {
      const formal = formals.get(r.text);
      if (formal === undefined) throw new Error(`No extraction for ${r.id}`);
      return { ...r, formal, status: formal === null ? ("pending" as const) : r.status };
    });
    const pending = requirements.filter((r) => r.status === "pending").map((r) => r.id);
    const started = performance.now();
    const { status, core } = await scenarioConflict({ ...c.corpus, requirements }, c.scenario);
    const latency_ms = performance.now() - started;
    const expected = { expected_status: c.expected_status, expected_core: c.expected_core };
    // Pending requirements are listed, never dropped in silence (SPEC §4).
    const message = `NEEDS_REVIEW, not in the solver: ${pending.join(", ")}`;
    predictions.push({ id: c.id, status, core, ...expected, latency_ms, usage: null, message });
  }
  return { predictions, extractions };
}

const ratio = (num: number, den: number) => (den === 0 ? null : num / den);
// Nearest-rank percentiles; null without samples.
function latency(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return { p50: sorted[Math.ceil(0.5 * sorted.length) - 1] ?? null, p95: sorted[Math.ceil(0.95 * sorted.length) - 1] ?? null };
}
const tokens = (usages: (Usage | null)[]) => ({
  prompt: usages.reduce((sum, u) => sum + (u?.prompt_tokens ?? 0), 0),
  completion: usages.reduce((sum, u) => sum + (u?.completion_tokens ?? 0), 0),
});

// UNSAT is the positive class; ERROR and UNKNOWN count as not UNSAT and as errors. Undefined ratios are null.
export function metrics(predictions: Prediction[]) {
  const count = (keep: (p: Prediction) => boolean) => predictions.filter(keep).length;
  const tp = count((p) => p.status === "UNSAT" && p.expected_status === "UNSAT");
  const predicted = count((p) => p.status === "UNSAT");
  const actual = count((p) => p.expected_status === "UNSAT");
  return {
    precision: ratio(tp, predicted),
    recall: ratio(tp, actual),
    f1: ratio(2 * tp, predicted + actual),
    core_exact: ratio(count((p) => p.expected_status === "UNSAT" && isDeepStrictEqual(p.core, p.expected_core)), actual),
    errors: count((p) => p.status === "ERROR" || p.status === "UNKNOWN"),
    latency_ms: latency(predictions.map((p) => p.latency_ms)),
    tokens: tokens(predictions.map((p) => p.usage)),
  };
}

// Share of cases with the same (status, core) in every run.
export function agreement(runs: Prediction[][]) {
  const [first, ...rest] = runs;
  if (first === undefined) throw new Error("Agreement needs at least one run");
  const key = (p: Prediction) => JSON.stringify([p.status, p.core]);
  const same = first.filter((p, i) => rest.every((run) => run[i] !== undefined && key(run[i]) === key(p)));
  return ratio(same.length, first.length);
}

// Audit (SPEC §4): consistency + scenario_conflict per scenario + vacuity + equivalence per interpretation.
async function audit(corpus: Corpus) {
  const started = performance.now();
  await consistency(corpus);
  for (const s of corpus.scenarios) await scenarioConflict(corpus, s.id);
  await vacuity(corpus);
  for (const i of corpus.interpretations) await equivalence(corpus, i.id);
  return performance.now() - started;
}

// As the server runs: the first audit of the process is cold, then one full warm-up audit before measuring.
async function auditLatency(base: Corpus) {
  const cold_first_audit_ms = await audit(base);
  await audit(base);
  const times: number[] = [];
  for (let i = 0; i < AUDITS; i++) times.push(await audit(base));
  return { cold_first_audit_ms, warmup_audits: 1, audits: AUDITS, ...latency(times), samples: times };
}

const round = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

async function main() {
  const started = performance.now();
  const run_id = new Date().toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
  const base = load("base");
  const gold = (readJson("tests/gold/cases.json") as Gold[]).filter((c) => ["G01", "G02", "G03", "G04"].includes(c.id));
  const cases: Case[] = [
    ...gold.map((c) => ({ ...c, corpus: load(c.corpus), expected_core: (c.expected_core ?? []).toSorted() })),
    ...(readJson("tests/gold/mutations.json") as Mutation[]).map((m) => mutate(base, m)),
  ];

  const audit_latency_ms = await auditLatency(base);
  const A = cases.map((c): Prediction => {
    const started = performance.now();
    const { conflict, involved_ids } = lint(c.corpus.requirements, scenarioText(c));
    const latency_ms = performance.now() - started;
    const expected = { expected_status: c.expected_status, expected_core: requirementIds(c.expected_core) };
    return { id: c.id, status: conflict ? "UNSAT" : "SAT", core: involved_ids, ...expected, latency_ms, usage: null, message: null };
  });
  const B: { run: number; predictions: Prediction[] }[] = [];
  const C: { run: number; predictions: Prediction[]; extractions: Awaited<ReturnType<typeof variantC>>["extractions"] }[] = [];
  for (let run = 1; run <= RUNS; run++) {
    B.push({ run, predictions: await inBatches(cases, variantB) });
    C.push({ run, ...(await variantC(cases, base.vocabulary)) });
  }

  const variants = {
    A: [{ run: 1, predictions: A, metrics: metrics(A), needs_review: 0 }],
    B: B.map((r) => ({ ...r, metrics: metrics(r.predictions), needs_review: 0 })),
    C: C.map(({ extractions, ...r }) => {
      const ids = [...new Set(extractions.map((x) => x.requirement))].sort();
      const exact_by_requirement = Object.fromEntries(
        ids.map((id) => {
          const own = extractions.filter((x) => x.requirement === id);
          return [id, { exact: own.filter((x) => x.exact).length, texts: own.length }];
        }),
      );
      // C spends tokens only on extraction; its per-case latency is the solve.
      const metricsC = { ...metrics(r.predictions), tokens: tokens(extractions.map((x) => x.usage)) };
      const needs_review = extractions.filter((x) => x.status === "NEEDS_REVIEW").length;
      const extract_latency_ms = latency(extractions.map((x) => x.latency_ms));
      return { ...r, extractions, metrics: metricsC, needs_review, extract_latency_ms, exact_by_requirement };
    }),
  };
  const all = [...variants.A, ...variants.B, ...variants.C];
  const report = {
    run_id,
    stage: "eval",
    protocol_version: PROTOCOL.version,
    protocol_change: PROTOCOL.reason,
    status: "complete",
    model: MODEL,
    // Exactly the system prompts sent: each base prompt followed by the shared preamble.
    prompts: {
      extract: `${PROMPTS.extract}\n${preamble(base.vocabulary)}`,
      judge: `${PROMPTS.judge}\n${preamble(base.vocabulary)}`,
    },
    cases: cases.map((c) => c.id),
    latency_ms: performance.now() - started,
    tokens: {
      prompt: all.reduce((sum, r) => sum + r.metrics.tokens.prompt, 0),
      completion: all.reduce((sum, r) => sum + r.metrics.tokens.completion, 0),
    },
    audit_latency_ms,
    agreement: { B: agreement(B.map((r) => r.predictions)), C: agreement(C.map((r) => r.predictions)) },
    variants,
  };
  mkdirSync(new URL("runs/", root), { recursive: true });
  writeFileSync(new URL(`runs/${run_id}.json`, root), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`run ${run_id} · protocol v${PROTOCOL.version} · model ${MODEL} · ${cases.length} cases · runs/${run_id}.json`);
  console.table(
    Object.entries(variants).flatMap(([variant, runs]) =>
      runs.map(({ run, needs_review, metrics: m }) => ({
        variant,
        run,
        P: round(m.precision),
        R: round(m.recall),
        F1: round(m.f1),
        core_exact: round(m.core_exact),
        needs_review,
        errors: m.errors,
        p50_ms: round(m.latency_ms.p50),
        p95_ms: round(m.latency_ms.p95),
        tokens_in: m.tokens.prompt,
        tokens_out: m.tokens.completion,
      })),
    ),
  );
  console.log("agreement across runs:", { B: round(report.agreement.B), C: round(report.agreement.C) });
  console.log("C extraction exact (exact/texts per run):");
  console.table(
    Object.fromEntries(
      Object.keys(variants.C[0]?.exact_by_requirement ?? {}).map((id) => [
        id,
        Object.fromEntries(variants.C.map((r) => [`run ${r.run}`, `${r.exact_by_requirement[id]?.exact}/${r.exact_by_requirement[id]?.texts}`])),
      ]),
    ),
  );
  const { cold_first_audit_ms, p50, p95 } = audit_latency_ms;
  console.log("audit latency (ms):", { cold_first_audit_ms: round(cold_first_audit_ms), warmup_audits: 1, audits: AUDITS, p50: round(p50), p95: round(p95) });
}

// Z3 workers keep the process alive, so the CLI exits explicitly (CLAUDE.md).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
  process.exit(0);
}
