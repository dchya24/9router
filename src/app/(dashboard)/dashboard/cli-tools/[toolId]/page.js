import { CLI_TOOLS } from "@/shared/constants/cliTools";
import ToolDetailLoader from "./ToolDetailLoader";

// Static export: dynamic routes must be enumerated at build time.
export function generateStaticParams() {
  return Object.keys(CLI_TOOLS).map((toolId) => ({ toolId }));
}

export default function ToolDetailPage() {
  return <ToolDetailLoader />;
}
