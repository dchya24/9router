import KindClient from "./KindClient";

// Static export wrapper — enumerates params at build time; Hono serves this
// shell for any param value at runtime (the client hydrates from the URL).
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";

export function generateStaticParams() {
  return MEDIA_PROVIDER_KINDS.map((k) => ({ kind: k.id }));
}
export default function Page() {
  return <KindClient />;
}
