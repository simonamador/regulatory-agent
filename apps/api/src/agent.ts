import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Corpus, type Finding, audit, loadCorpus } from "@rqaudit/core";
import { z } from "zod";
import { newRunId, ratio, root, round, tokens, write } from "./evals.js";
import { AGENT_TEMPERATURE, MODEL, PROMPTS, type Usage, agentSession } from "./llm.js";
import { type Leaf, agentTools, concerns, parseRegulation } from "./tools.js";

// CLI `pnpm eval:agent` (SPEC §10): 3 real agent runs on the regulation → runs/agent-<run_id>.json.
const REGULATION = "corpus/regulations/21-CFR-862.1355.txt";
const RUNS = 3;
const MAX_TURNS = 12;

// What the LLM decides: classification, citation and mapping. Never a verdict.
const Item = z.strictObject({
  paragraph: z.string(),
  category: z.enum(["behavior", "evidence", "labeling"]),
  quote: z.string(),
  implemented_by: z.array(z.string()),
  rationale: z.string(),
});
type Item = z.infer<typeof Item>;
const Assessment = z.strictObject({ obligations: z.array(Item) });

// Worst first (SPEC §10, step 5).
const SEVERITY = ["CONFLICT", "DEAD", "NOT_FORMALIZED", "CONSISTENT_BOUNDED"] as const;
type Contribution = { requirement: string; verdict: (typeof SEVERITY)[number]; finding_ref: string | null };
export type Obligation = Omit<Item, "category" | "quote" | "rationale"> & {
  category: Item["category"] | null;
  quote: string | null;
  rationale: string | null;
  verdict: Contribution["verdict"] | "NO_REQUIREMENT" | "OUT_OF_SCOPE" | "NEEDS_REVIEW";
  reasons: string[];
  contributions: Contribution[];
};
type GoldObligation = { paragraph: string; category: string; implemented_by: string[]; expected_verdict: string };

const ref = (f: Finding) => [f.check, f.scenario ?? f.subject].filter((x) => x !== null).join(":");
const designConflict = (f: Finding) => (f.check === "consistency" || f.check === "scenario_conflict") && f.status === "UNSAT";

// Step 4: one mapped requirement's own verdict and the finding behind it.
function contribution(id: string, corpus: Corpus, findings: Finding[]): Contribution {
  const conflict = findings.find((f) => designConflict(f) && f.core.includes(id));
  if (conflict !== undefined) return { requirement: id, verdict: "CONFLICT", finding_ref: ref(conflict) };
  const dead = findings.find((f) => f.check === "vacuity" && f.core.includes(`TRIGGER:${id}`));
  if (dead !== undefined) return { requirement: id, verdict: "DEAD", finding_ref: ref(dead) };
  const requirement = corpus.requirements.find((r) => r.id === id);
  if (requirement === undefined) throw new Error(`Unknown requirement ${id} reached the verdict step`);
  if (requirement.status === "pending" || requirement.formal === null) {
    const review = findings.find((f) => f.status === "NEEDS_REVIEW" && f.subject === id);
    return { requirement: id, verdict: "NOT_FORMALIZED", finding_ref: review === undefined ? null : ref(review) };
  }
  return { requirement: id, verdict: "CONSISTENT_BOUNDED", finding_ref: null };
}

// Step 1: why an item cannot be assessed; [] when it can.
function invalid(item: Item, leaf: Leaf, corpus: Corpus, findings: Finding[]) {
  const known = new Set(corpus.requirements.map((r) => r.id));
  const unknown = new Set(findings.filter((f) => f.status === "UNKNOWN" && f.check !== "equivalence").flatMap((f) => concerns(f, corpus)));
  const checks: [string, boolean][] = [
    ["invalid_quote", item.quote === "" || !leaf.context.includes(item.quote)],
    ["unknown_requirement", item.implemented_by.some((id) => !known.has(id))],
    ["audit_unknown", item.implemented_by.some((id) => unknown.has(id))],
  ];
  return checks.filter(([, failed]) => failed).map(([reason]) => reason);
}

const review = (paragraph: string, item: Item | null, reasons: string[]): Obligation => ({
  ...(item ?? { category: null, quote: null, implemented_by: [], rationale: null }),
  paragraph,
  verdict: "NEEDS_REVIEW",
  reasons,
  contributions: [],
});

// Steps 2–5: category first, then the worst individual verdict of the mapped requirements.
function judged(item: Item, corpus: Corpus, findings: Finding[]): Obligation {
  if (item.category === "evidence") return { ...item, verdict: "OUT_OF_SCOPE", reasons: [], contributions: [] };
  if (item.implemented_by.length === 0) return { ...item, verdict: "NO_REQUIREMENT", reasons: [], contributions: [] };
  const contributions = item.implemented_by.map((id) => contribution(id, corpus, findings));
  const worst = SEVERITY.find((v) => contributions.some((c) => c.verdict === v));
  if (worst === undefined) throw new Error(`No verdict for ${item.paragraph}`);
  return { ...item, verdict: worst, reasons: [], contributions };
}

