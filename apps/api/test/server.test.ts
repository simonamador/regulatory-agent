import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server.js";

// The storyboard endpoints, on the committed runs/ and the live Z3 audit. No test here calls OpenAI.
vi.stubEnv("OPENAI_API_KEY", "");
const app = createApp();
const g01 = { check: "scenario_conflict", scenario: "SCN-101", core: ["REQ-101", "REQ-102", "SCN-101"] };
const LIVE = 30_000; // each POST /api/audit runs the full audit, twice more for a regression

describe("GET /api/agent-report", () => {
  it("serves the latest agent run with the 27 leaves and the design conflict", async () => {
    const { status, body } = await request(app).get("/api/agent-report");
    expect(status).toBe(200);
    expect(body.leaves).toHaveLength(27);
    expect(body.live_available).toBe(false);
    for (const run of body.runs) expect(run.design_conflicts).toContainEqual(g01);
    expect(body.runs[0].obligations.slice(0, 27).map((o: { paragraph: string }) => o.paragraph)).toEqual(
      body.leaves.map((l: { id: string }) => l.id),
    );
  });
});

describe("POST /api/audit", () => {
  it("base: the G01 conflict with its timeline over minutes 0–44", { timeout: LIVE }, async () => {
    const { status, body } = await request(app).post("/api/audit").send({ snapshot: "base" });
    expect(status).toBe(200);
    expect(body.regression).toBeNull();
    const [conflict] = body.conflicts;
    expect({ check: conflict.check, scenario: conflict.scenario, core: conflict.core }).toEqual(g01);
    const { ticks, mode, signals, rows } = conflict.timeline;
    expect([ticks, mode[0], mode[29], mode[30]]).toEqual([45, "WARMUP", "WARMUP", "ACTIVE"]);
    expect(signals.urgent_low[10]).toBe(true);
    const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
    expect(rows).toEqual([
      { requirement: "REQ-101", kind: "required", response: "urgent_low_alert", ticks: range(10, 16) },
      { requirement: "REQ-102", kind: "forbidden", response: "urgent_low_alert", ticks: range(0, 30) },
    ]);
  });

  it("v2-scope-active: the conflict is resolved", { timeout: LIVE }, async () => {
    const { body } = await request(app).post("/api/audit").send({ snapshot: "v2-scope-active" });
    expect(body.conflicts).toEqual([]);
    expect(body.regression).toEqual({ introduced: [], resolved: [g01], persistent: [], changed_requirements: ["REQ-101"] });
  });

  it("v3-text-only: the conflict persists and no requirement changed logically", { timeout: LIVE }, async () => {
    const { body } = await request(app).post("/api/audit").send({ snapshot: "v3-text-only" });
    expect(body.regression).toEqual({ introduced: [], resolved: [], persistent: [g01], changed_requirements: [] });
  });

  it("serves concurrent audits: the Z3 Context is held by one run at a time", { timeout: LIVE }, async () => {
    const audits = await Promise.all(["base", "base", "v3-text-only"].map((snapshot) => request(app).post("/api/audit").send({ snapshot })));
    expect(audits.map((a) => a.status)).toEqual([200, 200, 200]);
    for (const a of audits) expect(a.body.findings.filter((f: { status: string }) => f.status === "UNKNOWN")).toEqual([]);
  });

  it("rejects a snapshot that is not in corpus/snapshots", async () => {
    const { status } = await request(app).post("/api/audit").send({ snapshot: "../invalid" });
    expect(status).toBe(400);
  });
});

describe("GET /api/evals", () => {
  it("serves eval v4 with the false positive rate on SAT cases, and the agent on both golds", async () => {
    const { status, body } = await request(app).get("/api/evals");
    expect(status).toBe(200);
    expect(body.eval.protocol_version).toBe(4);
    expect(body.eval.rows.map((r: { variant: string }) => r.variant)).toEqual(["A", "B", "B", "B", "C", "C", "C"]);
    for (const row of body.eval.rows) expect(typeof row.fpr_sat).toBe("number");
    expect(body.agent.at_run_time.valid_runs).toBe(3);
    expect(body.agent.rescored.verdict_accuracy).toBe(1);
  });

  it("labels each gold by its sha256 and commit; a run without gold_sha256 says so", async () => {
    const { body } = await request(app).get("/api/evals");
    expect(body.agent.gold_rescored).toBe("9946ab5b · 2026-10-27 18:42 (95b1902)");
    expect(body.agent.gold_at_run_time).toBeNull(); // runs/agent-2026-10-27T23-26-23Z.json predates gold_sha256
  });

  it("knows the current gold: run pnpm gold:versions after committing a gold change", () => {
    const gold = readFileSync(new URL("../../../tests/gold/obligations.json", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    const versions = JSON.parse(readFileSync(new URL("../gold-versions.json", import.meta.url), "utf8")) as { sha256: string }[];
    expect(versions.map((v) => v.sha256)).toContain(createHash("sha256").update(gold).digest("hex"));
  });
});

describe("POST /api/agent-run", () => {
  it("is off without an API key", async () => {
    const { status } = await request(app).post("/api/agent-run");
    expect(status).toBe(503);
  });
});
