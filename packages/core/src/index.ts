import { audit as auditOnce, exclusive, scenarioConflict as scenarioConflictOnce } from "./checks.js";
import { regression as regressionOnce } from "./regression.js";

// Every Z3 entry point of the public API holds the process's single Context for its whole run (checks.ts).
export const audit = exclusive(auditOnce);
export const scenarioConflict = exclusive(scenarioConflictOnce);
export const regression = exclusive(regressionOnce);
export { type Corpus, loadCorpus, mutate } from "./corpus.js";
export { type Fact, type Finding, type Formal, type Vocabulary, corpusSchemas } from "./schema.js";
