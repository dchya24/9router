import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mod = require("node-machine-id");
export const machineIdSync = mod.machineIdSync;
export const machineId = mod.machineId;
export default mod;
