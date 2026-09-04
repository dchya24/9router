import { getRecentLogs } from "@/lib/usageDb";

export async function GET() {
  try {
    const logs = await getRecentLogs(200);
    return Response.json(logs);
  } catch (error) {
    console.error("[API ERROR] /api/usage/logs failed:", error);
    console.error("[API ERROR] Stack:", error?.stack);
    return Response.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
