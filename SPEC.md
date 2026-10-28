# Technical SPEC — Neurosymbolic Requirements Auditor

This SPEC is the technical source of truth. It complemented a short product brief (PRD v0.1, not in this repository); if something is in neither, it is not built.
Precedence on conflict: `tests/gold/` > this SPEC > PRD.

It includes the v2 delta of 27-Oct-2026: the device is a continuous glucose monitor (CGM), time is in seconds with a tick from `signals.json`, obligations that run past the horizon are reported as `unverified`, and there is a regulatory agent (§10). The earlier infusion-pump corpus remains in the git history.

## 1. Stack (decided with Simón on 27-Oct-2026)

| Layer | Choice |
|---|---|
| Language | TypeScript 6.0 strict, Node 22+ |
| Monorepo | pnpm workspaces + Turborepo |
| Schemas and validation | Zod 4 |
| Solver | `z3-solver` 5.3.2 (official WASM), server side only |
| LLM | `openai` SDK 7, structured outputs with Zod; OpenAI directly, model in a constant |
| API | Express 5 |
| UI | React 19 + Vite 8 (`@vitejs/plugin-react`) + Tailwind 4 (`@tailwindcss/vite`) |
| Persistence | Versioned JSON in `corpus/`; no database |
| Tests | Vitest 5; supertest for the `server.ts` endpoints |
| Quality | `tsc --noEmit`, ESLint 10 + typescript-eslint 8, knip |
| Deploy | Vercel Hobby: `apps/web/dist` as static output and the Express app as one function at `/api` (`api/index.js`, `vercel.json`). Locally, Express listens and serves both on one port |

TypeScript is pinned to 6.0 because typescript-eslint 8 requires `<6.1`.

## 2. Layout (closed)

```
packages/core/src/
  schema.ts      # Zod: Signal, Requirement, Axiom, Scenario, Finding, Status
  corpus.ts      # reads and validates corpus/ with Zod (error boundary, §6); applies mutations (§7)
  encode.ts      # Requirement/Axiom/Scenario → Z3 formulas over the BMC trace
  checks.ts      # the 5 checks + core minimization + unverified. The only place with a Solver
  regression.ts  # findings diff between two snapshots
  index.ts       # public exports
apps/api/src/
  server.ts      # Express: GET /api/health, GET /api/agent-report, POST /api/audit {snapshot}, GET /api/evals, POST /api/agent-run; serves web/dist locally
  llm.ts         # text → Requirement.formal via OpenAI, and the agent's session. The only import of `openai`
  evals.ts       # CLI `pnpm eval`: variants A/B/C → runs/<run_id>.json; `--rescore`
  agent.ts       # regulatory agent and `pnpm eval:agent` (§10)
  tools.ts       # the agent's deterministic tools (§10)
apps/web/                   # index.html, vite.config.ts (proxies /api → :3000 in dev)
  src/main.tsx, index.css   # entry point and Swiss design tokens
  src/api.ts                # API types and fetch helpers
  src/App.tsx + one component per storyboard section (a–e)
api/index.js     # Vercel function: re-exports the Express app
corpus/          # signals.json, requirements/, axioms.json, scenarios/, interpretations/, snapshots/, invalid/, regulations/
tests/gold/      # cases.json, mutations.json, gen-mutations.mjs, obligations.json (approved by Simón; read-only for the agent)
runs/            # one JSON per eval or agent run (runs/README.md)
scripts/         # gate.sh (the Stop-hook gate), gold-versions.mjs
docs/            # corpus-review.md: the record of the corpus approval
```

`z3-solver` is imported only in `encode.ts` and `checks.ts`, and `openai` only in `llm.ts` (enforced by ESLint `no-restricted-imports`).

## 3. Formal model: bounded traces (BMC)

`corpus/signals.json` fixes the vocabulary: `tick_s`, `horizon_ticks`, `modes`, `signals` and a `descriptions` glossary. Everything else is validated against it. **No model number is hard-coded**: the horizon, the tick and the modes come from there.

Current vocabulary: `tick_s = 60` (1 tick = 1 minute), `horizon_ticks = 45` (minutes 0..44), modes `WARMUP`, `ACTIVE`, `EXPIRED`, signals `urgent_low`, `urgent_low_alert`, `glucose_shown`, `data_gap`, `signal_loss_alert`, `reading_sent`.

