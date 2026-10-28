import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Corpus, type Finding, type Formal, audit, loadCorpus, regression } from "@rqaudit/core";
import express from "express";
import { z } from "zod";
import { agentEval } from "./agent.js";
import { root } from "./evals.js";
import { parseRegulation } from "./tools.js";

// Express (SPEC §2): the storyboard API plus apps/web/dist. Errors propagate to Express's handler (SPEC §6).
const corpusDir = fileURLToPath(new URL("corpus/", root));
const runsDir = new URL("runs/", root);
const readRun = <T>(file: string) => JSON.parse(readFileSync(new URL(file, runsDir), "utf8")) as T;
// Run files are named by UTC timestamp, so the latest sorts last.
const runFiles = (pattern: RegExp) => readdirSync(runsDir).filter((f) => pattern.test(f)).sort();
const visible = (corpus: Corpus) => corpus.requirements.map(({ id, text, status }) => ({ id, text, status }));

type Stored = { run_id: string; stage: string; source_run_id?: string; summary?: unknown; gold_sha256?: string };

// A gold_sha256 as "9946ab5b · 2026-10-27 18:42 (95b1902)", from the map scripts/gold-versions.mjs generates.
// A run that predates gold_sha256 has none, and says so.
function goldLabel(sha256: string | undefined) {
  if (sha256 === undefined) return null;
  const versions = JSON.parse(readFileSync(new URL("apps/api/gold-versions.json", root), "utf8")) as { sha256: string; commit: string; date: string }[];
  const version = versions.find((v) => v.sha256 === sha256);
  const when = version === undefined ? "not in gold-versions.json" : `${version.date.slice(0, 16).replace("T", " ")} (${version.commit})`;
  return `${sha256.slice(0, 8)} · ${when}`;
}

// Section a: minute by minute, the scenario's modes and fixed signals and, for each requirement of the core, the
// ticks its response is forbidden (always, value false) or required (within: each trigger up to its deadline).
// Display only: it reads the same §3 semantics off the scenario facts; the verdict is Z3's.
function timeline(corpus: Corpus, f: Finding) {
  const { horizon_ticks: H, tick_s } = corpus.vocabulary;
  const scenario = corpus.scenarios.find((s) => s.id === f.scenario);
  if (scenario === undefined) throw new Error(`Unknown scenario ${f.scenario}`);
  const ticks = Array.from({ length: H }, (_, k) => k);
  const facts = (k: number) => scenario.facts.filter((x) => x.from_s <= k * tick_s && k * tick_s < x.to_s);
  const mode = ticks.map((k) => facts(k).flatMap((x) => ("mode" in x ? [x.mode] : []))[0] ?? null);
  const signal = (name: string) => ticks.map((k) => facts(k).flatMap((x) => ("signal" in x && x.signal === name ? [x.value] : []))[0] ?? null);
  const fixed = corpus.vocabulary.signals.filter((s) => signal(s).some((v) => v !== null));

  const entry = (k: number): number => (k > 0 && mode[k - 1] === mode[k] ? entry(k - 1) : k);
  const inScope = ({ mode: m, window_s }: Formal["scope"], k: number) => {
    if (m === "ANY") return true;
    const offset = (k - entry(k)) * tick_s;
    return mode[k] === m && (window_s === null || (window_s.from <= offset && offset < window_s.to));
  };
  const triggered = ({ scope, condition }: Formal, k: number) =>
    inScope(scope, k) && (condition === null || signal(condition.signal)[k] === condition.value);
  const marked = (formal: Formal) => {
    const { timing } = formal;
    if (timing.kind === "always") return ticks.filter((k) => triggered(formal, k));
    const d = timing.s / tick_s - (timing.bound === "exclusive" ? 1 : 0);
    return ticks.filter((j) => ticks.some((k) => k <= j && j <= k + d && triggered(formal, k)));
  };
  const rows = f.core.flatMap((id) => {
    const formal = corpus.requirements.find((r) => r.id === id)?.formal;
    if (formal == null) return [];
    const kind = formal.timing.kind === "always" && !formal.response.value ? "forbidden" : "required";
    return [{ requirement: id, kind, response: formal.response.signal, ticks: marked(formal) }];
  });
  return { tick_s, ticks: H, mode, signals: Object.fromEntries(fixed.map((s) => [s, signal(s)])), rows };
}

