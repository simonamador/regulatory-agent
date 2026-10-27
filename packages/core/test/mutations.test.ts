import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { scenarioConflict } from "../src/checks.js";
import { type Corpus, loadCorpus } from "../src/corpus.js";

type Mutation = {
  id: string;
  t: number;
  D: number;
  bound: "inclusive" | "exclusive";
  W: number;
  e: number;
  calEnd: number;
  expected_status: string;
  expected_core: string[] | null;
};

const base = loadCorpus(fileURLToPath(new URL("../../../corpus/", import.meta.url)), "base");
const mutations = JSON.parse(
  readFileSync(new URL("../../../tests/gold/mutations.json", import.meta.url), "utf8"),
) as Mutation[];

// SPEC §7: the full base corpus with REQ-001 and REQ-002 replaced, plus scenario SCN built from the fields.
function mutate(m: Mutation): Corpus {
  const requirements = base.requirements.map((r) => {
    if (r.formal === null) return r;
    if (r.id === "REQ-001") return { ...r, formal: { ...r.formal, timing: { kind: "within" as const, s: m.D, bound: m.bound } } };
    if (r.id === "REQ-002") return { ...r, formal: { ...r.formal, scope: { ...r.formal.scope, window_s: { from: 0, to: m.W } } } };
    return r;
  });
  const facts = [
    { mode: "NORMAL", from_s: 0, to_s: m.e },
    { mode: "CALIBRATION", from_s: m.e, to_s: m.calEnd },
    { mode: "NORMAL", from_s: m.calEnd, to_s: base.vocabulary.horizon_ticks },
    { signal: "occlusion", value: true, from_s: m.t, to_s: m.t + 1 },
  ].filter((f) => f.from_s < f.to_s);
  return { ...base, requirements, scenarios: [...base.scenarios, { id: "SCN", description: m.id, facts }] };
}

it.each(mutations)("$id", async (m) => {
  const f = await scenarioConflict(mutate(m), "SCN");
  expect(f.status).toBe(m.expected_status);
  expect(f.core).toEqual(m.expected_core?.toSorted() ?? []);
});
