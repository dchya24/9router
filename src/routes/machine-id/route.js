import { getMachineId } from "@/shared/utils/machine";

// Machine id for the static dashboard (same value /api/keys already exposes
// per key). Guarded by the standard deny-by-default /api/* auth.
export async function GET() {
  return Response.json({ machineId: await getMachineId() });
}
