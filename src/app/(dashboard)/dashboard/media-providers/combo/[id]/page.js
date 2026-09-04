import ComboClient from "./ComboClient";

// Static export wrapper — enumerates params at build time; Hono serves this
// shell for any param value at runtime (the client hydrates from the URL).
// Combo ids are DB uuids (unknowable at build time); one placeholder satisfies
  // the export requirement — Hono serves this shell for any real id.
export function generateStaticParams() {
  return [{ id: "shell" }];
}
export default function Page() {
  return <ComboClient />;
}
