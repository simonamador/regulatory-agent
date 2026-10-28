# rqaudit

Demo: a logical-consistency auditor for the requirements of a fictional medical device. The LLM fills a typed template; Z3 decides over bounded traces.
`SPEC.md` is the technical source of truth. Implement only the stage you are asked for.

## Commands
- Setup: `pnpm install`
- Gate (what the Stop hook runs): `scripts/gate.sh`
- One test: `pnpm --filter @rqaudit/core vitest run checks -t scenario`
- Dev: `pnpm dev` (api + web) · Eval: `pnpm eval` · Agent: `pnpm eval:agent` (real OpenAI calls, 3 runs)

## What is not obvious in this repo
- The code is the minimal implementation that passes `tests/gold/`. A function exists because a test, the API or the UI calls it; a helper with a single caller goes inline.
- Fail closed: errors propagate. `try/catch` only when loading `corpus/` and when calling the LLM (SPEC §6). A doubtful result is `UNKNOWN` or `NEEDS_REVIEW`, never a favorable default.
- `tests/gold/` and `corpus/` are the specification and are read-only. If a gold test looks wrong, stop and explain why; do not work around it.
- Deleting the code a stage makes obsolete is part of the task.
- `z3-solver`: `init()` is async and heavy. One `Context` per process (server, test file or CLI). CLIs end with `process.exit`, because Z3's workers keep the process alive. Two Z3 operations interleaved on that `Context` corrupt the WASM memory: core's public API (`audit`, `scenarioConflict`, `regression`) holds it exclusively; do not bypass it from the server.
- BMC: a `within T` obligation triggered near the horizon constrains nothing (SPEC §3). Forgetting this yields spurious UNSAT. It is not dropped silently: if its trigger is forced, it is reported in `unverified` (SPEC §4).
- The horizon, the tick and the modes come from `signals.json`; no model number is hard-coded.
- On Vercel the Express app is a function (`api/index.js`) that never listens: the warm-up is lazy, on each instance's first call. `listen` and `PORT` belong to the local entrypoint only. In production nothing writes to disk (the live agent is off).
- `tests/gold/gen-mutations.mjs` is a standalone script of Simón's: knip must ignore `tests/gold/**`; do not delete or import it.
- The acceptance tests read `tests/gold/*.json` from `packages/core/test/` and `apps/api/test/`; the JSON is the specification and the test only walks it. After a gold change is committed, run `pnpm gold:versions`.

## When done
Show the output of `scripts/gate.sh`, not a summary saying it passed.
