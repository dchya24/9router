import { cookies } from "next/headers";
import { clearDashboardAuthCookie } from "@/lib/auth/dashboardSession";

export async function POST() {
  const cookieStore = await cookies();
  clearDashboardAuthCookie(cookieStore);
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
  return Response.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
