// Writes apps/api/gold-versions.json: the sha256 of every committed version of tests/gold/obligations.json, with
// the commit that introduced it, so the UI can label a run's gold_sha256. Run it after committing a gold change
// (a test fails while the current gold is missing): pnpm gold:versions
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const GOLD = "tests/gold/obligations.json";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const versions = git("log", "--format=%H %cI", "--", GOLD)
  .trim()
  .split("\n")
  .map((line) => {
    const [commit, date] = line.split(" ");
    // Same normalization as apps/api/src/agent.ts, so a CRLF checkout hashes like an LF one.
    const content = git("show", `${commit}:${GOLD}`).replaceAll("\r\n", "\n");
    return { sha256: createHash("sha256").update(content).digest("hex"), commit: commit.slice(0, 7), date };
  });
writeFileSync(new URL("../apps/api/gold-versions.json", import.meta.url), `${JSON.stringify(versions, null, 2)}\n`);
console.log(versions.map((v) => `${v.sha256.slice(0, 8)} ${v.commit} ${v.date}`).join("\n"));
