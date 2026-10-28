# rqaudit

A logical-consistency auditor for the requirements of a fictional continuous glucose monitor (CGM), assessed against 21 CFR 862.1355. An LLM fills a typed template, Z3 decides over bounded traces, and an agent maps the regulation's 27 leaf paragraphs to requirements. The verdicts are computed in code, never by the LLM. `SPEC.md` is the technical source of truth.

## The storyboard (one page)

- **a. Design conflict**: REQ-101 × REQ-102 in scenario SCN-101. The UNSAT core and a minute-by-minute timeline, from a live Z3 audit.
- **b. Correction**: re-audit snapshot `v2-scope-active` (the conflict is resolved) or `v3-text-only` (it persists; no formal change).
- **c. Regulation**: the 27 paragraphs with category, highlighted quote, mapped requirements and verdict, from the latest committed agent run.
- **d. Evals**: variants A/B/C (rule linter, LLM judge, LLM extraction + Z3) and the agent's metrics, read from `runs/`.
- **e. Agent trace**: tool calls, turns, tokens and latency of each agent run.

## Where to start reading

This README → [SPEC.md](SPEC.md) §1–4 → [packages/core/src/checks.ts](packages/core/src/checks.ts) → [apps/api/src/agent.ts](apps/api/src/agent.ts) → [tests/gold/](tests/gold/).

## Run it locally

Node 22 or later, and pnpm 10.

```bash
pnpm install
pnpm dev        # API on :3000, UI on http://localhost:5173
```

One port, production build: `pnpm turbo run build && NODE_ENV=production node apps/api/dist/server.js`, then http://localhost:3000.
The evals and "Run agent live" need `OPENAI_API_KEY` in `.env`; the live agent runs locally only. Everything else runs without it.
Deployed on Vercel: the UI as static files and the Express app as one function at `/api` (`vercel.json`).

## Checks

```bash
scripts/gate.sh      # typecheck, lint, tests (gold cases, 84 mutations, endpoints), knip; never calls OpenAI
pnpm eval            # variants A/B/C → runs/<run_id>.json; `pnpm eval --rescore <run_id>` re-scores without the LLM
pnpm eval:agent      # 3 real agent runs → runs/agent-<run_id>.json; `--rescore <run_id>` against the current gold
```

## How this was built

Built in about one day with Claude Code working inside a harness, one session per stage (SPEC §9).

- **Guides:** `CLAUDE.md` (only the non-obvious rules), `SPEC.md`, and a gold set in `tests/gold/` approved by a human before the code existed ([docs/corpus-review.md](docs/corpus-review.md)).
- **Sensors:** a Stop-hook gate (`scripts/gate.sh`: typecheck, lint, tests, knip) that a turn cannot end without passing; deny rules that keep `corpus/` and `tests/gold/` read-only for the agent; ESLint rules for the fail-closed boundaries (`try/catch` in two places only), the Z3 and OpenAI import boundaries and complexity ≤ 8; knip for dead code; and a `scope-reviewer` subagent on each stage's diff.
- **Human decisions:** the stack, the data strategy (synthetic, anchored), the corpus and gold approvals, and each blocking decision the agent stopped for, recorded in SPEC (e.g. the verdict derivation order in §10, the witness pruning in §4, the vocabulary-terms exception in §6).

## Known limitations

- **A 45-minute horizon.** Traces cover minutes 0–44. An obligation whose deadline falls past the horizon constrains nothing; it is reported as `unverified`, not as proven.
- **A synthetic, anchored corpus.** The 8 requirements were written for the demo. Each one paraphrases a public source (21 CFR 862.1355, FDA 510(k) K213996) or is marked synthetic, and the thresholds are ours. They are not a real device's requirements.
- **A gold corrected from v1 to v2, declared.** After the first agent run, (b)(2) and (b)(1)(vii) were relabelled from behavior to evidence (commit `95b1902`). Section d shows the agent scored against both.
- **Solver memory grows by about 9 MB per audit, per instance.** Z3's AST wrappers are freed only by the garbage collector. Past 1.5 GB resident, an audit is refused with `503 solver_memory_limit`; `/api/health` reports `rss_mb` and `audits_served`. Planned fix: run Z3 in a worker_thread recycled every N audits.
