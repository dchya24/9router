import { getInstallLogTail } from "@/lib/pxpipe/install.js";
import { readPxpipeEvents } from "@/lib/pxpipe/events.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get("limit")) || 100, 500);
    return Response.json({
      installLog: getInstallLogTail(),
      events: readPxpipeEvents({ limit }).reverse(),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
