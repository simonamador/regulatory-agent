import type { Bool, Context, Model } from "z3-solver";
import type { Axiom, Fact, Formal, Vocabulary, Witness } from "./schema.js";

// Ticks in the half-open interval [from, to).
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

// The vocabulary's terms: the mode Datatype and, per tick, the mode and signal constants and their literals. They
// depend only on signals.json, so checks.ts builds them once per vocabulary. Declaring the Datatype on every check
// made a new sort, and new atoms, each time: memory grew with every audit. This is not a cache of results (SPEC §6).
// Z3 constants are identified by name, so `urgent_low@3` is the same variable wherever it is built.
export function vocabularyTerms(ctx: Context<"main">, { horizon_ticks: H, modes, signals }: Vocabulary) {
  const Mode = ctx.Datatype("Mode");
  for (const mode of modes) Mode.declare(mode);
  const modeSort = Mode.create();
  const ticks = range(0, H);
  const modeAt = (k: number) => ctx.Const(`mode@${k}`, modeSort);
  const signalAt = (signal: string, k: number) => ctx.Bool.const(`${signal}@${k}`);
  const table = (keys: string[], build: (key: string, k: number) => Bool<"main">) =>
    new Map(keys.map((key) => [key, ticks.map((k) => build(key, k))]));
  return {
    modeAt,
    modeAtoms: table(modes, (mode, k) => modeAt(k).eq(modeSort.constructorDecl(modes.indexOf(mode)).call())),
    trueAtoms: table(signals, signalAt),
    falseAtoms: table(signals, (signal, k) => ctx.Not(signalAt(signal, k))),
  };
}
export type VocabularyTerms = ReturnType<typeof vocabularyTerms>;

// Formulas over one bounded trace: ticks 0..H-1, a Bool per signal and a mode enum per tick (SPEC §3).
// Corpus times are seconds, already validated as multiples of tick_s; `tick` turns them into ticks.
export function encoder(ctx: Context<"main">, { horizon_ticks: H, tick_s, signals }: Vocabulary, terms: VocabularyTerms) {
  const ticks = range(0, H);
  const tick = (s: number) => s / tick_s;
  const { modeAt, modeAtoms, trueAtoms, falseAtoms } = terms;

  const lookup = (atoms: Map<string, Bool<"main">[]>, key: string, k: number) => {
    const atom = atoms.get(key)?.[k];
    if (atom === undefined) throw new Error(`No atom for ${key} at tick ${k}`);
    return atom;
  };
  const isMode = (mode: string, k: number) => lookup(modeAtoms, mode, k);
  const literal = ({ signal, value }: Formal["response"], k: number) => lookup(value ? trueAtoms : falseAtoms, signal, k);
  const entered = (mode: string, e: number) =>
    e === 0 ? isMode(mode, e) : ctx.And(isMode(mode, e), ctx.Not(isMode(mode, e - 1)));

  function inScope({ mode, window_s }: Formal["scope"], k: number): Bool<"main"> {
    if (mode === "ANY") return ctx.Bool.val(true);
    if (window_s === null) return isMode(mode, k);
    // Some entry e with from <= k - e < to, staying in the mode on every tick of [e, k].
    const entries = range(Math.max(0, k - tick(window_s.to) + 1), k - tick(window_s.from) + 1);
    return ctx.Or(...entries.map((e) => ctx.And(entered(mode, e), ...range(e, k + 1).map((j) => isMode(mode, j)))));
  }

  const trigger = (formal: Formal, k: number) =>
    formal.condition === null ? inScope(formal.scope, k) : ctx.And(inScope(formal.scope, k), literal(formal.condition, k));
  const last = (timing: Extract<Formal["timing"], { kind: "within" }>, k: number) =>
    timing.bound === "inclusive" ? k + tick(timing.s) : k + tick(timing.s) - 1;

  function obligation(formal: Formal, k: number): Bool<"main"> {
    const { timing, response } = formal;
    if (timing.kind === "always") return ctx.Implies(trigger(formal, k), literal(response, k));
    // A deadline past the horizon constrains nothing; otherwise the trace end yields spurious UNSAT (G04).
    // Those ticks are not dropped in silence: `tails` hands them to the unverified check (SPEC §4).
    if (last(timing, k) > H - 1) return ctx.Bool.val(true);
    return ctx.Implies(trigger(formal, k), ctx.Or(...range(k, last(timing, k) + 1).map((j) => literal(response, j))));
  }

  function axiom(formal: Axiom["formal"]): Bool<"main"> {
    if (formal.kind === "signal_impossible_in_mode") {
      const absent = { signal: formal.signal, value: false };
      return ctx.And(...ticks.map((k) => ctx.Implies(isMode(formal.mode, k), literal(absent, k))));
    }
    const [min, max] = [tick(formal.min_s), tick(formal.max_s)];
    // After each entry: stay for min ticks (a run cut by the horizon is valid) and be gone at e + max.
    const afterEntry = (e: number) => [
      ...range(e, Math.min(e + min, H)).map((j) => isMode(formal.mode, j)),
      ...(e + max <= H - 1 ? [ctx.Not(isMode(formal.mode, e + max))] : []),
    ];
    return ctx.And(...ticks.map((e) => ctx.Implies(entered(formal.mode, e), ctx.And(...afterEntry(e)))));
  }

  const fact = (f: Fact, k: number) => ("mode" in f ? isMode(f.mode, k) : literal(f, k));

  return {
    requirement: (formal: Formal) => ctx.And(...ticks.map((k) => obligation(formal, k))),
    triggered: (formal: Formal) => ctx.Or(...ticks.map((k) => trigger(formal, k))),
    // The ticks whose `within` deadline passes the horizon, with the trigger at each one.
    tails: (formal: Formal) => {
      const { timing } = formal;
      if (timing.kind === "always") return [];
      return ticks.filter((k) => last(timing, k) > H - 1).map((k) => ({ tick: k, trigger: trigger(formal, k) }));
    },
    axiom,
    scenario: (facts: Fact[]) =>
      ctx.And(...facts.flatMap((f) => range(tick(f.from_s), tick(f.to_s)).map((k) => fact(f, k)))),
    witness: (model: Model<"main">): Witness =>
      ticks.map((k) => ({
        mode: model.eval(modeAt(k), true).toString(),
        signals: Object.fromEntries(signals.map((s) => [s, ctx.isTrue(model.eval(lookup(trueAtoms, s, k), true))])),
      })),
  };
}
export type Encoder = ReturnType<typeof encoder>;
