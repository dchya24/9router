import ProviderDetailClient from "./ProviderDetailClient";

// Static export wrapper — enumerates params at build time; Hono serves this
// shell for any param value at runtime (the client hydrates from the URL).
import { AI_PROVIDERS } from "@/shared/constants/providers";

export function generateStaticParams() {
  return Object.keys(AI_PROVIDERS).map((id) => ({ id }));
}
export default function Page() {
  return <ProviderDetailClient />;
}
