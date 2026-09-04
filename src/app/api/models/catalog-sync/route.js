import fs from "node:fs";
import { getSyncState, syncModelCatalog } from "@/lib/modelCatalog/sync.js";
import { CATALOG_FILE } from "open-sse/providers/catalogOverride.js";

// GET /api/models/catalog-sync - Sync status and what the catalog currently holds
export async function GET() {
  const state = getSyncState();
  let catalog = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    catalog = {
      syncedAt: parsed.syncedAt,
      models: Object.keys(parsed.models || {}).length,
      providers: Object.keys(parsed.providers || {}).length,
      bytes: fs.statSync(CATALOG_FILE).size,
    };
  } catch {
    catalog = null;
  }
  return Response.json({ ...state, catalog });
}

// POST /api/models/catalog-sync - Run a sync now instead of waiting for the timer
export async function POST() {
  const result = await syncModelCatalog();
  if (!result) {
    return Response.json({ error: getSyncState().lastError || "sync in progress" }, { status: 503 });
  }
  return Response.json({ success: true, result });
}
