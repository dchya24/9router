// Static file serving for the exported dashboard (Next `output: "export"`).
//
// Resolution order for an extensionless path like /dashboard/providers/<uuid>:
//   1. exact file            out/dashboard/providers/<uuid>            (rare)
//   2. path + ".html"        out/dashboard/providers/<uuid>.html
//   3. path + "/index.html"  out/dashboard/providers/<uuid>/index.html
//   4. shell fallback: trim trailing segments until a "<path>.html" exists —
//      client components hydrate from the real URL, so serving the parent
//      shell for unknown param values is correct (classic SPA fallback).
// Asset requests (with a file extension) resolve exactly or 404.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
};

export function createStaticHandler(exportDir) {
  const root = path.resolve(PROJECT_ROOT, exportDir);
  if (!fs.existsSync(path.join(root, "index.html"))) {
    return null; // no exported dashboard available
  }

  const resolveFile = (pathname) => {
    const clean = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const segs = clean.split("/").filter(Boolean);
    const candidates = [];
    candidates.push(path.join(root, ...segs));
    if (!segs.length || path.extname(segs[segs.length - 1] || "") === "") {
      // extensionless route: try .html forms, then parent shells
      if (segs.length) {
        candidates.push(path.join(root, ...segs) + ".html");
        candidates.push(path.join(root, ...segs, "index.html"));
      }
      for (let i = segs.length - 1; i > 0; i--) {
        candidates.push(path.join(root, ...segs.slice(0, i)) + ".html");
        candidates.push(path.join(root, ...segs.slice(0, i), "index.html"));
      }
      candidates.push(path.join(root, "index.html"));
    }
    for (const file of candidates) {
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch { /* try next */ }
    }
    return null;
  };

  return (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    const file = resolveFile(pathname);
    if (!file) {
      return c.json({ error: { message: "Not found", type: "invalid_request_error" } }, 404);
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    const body = type.startsWith("text/") || type.includes("json") || type.includes("svg")
      ? fs.readFileSync(file, "utf8")
      : fs.readFileSync(file);
    return c.body(body, 200, {
      "Content-Type": type,
      "Cache-Control": pathname.startsWith("/_next/static/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
  };
}
