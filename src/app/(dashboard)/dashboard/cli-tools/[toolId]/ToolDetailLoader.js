"use client";

import { useEffect, useState } from "react";
import { usePathSegment } from "@/shared/hooks/usePathSegment";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import ToolDetailClient from "./ToolDetailClient";

// Client loader for the static-exported [toolId] page: reads the tool id from
// the URL, validates it, and fetches the machine id from /api/machine-id.
export default function ToolDetailLoader() {
  const toolId = usePathSegment(2); // /dashboard/cli-tools/<toolId>
  const [machineId, setMachineId] = useState(null);

  useEffect(() => {
    fetch("/api/machine-id")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("unauthorized"))))
      .then((d) => setMachineId(d.machineId))
      .catch(() => setMachineId(""));
  }, []);

  if (!toolId || !CLI_TOOLS[toolId]) {
    return <p style={{ padding: 24 }}>Unknown tool: {String(toolId)}</p>;
  }
  if (machineId === null) return null;
  return <ToolDetailClient toolId={toolId} machineId={machineId} />;
}
