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
      message: String(error),
    });
    return [];
  }
}

// `name` is "base", a directory under corpus/snapshots/, or "invalid" (corpus/invalid/, SPEC §3).
// Overlays only carry requirements. Without a valid signals.json nothing can be validated, so it throws.
export function loadCorpus(root: string, name: string) {
  const schemas = corpusSchemas(Vocabulary.parse(readJson(join(root, "signals.json"))));
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
    // Overlay requirements come last, so they replace the base ones by id.
    requirements: [...new Map(requirements.map((r) => [r.id, r])).values()],
    axioms: parseFile(join(root, "axioms.json"), z.array(schemas.Axiom), findings).flat(),
    scenarios: loadDir(join(root, "scenarios"), schemas.Scenario),
    interpretations: loadDir(join(root, "interpretations"), schemas.Interpretation),
    findings,
  };
}
