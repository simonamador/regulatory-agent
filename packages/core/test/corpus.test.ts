import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "../src/corpus.js";

const corpusUrl = new URL("../../../corpus/", import.meta.url);
const corpusDir = fileURLToPath(corpusUrl);
const gold = JSON.parse(readFileSync(new URL("../../../tests/gold/cases.json", import.meta.url), "utf8")) as {
  id: string;
  check: string;
  corpus: string;
  expected_parse_errors: string[];
}[];

describe("corpus", () => {
  const snapshots = readdirSync(new URL("snapshots/", corpusUrl));

  // SPEC §7: 9 requirements, 2 axioms, 5 scenarios, 2 interpretations; snapshots replace, never add.
  it.each(["base", ...snapshots])("%s loads without findings", (name) => {
    const corpus = loadCorpus(corpusDir, name);
    expect(corpus.findings).toEqual([]);
    const counts = [corpus.requirements, corpus.axioms, corpus.scenarios, corpus.interpretations].map((xs) => xs.length);
    expect(counts).toEqual([9, 2, 5, 2]);
  });

  it.each(snapshots)("%s replaces REQ-002 by id", (name) => {
    const req002 = (corpus: string) => loadCorpus(corpusDir, corpus).requirements.find((r) => r.id === "REQ-002");
    expect(req002(name)).not.toEqual(req002("base"));
  });

  it.each(gold.filter((c) => c.check === "load"))("$id: PARSE_ERROR for each invalid file", (c) => {
    const { findings } = loadCorpus(corpusDir, c.corpus);
    expect(findings.map((f) => `${f.status} ${f.subject}`).sort()).toEqual(
      c.expected_parse_errors.map((id) => `PARSE_ERROR ${id}`),
    );
  });
});
