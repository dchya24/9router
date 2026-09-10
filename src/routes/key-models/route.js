// Fork addition: manage per-API-key model restrictions.
//   GET    /api/keys/models              → all restrictions [{ keyId, keyName, patterns }]
//   PUT    /api/keys/models  { keyId, patterns }   → set (empty array = unrestricted)
//   DELETE /api/keys/models?keyId=<id>   → remove restriction
// Standard deny-by-default /api auth applies (guard).
import { getApiKeys } from "@/lib/localDb";
import {
  getAllKeyModelRestrictions,
  setKeyModelRestrictions,
  deleteKeyModelRestrictions,
} from "@/lib/db/repos/keyModelRestrictionsRepo.js";

function sanitizePatterns(patterns) {
  if (!Array.isArray(patterns)) return null;
  const cleaned = [...new Set(patterns.map((p) => String(p).trim()).filter(Boolean))];
  return cleaned;
}

export async function GET() {
  try {
    const [keys, restrictions] = await Promise.all([getApiKeys(), getAllKeyModelRestrictions()]);
    const data = keys.map((k) => ({
      keyId: k.id,
      keyName: k.name,
      keyPrefix: String(k.key || "").slice(0, 12) + "…",
      patterns: restrictions[k.id] || [],
    }));
    return Response.json({ restrictions: data });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const { keyId, patterns } = await request.json();
    if (!keyId) {
      return Response.json({ error: "keyId required" }, { status: 400 });
    }
    const cleaned = sanitizePatterns(patterns);
    if (cleaned === null) {
      return Response.json({ error: "patterns must be an array of strings" }, { status: 400 });
    }
    if (cleaned.length === 0) {
      await deleteKeyModelRestrictions(keyId);
      return Response.json({ success: true, unrestricted: true });
    }
    await setKeyModelRestrictions(keyId, cleaned);
    return Response.json({ success: true, patterns: cleaned });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const keyId = new URL(request.url).searchParams.get("keyId");
    if (!keyId) {
      return Response.json({ error: "keyId query param required" }, { status: 400 });
    }
    await deleteKeyModelRestrictions(keyId);
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