- **Units:** every time value in the corpus is in seconds: `s`, `window_s`, `min_s`, `max_s`, `from_s`, `to_s`. The encoder divides by `tick_s`. A value that is not a multiple of `tick_s` is a `PARSE_ERROR` (G11: REQ-902 with 90 s).
- **Trace:** ticks `k = 0..H−1`, with `H = horizon_ticks`.
- **State per tick:** one `Bool` per signal, and `mode_k` as a Z3 enum over the vocabulary's modes.
- **Entering a mode:** `entered(M, e)` ⇔ `mode_e = M` and (`e = 0` or `mode_{e-1} ≠ M`).
- **Every interval is half-open `[from, to)`**: scope windows and scenario facts alike.

Exact semantics of a requirement, for each tick `k` (durations already divided by `tick_s`):
- `trigger(k)` = `in_scope(k) ∧ condition(k)` (a null `condition` is true).
- `in_scope(k)`: `ANY` → true. Mode `M` without a window → `mode_k = M`. With a window `[from, to)` → there is an entry `e ≤ k` with `entered(M, e)`, `mode_j = M` for every `j ∈ [e, k]`, and `from ≤ k − e < to`.
- `always`: `trigger(k) → response(k)`.
- `within s`: with `d = s / tick_s`, `last = k + d` (inclusive) or `k + d − 1` (exclusive). If `last > H − 1`, tick `k` constrains nothing (truncation at the horizon), but it is not dropped silently: it goes to the `unverified` check (§4). Otherwise `trigger(k) → ∃ j ∈ [k, last]: response(j)`.

Without the truncation, spurious UNSAT results appear at the end of the trace (gold case G04 tests this).

### DSL: a flat FRET-style template, not a recursive AST

The LLM fills typed fields; there are no nested expressions. `encode.ts` translates each combination into formulas over the trace.

```ts
Requirement = {
  id, version, text,
  source: { kind: "anchored" | "synthetic", ref: string | null, note: string },
  status: "pending" | "approved", approved_by: string | null,
  formal: null | {                                             // null only while status = "pending"
    scope:     { mode: "ANY" | Mode,                           // Mode: one of signals.json
                 window_s: { from: int, to: int } | null },   // seconds, relative to entering the mode
    condition: { signal: SignalName, value: boolean } | null, // trigger
    timing:    { kind: "within", s: int, bound: "inclusive" | "exclusive" }
             | { kind: "always" },
    response:  { signal: SignalName, value: boolean },
  }
}
```

Canonical readings:
- REQ-101: `scope ANY`, `condition urgent_low=true`, `timing within 300 inclusive`, `response urgent_low_alert=true`.
- REQ-102: `scope WARMUP, window 0–1800`, `condition null`, `timing always`, `response urgent_low_alert=false`.

**Axioms (`AX-*`), in `corpus/axioms.json`:**
- `{ kind: "mode_duration", mode, min_s, max_s }`: with `min = min_s / tick_s` and `max = max_s / tick_s`, after each entry `e` the mode holds on `[e, min(e + min, H))`, and `mode_{e+max} ≠ M` if `e + max ≤ H − 1`. A run cut by the horizon is valid.
- `{ kind: "signal_impossible_in_mode", signal, mode }`: `mode_k = M → ¬signal_k` for every `k`.

**Scenarios (`SCN-*`):** `facts` is a list of `{ mode, from_s, to_s }` or `{ signal, value, from_s, to_s }`. Whatever a scenario does not fix stays free.

**Interpretations (`INT-*`):** `{ id, requirement_id, question, context_scenario, readings: { A: formal, B: formal } }`. The `context_scenario` keeps the witness readable (G07: urgent low at minute 2 → alert at minute 7).

**Snapshots:** `corpus/snapshots/<name>/requirements/*.json` replace the requirements of `corpus/requirements/` by `id`. `base` is the corpus without replacements.

An undeclared signal or mode, or seconds that are not integers or not multiples of `tick_s` → `PARSE_ERROR` (rejected by Zod). `corpus/invalid/` exists only to test this.

