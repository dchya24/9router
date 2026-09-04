"use client";

import EndpointPageClient from "./endpoint/EndpointPageClient";

import { useEffect, useState } from "react";

// Static export: machine id comes from the authed /api/machine-id endpoint
// instead of a server render (the build machine's id would be wrong here).
function useMachineId() {
  const [machineId, setMachineId] = useState(null);
  useEffect(() => {
    fetch("/api/machine-id")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("unauthorized"))))
      .then((d) => setMachineId(d.machineId))
      .catch(() => setMachineId(""));
  }, []);
  return machineId;
}

export default function DashboardPage() {
  const machineId = useMachineId();
  if (machineId === null) return null;
  return <EndpointPageClient machineId={machineId} />;
}
