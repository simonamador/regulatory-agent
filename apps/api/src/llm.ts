import { type Formal, type Vocabulary, corpusSchemas } from "@rqaudit/core";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

// Model and prompts are versioned constants; every run records them (SPEC §5).
export const MODEL = "gpt-6.1-terra";

export const PROMPTS = {
  extract: ({ modes, signals }: Vocabulary) => `You formalize one requirement of an infusion pump into a flat template. Fill the fields; do not invent signals or modes.
Time is discrete: one tick per second. All intervals are half-open [from, to).
- scope.mode: the operating mode the requirement applies in, or "ANY".
- scope.window_s: null, or a window {from, to} in seconds measured from the moment the pump entered scope.mode.
- condition: the signal value that triggers the obligation, or null if it holds at every tick in scope.
- timing: {"kind":"always"} when the response must hold at the same tick as the trigger, for as long as the trigger holds;
  {"kind":"within","s":S,"bound":"inclusive"} when the response must occur at some tick in [t, t+S] after a trigger at t ("within a maximum of S", "at most S", "immediately" is S=0);
  {"kind":"within","s":S,"bound":"exclusive"} when it must occur in [t, t+S) ("in less than S").
- response: the signal value that must hold.
Return {"formal": null} when the requirement cannot be expressed with the given modes and signals.
Modes: ${modes.join(", ")}. Signals: ${signals.join(", ")}.`,
  judge: `You review the requirements of an infusion pump against a scenario. Time is discrete, one tick per second; intervals are half-open [from, to).
Anything the scenario does not fix is free. Decide whether there is NO execution consistent with the scenario that satisfies every requirement and domain fact.
Return conflict=true only in that case, with involved_ids = the ids of the smallest set of requirements (REQ-*) that cannot hold together in the scenario. Otherwise conflict=false and involved_ids=[].`,
};

export type Usage = { prompt_tokens: number; completion_tokens: number };
type Reply<T> = { latency_ms: number; usage: Usage | null } & ({ value: T; message: null } | { value: null; message: string });

// Fail-closed boundary (SPEC §6): any error, refusal or schema mismatch comes back as a message. No retries.
async function ask<T>(schema: z.ZodType<T>, name: string, system: string, user: string): Promise<Reply<T>> {
  const started = performance.now();
  try {
    const completion = await new OpenAI({ apiKey: process.env.OPENAI_API_KEY }).chat.completions.parse({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: zodResponseFormat(schema, name),
    });
    const message = completion.choices[0]?.message;
    if (message?.parsed == null) throw new Error(message?.refusal ?? "The model returned no parsed output.");
    const latency_ms = performance.now() - started;
    return { value: schema.parse(message.parsed), message: null, latency_ms, usage: completion.usage ?? null };
  } catch (error) {
    return { value: null, message: String(error), latency_ms: performance.now() - started, usage: null };
  }
}

// The LLM only proposes `formal`; no formal means the requirement stays pending (NEEDS_REVIEW).
export async function extract(vocabulary: Vocabulary, text: string) {
  const schema = z.strictObject({ formal: corpusSchemas(vocabulary).Formal.nullable() });
  const reply = await ask(schema, "requirement", PROMPTS.extract(vocabulary), text);
  const formal: Formal | null = reply.value?.formal ?? null;
  return {
    ...reply,
    formal,
    status: formal === null ? ("NEEDS_REVIEW" as const) : null,
    message: reply.message ?? (formal === null ? "The model found no formal reading." : null),
  };
}

const Verdict = z.strictObject({ conflict: z.boolean(), involved_ids: z.array(z.string()) });

// Variant B of the eval: the LLM alone judges the scenario (SPEC §5).
export function judge(texts: { id: string; text: string }[], scenario: string) {
  const listed = texts.map(({ id, text }) => `${id}: ${text}`).join("\n");
  return ask(Verdict, "verdict", PROMPTS.judge, `Requirements and domain facts:\n${listed}\n\nScenario:\n${scenario}`);
}