## 4. Checks

Each requirement, axiom and fact is asserted as `Implies(p_id, formula)` with a literal `p_id`, and solved with `solver.check(...literals)` + `solver.unsatCore()`.

| Check | Formula | Output |
|---|---|---|
| `consistency` | AX ∧ REQ | UNSAT → core |
| `scenario_conflict` | AX ∧ REQ ∧ SCN | UNSAT → core · SAT → witness trace + `unverified` |
| `vacuity` (per requirement with a `condition`) | AX ∧ REQ∖{r} ∧ `TRIGGER:r` = ∃k: trigger_r(k) | UNSAT → unreachable trigger |
| `equivalence` (A vs B) | AX ∧ SCN(context) ∧ ¬(A ↔ B) | SAT → boundary witness trace |
| `regression` | findings diff between snapshots | introduced / resolved / persistent |

`REQ` = approved requirements only. Each `pending` requirement also produces its own `NEEDS_REVIEW` finding. Core ids are corpus ids or `TRIGGER:<req>`.

- **Unverified obligations:** a SAT `scenario_conflict` also returns `unverified: {requirement, tick}[]`. A pair is listed if (a) the requirement's timing is `within`, (b) its `last` at that tick is past `H − 1`, and (c) the trigger holds in **every** model of AX ∧ REQ ∧ SCN. To decide (c), a check with the assumption ¬trigger(k) must be UNSAT. The witness does not decide: it only discards pairs whose trigger is false in it. Every reported pair comes from an UNSAT check. The solver of the SAT check is reused (incremental). The list is sorted by requirement, then by tick; if the result is UNSAT it is empty. If any of those checks returns `unknown`, the whole finding is `UNKNOWN`.
- **Minimal core:** Z3's core is not minimal by guarantee. It is minimized by deletion: drop one literal, re-check, and discard it if still UNSAT.
- **Finding identity:** `(check, scenario_id | null, sorted core ids)`. Regression compares by this key.
- **Solver:** `random_seed = 0`, `timeout = 2000` ms; on timeout → `UNKNOWN`. One `Context` per process. Each public operation of core (`audit`, `scenarioConflict`, `regression`) holds it exclusively, because two interleaved checks corrupt the WASM memory.
- **Witness:** a tick × signal/mode table; the UI draws it as a timeline.
- **Audit:** an audit = consistency + scenario_conflict for each scenario + vacuity + equivalence for each interpretation, over the base corpus, in a process that has already run one full warm-up audit. The local server warms up at boot; a Vercel instance warms up on its first call, and `/api/health` answers 200 only once that is done. `pnpm eval` reports the process's first audit separately as `cold_first_audit_ms`.

**Status:** `SAT | UNSAT | UNKNOWN | PARSE_ERROR | NEEDS_REVIEW`. There is no `compliant` field of any kind. A `pending` requirement is never excluded silently.

## 5. LLM (`apps/api/src/llm.ts`)

- Extraction calls `client.chat.completions.parse` with `response_format: zodResponseFormat(z.strictObject({ formal: FormalSchema.nullable() }), "requirement")`. The output is re-validated with the same Zod schema.
- `extract` answers `{ formal: Formal | null }`, not a bare `Formal`. Structured outputs require an object at the schema root, and `null` is the only way for the model to say that the text cannot be expressed with the `signals.json` vocabulary (REQ-108) without inventing a reading. A `formal: null`, like a failed call, leaves the requirement `pending` → `NEEDS_REVIEW`.
- Model and prompts are versioned constants; every `run_id` records them.
- The LLM only proposes `formal`. It never decides SAT/UNSAT, never marks `approved`, never produces code.
- Eval variant B (LLM-only judge) returns `{ conflict: boolean, involved_ids: string[] }` with its own Zod schema.

## 6. Errors: fail closed, no fallbacks

