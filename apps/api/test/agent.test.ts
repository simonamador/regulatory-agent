import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { audit, loadCorpus } from "@rqaudit/core";
import { describe, expect, it } from "vitest";
import { type Obligation, agentAgreement, agentMetrics, agentSummary, assess, assessmentReport } from "../src/agent.js";
import { agentTools, parseRegulation } from "../src/tools.js";

// No test here calls OpenAI (SPEC §10): mappings are fixed, the audit is the real one.
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const corpus = loadCorpus(fileURLToPath(new URL("../../../corpus/", import.meta.url)), "base");
const leaves = parseRegulation(read("corpus/regulations/21-CFR-862.1355.txt"));
const gold = (JSON.parse(read("tests/gold/obligations.json")) as {
  obligations: { paragraph: string; category: "behavior" | "evidence" | "labeling"; implemented_by: string[]; expected_verdict: string }[];
}).obligations;
const findings = await audit(corpus);

// A valid quote: the leaf's own line, the last line of its context.
const quote = (paragraph: string) => leaves.find((l) => l.id === paragraph)?.context.split("\n").at(-1) ?? "";
const goldItems = gold.map(({ paragraph, category, implemented_by }) => ({ paragraph, category, implemented_by, quote: quote(paragraph), rationale: "" }));
const withMapping = (paragraph: string, implemented_by: string[]) =>
  goldItems.map((i) => (i.paragraph === paragraph ? { ...i, implemented_by } : i));
const obligation = (os: Obligation[], paragraph: string) => os.find((o) => o.paragraph === paragraph);

describe("regulation parser", () => {
  it("finds the 27 leaf paragraphs of obligations.json, (a) excluded", () => {
    expect(leaves.map((l) => l.id)).toEqual(gold.map((g) => g.paragraph));
  });

  it("gives each leaf its ancestors' text plus its own", () => {
    const lines = leaves.find((l) => l.id === "(b)(1)(v)(A)")?.context.split("\n") ?? [];
    expect(lines.map((line) => line.slice(0, 4))).toEqual(["(b) ", "(1) ", "(v) ", "(A) "]);
  });
});

describe("tools", () => {
  const call = (name: string, args: object) => agentTools(corpus, leaves).find((t) => t.name === name)?.call(args);

  it("search_requirements exposes neither source nor formal", async () => {
    const found = (await call("search_requirements", { query: "warm-up" })) as object[];
    expect(found.length).toBeGreaterThan(0);
    for (const r of found) expect(Object.keys(r).sort()).toEqual(["id", "status", "text"]);
  });

  it("search_requirements matches any whitespace-separated term", async () => {
    const ids = async (query: string) => ((await call("search_requirements", { query })) as { id: string }[]).map((r) => r.id);
    expect(await ids("signal")).toEqual(["REQ-105"]);
    expect(await ids("signal transmit")).toEqual(["REQ-104", "REQ-105"]);
  });

  it("run_audit returns the findings that touch the given ids", async () => {
    const touched = (await call("run_audit", { requirement_ids: ["REQ-101"] })) as { scenario: string | null; core: string[] }[];
    expect(touched).toContainEqual(expect.objectContaining({ scenario: "SCN-101", core: ["REQ-101", "REQ-102", "SCN-101"] }));
  });
});

