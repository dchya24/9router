import { disableTunnel } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

export async function POST() {
  try {
    const result = await disableTunnel();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tunnel monitor update failed:", error.message));
    return Response.json(result);
  } catch (error) {
    console.error("Tunnel disable error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
