import ToolDetailLoader from "./ToolDetailLoader";

// Client component — one shell placeholder; Hono serves it for any toolId.
export function generateStaticParams() {
  return [{ toolId: "shell" }];
}

export default function ToolDetailPage() {
  return <ToolDetailLoader />;
}
