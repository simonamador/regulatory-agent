// Generates tests/gold/mutations.json. Labels come from a closed-form rule, not from Z3,
// so the eval does not grade the solver with the solver.
//
// Family: REQ-001 (occlusion -> alarm within D) vs REQ-002 (no alarm in the first W s of
// calibration) under one scenario: calibration on [e, calEnd), occlusion at t, horizon 20 ticks.
//   last      = t + D (inclusive) | t + D - 1 (exclusive)
//   forbidden = [e, min(e + W, calEnd))
//   UNSAT  <=> last <= 19 && t >= e && last < forbiddenEnd
import { writeFileSync } from "node:fs";

const HORIZON_LAST = 19;
const cases = [];

function label({ t, D, bound, W, e, calEnd }) {
  const last = bound === "inclusive" ? t + D : t + D - 1;
  const forbiddenEnd = Math.min(e + W, calEnd);
  return last <= HORIZON_LAST && t >= e && last < forbiddenEnd ? "UNSAT" : "SAT";
}

function add(p) {
  const status = label(p);
  cases.push({
    id: `M${String(cases.length + 1).padStart(3, "0")}`,
    ...p,
    expected_status: status,
    expected_core: status === "UNSAT" ? ["REQ-001", "REQ-002", "SCN"] : null,
  });
}

// Early-calibration grid: calibration [0,12), then NORMAL.
for (const t of [0, 2, 4, 6, 8])
  for (const D of [3, 5, 7])
    for (const bound of ["inclusive", "exclusive"])
      for (const W of [6, 10]) add({ family: "grid", t, D, bound, W, e: 0, calEnd: 12 });

// Horizon family: NORMAL [0,e), calibration [e,20). Truncation decides the label.
for (const e of [12, 14])
  for (const t of [16, 18])
    for (const D of [1, 3, 5]) add({ family: "horizon", t, D, bound: "inclusive", W: 10, e, calEnd: 20 });

writeFileSync(new URL("./mutations.json", import.meta.url), JSON.stringify(cases, null, 2) + "\n");
const unsat = cases.filter((c) => c.expected_status === "UNSAT").length;
console.log(`${cases.length} mutations, ${unsat} UNSAT, ${cases.length - unsat} SAT`);
