import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "../src/corpus.js";
import { Vocabulary } from "../src/schema.js";

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

  // SPEC §7: 8 requirements, 2 axioms, 5 scenarios, 2 interpretations; snapshots replace, never add.
  it.each(["base", ...snapshots])("%s loads without findings", (name) => {
    const corpus = loadCorpus(corpusDir, name);
    expect(corpus.findings).toEqual([]);
    const counts = [corpus.requirements, corpus.axioms, corpus.scenarios, corpus.interpretations].map((xs) => xs.length);
    expect(counts).toEqual([8, 2, 5, 2]);
  });

  it.each(snapshots)("%s replaces its requirements by id", (name) => {
    const ids = readdirSync(new URL(`snapshots/${name}/requirements/`, corpusUrl)).map((file) => basename(file, ".json"));
    const find = (corpus: string, id: string) => loadCorpus(corpusDir, corpus).requirements.find((r) => r.id === id);
    expect(ids).not.toEqual([]);
    for (const id of ids) expect(find(name, id)).not.toEqual(find("base", id));
  });

  it("signals.json needs one description per declared signal, and no extra one", () => {
    const vocabulary = JSON.parse(readFileSync(new URL("signals.json", corpusUrl), "utf8")) as Vocabulary;
    const missing = Object.fromEntries(Object.entries(vocabulary.descriptions).filter(([s]) => s !== vocabulary.signals[0]));
    expect(Vocabulary.safeParse(vocabulary).success).toBe(true);
    expect(Vocabulary.safeParse({ ...vocabulary, descriptions: missing }).success).toBe(false);
    expect(Vocabulary.safeParse({ ...vocabulary, descriptions: { ...vocabulary.descriptions, extra: "x" } }).success).toBe(false);
  });

  it.each(gold.filter((c) => c.check === "load"))("$id: PARSE_ERROR for each invalid file", (c) => {
    const { findings } = loadCorpus(corpusDir, c.corpus);
    expect(findings.map((f) => `${f.status} ${f.subject}`).sort()).toEqual(
      c.expected_parse_errors.map((id) => `PARSE_ERROR ${id}`),
    );
  });
});
