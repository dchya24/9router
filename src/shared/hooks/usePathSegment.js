"use client";

import { useEffect, useState } from "react";

// In the static-export deployment, dynamic pages are served as placeholder
// shells ("shell" params baked into the prerendered payload), so useParams()
// would return the placeholder. The real param lives in the address bar —
// read it from there. Works identically in `next dev` where the router state
// is live.
export function pathSegments(offset) {
  if (typeof window === "undefined") return null;
  return window.location.pathname.split("/").filter(Boolean).slice(offset);
}

export function usePathSegment(offset) {
  const [value, setValue] = useState(() => pathSegments(offset)?.[0] ?? null);

  useEffect(() => {
    const sync = () => setValue(pathSegments(offset)?.[0] ?? null);
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [offset]);

  return value;
}
