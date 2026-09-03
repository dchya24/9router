// Registers the alias loader for bare-Node execution of src/ + open-sse/.
// Run with: node --import ./hono-server/register.mjs hono-server/server.js
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);
