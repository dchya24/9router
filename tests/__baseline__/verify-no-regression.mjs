// Regression gate: compares a vitest JSON report against the committed
// known-fails baseline.
//
// PASS when no test that is not listed in known-fails.txt has failed.
// New (unlisted) failures are reported as regressions and exit 1.
//
// Usage:
//   node tests/__baseline__/verify-no-regression.mjs <results.json>
//   node tests/__baseline__/verify-no-regression.mjs <results.json> --update
//
// `--update` rewrites known-fails.txt from the given report (use only when the
// new failures are understood and accepted).
//
// Test identity is "<path from tests/…> :: <full test name>", so the baseline
// stays valid no matter where the repo is checked out (the old version split
// on "/app/", which produced "undefined :: …" outside that one CI image).
import { readFileSync, writeFileSync } from "fs";

const fallbackKnownFailsPath = new URL("./known-fails.txt", import.meta.url);
const resultsPath = process.argv[2];
const update = process.argv.includes("--update");

if (!resultsPath) {
  console.error("Missing results.json path");
  console.error("Usage: node tests/__baseline__/verify-no-regression.mjs <results.json> [--update]");
  process.exit(2);
}

function relPath(fileName) {
  const normalized = String(fileName || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/tests/");
  if (idx !== -1) return normalized.slice(idx + 1);
  if (normalized.startsWith("tests/")) return normalized;
  return normalized;
}

function readKnownFails() {
  try {
    return new Set(
      readFileSync(fallbackKnownFailsPath, "utf8")
        .split("\n").map((s) => s.trim()).filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

const report = JSON.parse(readFileSync(resultsPath, "utf8"));
const nowFails = report.testResults.flatMap((f) =>
  f.assertionResults
    .filter((a) => a.status === "failed")
    .map((a) => `${relPath(f.name)} :: ${a.fullName}`)
);

if (update) {
  const sorted = [...new Set(nowFails)].sort();
  writeFileSync(fallbackKnownFailsPath, sorted.join("\n") + "\n");
  console.log(`✅ Baseline updated: ${sorted.length} known failures written to known-fails.txt`);
  process.exit(0);
}

const knownFails = readKnownFails();
const regressions = nowFails.filter((f) => !knownFails.has(f));
const fixed = [...knownFails].filter((f) => !nowFails.includes(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test(s) failed that are not in the baseline:\n`);
  regressions.forEach((f) => console.error("  - " + f));
  if (fixed.length) {
    console.error(`\n(${fixed.length} baseline entr(ies) now pass — consider pruning known-fails.txt)`);
  }
  process.exit(1);
}

console.log(
  `✅ No regression. (fails now=${nowFails.length}, baseline known=${knownFails.size}`
  + (fixed.length ? `, ${fixed.length} baseline entr(ies) now pass` : "")
  + ")"
);
