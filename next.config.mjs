import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));
// CLI bundling needs workspace root so tracing includes hoisted node_modules (slim ~50MB).
// Docker / default uses projectRoot so server.js lands at /app/server.js (not nested).
const tracingRoot = process.env.NEXT_TRACING_ROOT_MODE === "workspace"
  ? join(projectRoot, "..")
  : projectRoot;

// Static export is a PRODUCTION build mode (NEXT_EXPORT=1): Next then requires
// generateStaticParams for every dynamic route and forbids rewrites. Plain dev
// (`npm run dev`) must NOT export — dynamic pages render freely and /api + /v1
// are proxied to the running Hono server (default 127.0.0.1:20128).
const isExport = process.env.NEXT_EXPORT === "1";
const devApi = process.env.NINEROUTER_DEV_API || "http://127.0.0.1:20128";

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  ...(isExport ? { output: "export" } : {}),
  // `open` must stay external. It derives its own directory from `import.meta.url`, and
  // webpack replaces that with the absolute path of the BUILD machine as a string literal.
  // A release built on macOS therefore ships `file:///Users/.../open/index.js`, which
  // `fileURLToPath` rejects on Windows ("File URL path must be absolute" — no drive
  // letter). That throw happens at module scope, so every consumer of `open` dies on
  // import — including xAI/Grok token refresh, which loads the OAuth service that imports
  // it. Keeping it external preserves the real `import.meta.url` at runtime.
  serverExternalPackages: ["better-sqlite3", "sql.js", "node:sqlite", "bun:sqlite", "open"],
  turbopack: {
    root: tracingRoot
  },
  outputFileTracingRoot: tracingRoot,
  outputFileTracingExcludes: {
    "*": ["./gitbook/**/*"]
  },
  images: {
    unoptimized: true
  },
  env: {},
  experimental: {
    // Cache fetch responses across HMR refreshes for faster dev reloads.
    serverComponentsHmrCache: true,
    // Tree-shake heavy barrel imports to cut compile + bundle size
    optimizePackageImports: ["@xyflow/react", "@dnd-kit/core", "@dnd-kit/sortable", "material-symbols", "marked"],
  },
  // Dev only (export forbids rewrites): bridge dashboard API calls to Hono.
  ...(isExport ? {} : {
    async rewrites() {
      return [
        { source: "/api/:path*", destination: `${devApi}/api/:path*` },
        { source: "/v1/:path*", destination: `${devApi}/v1/:path*` },
        { source: "/v1beta/:path*", destination: `${devApi}/v1beta/:path*` },
        { source: "/codex/:path*", destination: `${devApi}/api/v1/responses` },
        { source: "/responses", destination: `${devApi}/api/v1/responses` },
      ];
    },
  }),
  webpack: (config, { isServer }) => {
    // Ignore fs/path modules in browser bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
    // Exclude non-source dirs from watcher to reduce inotify load
    config.watchOptions = {
      ...config.watchOptions,
      aggregateTimeout: 300,
      ignored: /[\\/](node_modules|\.git|logs|\.next|\.next-cli-build|gitbook|cli|open-sse\.old|tests|docs)[\\/]/,
    };
    return config;
  },
};

export default nextConfig;
