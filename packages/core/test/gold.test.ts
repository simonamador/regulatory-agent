import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { consistency, equivalence, holds, scenarioConflict, vacuity } from "../src/checks.js";
import { type Corpus, loadCorpus } from "../src/corpus.js";
import { regression } from "../src/regression.js";
import type { Witness } from "../src/schema.js";

type Gold = {
  id: string;
  check: string;
  corpus: string;
  scenario: string;
  interpretation: string;
  expected_status: string;
  expected_core: string[] | null;
  expected_unverified: { requirement: string; tick: number }[];
  expected_review: string[];
  expected_findings: { requirement: string; expected_status: string; expected_core: string[] }[];
  expected_reachable: string[];
  from: string;
  to: string;
  expected: Record<string, unknown>;
};

const corpusDir = fileURLToPath(new URL("../../../corpus/", import.meta.url));
const load = (name: string) => loadCorpus(corpusDir, name);
const gold = JSON.parse(readFileSync(new URL("../../../tests/gold/cases.json", import.meta.url), "utf8")) as Gold[];

// G07: on the witness exactly one reading holds, and the response first fires at t_trigger + s (in ticks).
async function replay(corpus: Corpus, interpretationId: string, witness: Witness) {
  const interpretation = corpus.interpretations.find((i) => i.id === interpretationId);
  if (interpretation === undefined) throw new Error(`Unknown interpretation ${interpretationId}`);
  const { A, B } = interpretation.readings;
  const { condition, response, timing } = A;
  if (condition === null || timing.kind !== "within") throw new Error("Replay needs a conditional within reading");

  expect(await holds(corpus.vocabulary, A, witness)).not.toBe(await holds(corpus.vocabulary, B, witness));
  const tTrigger = witness.findIndex((row) => row.signals[condition.signal] === condition.value);
  const tResponse = witness.findIndex((row, k) => k >= tTrigger && row.signals[response.signal] === response.value);
  expect(tTrigger).toBeGreaterThanOrEqual(0);
  expect(tResponse).toBe(tTrigger + timing.s / corpus.vocabulary.tick_s);
}

const runners: Record<string, (c: Gold) => Promise<void>> = {
  scenario_conflict: async (c) => {
    const corpus = load(c.corpus);
    const f = await scenarioConflict(corpus, c.scenario);
    expect(f.status).toBe(c.expected_status);
    expect(f.core).toEqual(c.expected_core?.toSorted() ?? []);
    expect(f.unverified).toEqual(c.expected_unverified);
    if (f.status === "SAT") expect(f.witness).toHaveLength(corpus.vocabulary.horizon_ticks);
  },

  consistency: async (c) => {
    const [main, ...review] = await consistency(load(c.corpus));
    expect(main?.status).toBe(c.expected_status);
    expect(main?.core).toEqual(c.expected_core ?? []);
    expect(review.map((f) => [f.status, f.subject])).toEqual(c.expected_review.map((id) => ["NEEDS_REVIEW", id]));
  },

  vacuity: async (c) => {
    const findings = await vacuity(load(c.corpus));
    const reported = findings.map((f) => ({ requirement: f.subject, expected_status: f.status, expected_core: f.core }));
    expect(reported).toEqual(c.expected_findings.map((e) => ({ ...e, expected_core: e.expected_core.toSorted() })));
    expect(findings.filter((f) => f.subject !== null && c.expected_reachable.includes(f.subject))).toEqual([]);
  },

  equivalence: async (c) => {
    const corpus = load(c.corpus);
    const f = await equivalence(corpus, c.interpretation);
    expect(f.status).toBe(c.expected_status);
    if (f.status === "SAT") await replay(corpus, c.interpretation, f.witness ?? []);
  },

  regression: async (c) => {
    const result: Record<string, unknown> = await regression(load(c.from), load(c.to), c.scenario);
    for (const [field, value] of Object.entries(c.expected)) expect(result[field], field).toEqual(value);
  },
};

it.each(gold.filter((c) => c.check !== "load"))("$id $check", async (c) => {
  const run = runners[c.check];
  expect(run, `no runner for ${c.check}`).toBeDefined();
  await run?.(c);
});