// Regression of every scenario between two snapshots, merged; SAT in both contributes nothing.
async function regressions(from: Corpus, to: Corpus) {
  const parts = [];
  for (const s of to.scenarios) parts.push(await regression(from, to, s.id));
  const [first] = parts;
  if (first === undefined) throw new Error("No scenario to compare");
  return {
    introduced: parts.flatMap((p) => p.introduced),
    resolved: parts.flatMap((p) => p.resolved),
    persistent: parts.flatMap((p) => p.persistent),
    changed_requirements: first.changed_requirements,
  };
}

// Fail closed on memory (SPEC §6): the solver's memory grows with every audit (README, Known limitations), so past
// this resident size an audit is refused with 503 instead of being attempted.
export const SOLVER_MEMORY_LIMIT_BYTES = 1.5 * 1024 ** 3;
const MB = 1024 ** 2;

// The instance's warm-up audit (SPEC §4), started once by whoever asks first, behind the Z3 lock: the first request
// on a serverless instance, or the boot of a local server. A failed warm-up rejects for every caller.
export function warmup(): () => Promise<unknown> {
  let started: Promise<unknown> | null = null;
  return () => (started ??= audit(loadCorpus(corpusDir, "base")));
}

// No live agent in production: a live run writes to runs/, and in production nothing writes to disk.
const liveAvailable = () => Boolean(process.env.OPENAI_API_KEY) && process.env.NODE_ENV !== "production";

// `warm` starts (or joins) the warm-up; `rss` reads the resident set size, injected so a test can simulate it.
export function createApp({ warm, rss }: { warm: () => Promise<unknown>; rss: () => number }) {
  const app = express();
  app.use(express.json());
  let audits_served = 0;
  const overLimit = () => rss() > SOLVER_MEMORY_LIMIT_BYTES;
  app.use((_req, _res, next) => {
    void warm();
    next();
  });

  // 200 only once the warm-up audit has finished; the UI calls it on load.
  app.get("/api/health", async (_req, res) => {
    await warm();
    res.json({ ready: true, rss_mb: Math.round(rss() / MB), audits_served });
  });

  // Sections c and e: the latest agent run in runs/ (the agent is not called by default).
  app.get("/api/agent-report", (_req, res) => {
    const file = runFiles(/^agent-\d.*\.json$/).at(-1);
    if (file === undefined) throw new Error("No agent run in runs/");
    const { model, regulation, runs } = readRun<Awaited<ReturnType<typeof agentEval>>>(file);
    const leaves = parseRegulation(readFileSync(new URL(regulation, root), "utf8"));
    res.json({
      file, model, leaves, requirements: visible(loadCorpus(corpusDir, "base")),
      live_available: liveAvailable(),
      runs: runs.map((r) => ({
        run: r.run, status: r.status, latency_ms: r.latency_ms, tokens: r.tokens, turns: r.turns,
        tool_calls: r.tool_calls, temperature: r.temperature, temperature_error: r.temperature_error,
        reasoning_effort: r.reasoning_effort, trace: r.trace, obligations: r.report.obligations, design_conflicts: r.report.design_conflicts,
      })),
    });
  });

  // Sections a and b: the live audit (Z3) of a snapshot and, against base, the regression.
  app.post("/api/audit", async (req, res) => {
    const snapshots = ["base", ...readdirSync(join(corpusDir, "snapshots"))];
    const body = z.strictObject({ snapshot: z.string() }).safeParse(req.body);
    if (!body.success || !snapshots.includes(body.data.snapshot)) {
      res.status(400).json({ error: `snapshot must be one of ${snapshots.join(", ")}` });
      return;
    }
    if (overLimit()) {
      res.status(503).json({ error: "solver_memory_limit" });
      return;
    }
    const { snapshot } = body.data;
    const corpus = loadCorpus(corpusDir, snapshot);
    const started = performance.now();
    const findings = await audit(corpus);
    const audit_ms = performance.now() - started;
    audits_served += 1;
    const base = loadCorpus(corpusDir, "base");
    res.json({
      snapshot, snapshots, audit_ms, load_findings: corpus.findings, requirements: visible(corpus),
      conflicts: findings.filter((f) => (f.check === "consistency" || f.check === "scenario_conflict") && f.status === "UNSAT").map((f) => ({ check: f.check, scenario: f.scenario, core: f.core, timeline: timeline(corpus, f) })),
      findings: findings.map(({ check, status, subject, scenario, core, unverified }) => ({ check, status, subject, scenario, core, unverified })),
      regression: snapshot === "base" ? null : await regressions(base, corpus),
    });
  });

  // Section d: eval v4 (A/B/C) with its rescore, and the latest agent rescore next to the run it rescored. A live
  // run writes a newer agent file, so the agent table follows the rescore, not the newest run.
  app.get("/api/evals", (_req, res) => {
    const stored = runFiles(/\.json$/).map((file) => readRun<Stored>(file));
    const latest = (stage: string, source?: string) =>
      stored.filter((r) => r.stage === stage && (source === undefined || r.source_run_id === source)).at(-1);
    const evalRun = latest("eval") as (Stored & EvalRun) | undefined;
    const rescore = latest("agent_rescore");
    const agentRun = stored.find((r) => r.stage === "agent" && r.run_id === rescore?.source_run_id);
    if (evalRun === undefined || rescore === undefined || agentRun === undefined) {
      throw new Error("runs/ needs an eval run, an agent rescore and the agent run it rescored");
    }
    res.json({
      eval: evalTable(evalRun, latest("rescore", evalRun.run_id) as (Stored & EvalRescore) | undefined),
      agent: {
        run_id: agentRun.run_id, at_run_time: agentRun.summary, rescored: rescore.summary,
        gold_at_run_time: goldLabel(agentRun.gold_sha256), gold_rescored: goldLabel(rescore.gold_sha256),
      },
    });
  });

  // "Run agent live": one real run, written to runs/ like `pnpm eval:agent`. Off without an API key and in production.
  app.post("/api/agent-run", async (_req, res) => {
    if (!liveAvailable()) {
      res.status(503).json({ error: "The live agent runs locally only, with OPENAI_API_KEY set" });
      return;
    }
    if (overLimit()) {
      res.status(503).json({ error: "solver_memory_limit" });
      return;
    }
    const { run_id } = await agentEval(1);
    res.json({ run_id });
  });

  const web = fileURLToPath(new URL("apps/web/dist/", root));
  app.use(express.static(web));
  return app;
}

