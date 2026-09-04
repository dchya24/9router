import { stopHeadroomProxy } from "@/lib/headroom/process";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = stopHeadroomProxy();
    const status = result.stopped ? 200 : 409;
    return Response.json({ ...result }, { status });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: 500 });
  }
}