- `try/catch` only at two boundaries: loading `corpus/` files and calling the LLM. There the error becomes a `PARSE_ERROR` or `NEEDS_REVIEW` that keeps the original message. Everywhere else the error propagates.
- If LLM extraction fails, the requirement stays `pending`. The UI shows the committed runs in `runs/` and the live audit; it never substitutes reviewed fixtures for a failed call.
- A solver instance past 1.5 GB resident refuses audits with `503 solver_memory_limit` instead of attempting them (README, Known limitations).
- No retries, caches, feature flags, dynamic configuration or abstract classes. The one exception, and it is not a result cache: `checks.ts` builds the vocabulary's Z3 terms once per instance (the modes `Datatype` and the constants and literals per signal and tick), keyed by the sha256 of `signals.json`. Requirement, axiom and scenario formulas, and every result, are built per check. Each `Solver` and `Model` is released with `release()` when its work ends.
- Log: one JSON per execution in `runs/<run_id>.json` (`stage`, `latency_ms`, `tokens`, `status`).

## 7. Data

**Strategy: synthetic, anchored.** Each requirement is `anchored` (a paraphrase of a real public requirement, cited in `source.ref`) or `synthetic` (written for the demo, with the reason in `source.note`). Conflicts are injected on purpose and declared. No source text is copied verbatim into a requirement.

**Anchoring sources:**
- `corpus/regulations/21-CFR-862.1355.txt`: the official eCFR text (version 2026-10-01, public domain). It is the agent's input (§10).
- 21 CFR 862.1355(b)(1)(vii), (b)(2), (b)(5) and (b)(7)(iv).
- FDA 510(k) decision summary K213996 (FreeStyle Libre 3): the Urgent Low alert is mandatory and cannot be turned off.

The thresholds (5 min, 10 min, 1 min) are ours; the regulation does not set them, and each `source.note` says so.

**Base corpus** (`corpus/`): 8 requirements, 2 axioms, 5 scenarios, 2 interpretations, 2 snapshots, 2 invalid files and 1 regulation.

| Id | Kind | Role in the demo |
|---|---|---|
| REQ-101 | anchored K213996 | Urgent Low alert within 5 min in any mode; side A of the central conflict |
| REQ-102 | synthetic | No glucose alerts in the first 30 min of warm-up; injected conflict |
| REQ-103 | synthetic | No glucose values during warm-up |
| REQ-104 | anchored (b)(2) | In `ACTIVE`, a reading at least every 5 min; its tails run past the horizon (`unverified`) |
| REQ-105 | anchored (b)(1)(vii) | No data for 10 min → Signal Loss alert within 1 min |
| REQ-106 | anchored (b)(5) | Expired sensor → no glucose display |
| REQ-107 | synthetic | Vacuity target: urgent low with an expired sensor (unreachable by AX-102) |
| REQ-108 | anchored (b)(7)(iv) | Labeling obligation, left unformalized on purpose → `NEEDS_REVIEW` |

Axioms: AX-101 (warm-up lasts exactly 30 min) and AX-102 (an expired sensor measures no glucose).

**Central conflict (G01):** REQ-101 clashes with REQ-102 if glucose is urgently low during warm-up. This is realistic: real CGMs give no readings during warm-up and resolve it through labeling. Snapshot `v2-scope-active` shows that correction (REQ-101 limited to `ACTIVE`); `v3-text-only` changes only the text of REQ-102.

**Gold** (`tests/gold/cases.json`): 11 cases (G01–G11), positive and negative. It covers the exact boundary (G03: the alert may fire at minute 30), the horizon (G04: SAT with REQ-101 `unverified` at tick 42), `NEEDS_REVIEW` (G05) and `PARSE_ERROR` (G11). G01–G04 carry `expected_unverified`.

**Mutations** (`tests/gold/mutations.json`, generated by `gen-mutations.mjs`): 84 variants of the REQ-101 × REQ-102 × scenario family (58 UNSAT, 26 SAT). Labels come from a closed-form rule, not from Z3, so the eval does not grade the solver with the solver. Each case describes itself:
- `overrides`: the `formal` fields replaced, by requirement id;
- `scenario`: the full scenario, with its `facts`;
- `expected_status`, `expected_core` and `expected_unverified`.

The test applies the overrides to the full base corpus (validated with the same schemas as `corpus/`), runs `scenario_conflict` and compares. It knows no requirement or mode names.

