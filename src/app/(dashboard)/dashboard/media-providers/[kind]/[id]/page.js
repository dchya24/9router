import KindIdClient from "./KindIdClient";

// Static export wrapper — enumerates params at build time; Hono serves this
// shell for any param value at runtime (the client hydrates from the URL).
// Client component — one shell placeholder; Hono serves it for any kind/id.
export function generateStaticParams() {
  return [{ kind: "shell", id: "shell" }];
}
export default function Page() {
  return <KindIdClient />;
}