// Verdicts are computed here from the audit findings, never by the LLM (SPEC §10). One obligation per leaf, then
// one NEEDS_REVIEW per item whose paragraph is not a leaf.
export function assess(items: Item[], leaves: Leaf[], corpus: Corpus, findings: Finding[]): Obligation[] {
  const assessed = leaves.map((leaf) => {
    const own = items.filter((i) => i.paragraph === leaf.id);
    const [item] = own;
    if (item === undefined) return review(leaf.id, null, ["missing_paragraph"]);
    if (own.length > 1) return review(leaf.id, item, ["duplicate_paragraph"]);
    const reasons = invalid(item, leaf, corpus, findings);
    return reasons.length > 0 ? review(leaf.id, item, reasons) : judged(item, corpus, findings);
  });
  const ids = new Set(leaves.map((l) => l.id));
  const extra = items.filter((i) => !ids.has(i.paragraph)).map((i) => review(i.paragraph, i, ["extra_paragraph"]));
  return [...assessed, ...extra];
}

// The report lists every design conflict of the full audit, mapped to a paragraph or not, and the unverified tails.
export function assessmentReport(obligations: Obligation[], findings: Finding[]) {
  return {
    obligations,
    design_conflicts: findings.filter(designConflict).map(({ check, scenario, core }) => ({ check, scenario, core })),
    unverified: findings
      .filter((f) => f.check === "scenario_conflict")
      .flatMap((f) => f.unverified.map((u) => ({ scenario: f.scenario, ...u }))),
  };
}

// Metrics of one run against tests/gold/obligations.json. Mapping is scored on the raw items, by (paragraph, req).
export function agentMetrics(obligations: Obligation[], items: Item[], leaves: Leaf[], gold: GoldObligation[], corpus: Corpus) {
  const byParagraph = new Map(obligations.map((o) => [o.paragraph, o]));
  const share = <T>(of: T[], keep: (x: T) => boolean) => ratio(of.filter(keep).length, of.length);
  const pairs = (xs: { paragraph: string; implemented_by: string[] }[]) =>
    new Set(xs.flatMap((x) => x.implemented_by.map((id) => `${x.paragraph} ${id}`)));
  const [predicted, expected] = [pairs(items), pairs(gold)];
  const hits = [...predicted].filter((p) => expected.has(p)).length;
  const contexts = new Map(leaves.map((l) => [l.id, l.context]));
  const known = new Set(corpus.requirements.map((r) => r.id));
  return {
    category_accuracy: share(gold, (g) => byParagraph.get(g.paragraph)?.category === g.category),
    mapping_precision: ratio(hits, predicted.size),
    mapping_recall: ratio(hits, expected.size),
    gap_recall: share(gold.filter((g) => g.expected_verdict === "NO_REQUIREMENT"), (g) => byParagraph.get(g.paragraph)?.verdict === "NO_REQUIREMENT"),
    valid_quote_rate: share(items, (i) => i.quote !== "" && (contexts.get(i.paragraph)?.includes(i.quote) ?? false)),
    invented_ids: items.flatMap((i) => i.implemented_by).filter((id) => !known.has(id)).length,
    verdict_accuracy: share(gold, (g) => byParagraph.get(g.paragraph)?.verdict === g.expected_verdict),
    needs_review: obligations.filter((o) => o.verdict === "NEEDS_REVIEW").length,
  };
}

// Share of leaves with the same category, mapping and verdict in every run.
export function agentAgreement(runs: Obligation[][], leaves: Leaf[]) {
  const key = (run: Obligation[], id: string) => {
    const o = run.find((x) => x.paragraph === id);
    return JSON.stringify(o === undefined ? null : [o.category, o.implemented_by.toSorted(), o.verdict]);
  };
  return ratio(leaves.filter((l) => runs.every((run) => key(run, l.id) === key(runs[0] ?? [], l.id))).length, leaves.length);
}