**Obligations** (`tests/gold/obligations.json`): the 27 leaf paragraphs of 21 CFR 862.1355 with category, mapping and expected verdict, used by the agent (§10). Gold v2 (commit `95b1902`) relabelled (b)(2) and (b)(1)(vii) from behavior to evidence after the first agent run; `scripts/gold-versions.mjs` maps each gold sha256 to its commit.

**Prior verification:** an independent BMC oracle in Python (not in the repo) reproduces the 11 cases and the 84 labels.

**Approval:** requirements arrive with `status: "pending"`. Simón reviews them (`docs/corpus-review.md`) and approves those he accepts. The gold assumes REQ-101…107 and the snapshot requirements approved, with REQ-108 always pending.

## 8. Harness

- **Guides:** `CLAUDE.md` (only the non-obvious), this SPEC, the gold tests.
- **Computational sensors:**
  - Stop hook `scripts/gate.sh`: typecheck, lint, test, knip. On failure it exits 2 and the agent's turn does not end.
  - The turbo `test` task declares `corpus/**`, `tests/gold/**` and `runs/**` as inputs: a gate that passes from cache is not a sensor.
  - ESLint: `complexity ≤ 8`; `no-restricted-syntax` against `TryStatement` except at the two boundaries; `no-restricted-imports` for z3 and openai; `no-explicit-any`; `ban-ts-comment`.
  - knip: unused files, exports and dependencies fail the gate.
  - `permissions.deny` on `tests/gold/**` and `corpus/**`.
- **Inferential sensor:** the `scope-reviewer` subagent at the close of each stage; it reports only correctness and scope gaps.

## 9. Stages in Claude Code

One session per stage; `/clear` between stages. Plan mode in stages 02 and 03.

| Stage | Output | Done when |
|---|---|---|
| 00 (Simón) | Review `corpus/` and `tests/gold/` (`docs/corpus-review.md`) | Requirements approved; labels checked by hand |
| 01 | Scaffold, `schema.ts`, `corpus.ts` | Gate green; all of `corpus/` loads; G11 gives `PARSE_ERROR` |
| 02 | `encode.ts`, `checks.ts`, `regression.ts` | All gold cases pass, positive and negative |
| 03 | `llm.ts`, `evals.ts` | A/B/C run over gold + mutations and write metrics to `runs/` |
| 05 | CGM domain + units + `unverified` + self-describing mutations + A/B/C evals with CGM templates | Gate green with G01–G11 and 84 mutations; `pnpm eval` v3 and its rescore; audit p95 < 2 s |
| 06 | `agent.ts`, `tools.ts`, `pnpm eval:agent` | Gate green; one real run with metrics against `obligations.json` |
| 07 | `server.ts`, `apps/web` | The storyboard works end to end locally |
| 08 | Deploy on Vercel + video | The public link reproduces the storyboard |

Server + UI (originally stage 04) moved to 07, and deploy (originally 05) to 08.

Prompt per stage: *"Implement stage NN of SPEC.md. Run `scripts/gate.sh` and show its output. When done, use the scope-reviewer subagent on the diff."*

## 10. Regulatory agent (`apps/api/src/agent.ts`, stage 06)

**Goal:** given a regulatory text, produce an *impact assessment* of the product requirements. Each obligation is classified, quoted, mapped to requirements and given an evidence-based verdict.

**Loop:** OpenAI tool calling with the `openai` SDK on the Responses API (`client.responses.parse` with strict tools and a Zod text format; Chat Completions does not accept tools with reasoning for this model). At most 12 turns, default reasoning, as in B and C. `temperature: 0` is sent; if the API rejects it, it is omitted and the run records `temperature: null` with the error message, without trying other values. The run also records the effective reasoning effort. The loop lives in `agent.ts`; the OpenAI session in `llm.ts` (the §6 boundary). The LLM decides classification and mapping. **Verdicts are computed by code, never by the LLM.**

**Tools** (deterministic, in `apps/api/src/tools.ts`):
- `get_regulation()` returns the leaf paragraphs as `{ id, context }`. The parser is deterministic and uses no LLM; `context` is the ancestors' text plus the paragraph's own.
- `search_requirements(query)` returns `{ id, text, status }` for every requirement whose text contains any term of the query. It exposes neither `source` nor `formal`: the mapping has to be semantic, not copied traces.
- `get_requirement(id)` returns `{ id, text, status, formal }`. For an unknown id it returns `{ error }` to the model as the tool result, without aborting the run. This is not a fallback: the code still validates the final `implemented_by` ids (`unknown_requirement`).
- `run_audit(requirement_ids)` runs the §4 audit (consistency, scenario_conflict per scenario, vacuity, equivalence) and returns the findings that touch those ids: core, summarized witness and `unverified`.

