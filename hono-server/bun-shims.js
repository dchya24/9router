// Bun runtime shims (fork feature). Without them, bare-specifier Next
// request-context modules resolve to the REAL Next packages (installed as
// devDependencies for the dashboard build) and blow up at runtime with
// "`cookies` was called outside a request scope".
//
// Runtime plugins remap exact specifiers via build.module() (onResolve is
// bundler-only). Loaded via the bunfig.toml preload so the mapping is in place
// before guard.js's static import chain; hono-server/server.js also calls
// registerBunShims() as a safety net for the lazily-imported routes.
//
// Mappings:
//   next/headers     -> shims/next-headers.mjs
//   next/server      -> shims/next-server.mjs
//   node-machine-id  -> shims/node-machine-id.mjs
// (@/* and open-sse resolve natively via jsconfig paths under Bun.)

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const MAPPINGS = {
  "next/headers": path.join(here, "shims", "next-headers.mjs"),
  "next/server": path.join(here, "shims", "next-server.mjs"),
  // node-machine-id deliberately NOT remapped: the real package is pure JS
  // and works under Bun, and the effective machine ID comes from the
  // DATA_DIR/machine-id file first (machineId.js loadRawMachineId) — the
  // value matches production regardless. Remapping it here would also
  // intercept the shim's own internal require() and recurse.
};

let registered = false;

export function registerBunShims() {
  if (registered || !process.versions.bun) return false;
  const bun = globalThis.Bun;
  if (!bun?.plugin) return false;
  registered = true;
  bun.plugin({
    name: "9router-next-request-context-shims",
    setup(build) {
      for (const [specifier, filePath] of Object.entries(MAPPINGS)) {
        build.module(specifier, async () => {
          try {
            const mod = await import(filePath);
            return { exports: mod, loader: "object" };
          } catch (e) {
            console.error(`[bun-shims] failed to load shim for ${specifier}:`, e?.message || e);
            return { exports: {}, loader: "object" };
          }
        });
      }
    },
  });
  console.log("[bun-shims] next/headers, next/server, node-machine-id -> hono-server/shims");
  return true;
}

// Self-invoke so `bun --preload ./hono-server/bun-shims.js` alone is enough —
// preload runs before the entry file's static imports (guard.js ->
// machineId.js -> "node-machine-id"), which plain body execution cannot beat.
registerBunShims();
