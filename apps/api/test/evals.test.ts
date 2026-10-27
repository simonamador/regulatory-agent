import { fileURLToPath } from "node:url";
import { loadCorpus } from "@rqaudit/core";
import { describe, expect, it } from "vitest";
import { type Prediction, agreement, lint, metrics, renderReq001, renderReq002, renderScenario } from "../src/evals.js";

const base = loadCorpus(fileURLToPath(new URL("../../../corpus/", import.meta.url)), "base");
const text = (id: string) => base.requirements.find((r) => r.id === id)?.text;
const texts = base.requirements.map(({ id, text }) => ({ id, text }));
const H = base.vocabulary.horizon_ticks;

describe("templates", () => {
  it("reproduce the base corpus texts with D=5 inclusive and W=10", () => {
    expect(renderReq001(5, "inclusive")).toBe(text("REQ-001"));
    expect(renderReq002(10)).toBe(text("REQ-002"));
  });

  it("render the exclusive bound with its own wording", () => {
    expect(renderReq001(3, "exclusive")).toContain("in less than 3 seconds");
  });
});

describe("variant A", () => {
  it("flags G01 with REQ-001 and REQ-002 involved", () => {
    const scenario = base.scenarios.find((s) => s.id === "SCN-001");
    const verdict = lint(texts, renderScenario(H, scenario?.facts ?? []));
    expect(verdict.conflict).toBe(true);
    expect(verdict.involved_ids).toEqual(expect.arrayContaining(["REQ-001", "REQ-002"]));
  });

  it("does not flag a normal-mode scenario without occlusion", () => {
    const verdict = lint(texts, renderScenario(H, [{ mode: "NORMAL", from_s: 0, to_s: H }]));
    expect(verdict).toEqual({ conflict: false, involved_ids: [] });
  });
});

const prediction = (status: string, expected_status: string, core: string[], latency_ms: number): Prediction => ({
  id: `${status}-${expected_status}-${latency_ms}`,
  status,
  core,
  expected_status,
  expected_core: expected_status === "UNSAT" ? ["REQ-001", "REQ-002"] : [],
  latency_ms,
  usage: { prompt_tokens: 10, completion_tokens: 2 },
  message: null,
});

describe("metrics", () => {
  const fixed = [
    prediction("UNSAT", "UNSAT", ["REQ-001", "REQ-002"], 1), // TP, exact core
    prediction("UNSAT", "UNSAT", ["REQ-001"], 2), // TP, wrong core
    prediction("SAT", "UNSAT", [], 3), // FN
    prediction("ERROR", "UNSAT", [], 4), // FN and error
    prediction("UNSAT", "SAT", ["REQ-003"], 5), // FP
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
    const flipped = fixed.map((p, i) => (i === 0 ? { ...p, core: ["REQ-002"] } : p));
    expect(agreement([fixed, fixed, flipped])).toBe(6 / 7);
  });
});
