// Registers the alias loader for bare-Node execution of src/ + open-sse/.
// Run with: node --import ./hono-server/register.mjs hono-server/server.js
import { register } from "node:module";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

register("./alias-loader.mjs", import.meta.url);

// The ESM resolve hook above only sees ESM imports. Some CJS files under src/
// require() aliased specifiers (e.g. src/lib/mcp/stdioSseBridge.js
// require("@/shared/constants/coworkPlugins")) — those go through the CJS
// resolver, which needs the same mapping.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) {
    request = path.join(projectRoot, "src", request.slice(2));
  } else if (request === "open-sse") {
    request = path.join(projectRoot, "open-sse", "index.js");
  } else if (request.startsWith("open-sse/")) {
    request = path.join(projectRoot, "open-sse", request.slice("open-sse/".length));
  }
  return origResolveFilename.call(this, request, ...rest);
};
