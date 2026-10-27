import type { Bool, Context, Model } from "z3-solver";
import type { Axiom, Fact, Formal, Vocabulary, Witness } from "./schema.js";

// Ticks in the half-open interval [from, to).
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

// Formulas over one bounded trace: ticks 0..H-1, a Bool per signal and a mode enum per tick (SPEC §3).
// Z3 constants are identified by name, so `alarm@3` is the same variable wherever it is built.
export function encoder(ctx: Context<"main">, { horizon_ticks: H, modes, signals }: Vocabulary) {
  const Mode = ctx.Datatype("Mode");
  for (const mode of modes) Mode.declare(mode);
  const modeSort = Mode.create();
  const ticks = range(0, H);

  const modeAt = (k: number) => ctx.Const(`mode@${k}`, modeSort);
  const signalAt = (signal: string, k: number) => ctx.Bool.const(`${signal}@${k}`);

  // Atoms are built once: every Z3 call crosses into WASM, and rebuilding them dominated the check time.
  const table = (keys: string[], build: (key: string, k: number) => Bool<"main">) =>
    new Map(keys.map((key) => [key, ticks.map((k) => build(key, k))]));
  const lookup = (atoms: Map<string, Bool<"main">[]>, key: string, k: number) => {
    const atom = atoms.get(key)?.[k];
    if (atom === undefined) throw new Error(`No atom for ${key} at tick ${k}`);
    return atom;
  };
  const modeAtoms = table(modes, (mode, k) => modeAt(k).eq(modeSort.constructorDecl(modes.indexOf(mode)).call()));
  const trueAtoms = table(signals, signalAt);
  const falseAtoms = table(signals, (signal, k) => ctx.Not(signalAt(signal, k)));
  const isMode = (mode: string, k: number) => lookup(modeAtoms, mode, k);
  const literal = ({ signal, value }: Formal["response"], k: number) => lookup(value ? trueAtoms : falseAtoms, signal, k);
  const entered = (mode: string, e: number) =>
    e === 0 ? isMode(mode, e) : ctx.And(isMode(mode, e), ctx.Not(isMode(mode, e - 1)));

  function inScope({ mode, window_s }: Formal["scope"], k: number): Bool<"main"> {
    if (mode === "ANY") return ctx.Bool.val(true);
    if (window_s === null) return isMode(mode, k);
    // Some entry e with from <= k - e < to, staying in the mode on every tick of [e, k].
    const entries = range(Math.max(0, k - window_s.to + 1), k - window_s.from + 1);
    return ctx.Or(...entries.map((e) => ctx.And(entered(mode, e), ...range(e, k + 1).map((j) => isMode(mode, j)))));
  }

  const trigger = (formal: Formal, k: number) =>
    formal.condition === null ? inScope(formal.scope, k) : ctx.And(inScope(formal.scope, k), literal(formal.condition, k));

  function obligation(formal: Formal, k: number): Bool<"main"> {
    const { timing, response } = formal;
    if (timing.kind === "always") return ctx.Implies(trigger(formal, k), literal(response, k));
    const last = timing.bound === "inclusive" ? k + timing.s : k + timing.s - 1;
    // A deadline past the horizon constrains nothing; otherwise the trace end yields spurious UNSAT (G04).
    if (last > H - 1) return ctx.Bool.val(true);
    return ctx.Implies(trigger(formal, k), ctx.Or(...range(k, last + 1).map((j) => literal(response, j))));
  }

  function axiom(formal: Axiom["formal"]): Bool<"main"> {
    if (formal.kind === "signal_impossible_in_mode") {
      const absent = { signal: formal.signal, value: false };
      return ctx.And(...ticks.map((k) => ctx.Implies(isMode(formal.mode, k), literal(absent, k))));
    }
    const { mode, min_s, max_s } = formal;
    // After each entry: stay for min_s (a run cut by the horizon is valid) and be gone at e + max_s.
    const afterEntry = (e: number) => [
      ...range(e, Math.min(e + min_s, H)).map((j) => isMode(mode, j)),
      ...(e + max_s <= H - 1 ? [ctx.Not(isMode(mode, e + max_s))] : []),
    ];
    return ctx.And(...ticks.map((e) => ctx.Implies(entered(mode, e), ctx.And(...afterEntry(e)))));
  }

  const fact = (f: Fact, k: number) => ("mode" in f ? isMode(f.mode, k) : literal(f, k));

  return {
    requirement: (formal: Formal) => ctx.And(...ticks.map((k) => obligation(formal, k))),
    triggered: (formal: Formal) => ctx.Or(...ticks.map((k) => trigger(formal, k))),
    axiom,
    scenario: (facts: Fact[]) => ctx.And(...facts.flatMap((f) => range(f.from_s, f.to_s).map((k) => fact(f, k)))),
    witness: (model: Model<"main">): Witness =>
      ticks.map((k) => ({
        mode: model.eval(modeAt(k), true).toString(),
        signals: Object.fromEntries(signals.map((s) => [s, ctx.isTrue(model.eval(signalAt(s, k), true))])),
      })),
  };
}
export type Encoder = ReturnType<typeof encoder>;
