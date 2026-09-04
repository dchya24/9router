import { getUsageStats } from "@/lib/usageDb";

export async function GET() {
  try {
    const stats = await getUsageStats();
    return Response.json(stats);
  } catch (error) {
    console.error("Error fetching usage stats:", error);
    return Response.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
