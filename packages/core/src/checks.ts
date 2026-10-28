import { type Bool, type Solver, init } from "z3-solver";
import type { Corpus } from "./corpus.js";
import { type Encoder, type VocabularyTerms, encoder, vocabularyTerms } from "./encode.js";
import type { Finding, Formal, Witness } from "./schema.js";

// init() is async and heavy: one Context per process (CLAUDE.md).
const { Context } = await init();
const ctx = Context("main");

// Z3's async check runs on a worker over this single Context; two operations interleaved on it corrupt WASM memory
// (concurrent HTTP requests crashed the server). The public API (index.ts) holds the Context for each whole run;
// the next run waits whatever this one's outcome, and the outcome itself still reaches its caller.
let held: Promise<unknown> = Promise.resolve();
export function exclusive<A extends unknown[], T>(run: (...args: A) => Promise<T>) {
  return (...args: A): Promise<T> => {
    const result = held.then(() => run(...args));
    held = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

// The vocabulary's terms, built once per sha256 of signals.json (encode.ts). Formulas and results are built per check.
const terms = new Map<string, VocabularyTerms>();
function encoderOf(corpus: Corpus) {
  const known = terms.get(corpus.vocabulary_sha256) ?? vocabularyTerms(ctx, corpus.vocabulary);
  terms.set(corpus.vocabulary_sha256, known);
  return encoder(ctx, corpus.vocabulary, known);
}

type Literal = [id: string, literal: Bool<"main">];
type Outcome = Pick<Finding, "status" | "core" | "witness" | "unverified">;
type Tail = { requirement: string; tick: number; trigger: Bool<"main"> };

// Deletion (SPEC §4): Z3's core is not minimal by guarantee. A literal stays unless dropping it is still UNSAT.
async function minimize(solver: Solver<"main">, core: Literal[]) {
  let kept = core;
  for (const [id] of core) {
    const without = kept.filter(([other]) => other !== id);
    if ((await solver.check(...without.map(([, literal]) => literal))) === "unsat") kept = without;
  }
  return kept.map(([id]) => id).sort();
}

// Z3 objects are otherwise freed only when JS's GC runs their finalizers, so Solvers and Models piled up and the
// WASM memory, which never shrinks, grew with every audit. Each one is released when its work ends, success or error,
// through Promise.finally: checks.ts is not a try/catch boundary (SPEC §6).
const released = <Z3 extends { release(): void }, R>(z3: Z3, run: (z3: Z3) => Promise<R>) => run(z3).finally(() => z3.release());

// Each assertion is Implies(literal, formula) with the literal named exactly as its corpus id (SPEC §4).
// Only scenario_conflict has tails to check; every other check passes [].
const solve = (enc: Encoder, assertions: { id: string; formula: Bool<"main"> }[], tails: Tail[]) =>
  released(new ctx.Solver(), async (solver): Promise<Outcome> => {
    solver.set("random_seed", 0);
    solver.set("timeout", 2000);
    const literals = assertions.map(({ id, formula }): Literal => {
      const literal = ctx.Bool.const(id);
      solver.add(ctx.Implies(literal, formula));
      return [id, literal];
    });
    const assumptions = literals.map(([, literal]) => literal);
    const result = await solver.check(...assumptions);
    const unknown: Outcome = { status: "UNKNOWN", core: [], witness: null, unverified: [] };
    if (result === "unknown") return unknown;
    if (result === "sat") {
      // Unverified (SPEC §4): a tail counts when its trigger holds in every model, i.e. assuming ¬trigger is UNSAT.
      // The witness does not decide: it only discards tails whose trigger is false in it. Every reported pair comes
      // from an UNSAT check on this same solver (incremental). One UNKNOWN makes the list, and the finding, unknown.
      const { witness, candidates } = await released(solver.model(), async (model) => ({
        witness: enc.witness(model),
        candidates: tails.filter(({ trigger }) => ctx.isTrue(model.eval(trigger, true))),
      }));
      const unverified: Finding["unverified"] = [];
      for (const { requirement, tick, trigger } of candidates) {
        const forced = await solver.check(...assumptions, ctx.Not(trigger));
        if (forced === "unknown") return unknown;
        if (forced === "unsat") unverified.push({ requirement, tick });
      }
      return { status: "SAT", core: [], witness, unverified };
    }
    const core = new Set([...solver.unsatCore()].map((literal) => String(literal.decl().name())));
    const minimal = await minimize(solver, literals.filter(([id]) => core.has(id)));
    return { status: "UNSAT", core: minimal, witness: null, unverified: [] };
  });

const finding = (check: Finding["check"], subject: string | null, scenario: string | null, outcome: Outcome): Finding => ({
  check,
  subject,
  scenario,
  ...outcome,
  message: null,
});

function byId<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((x) => x.id === id);
  if (item === undefined) throw new Error(`Unknown corpus id: ${id}`);
  return item;
}

const axioms = (enc: Encoder, corpus: Corpus) => corpus.axioms.map((a) => ({ id: a.id, formula: enc.axiom(a.formal) }));

// REQ is only approved requirements (SPEC §4); pending ones surface as NEEDS_REVIEW from consistency().
const approved = (enc: Encoder, corpus: Corpus) =>
  corpus.requirements.flatMap((r) =>
    r.status === "approved" && r.formal !== null
      ? [{ id: r.id, formal: r.formal, formula: enc.requirement(r.formal) }]
      : [],
  );

export async function consistency(corpus: Corpus): Promise<Finding[]> {
  const enc = encoderOf(corpus);
  const outcome = await solve(enc, [...axioms(enc, corpus), ...approved(enc, corpus)], []);
  const review = corpus.requirements
    .filter((r) => r.status === "pending")
    .map((r) => ({ ...finding("consistency", r.id, null, { status: "NEEDS_REVIEW", core: [], witness: null, unverified: [] }),
      message: "Pending: not in the solver until approved." }));
  return [finding("consistency", null, null, outcome), ...review];
}

export async function scenarioConflict(corpus: Corpus, scenarioId: string): Promise<Finding> {
  const enc = encoderOf(corpus);
  const scenario = byId(corpus.scenarios, scenarioId);
  const facts = { id: scenario.id, formula: enc.scenario(scenario.facts) };
  const requirements = approved(enc, corpus).toSorted((a, b) => a.id.localeCompare(b.id));
  // Sorted by requirement, then by tick (SPEC §4).
  const tails = requirements.flatMap((r) => enc.tails(r.formal).map((t) => ({ requirement: r.id, ...t })));
  const outcome = await solve(enc, [...axioms(enc, corpus), ...requirements, facts], tails);
  return finding("scenario_conflict", null, scenario.id, outcome);
}

// Reports only requirements whose trigger is unreachable (UNSAT) or undecided (UNKNOWN).
export async function vacuity(corpus: Corpus): Promise<Finding[]> {
  const enc = encoderOf(corpus);
  const requirements = approved(enc, corpus);
  const findings: Finding[] = [];
  for (const r of requirements.filter((x) => x.formal.condition !== null)) {
    const trigger = { id: `TRIGGER:${r.id}`, formula: enc.triggered(r.formal) };
    const others = requirements.filter((x) => x.id !== r.id);
    const outcome = await solve(enc, [...axioms(enc, corpus), ...others, trigger], []);
    if (outcome.status !== "SAT") findings.push(finding("vacuity", r.id, null, outcome));
  }
  return findings;
}

export async function equivalence(corpus: Corpus, interpretationId: string): Promise<Finding> {
  const enc = encoderOf(corpus);
  const { id, context_scenario, readings } = byId(corpus.interpretations, interpretationId);
  const context = byId(corpus.scenarios, context_scenario);
  const differ = ctx.Not(enc.requirement(readings.A).eq(enc.requirement(readings.B)));
  const assertions = [...axioms(enc, corpus), { id: context.id, formula: enc.scenario(context.facts) }, { id, formula: differ }];
  return finding("equivalence", id, context.id, await solve(enc, assertions, []));
}

// Audit (SPEC §4): consistency + scenario_conflict per scenario + vacuity + equivalence per interpretation.
export async function audit(corpus: Corpus): Promise<Finding[]> {
  const findings = await consistency(corpus);
  for (const s of corpus.scenarios) findings.push(await scenarioConflict(corpus, s.id));
  findings.push(...(await vacuity(corpus)));
  for (const i of corpus.interpretations) findings.push(await equivalence(corpus, i.id));
  return findings;
}

// Whether `formal` holds on a fully fixed trace, e.g. a witness.
export async function holds(corpus: Corpus, formal: Formal, witness: Witness): Promise<boolean> {
  const { vocabulary } = corpus;
  const enc = encoderOf(corpus);
  const span = (k: number) => ({ from_s: k * vocabulary.tick_s, to_s: (k + 1) * vocabulary.tick_s });
  const facts = witness.flatMap(({ mode, signals }, k) => [
    { mode, ...span(k) },
    ...Object.entries(signals).map(([signal, value]) => ({ signal, value, ...span(k) })),
  ]);
  const { status } = await solve(enc, [
    { id: "WITNESS", formula: enc.scenario(facts) },
    { id: "READING", formula: enc.requirement(formal) },
  ], []);
  if (status === "UNKNOWN") throw new Error("Could not evaluate the formula on the witness.");
  return status === "SAT";
}
