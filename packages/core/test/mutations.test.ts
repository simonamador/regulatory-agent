import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { scenarioConflict } from "../src/checks.js";
import { loadCorpus, mutate } from "../src/corpus.js";

// Self-describing (SPEC §7): the test knows no requirement or mode names, only what each case carries.
type Mutation = {
  id: string;
  overrides: Record<string, object>;
  scenario: { id: string; facts: object[] };
  expected_status: string;
  expected_core: string[] | null;
  expected_unverified: { requirement: string; tick: number }[];
};

const base = loadCorpus(fileURLToPath(new URL("../../../corpus/", import.meta.url)), "base");
const mutations = JSON.parse(
  readFileSync(new URL("../../../tests/gold/mutations.json", import.meta.url), "utf8"),
) as Mutation[];

it.each(mutations)("$id", async (m) => {
  const f = await scenarioConflict(mutate(base, m), m.scenario.id);
  expect(f.status).toBe(m.expected_status);
  expect(f.core).toEqual(m.expected_core?.toSorted() ?? []);
  expect(f.unverified).toEqual(m.expected_unverified);
});