describe("verdict derivation (SPEC §10)", () => {
  it("reproduces every expected verdict of obligations.json with its mapping", () => {
    const assessed = assess(goldItems, leaves, corpus, findings);
    expect(assessed.map((o) => [o.paragraph, o.verdict])).toEqual(gold.map((g) => [g.paragraph, g.expected_verdict]));
  });

  it("lists REQ-101 × REQ-102 as a design conflict although no paragraph maps REQ-101", () => {
    const report = assessmentReport(assess(goldItems, leaves, corpus, findings), findings);
    expect(goldItems.flatMap((i) => i.implemented_by)).not.toContain("REQ-101");
    expect(report.design_conflicts).toContainEqual({ check: "scenario_conflict", scenario: "SCN-101", core: ["REQ-101", "REQ-102", "SCN-101"] });
  });

  it("(b)(7)(iv) → [REQ-108, REQ-101] is CONFLICT, the worst contribution", () => {
    const o = obligation(assess(withMapping("(b)(7)(iv)", ["REQ-108", "REQ-101"]), leaves, corpus, findings), "(b)(7)(iv)");
    expect(o?.verdict).toBe("CONFLICT");
    expect(o?.contributions).toEqual([
      { requirement: "REQ-108", verdict: "NOT_FORMALIZED", finding_ref: "consistency:REQ-108" },
      { requirement: "REQ-101", verdict: "CONFLICT", finding_ref: "scenario_conflict:SCN-101" },
    ]);
  });

  it("(b)(5) → [REQ-106, REQ-107] is DEAD: TRIGGER:REQ-107 is a vacuity core, not a conflict", () => {
    const o = obligation(assess(withMapping("(b)(5)", ["REQ-106", "REQ-107"]), leaves, corpus, findings), "(b)(5)");
    expect(o?.verdict).toBe("DEAD");
    expect(o?.contributions).toEqual([
      { requirement: "REQ-106", verdict: "CONSISTENT_BOUNDED", finding_ref: null },
      { requirement: "REQ-107", verdict: "DEAD", finding_ref: "vacuity:REQ-107" },
    ]);
  });

  it("an UNKNOWN scenario_conflict sends every obligation mapped to an approved requirement to NEEDS_REVIEW", () => {
    const unknown = findings.map((f) => (f.scenario === "SCN-102" && f.check === "scenario_conflict" ? { ...f, status: "UNKNOWN" as const, witness: null, unverified: [] } : f));
    const assessed = assess(goldItems, leaves, corpus, unknown);
    expect(obligation(assessed, "(b)(1)(vii)")).toMatchObject({ verdict: "NEEDS_REVIEW", reasons: ["audit_unknown"], contributions: [] });
    expect(obligation(assessed, "(b)(7)(iv)")?.verdict).toBe("NOT_FORMALIZED"); // REQ-108 is pending: never in a solve
    expect(obligation(assessed, "(b)(1)(i)")?.verdict).toBe("OUT_OF_SCOPE");
  });

  it("an UNKNOWN equivalence does not count (SPEC §10)", () => {
    const unknown = findings.map((f) => (f.subject === "INT-102" ? { ...f, status: "UNKNOWN" as const } : f));
    const o = obligation(assess(goldItems, leaves, corpus, unknown), "(b)(1)(vii)"); // REQ-105, the requirement of INT-102
    expect(o?.verdict).toBe("CONSISTENT_BOUNDED");
  });

  it("fails closed on a bad quote, an unknown id, and a missing, duplicate or extra paragraph", () => {
    const items = goldItems
      .filter((i) => i.paragraph !== "(b)(3)")
      .map((i) => (i.paragraph === "(b)(2)" ? { ...i, quote: "not in the text" } : i))
      .map((i) => (i.paragraph === "(b)(5)" ? { ...i, implemented_by: ["REQ-999"] } : i));
    const evidence = { category: "evidence" as const, quote: "", implemented_by: [], rationale: "" };
    const extra = { ...evidence, paragraph: "(b)(9)" };
    const duplicate = { ...evidence, paragraph: "(b)(4)", quote: quote("(b)(4)") };
    const assessed = assess([...items, extra, duplicate, duplicate], leaves, corpus, findings);
    const reasons = (p: string) => obligation(assessed, p)?.reasons;
    expect(reasons("(b)(2)")).toEqual(["invalid_quote"]);
    expect(reasons("(b)(5)")).toEqual(["unknown_requirement"]);
    expect(reasons("(b)(3)")).toEqual(["missing_paragraph"]);
    expect(reasons("(b)(4)")).toEqual(["duplicate_paragraph"]);
    expect(reasons("(b)(9)")).toEqual(["extra_paragraph"]);
    expect(assessed.filter((o) => o.verdict === "NEEDS_REVIEW")).toHaveLength(5);
  });
});

