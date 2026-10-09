#!/usr/bin/env node

// Postinstall: warm the tray runtime into ~/.9router/runtime so the first
// `9router` start doesn't need network. The server itself needs no warm-up: it
// runs on Bun with the built-in bun:sqlite. Failure here is non-fatal.
const { ensureTrayRuntime } = require("./trayRuntime");

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[9router] tray runtime skipped: ${e.message}`);
}

process.exit(0);
