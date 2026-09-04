"use client";

import { useEffect } from "react";

export default function InitPage() {
  useEffect(() => {
    window.location.replace("/dashboard");
  }, []);
  return null;
}
