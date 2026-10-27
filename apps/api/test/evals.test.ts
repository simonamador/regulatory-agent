import { fileURLToPath } from "node:url";
import { loadCorpus } from "@rqaudit/core";
import { describe, expect, it } from "vitest";
import { type Prediction, agreement, lint, metrics, renderReq101, renderReq102, renderScenario, rescored } from "../src/evals.js";

const base = loadCorpus(fileURLToPath(new URL("../../../corpus/", import.meta.url)), "base");
const text = (id: string) => base.requirements.find((r) => r.id === id)?.text;
const texts = base.requirements.map(({ id, text }) => ({ id, text }));
const { vocabulary } = base;
const all = vocabulary.horizon_ticks * vocabulary.tick_s;

describe("templates", () => {
  it("reproduce the base corpus texts with D=5 inclusive and W=30", () => {
    expect(renderReq101(5, "inclusive")).toBe(text("REQ-101"));
    expect(renderReq102(30)).toBe(text("REQ-102"));
  });

  it("render the exclusive bound with its own wording", () => {
    expect(renderReq101(3, "exclusive")).toContain("in less than 3 minutes");
  });

  it("render scenario facts in natural language, in minutes", () => {
    const lines = renderScenario(vocabulary, [
      { mode: "WARMUP", from_s: 0, to_s: 1800 },
      { signal: "urgent_low", value: true, from_s: 600, to_s: 660 },
      { signal: "urgent_low", value: false, from_s: 660, to_s: all },
    ]).split("\n");
    expect(lines).toEqual([
      "The trace covers minute 0 to minute 44. Anything not stated is unconstrained.",
      "The sensor is in warmup mode from minute 0 to minute 30.",
      "An urgent low is detected at minute 10.",
      "No urgent low is detected from minute 11 to minute 45.",
    ]);
  });
});

describe("variant A", () => {
  it("flags G01 with REQ-101 and REQ-102 involved", () => {
    const scenario = base.scenarios.find((s) => s.id === "SCN-101");
    const verdict = lint(texts, renderScenario(vocabulary, scenario?.facts ?? []));
    expect(verdict.conflict).toBe(true);
    expect(verdict.involved_ids).toEqual(expect.arrayContaining(["REQ-101", "REQ-102"]));
  });

  it("does not flag an active-sensor scenario without urgent low", () => {
    const verdict = lint(texts, renderScenario(vocabulary, [{ mode: "ACTIVE", from_s: 0, to_s: all }]));
    expect(verdict).toEqual({ conflict: false, involved_ids: [] });
  });
});

const tail = [{ requirement: "REQ-104", tick: 44 }];
const prediction = (status: string, expected_status: string, core: string[], latency_ms: number): Prediction => ({
  id: `${status}-${expected_status}-${latency_ms}`,
  status,
  core,
  expected_status,
  expected_core: expected_status === "UNSAT" ? ["REQ-101", "REQ-102"] : [],
  expected_unverified: expected_status === "UNSAT" ? [] : tail,
  latency_ms,
  usage: { prompt_tokens: 10, completion_tokens: 2 },
  message: null,
});

describe("metrics", () => {
  const fixed = [
    prediction("UNSAT", "UNSAT", ["REQ-101", "REQ-102"], 1), // TP, exact core
    prediction("UNSAT", "UNSAT", ["REQ-101"], 2), // TP, wrong core
    prediction("SAT", "UNSAT", [], 3), // FN
    prediction("ERROR", "UNSAT", [], 4), // FN and error
    prediction("UNSAT", "SAT", ["REQ-103"], 5), // FP
    prediction("SAT", "SAT", [], 6), // TN
    prediction("UNKNOWN", "SAT", [], 7), // error
  ];

  it("scores UNSAT as the positive class", () => {
    expect(metrics(fixed)).toEqual({
      precision: 2 / 3,
      recall: 2 / 4,
      f1: 4 / 7,
      core_exact: 1 / 4,
      errors: 2,
      latency_ms: { p50: 4, p95: 7 },
      tokens: { prompt: 70, completion: 14 },
    });
  });

  it("leaves undefined ratios null instead of a favorable default", () => {
    const m = metrics([prediction("SAT", "SAT", [], 1)]);
    expect([m.precision, m.recall, m.f1, m.core_exact]).toEqual([null, null, null, null]);
    expect(metrics([]).latency_ms).toEqual({ p50: null, p95: null });
  });

  it("measures agreement as cases with the same status and core in every run", () => {
    const flipped = fixed.map((p, i) => (i === 0 ? { ...p, core: ["REQ-102"] } : p));
    expect(agreement([fixed, fixed, flipped])).toBe(6 / 7);
  });

  it("rescores the in_horizon slice and the false positive rate on SAT cases", () => {
    const { in_horizon, sat } = rescored(fixed);
    expect([in_horizon.cases, in_horizon.accuracy, in_horizon.recall]).toEqual([4, 2 / 4, 2 / 4]);
    expect(sat).toEqual({ cases: 3, false_positive_rate: 1 / 3 });
  });
});
