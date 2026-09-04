import { getRecentLogs } from "@/lib/usageDb";

export async function GET() {
  try {
    const logs = await getRecentLogs(200);
    return Response.json(logs);
  } catch (error) {
    console.error("Error fetching logs:", error);
    return Response.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