**LLM output** (Zod schema, structured output), one item per leaf paragraph:

```
{ paragraph, category: "behavior" | "evidence" | "labeling",
  quote: string,                 // must be an exact substring of the paragraph's context
  implemented_by: string[],      // existing ids
  rationale: string }            // at most 2 sentences
```

**Validation in code, fail-closed:**
- If `quote` is not an exact substring of the paragraph's context, the item is `NEEDS_REVIEW` with reason `invalid_quote`.
- If an `implemented_by` id does not exist, the item is `NEEDS_REVIEW` with reason `unknown_requirement`.
- If a leaf paragraph is missing or there is an extra one, the item is `NEEDS_REVIEW`.

**Verdict per obligation** (computed in code from the §4 audit; defined by `tests/gold/obligations.json`): `CONFLICT`, `DEAD`, `NOT_FORMALIZED`, `NO_REQUIREMENT`, `CONSISTENT_BOUNDED`, `OUT_OF_SCOPE`, or `NEEDS_REVIEW`.

Derivation order per obligation (decided with Simón on 27-Oct-2026):
1. **Validation.** If it fails (`invalid_quote`, `unknown_requirement`, missing, duplicate or extra paragraph) or any mapped requirement has an `UNKNOWN` finding → `NEEDS_REVIEW` (reason `audit_unknown` in the last case). Nothing else is evaluated. An `UNKNOWN` `consistency` or `scenario_conflict` touches every approved requirement, since all of them were in the solve; an `UNKNOWN` `vacuity` touches its subject; an `UNKNOWN` `equivalence` does not count. An empty quote is `invalid_quote`.
2. `category = evidence` → `OUT_OF_SCOPE`, even with requirements mapped.
3. `behavior`/`labeling` with no requirements → `NO_REQUIREMENT`.
4. For each mapped requirement, its own verdict:
   - `CONFLICT` if its id appears exactly in the UNSAT core of `consistency` or `scenario_conflict`;
   - `DEAD` if `TRIGGER:<id>` appears in a `vacuity` core;
   - `NOT_FORMALIZED` if it is `pending` or has a null `formal`;
   - `CONSISTENT_BOUNDED` otherwise.
   `equivalence` never produces an obligation verdict.
5. Final verdict = the worst: `CONFLICT` > `DEAD` > `NOT_FORMALIZED` > `CONSISTENT_BOUNDED`.

Each obligation carries `contributions: [{ requirement, verdict, finding_ref }]` with every individual verdict from step 4, not only the winner. `finding_ref` is `<check>:<scenario or subject>` of the finding that produced it, or null for `CONSISTENT_BOUNDED`.

**Final output:** `runs/agent-<run_id>.json` with the report, the tool-call trace, tokens and latency. It also includes a full audit of the corpus that shows the G01 conflict even though REQ-101 maps to no paragraph: the report lists it under design conflicts.

**Agent evals** (`pnpm eval:agent`, 3 runs):
- category accuracy;
- precision and recall of the `implemented_by` mapping, per (paragraph, requirement) pair;
- gap recall: `NO_REQUIREMENT` obligations detected;
- valid quote rate;
- invented ids (must be 0);
- verdict accuracy;
- agreement across runs, latency and tokens.

A run that fails at the API is marked `status: "api_error"` and is left out of agreement, accuracies, latency and tokens. With no valid run every figure is null, never 1; agreement needs two valid runs.

`pnpm eval:agent --rescore <run_id>` recomputes the metrics of a stored run against the current `obligations.json`, without calling OpenAI, and writes `runs/agent-rescore-<run_id>.json`. Every run and rescore records its `gold_sha256`.

No gate test calls OpenAI. The gate tests cover the parser, quote and id validation, verdict derivation with fixed mappings, and the metrics function.
