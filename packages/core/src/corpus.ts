import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { type Finding, Vocabulary, corpusSchemas } from "./schema.js";

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

// Fail-closed boundary (SPEC §6): a bad file becomes a PARSE_ERROR finding and the rest still loads.
function parseFile<T>(path: string, schema: z.ZodType<T>, findings: Finding[]): T[] {
  try {
    return [schema.parse(readJson(path))];
  } catch (error) {
    findings.push({
      check: "load",
      status: "PARSE_ERROR",
      subject: basename(path, ".json"),
      scenario: null,
      core: [],
      witness: null,
      unverified: [],
      message: String(error),
    });
    return [];
  }
}

// `name` is "base", a directory under corpus/snapshots/, or "invalid" (corpus/invalid/, SPEC §3).
// Overlays only carry requirements. Without a valid signals.json nothing can be validated, so it throws.
export function loadCorpus(root: string, name: string) {
  const signals = readFileSync(join(root, "signals.json"), "utf8").replaceAll("\r\n", "\n");
  const vocabulary = Vocabulary.parse(JSON.parse(signals));
  const schemas = corpusSchemas(vocabulary);
  const findings: Finding[] = [];
  const loadDir = <T>(dir: string, schema: z.ZodType<T>) =>
    readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .flatMap((file) => parseFile(join(dir, file), schema, findings));
  const overlay = name === "invalid" ? join(root, "invalid") : join(root, "snapshots", name);
  const requirements = [
    ...loadDir(join(root, "requirements"), schemas.Requirement),
    ...(name === "base" ? [] : loadDir(join(overlay, "requirements"), schemas.Requirement)),
  ];

  return {
    vocabulary,
    // Keys the vocabulary's Z3 terms in checks.ts; LF-normalized, so a CRLF checkout keys like an LF one.
    vocabulary_sha256: createHash("sha256").update(signals).digest("hex"),
    // Overlay requirements come last, so they replace the base ones by id.
    requirements: [...new Map(requirements.map((r) => [r.id, r])).values()],
    axioms: parseFile(join(root, "axioms.json"), z.array(schemas.Axiom), findings).flat(),
    scenarios: loadDir(join(root, "scenarios"), schemas.Scenario),
    interpretations: loadDir(join(root, "interpretations"), schemas.Interpretation),
    findings,
  };
}
export type Corpus = ReturnType<typeof loadCorpus>;

// A self-describing mutation (SPEC §7): `formal` fields replaced per requirement id, plus one extra scenario.
// Both go through the corpus schemas, so a mutation cannot carry what a corpus file could not (e.g. 90 s).
export function mutate(
  corpus: Corpus,
  { id, overrides, scenario }: { id: string; overrides: Record<string, object>; scenario: object },
): Corpus {
  const schemas = corpusSchemas(corpus.vocabulary);
  const unknown = Object.keys(overrides).filter((req) => !corpus.requirements.some((r) => r.id === req && r.formal !== null));
  if (unknown.length > 0) throw new Error(`${id} overrides requirements without a formal: ${unknown.join(", ")}`);
  const requirements = corpus.requirements.map((r) => {
    const override = overrides[r.id];
    return override === undefined ? r : { ...r, formal: schemas.Formal.parse({ ...r.formal, ...override }) };
  });
  const extra = schemas.Scenario.parse({ ...scenario, description: id });
  return { ...corpus, requirements, scenarios: [...corpus.scenarios, extra] };
}
