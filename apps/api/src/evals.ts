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
  mutate,
  scenarioConflict,
  vacuity,
} from "@rqaudit/core";
import { MODEL, PROMPTS, type Usage, extract, judge, preamble } from "./llm.js";

// CLI `pnpm eval` (SPEC §9): variants A/B/C over the scenario_conflict gold cases and the mutations → runs/<run_id>.json.
// `pnpm eval --rescore <run_id>` re-scores a v3+ run without calling the LLM again.
const RUNS = 3; // B and C, for the agreement rate
const AUDITS = 50;
// v1 gave C the vocabulary but not B and rendered scenarios as `signal = value` lists; v2 fixed both, on the pump domain.
// v3 moved to the CGM domain: templates reproduce the corpus texts of REQ-101 and REQ-102, scenarios and the shared
// preamble speak minutes, extract fills durations in seconds, and predictions record expected_unverified.
const PROTOCOL = {
  version: 4,
  reason:
    "The shared vocabulary preamble of B and C carries the signal glossary of signals.json (descriptions). " +
    "No other prompt change. In v3, C abstained (formal null) on REQ-102 and REQ-105.",
};
const BATCH = 8; // concurrent LLM calls

const root = new URL("../../../", import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const load = (name: string) => loadCorpus(fileURLToPath(new URL("corpus/", root)), name);

type Bound = "inclusive" | "exclusive";
type Unverified = { requirement: string; tick: number }[];
type Expected = { expected_status: string; expected_core: string[] | null; expected_unverified: Unverified };
type Gold = Expected & { id: string; check: string; corpus: string; scenario: string };
type Mutation = Expected & {
  id: string;
  params: { D: number; bound: Bound; W: number };
  overrides: Record<string, object>;
  scenario: { id: string; facts: object[] };
};
type Case = { id: string; corpus: Corpus; scenario: string; expected_status: string; expected_core: string[]; expected_unverified: Unverified };
export type Prediction = {
  id: string;
  status: string; // SAT | UNSAT | UNKNOWN | ERROR
  core: string[];
  expected_status: string;
  expected_core: string[];
  expected_unverified: Unverified;
  latency_ms: number;
  usage: Usage | null;
  message: string | null;
};

// Fixed templates in minutes, the unit of the corpus texts: the only text that changes across mutations.
export const renderReq101 = (D: number, bound: Bound) =>
  `When glucose is at or below 55 mg/dL, the system shall issue the Urgent Low alert ${
    bound === "inclusive" ? `within a maximum of ${D} minutes` : `in less than ${D} minutes`
  }, in any operating mode.`;
export const renderReq102 = (W: number) =>
  `During sensor warm-up (the first ${W} minutes after sensor start), the system shall not issue glucose alerts.`;

// Display unit of texts and scenarios; the model's tick comes from signals.json.
const minutes = (s: number) => s / 60;

// Natural language, the same for every case and variant; `description` is not used because it hints at the answer.
// Intervals stay half-open: "from minute 0 to minute 30" is [0, 30).
export function renderScenario({ horizon_ticks, tick_s }: Vocabulary, facts: Fact[]) {
  const sentences = facts.map((f) => {
    const span =
      f.to_s - f.from_s === tick_s ? `at minute ${minutes(f.from_s)}` : `from minute ${minutes(f.from_s)} to minute ${minutes(f.to_s)}`;
    if ("mode" in f) return `The sensor is in ${f.mode.toLowerCase()} mode ${span}.`;
    const name = f.signal.replaceAll("_", " ");
    if (!f.value) return `No ${name} is detected ${span}.`;
    return `${/^[aeiou]/.test(name) ? "An" : "A"} ${name} is detected ${span}.`;
  });
  const last = minutes((horizon_ticks - 1) * tick_s);
  return [`The trace covers minute 0 to minute ${last}. Anything not stated is unconstrained.`, ...sentences].join("\n");
}

function scenarioText({ corpus, scenario }: Case) {
  const found = corpus.scenarios.find((s) => s.id === scenario);
  if (found === undefined) throw new Error(`Unknown scenario ${scenario}`);
  return renderScenario(corpus.vocabulary, found.facts);
}

const requirementIds = (ids: string[]) => [...new Set(ids.filter((id) => id.startsWith("REQ-")))].sort();
const expectedOf = ({ expected_status, expected_core, expected_unverified }: Case) => ({ expected_status, expected_core, expected_unverified });

// Variant A: rule-based text linter, a baseline on purpose (not tuned).
const SIGNAL_WORDS: [string, RegExp][] = [
  ["urgent_low", /urgent(ly)? low/i],
  ["urgent_low_alert", /urgent low alert|glucose alerts/i],
  ["glucose_shown", /display glucose|glucose values/i],
  ["data_gap", /no glucose data/i],
  ["signal_loss_alert", /signal loss/i],
  ["reading_sent", /transmit|reading/i],
];
const MODE_WORDS: [string, RegExp][] = [
  ["WARMUP", /warm-?up/i],
  ["ACTIVE", /\bactive\b/i],
  ["EXPIRED", /expired|wear period has ended/i],
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
  const expected = { ...expectedOf(c), expected_core: requirementIds(c.expected_core) };
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
    const expected = expectedOf(c);
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

// Rescore: the in_horizon slice (no obligation past the horizon) and the false positive rate on SAT cases.
// In this corpus every SAT case has unverified tails, so an "unverified" slice would just be the SAT class.
export function rescored(predictions: Prediction[]) {
  const inHorizon = predictions.filter((p) => p.expected_unverified.length === 0);
  const correct = inHorizon.filter((p) => p.status === p.expected_status).length;
  const sat = predictions.filter((p) => p.expected_status === "SAT");
  return {
    in_horizon: { cases: inHorizon.length, accuracy: ratio(correct, inHorizon.length), ...metrics(inHorizon) },
    sat: { cases: sat.length, false_positive_rate: ratio(sat.filter((p) => p.status === "UNSAT").length, sat.length) },
  };
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
const newRunId = () => new Date().toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
const write = (run_id: string, report: object) => {
  mkdirSync(new URL("runs/", root), { recursive: true });
  writeFileSync(new URL(`runs/${run_id}.json`, root), `${JSON.stringify(report, null, 2)}\n`);
};

// Re-scores the stored predictions of a run; it never calls the LLM or the solver.
function rescore(source_run_id: string) {
  const started = performance.now();
  const source = readJson(`runs/${source_run_id}.json`) as {
    protocol_version: number;
    variants: Record<string, { run: number; predictions: Prediction[] }[]>;
  };
  if (source.protocol_version < 3) throw new Error(`${source_run_id} is protocol v${source.protocol_version}: rescore needs v3+`);
  const variants = Object.fromEntries(
    Object.entries(source.variants).map(([variant, runs]) => [variant, runs.map(({ run, predictions }) => ({ run, ...rescored(predictions) }))]),
  );
  const run_id = newRunId();
  const report = { run_id, stage: "rescore", source_run_id, protocol_version: source.protocol_version, status: "complete",
    latency_ms: performance.now() - started, tokens: { prompt: 0, completion: 0 }, variants };
  write(run_id, report);

  console.log(`rescore ${run_id} of ${source_run_id} · runs/${run_id}.json`);
  console.table(
    Object.entries(variants).flatMap(([variant, runs]) =>
      runs.map(({ run, in_horizon: m, sat }) => ({
        variant, run, in_horizon: m.cases, accuracy: round(m.accuracy), P: round(m.precision), R: round(m.recall),
        F1: round(m.f1), core_exact: round(m.core_exact), errors: m.errors, sat: sat.cases, fpr_sat: round(sat.false_positive_rate),
      })),
    ),
  );
}

async function main() {
  const started = performance.now();
  const run_id = newRunId();
  const base = load("base");
  const gold = (readJson("tests/gold/cases.json") as Gold[]).filter((c) => c.check === "scenario_conflict");
  const cases: Case[] = [
    ...gold.map((c) => ({ ...c, corpus: load(c.corpus), expected_core: (c.expected_core ?? []).toSorted() })),
    // SPEC §7: the base corpus with each mutation applied; each overridden requirement gets its text from its template.
    ...(readJson("tests/gold/mutations.json") as Mutation[]).map((m): Case => {
      const corpus = mutate(base, m);
      const texts: Record<string, string> = { "REQ-101": renderReq101(m.params.D, m.params.bound), "REQ-102": renderReq102(m.params.W) };
      const requirements = corpus.requirements.map((r) => {
        if (!(r.id in m.overrides)) return r;
        const text = texts[r.id];
        if (text === undefined) throw new Error(`${m.id}: no template for ${r.id}`);
        return { ...r, text };
      });
      const { id, expected_status, expected_core, expected_unverified } = m;
      return { id, corpus: { ...corpus, requirements }, scenario: m.scenario.id, expected_status, expected_core: expected_core ?? [], expected_unverified };
    }),
  ];

  const audit_latency_ms = await auditLatency(base);
  const A = cases.map((c): Prediction => {
    const started = performance.now();
    const { conflict, involved_ids } = lint(c.corpus.requirements, scenarioText(c));
    const latency_ms = performance.now() - started;
    const expected = { ...expectedOf(c), expected_core: requirementIds(c.expected_core) };
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
  write(run_id, report);

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
  const flag = process.argv.indexOf("--rescore");
  if (flag === -1) await main();
  else {
    const source = process.argv[flag + 1];
    if (source === undefined) throw new Error("Usage: pnpm eval --rescore <run_id>");
    rescore(source);
  }
  process.exit(0);
}
