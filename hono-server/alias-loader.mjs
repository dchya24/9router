// Node loader hook: resolves "@/..." and "open-sse..." specifiers used across
// src/ and open-sse/ (same mapping as jsconfig.json paths) so the proxy core
// runs on bare Node — no bundler, no Next.js.
// Registered via --experimental-loader. Import specifiers ending in .js that
// resolve to a directory get "/index.js" appended.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveAlias(specifier) {
  // UMD bundle whose named exports cjs-module-lexer cannot detect statically —
  // import { machineIdSync } from "node-machine-id" fails on bare Node ESM.
  if (specifier === "node-machine-id") {
    return path.join(projectRoot, "hono-server", "shims", "node-machine-id.mjs");
  }
  // Next request-context modules, replaced with per-request AsyncLocalStorage
  // shims (see shims/next-headers.mjs) and minimal classes (next-server.mjs).
  if (specifier === "next/headers") {
    return path.join(projectRoot, "hono-server", "shims", "next-headers.mjs");
  }
  if (specifier === "next/server") {
    return path.join(projectRoot, "hono-server", "shims", "next-server.mjs");
  }
  if (specifier === "open-sse") return path.join(projectRoot, "open-sse", "index.js");
  if (specifier.startsWith("open-sse/")) {
    return path.join(projectRoot, "open-sse", specifier.slice("open-sse/".length));
  }
  if (specifier.startsWith("@/")) {
    return path.join(projectRoot, "src", specifier.slice(2));
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let mapped = null;
  try {
    mapped = resolveAlias(specifier);
  } catch {
    mapped = null;
  }
  if (mapped) {
    let candidate = mapped;
    if (!path.extname(candidate) || !existsSync(candidate)) {
      if (existsSync(candidate + ".js")) candidate = candidate + ".js";
      else if (existsSync(path.join(candidate, "index.js"))) candidate = path.join(candidate, "index.js");
    }
    return nextResolve(pathToFileURL(candidate).href, context);
  }
  return nextResolve(specifier, context);
}