type Metrics = ReturnType<typeof agentMetrics>;
// Across runs: an api_error run is left out of agreement, accuracies, latency and tokens. With no valid run every
// figure is null, never 1; agreement needs two valid runs.
export function agentSummary(
  runs: { status: string; latency_ms: number; tokens: { prompt: number; completion: number }; metrics: Metrics | null; obligations: Obligation[] }[],
  leaves: Leaf[],
) {
  const valid = runs.flatMap((r) => (r.status === "api_error" || r.metrics === null ? [] : [{ ...r, metrics: r.metrics }]));
  const mean = (values: (number | null)[]) => {
    const xs = values.filter((x) => x !== null);
    return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  const total = (values: number[]) => (valid.length === 0 ? null : values.reduce((a, b) => a + b, 0));
  const meanOf = (key: Exclude<keyof Metrics, "invented_ids" | "needs_review">) => mean(valid.map((r) => r.metrics[key]));
  return {
    valid_runs: valid.length,
    agreement: valid.length < 2 ? null : agentAgreement(valid.map((r) => r.obligations), leaves),
    category_accuracy: meanOf("category_accuracy"),
    mapping_precision: meanOf("mapping_precision"),
    mapping_recall: meanOf("mapping_recall"),
    gap_recall: meanOf("gap_recall"),
    valid_quote_rate: meanOf("valid_quote_rate"),
    verdict_accuracy: meanOf("verdict_accuracy"),
    invented_ids: total(valid.map((r) => r.metrics.invented_ids)),
    needs_review: total(valid.map((r) => r.metrics.needs_review)),
    latency_ms: mean(valid.map((r) => r.latency_ms)),
    tokens_in: total(valid.map((r) => r.tokens.prompt)),
    tokens_out: total(valid.map((r) => r.tokens.completion)),
  };
}

// Tool-calling loop, at most MAX_TURNS model turns. No final answer leaves every leaf missing (NEEDS_REVIEW).
async function runAgent(corpus: Corpus, leaves: Leaf[]) {
  const tools = agentTools(corpus, leaves);
  const { next, settings } = agentSession(Assessment, tools, `Assess ${REGULATION} against the product requirements.`);
  const trace: { turn: number; tool: string; arguments: unknown; latency_ms: number }[] = [];
  const usages: (Usage | null)[] = [];
  let results: { id: string; content: string }[] = [];
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const reply = await next(results);
    usages.push(reply.usage);
    if (reply.value === null) return { status: "api_error", message: reply.message, items: [], trace, usages, settings };
    if (reply.value.final !== null) return { status: "complete", message: null, items: reply.value.final.obligations, trace, usages, settings };
    results = [];
    for (const call of reply.value.calls) {
      const tool = tools.find((t) => t.name === call.name);
      if (tool === undefined) throw new Error(`Unknown tool ${call.name}`);
      const started = performance.now();
      const content = JSON.stringify(await tool.call(call.arguments));
      trace.push({ turn, tool: call.name, arguments: call.arguments, latency_ms: performance.now() - started });
      results.push({ id: call.id, content });
    }
  }
  return { status: "max_turns", message: `No final answer after ${MAX_TURNS} turns.`, items: [], trace, usages, settings };
}

async function main() {
  const started = performance.now();
  const run_id = newRunId();
  const corpus = loadCorpus(fileURLToPath(new URL("corpus/", root)), "base");
  if (corpus.findings.length > 0) throw new Error(`The base corpus does not load cleanly: ${JSON.stringify(corpus.findings)}`);
  const leaves = parseRegulation(readFileSync(new URL(REGULATION, root), "utf8"));
  const gold = (JSON.parse(readFileSync(new URL("tests/gold/obligations.json", root), "utf8")) as { obligations: GoldObligation[] }).obligations;

  const runs = [];
  for (let run = 1; run <= RUNS; run++) {
    const runStarted = performance.now();
    const session = await runAgent(corpus, leaves);
    const findings = await audit(corpus);
    const obligations = assess(session.items, leaves, corpus, findings);
    runs.push({
      run, status: session.status, message: session.message, latency_ms: performance.now() - runStarted,
      ...session.settings, tokens: tokens(session.usages), turns: session.usages.length, tool_calls: session.trace.length,
      metrics: session.status === "api_error" ? null : agentMetrics(obligations, session.items, leaves, gold, corpus),
      obligations, report: assessmentReport(obligations, findings), items: session.items, trace: session.trace,
    });
  }
  const report = {
    run_id, stage: "agent", status: runs.every((r) => r.status === "complete") ? "complete" : "incomplete",
    model: MODEL, requested_temperature: AGENT_TEMPERATURE, prompt: PROMPTS.agent, regulation: REGULATION, max_turns: MAX_TURNS,
    latency_ms: performance.now() - started,
    summary: agentSummary(runs, leaves),
    runs,
  };
  write(`agent-${run_id}`, report);

  console.log(`agent ${run_id} · model ${MODEL} · ${leaves.length} leaf paragraphs · runs/agent-${run_id}.json`);
  console.table(
    runs.map(({ run, status, metrics: m, latency_ms, tokens: t, turns, tool_calls, temperature, reasoning_effort }) => ({
      run, status, ...Object.fromEntries(Object.entries(m ?? {}).map(([key, value]) => [key, round(value)])),
      turns, tool_calls, latency_ms: Math.round(latency_ms), tokens_in: t.prompt, tokens_out: t.completion, temperature, reasoning_effort,
    })),
  );
  console.log("summary over valid runs:", JSON.stringify(report.summary));
  runs
    .filter((r) => r.message !== null || r.temperature_error !== null)
    .forEach((r) => console.log(`run ${r.run}:`, r.message, r.temperature_error));
  console.log("design conflicts:", JSON.stringify(runs[0]?.report.design_conflicts));
}

// Z3 workers keep the process alive, so the CLI exits explicitly (CLAUDE.md).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
  process.exit(0);
}
