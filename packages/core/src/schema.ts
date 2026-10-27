import { z } from "zod";

// corpus/signals.json fixes the vocabulary; every other corpus file is validated against it (SPEC §3).
// One tick is one second, so seconds and ticks are the same integers.
export const Vocabulary = z.strictObject({
  tick_s: z.literal(1),
  horizon_ticks: z.int().positive(),
  modes: z.array(z.string()).nonempty(),
  signals: z.array(z.string()).nonempty(),
});

const Status = z.enum(["SAT", "UNSAT", "UNKNOWN", "PARSE_ERROR", "NEEDS_REVIEW"]);

export const Finding = z.strictObject({
  check: z.enum(["load", "consistency", "scenario_conflict", "vacuity", "equivalence"]),
  status: Status,
  subject: z.string().nullable(), // requirement, interpretation or corpus file the finding is about
  scenario: z.string().nullable(),
  core: z.array(z.string()), // corpus ids or TRIGGER:<req>
  witness: z.array(z.strictObject({ mode: z.string(), signals: z.record(z.string(), z.boolean()) })).nullable(), // one row per tick
  message: z.string().nullable(),
});
export type Finding = z.infer<typeof Finding>;
export type Witness = NonNullable<Finding["witness"]>;

const seconds = z.int().nonnegative();

export function corpusSchemas({ modes, signals, horizon_ticks }: Vocabulary) {
  const Mode = z.enum(modes);
  const Signal = z.enum(signals);
  const Literal = z.strictObject({ signal: Signal, value: z.boolean() });

  const Formal = z.strictObject({
    scope: z.strictObject({
      mode: z.enum(["ANY", ...modes]),
      window_s: z.strictObject({ from: seconds, to: seconds }).nullable(),
    }),
    condition: Literal.nullable(),
    timing: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("within"), s: seconds, bound: z.enum(["inclusive", "exclusive"]) }),
      z.strictObject({ kind: z.literal("always") }),
    ]),
    response: Literal,
  });

  const Requirement = z
    .strictObject({
      id: z.string(),
      version: z.string(),
      text: z.string(),
      source: z.strictObject({
        kind: z.enum(["anchored", "synthetic"]),
        ref: z.string().nullable(),
        note: z.string(),
      }),
      status: z.enum(["pending", "approved"]),
      approved_by: z.string().nullable(),
      formal: Formal.nullable(),
    })
    .refine((r) => r.formal !== null || r.status === "pending", {
      message: "formal may be null only while status is pending",
      path: ["formal"],
    });

  const Axiom = z.strictObject({
    id: z.string(),
    text: z.string(),
    formal: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("mode_duration"), mode: Mode, min_s: seconds, max_s: seconds }),
      z.strictObject({ kind: z.literal("signal_impossible_in_mode"), signal: Signal, mode: Mode }),
    ]),
  });

  // Facts are half-open [from_s, to_s) inside the horizon (SPEC §3).
  const interval = { from_s: seconds, to_s: seconds.max(horizon_ticks) };
  const Fact = z
    .union([
      z.strictObject({ mode: Mode, ...interval }),
      z.strictObject({ signal: Signal, value: z.boolean(), ...interval }),
    ])
    .refine((f) => f.from_s < f.to_s, "fact needs from_s < to_s");

  const Scenario = z.strictObject({ id: z.string(), description: z.string(), facts: z.array(Fact) });

  const Interpretation = z.strictObject({
    id: z.string(),
    requirement_id: z.string(),
    question: z.string(),
    context_scenario: z.string(),
    readings: z.strictObject({ A: Formal, B: Formal }),
  });

  return { Formal, Requirement, Axiom, Scenario, Interpretation };
}

type Schemas = ReturnType<typeof corpusSchemas>;
export type Vocabulary = z.infer<typeof Vocabulary>;
export type Formal = z.infer<Schemas["Formal"]>;
export type Axiom = z.infer<Schemas["Axiom"]>;
export type Fact = z.infer<Schemas["Scenario"]>["facts"][number];
