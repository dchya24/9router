import { getPxpipeStats } from "@/lib/pxpipe/events.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const recentLimit = Math.min(Number(searchParams.get("limit")) || 100, 500);
    return Response.json(getPxpipeStats({ recentLimit }));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
