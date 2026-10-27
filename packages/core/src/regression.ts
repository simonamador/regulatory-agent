import { scenarioConflict } from "./checks.js";
import type { Corpus } from "./corpus.js";
import type { Finding } from "./schema.js";

// Finding identity (SPEC §4): check, scenario and the sorted core ids.
const identity = ({ check, scenario, core }: Finding) => ({ check, scenario, core });
const key = (f: Finding) => JSON.stringify(identity(f));

// Diff of the findings of one scenario between two snapshots. SAT is not a finding.
export async function regression(from: Corpus, to: Corpus, scenarioId: string) {
  const findings = async (corpus: Corpus) =>
    [await scenarioConflict(corpus, scenarioId)].filter((f) => f.status !== "SAT");
  const before = await findings(from);
  const after = await findings(to);
  const keys = (fs: Finding[]) => new Set(fs.map(key));
  const formals = (corpus: Corpus) => new Map(corpus.requirements.map((r) => [r.id, JSON.stringify(r.formal)]));
  const [formalsBefore, formalsAfter] = [formals(from), formals(to)];

  return {
    introduced: after.filter((f) => !keys(before).has(key(f))).map(identity),
    resolved: before.filter((f) => !keys(after).has(key(f))).map(identity),
    persistent: before.filter((f) => keys(after).has(key(f))).map(identity),
    // Text or version edits do not count: only a different formal reading does.
    changed_requirements: [...new Set([...formalsBefore.keys(), ...formalsAfter.keys()])]
      .filter((id) => formalsBefore.get(id) !== formalsAfter.get(id))
      .sort(),
  };
}
