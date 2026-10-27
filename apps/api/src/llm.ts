import { type Formal, type Vocabulary, corpusSchemas } from "@rqaudit/core";
import OpenAI from "openai";
import { zodResponseFormat, zodResponsesFunction, zodTextFormat } from "openai/helpers/zod";
import type { ResponseInput } from "openai/resources/responses/responses";
import { z } from "zod";

// Model and prompts are versioned constants; every run records them (SPEC §5).
export const MODEL = "gpt-6.1-terra";
export const AGENT_TEMPERATURE = 0; // the minimum (SPEC §10)

// B and C get the same vocabulary preamble, appended to their system prompts. Since protocol v3 it speaks minutes;
// since v4 it carries the signal glossary of signals.json.
export const preamble = ({ modes, signals, tick_s, descriptions }: Vocabulary) =>
  `Modes: ${modes.join(", ")}. Signals: ${signals.join(", ")}.
Time is discrete: one tick is ${tick_s / 60} minute (${tick_s} s). Each signal is a Boolean the CGM observes every tick; true at minute t means the CGM detects that condition at minute t.
Signal glossary:
${signals.map((s) => `- ${s}: ${descriptions[s]}`).join("\n")}`;

export const PROMPTS = {
  extract: `You formalize one requirement of a continuous glucose monitor (CGM) into a flat template. Fill the fields; do not invent signals or modes.
All intervals are half-open [from, to). Every duration in the template is in seconds (2 minutes is 120) and must be a whole number of ticks.
- scope.mode: the operating mode the requirement applies in, or "ANY".
- scope.window_s: null, or a window {from, to} in seconds measured from the moment the sensor entered scope.mode.
- condition: the signal value that triggers the obligation, or null if it holds at every tick in scope.
- timing: {"kind":"always"} when the response must hold at the same tick as the trigger, for as long as the trigger holds;
  {"kind":"within","s":S,"bound":"inclusive"} when the response must occur at some tick in [t, t+S] after a trigger at t ("within a maximum of S", "at most S", "immediately" is S=0);
  {"kind":"within","s":S,"bound":"exclusive"} when it must occur in [t, t+S) ("in less than S").
- response: the signal value that must hold.
Return {"formal": null} when the requirement cannot be expressed with the given modes and signals.`,
  judge: `You review the requirements of a continuous glucose monitor (CGM) against a scenario. Time is discrete, in ticks; intervals are half-open [from, to).
Anything the scenario does not fix is free. Decide whether there is NO execution consistent with the scenario that satisfies every requirement and domain fact.
Return conflict=true only in that case, with involved_ids = the ids of the smallest set of requirements (REQ-*) that cannot hold together in the scenario. Otherwise conflict=false and involved_ids=[].`,
  agent: `You are a regulatory engineer for a continuous glucose monitor (CGM). Produce an impact assessment of a regulation on the product requirements.
Tools: get_regulation returns every leaf paragraph of the regulation with its context; search_requirements and get_requirement find the product requirements; run_audit returns the formal audit findings that touch the given requirement ids.
Output exactly one item for every leaf paragraph returned by get_regulation:
- paragraph: the paragraph id exactly as given.
- category: "behavior" if it constrains what the device does at runtime; "evidence" if it asks for design verification/validation, clinical, manufacturing or usability evidence; "labeling" if it is content the labeling must include.
- quote: a short exact substring of that paragraph's context that supports the category.
- implemented_by: the ids of the product requirements that implement the obligation, [] if none. Use only ids returned by the tools.
- rationale: at most two sentences.
Do not judge consistency or compliance: the verdicts are computed from the audit, not by you.`,
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

type Step<T> = { calls: { id: string; name: string; arguments: unknown }[]; final: T | null };

// One model turn: either function calls, or the final structured answer. Its own function because inline it pushes
// the session's `next` past ESLint's complexity limit.
function step<T>(schema: z.ZodType<T>, response: { output: { type: string }[]; output_parsed: unknown }): Step<T> {
  const calls = response.output
    .filter((item) => item.type === "function_call")
    .map((item) => z.object({ call_id: z.string(), name: z.string(), arguments: z.string() }).parse(item))
    .map((c) => ({ id: c.call_id, name: c.name, arguments: JSON.parse(c.arguments) as unknown }));
  if (calls.length > 0) return { calls, final: null };
  if (response.output_parsed == null) throw new Error("The model returned neither function calls nor parsed output.");
  return { calls, final: schema.parse(response.output_parsed) };
}

// The agent's conversation (SPEC §10) on the Responses API: agent.ts drives the loop, every request crosses this
// boundary (SPEC §6). Turns chain by previous_response_id; each call sends the previous turn's function outputs.
// Temperature 0 is sent; if the API rejects it, it is omitted from then on and the rejection is kept in `settings`.
export function agentSession<T>(
  schema: z.ZodType<T>,
  tools: { name: string; description: string; parameters: z.ZodType<object> }[],
  user: string,
) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const settings = {
    temperature: AGENT_TEMPERATURE as number | null,
    temperature_error: null as string | null,
    reasoning_effort: null as string | null, // effective, as the API reports it
  };
  let previous: string | null = null;
  const request = (input: ResponseInput) =>
    client.responses.parse({
      model: MODEL,
      instructions: PROMPTS.agent,
      input,
      previous_response_id: previous,
      tools: tools.map(({ name, description, parameters }) => zodResponsesFunction({ name, description, parameters })),
      text: { format: zodTextFormat(schema, "assessment") },
      ...(settings.temperature === null ? {} : { temperature: settings.temperature }),
    });
  const next = async (results: { id: string; content: string }[]): Promise<Reply<Step<T>>> => {
    const input: ResponseInput =
      previous === null
        ? [{ role: "user", content: user }]
        : results.map(({ id, content }) => ({ type: "function_call_output", call_id: id, output: content }));
    const started = performance.now();
    try {
      const response = await request(input).catch((error: unknown) => {
        const temperature = error instanceof OpenAI.APIError && error.status === 400 &&
          (error.param === "temperature" || /temperature/i.test(error.message));
        if (!temperature || settings.temperature === null) throw error;
        [settings.temperature, settings.temperature_error] = [null, String(error)];
        return request(input);
      });
      previous = response.id;
      settings.reasoning_effort = response.reasoning?.effort ?? null;
      const usage = response.usage === undefined ? null : { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens };
      return { value: step(schema, response), message: null, latency_ms: performance.now() - started, usage };
    } catch (error) {
      return { value: null, message: String(error), latency_ms: performance.now() - started, usage: null };
    }
  };
  return { next, settings };
}

// The LLM only proposes `formal`; no formal means the requirement stays pending (NEEDS_REVIEW).
export async function extract(vocabulary: Vocabulary, text: string) {
  const schema = z.strictObject({ formal: corpusSchemas(vocabulary).Formal.nullable() });
  const reply = await ask(schema, "requirement", `${PROMPTS.extract}\n${preamble(vocabulary)}`, text);
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
export function judge(vocabulary: Vocabulary, texts: { id: string; text: string }[], scenario: string) {
  const listed = texts.map(({ id, text }) => `${id}: ${text}`).join("\n");
  const system = `${PROMPTS.judge}\n${preamble(vocabulary)}`;
  return ask(Verdict, "verdict", system, `Requirements and domain facts:\n${listed}\n\nScenario:\n${scenario}`);
}
