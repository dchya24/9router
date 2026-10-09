import { ensureDirs, DATA_FILE } from "./paths.js";

// Use global to survive dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

// Bun only: bun:sqlite is built into the runtime. The Node fallbacks
// (better-sqlite3, node:sqlite, sql.js) were deleted along with the Node
// server path, so a non-Bun runtime fails loudly instead of silently
// degrading to a different driver.
async function createAdapter() {
  if (!process.versions.bun) {
    throw new Error("[DB] This build requires the Bun runtime (bun:sqlite is built in)");
  }
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    throw new Error(`[DB] bun:sqlite unavailable: ${e.message}`);
  }
}

async function initAdapter() {
  ensureDirs();
  const adapter = await createAdapter();

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = initAdapter().then((a) => { state.instance = a; return a; });
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
