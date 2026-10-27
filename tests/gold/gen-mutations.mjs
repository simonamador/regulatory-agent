// Generates tests/gold/mutations.json. Labels come from closed-form rules, not from Z3,
// so the eval does not grade the solver with the solver. Units: 1 tick = 60 s, ticks 0..44.
//
// Family: REQ-101 (urgent low -> Urgent Low alert within D minutes) vs REQ-102 (no glucose
// alerts during the first W minutes of warm-up). Scenario: EXPIRED [0,e), WARMUP [e,warmEnd),
// ACTIVE [warmEnd,45); urgent low at minute t.
//   last      = t + D (inclusive) | t + D - 1 (exclusive)
//   forbidden = [e, min(e + W, warmEnd))
//   UNSAT  <=> last <= 44 && t >= e && last < forbiddenEnd
// Unverified obligations (reported only when SAT): an obligation whose window passes minute 44
// and whose trigger holds in every model. Here that is REQ-101 at t when last > 44, and REQ-104
// ("a reading at least every 5 min", exclusive -> last = k + 4) at every forced ACTIVE minute k >= 41.
import { writeFileSync } from "node:fs";

const LAST = 44;
const cases = [];
const min = (m) => m * 60;

function label({ t, D, bound, W, e, warmEnd }) {
  const last = bound === "inclusive" ? t + D : t + D - 1;
  const forbiddenEnd = Math.min(e + W, warmEnd);
  return last <= LAST && t >= e && last < forbiddenEnd ? "UNSAT" : "SAT";
}

function unverified({ t, D, bound, warmEnd }) {
  const last = bound === "inclusive" ? t + D : t + D - 1;
  const out = [];
  if (last > LAST) out.push({ requirement: "REQ-101", tick: t });
  for (let k = Math.max(warmEnd, LAST - 3); k <= LAST; k++) out.push({ requirement: "REQ-104", tick: k });
  return out.sort((a, b) => a.requirement.localeCompare(b.requirement) || a.tick - b.tick);
}

function facts({ t, e, warmEnd }) {
  const f = [];
  if (e > 0) f.push({ mode: "EXPIRED", from_s: 0, to_s: min(e) });
  f.push({ mode: "WARMUP", from_s: min(e), to_s: min(warmEnd) });
  if (warmEnd < 45) f.push({ mode: "ACTIVE", from_s: min(warmEnd), to_s: min(45) });
  f.push({ signal: "urgent_low", value: true, from_s: min(t), to_s: min(t + 1) });
  return f;
}

function add(family, p) {
  const status = label(p);
  cases.push({
    id: `M${String(cases.length + 1).padStart(3, "0")}`,
    family,
    params: p,
    overrides: {
      "REQ-101": { timing: { kind: "within", s: min(p.D), bound: p.bound } },
      "REQ-102": { scope: { mode: "WARMUP", window_s: { from: 0, to: min(p.W) } } },
    },
    scenario: { id: "SCN", facts: facts(p) },
    expected_status: status,
    expected_core: status === "UNSAT" ? ["REQ-101", "REQ-102", "SCN"] : null,
    expected_unverified: status === "SAT" ? unverified(p) : [],
  });
}

// Warm-up grid: new sensor, WARMUP [0,30), ACTIVE [30,45).
for (const t of [0, 5, 10, 15, 20, 25])
  for (const D of [3, 5, 10])
    for (const bound of ["inclusive", "exclusive"])
      for (const W of [20, 30]) add("grid", { t, D, bound, W, e: 0, warmEnd: 30 });

// Horizon family: expired sensor until e, new sensor warming up until the horizon.
for (const e of [15, 20])
  for (const t of [40, 42])
    for (const D of [1, 3, 5]) add("horizon", { t, D, bound: "inclusive", W: 30, e, warmEnd: 45 });

writeFileSync(new URL("./mutations.json", import.meta.url), JSON.stringify(cases, null, 2) + "\n");
const unsat = cases.filter((c) => c.expected_status === "UNSAT").length;
console.log(`${cases.length} mutations, ${unsat} UNSAT, ${cases.length - unsat} SAT`);
