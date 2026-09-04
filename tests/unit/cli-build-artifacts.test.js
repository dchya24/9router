import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { describe, it } = testApi;

// The build script no longer merges Next standalone artifacts; it copies the
// Hono runtime layout. Assert the layout contract build-cli.js depends on.
const require = createRequire(import.meta.url);
const appDir = path.resolve(require.resolve("../../package.json"), "..");

describe("CLI bundle layout", () => {
  it("repo checkout contains the runtime directories build-cli packages", () => {
    for (const dir of ["hono-server", "src", "open-sse"]) {
      assert.ok(fs.existsSync(path.join(appDir, dir)), `missing runtime dir: ${dir}`);
    }
    assert.ok(
      fs.existsSync(path.join(appDir, "hono-server", "server.js")),
      "hono-server/server.js is the bundle entry point",
    );
    assert.ok(
      fs.existsSync(path.join(appDir, "hono-server", "register.mjs")),
      "hono-server/register.mjs is the --import loader target",
    );
  });
});