// v4 F1 and core_exact per variant and run, with the false positive rate on SAT cases from its rescore.
function evalTable(run: Stored & EvalRun, rescore: (Stored & EvalRescore) | undefined) {
  const fpr = (variant: string, n: number) => rescore?.variants[variant]?.find((r) => r.run === n)?.sat.false_positive_rate ?? null;
  return {
    run_id: run.run_id, protocol_version: run.protocol_version, model: run.model, rescore_run_id: rescore?.run_id ?? null,
    audit_latency_ms: { ...run.audit_latency_ms, samples: undefined },
    rows: Object.entries(run.variants).flatMap(([variant, runs]) =>
      runs.map(({ run: n, metrics: m }) => ({ variant, run: n, precision: m.precision, recall: m.recall, f1: m.f1, core_exact: m.core_exact, fpr_sat: fpr(variant, n) }))),
  };
}


type EvalRun = {
  protocol_version: number;
  model: string;
  audit_latency_ms: Record<string, unknown>;
  variants: Record<string, { run: number; metrics: { precision: number | null; recall: number | null; f1: number | null; core_exact: number | null } }[]>;
};
type EvalRescore = { variants: Record<string, { run: number; sat: { false_positive_rate: number | null } }[]> };

const rss = () => process.memoryUsage().rss;

// Vercel (api/index.js) imports this instance: the function never listens, and the warm-up waits for the first call.
export default createApp({ warm: warmup(), rss });

// Locally: listen on PORT (3000 by default; Vite proxies /api to it) and warm up at boot.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? "3000");
  const warm = warmup();
  const started = performance.now();
  createApp({ warm, rss }).listen(port, () => console.log(`rqaudit api on :${port}`));
  await warm();
  console.log(`warm-up audit ${Math.round(performance.now() - started)} ms: ready`);
}
