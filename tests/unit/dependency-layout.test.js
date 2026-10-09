/**
 * Dependency-layout invariants for the minimal runtime image.
 *
 * The Bun runtime image installs with `--omit=dev --omit=optional`; anything
 * declared as a runtime dependency is therefore shipped into a server process
 * that never renders React. These assertions keep the pruning from silently
 * regressing:
 *
 *   - dead packages stay out of the manifest entirely
 *   - browser-only UI libraries stay in devDependencies
 *   - the last-resort SQLite driver stays optional
 *
 * See docs/MEMORY_OPTIMIZATION.md for the image-size rationale.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const runtimeDeps = pkg.dependencies || {};
const optionalDeps = pkg.optionalDependencies || {};
const devDeps = pkg.devDependencies || {};

// Packages with zero import sites in server, dashboard, or CLI sources.
const DEAD_PACKAGES = ["selfsigned", "socks-proxy-agent"];

// Browser-only libraries: fine in devDependencies (dashboard build), never in
// the runtime image the server actually boots from.
const BROWSER_ONLY_PACKAGES = ["@xyflow/react", "react", "react-dom", "recharts"];

// The server is Bun-only: bun:sqlite is built into the runtime, so no SQLite
// driver is declared, and Bun.serve replaces the Node server adapter.
const RETIRED_RUNTIME_PACKAGES = ["sql.js", "better-sqlite3", "@hono/node-server"];

const SOURCE_ROOTS = ["src", "open-sse", "hono-server"];
const SOURCE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx)$/;

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

function filesImporting(pkgName) {
  // Matches static/dynamic import and require of the exact package name,
  // including subpath imports (`pkg/sub`).
  const pattern = new RegExp(
    `(?:from\\s*|import\\s*\\(|require\\s*\\(\\s*)['"]${pkgName.replace(/[/@.]/g, "\\$&")}(?:/[^'"]*)?['"]`
  );
  const hits = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(join(ROOT, root))) {
      if (pattern.test(readFileSync(file, "utf8"))) {
        hits.push(file.slice(ROOT.length));
      }
    }
  }
  return hits;
}

describe("dependency layout", () => {
  it.each(DEAD_PACKAGES)("keeps %s out of every dependency section", (name) => {
    expect(runtimeDeps).not.toHaveProperty(name);
    expect(optionalDeps).not.toHaveProperty(name);
    expect(devDeps).not.toHaveProperty(name);
  });

  it.each(DEAD_PACKAGES)("has no import site for %s", (name) => {
    expect(filesImporting(name)).toEqual([]);
  });

  it.each(BROWSER_ONLY_PACKAGES)("does not ship browser-only %s in the runtime image", (name) => {
    expect(runtimeDeps).not.toHaveProperty(name);
  });

  it("keeps @xyflow/react available to the dashboard build", () => {
    expect(devDeps).toHaveProperty("@xyflow/react");
  });

  it.each(RETIRED_RUNTIME_PACKAGES)("no longer declares the retired Node-era package %s", (name) => {
    expect(runtimeDeps).not.toHaveProperty(name);
    expect(optionalDeps).not.toHaveProperty(name);
    expect(devDeps).not.toHaveProperty(name);
  });

  it.each(RETIRED_RUNTIME_PACKAGES)("has no import site for the retired package %s", (name) => {
    expect(filesImporting(name)).toEqual([]);
  });

  it("keeps no optional SQLite driver: bun:sqlite is built into the runtime", () => {
    expect(optionalDeps).toEqual({});
  });
});
