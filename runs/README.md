One JSON per execution (SPEC §6), named by its UTC start time; the UI reads the latest of each kind from this folder.
- `2026-10-27T22-18-21Z.json`, `2026-10-27T22-44-26Z.json`: `pnpm eval` protocol v3 and v4. **v4 feeds section d** (variants A/B/C).
- `2026-10-27T22-52-02Z.json`, `2026-10-27T22-52-03Z.json`: `--rescore` of v3 and v4; the v4 rescore supplies d's false positive rate on SAT cases.
- `agent-2026-10-27T23-26-23Z.json`: 3 real agent runs, **feeds sections a and e**; `agent-rescore-2026-10-27T23-44-34Z.json` scores it against gold v2 for d. `agent-2026-10-27T23-17-06Z.json` is the failed first attempt, kept as evidence of fail-closed behaviour (27 NEEDS_REVIEW, no verdict invented).
- `archive-infusion-pump/`: eval protocol v1 and v2 on the earlier infusion-pump corpus, history only; nothing reads it.
