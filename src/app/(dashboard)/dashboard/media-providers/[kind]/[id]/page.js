import KindIdClient from "./KindIdClient";

// Static export wrapper — enumerates params at build time; Hono serves this
// shell for any param value at runtime (the client hydrates from the URL).
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS } from "@/shared/constants/providers";

export function generateStaticParams() {
  return MEDIA_PROVIDER_KINDS.flatMap((k) =>
    Object.keys(AI_PROVIDERS).map((id) => ({ kind: k.id, id }))
  );
}
export default function Page() {
  return <KindIdClient />;
}
