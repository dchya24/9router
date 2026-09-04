"use server";

import { getMitmAlias, setMitmAliasAll } from "@/models";
import { getMitmStatus } from "@/mitm/manager";
import { writeAliasForTool } from "@/lib/mitmAliasCache";

// Hard opt-out: see the parent MITM route's flag documentation.
const MITM_DISABLED = process.env.NINEROUTER_DISABLE_MITM === "1";
const disabledResponse = () =>
  Response.json({ error: "MITM disabled on this deployment (NINEROUTER_DISABLE_MITM=1)" }, { status: 503 });

// GET - Get MITM aliases for a tool
export async function GET(request) {
  if (MITM_DISABLED) return disabledResponse();
  try {
    const { searchParams } = new URL(request.url);
    const toolName = searchParams.get("tool");
    const aliases = await getMitmAlias(toolName || undefined);
    return Response.json({ aliases });
  } catch (error) {
    console.log("Error fetching MITM aliases:", error.message);
    return Response.json({ error: "Failed to fetch aliases" }, { status: 500 });
  }
}

// PUT - Save MITM aliases for a specific tool
export async function PUT(request) {
  if (MITM_DISABLED) return disabledResponse();
  try {
    const { tool, mappings } = await request.json();

    if (!tool || !mappings || typeof mappings !== "object") {
      return Response.json({ error: "tool and mappings required" }, { status: 400 });
    }

    // Check if DNS is enabled for this tool
    const status = await getMitmStatus();
    if (!status.dnsStatus || !status.dnsStatus[tool]) {
      return Response.json(
        { error: `DNS must be enabled for ${tool} before editing model mappings` },
        { status: 403 }
      );
    }

    const filtered = {};
    for (const [alias, model] of Object.entries(mappings)) {
      if (model && model.trim()) {
        filtered[alias] = model.trim();
      }
    }

    await setMitmAliasAll(tool, filtered);
    writeAliasForTool(tool, filtered);
    return Response.json({ success: true, aliases: filtered });
  } catch (error) {
    console.log("Error saving MITM aliases:", error.message);
    return Response.json({ error: "Failed to save aliases" }, { status: 500 });
  }
}
