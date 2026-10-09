/**
 * Bun-only SQLite driver chain.
 *
 * The server runs exclusively under Bun, so the adapter chain no longer walks
 * better-sqlite3 → node:sqlite → sql.js. bun:sqlite is built in, and the Node
 * fallback adapters were deleted rather than kept as dead code.
 *
 * Requires the Bun runtime:
 *   bun --bun x vitest run --config tests/vitest.config.js tests/unit/db-driver-chain.test.js
 */
import { existsSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

const REMOVED_ADAPTERS = [
  "src/lib/db/adapters/betterSqliteAdapter.js",
  "src/lib/db/adapters/nodeSqliteAdapter.js",
  "src/lib/db/adapters/sqljsAdapter.js",
];

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bun-driver-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Bun-only SQLite driver", () => {
  it("resolves the built-in bun:sqlite adapter", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(process.versions.bun).toBeDefined();
    expect(db.driver).toBe("bun:sqlite");
  });

  it.each(REMOVED_ADAPTERS)("deleted the Node-only adapter %s", (relPath) => {
    expect(existsSync(path.join(REPO, relPath))).toBe(false);
  });
});