describe("agent metrics", () => {
  it("scores a perfect run as perfect", () => {
    const assessed = assess(goldItems, leaves, corpus, findings);
    expect(agentMetrics(assessed, goldItems, leaves, gold, corpus)).toEqual({
      category_accuracy: 1, mapping_precision: 1, mapping_recall: 1, gap_recall: 1,
      valid_quote_rate: 1, invented_ids: 0, verdict_accuracy: 1, needs_review: 0,
    });
  });

  it("scores category, mapping pairs, gaps, quotes, invented ids and verdicts", () => {
    // (b)(7)(i) mapped to REQ-103 (a gap missed, a wrong pair), (b)(2) as labeling, (b)(5) cites nothing real,
    // (b)(1)(vii) maps an invented id.
    const items = goldItems
      .map((i) => (i.paragraph === "(b)(7)(i)" ? { ...i, implemented_by: ["REQ-103"] } : i))
      .map((i) => (i.paragraph === "(b)(2)" ? { ...i, category: "labeling" as const } : i))
      .map((i) => (i.paragraph === "(b)(5)" ? { ...i, quote: "invented" } : i))
      .map((i) => (i.paragraph === "(b)(1)(vii)" ? { ...i, implemented_by: ["REQ-105", "REQ-777"] } : i));
    const m = agentMetrics(assess(items, leaves, corpus, findings), items, leaves, gold, corpus);
    expect(m).toEqual({
      category_accuracy: 26 / 27,
      mapping_precision: 4 / 6, // REQ-104, REQ-105, REQ-106, REQ-108 right; REQ-103, REQ-777 wrong
      mapping_recall: 4 / 4,
      gap_recall: 3 / 4,
      valid_quote_rate: 26 / 27,
      invented_ids: 1,
      verdict_accuracy: 24 / 27, // (b)(7)(i) CONSISTENT_BOUNDED, (b)(5) and (b)(1)(vii) NEEDS_REVIEW
      needs_review: 2,
    });
  });

  const failed = { status: "api_error", latency_ms: 1800, tokens: { prompt: 0, completion: 0 }, metrics: null, obligations: assess([], leaves, corpus, findings) };

  it("3 runs failed at the API: agreement and every figure are null, never 1", () => {
    const summary = agentSummary([failed, failed, failed], leaves);
    expect(summary.valid_runs).toBe(0);
    expect(Object.entries(summary).filter(([key]) => key !== "valid_runs")).toEqual(
      Object.keys(summary).filter((key) => key !== "valid_runs").map((key) => [key, null]),
    );
  });

  it("an api_error run is left out of agreement, accuracies, latency and tokens", () => {
    const obligations = assess(goldItems, leaves, corpus, findings);
    const ok = { status: "complete", latency_ms: 1000, tokens: { prompt: 10, completion: 2 }, obligations,
      metrics: agentMetrics(obligations, goldItems, leaves, gold, corpus) };
    expect(agentSummary([ok, failed, ok], leaves)).toMatchObject({
      valid_runs: 2, agreement: 1, verdict_accuracy: 1, latency_ms: 1000, tokens_in: 20, tokens_out: 4, needs_review: 0,
    });
    expect(agentSummary([ok, failed], leaves).agreement).toBeNull(); // agreement needs two valid runs
  });

  it("measures agreement as leaves with the same category, mapping and verdict in every run", () => {
    const base = assess(goldItems, leaves, corpus, findings);
    const changed = assess(withMapping("(b)(5)", ["REQ-106", "REQ-107"]), leaves, corpus, findings);
    expect(agentAgreement([base, base, changed], leaves)).toBe(26 / 27);
  });
});
