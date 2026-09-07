// Guards against route relocations silently breaking relative package.json
// imports (version/route.js broke when src/app/api moved to src/routes — the
// error only surfaced as a 500 inside the deployed container).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scanDirs = ["src", "open-sse", "hono-server"];

function* walk(dir) {
  for (const entry of readdirSafe(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

describe("relative package.json imports resolve after tree moves", () => {
  it("every ../package.json import points at the repo root package.json", () => {
    const broken = [];
    for (const dir of scanDirs) {
      for (const file of walk(path.join(repoRoot, dir))) {
        const src = readFileSync(file, "utf8");
        const re = /(?:from|require\()\s*["']((?:\.\.\/)+package\.json)["']/g;
        let m;
        while ((m = re.exec(src))) {
          const resolved = path.resolve(path.dirname(file), m[1]);
          if (resolved !== path.join(repoRoot, "package.json")) {
            broken.push(`${path.relative(repoRoot, file)} → ${m[1]} (${resolved})`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("the /api/version route module loads and reports the app version", async () => {
    const mod = await import("../../src/routes/version/route.js");
    expect(typeof mod.GET).toBe("function");
    const res = await mod.GET(new Request("http://localhost/api/version"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
