import { unloadPxpipe } from "@/lib/pxpipe/loader.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";

// "Stop" in library mode = drop the in-process module; requests fail open to
// uncompressed passthrough until it is started again.
export async function POST() {
  try {
    const wasLoaded = unloadPxpipe();
    return Response.json({ stopped: wasLoaded, ...getPxpipeStatus() });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
