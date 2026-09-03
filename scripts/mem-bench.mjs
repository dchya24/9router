#!/usr/bin/env node
// Warm-idle memory benchmark: Next standalone vs Hono proxy surface.
//
// Protocol (identical for both targets):
//   1. Spawn server on isolated port, wait until healthy.
//   2. Record cold RSS (VmRSS from /proc, same metric docker stats reports).
//   3. Warmup: one request per route group to trigger lazy module loading
//      (translators init, DB open, provider registry) — not measured.
//   4. Settle, then sample RSS and report median / spread.
//
// Usage:
//   node scripts/mem-bench.mjs next     # benchmark .next-cli-build/standalone + custom-server
//   node scripts/mem-bench.mjs hono     # benchmark hono-server/server.js
//   node scripts/mem-bench.mjs next hono [more...]
//
// Env: BENCH_PORT (20131), SAMPLES (30), SAMPLE_INTERVAL_MS (500), SETTLE_MS (5000)

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.BENCH_PORT || 20131);
const SAMPLES = Number(process.env.SAMPLES || 30);
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS || 500);
const SETTLE_MS = Number(process.env.SETTLE_MS || 5000);

const rssKb = (pid) => {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
};

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
const percentile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mb = (kb) => Math.round((kb / 1024) * 10) / 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(mode) {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(PORT),
    HOSTNAME: "127.0.0.1",
    HOST: "127.0.0.1",
    // Identical data dir for both targets → identical DB state
    DATA_DIR: process.env.BENCH_DATA_DIR || path.join(process.env.HOME || "", ".9router"),
    NINEROUTER_DISABLE_BG_REFRESH: process.env.NINEROUTER_DISABLE_BG_REFRESH || "",
  };
  let command, args, cwd, healthPath;

  if (mode === "hono") {
    command = process.execPath;
    args = ["--import", "./hono-server/register.mjs", "hono-server/server.js"];
    cwd = PROJECT_ROOT;
    healthPath = "/healthz";
  } else if (mode === "next") {
    const standalone = path.join(PROJECT_ROOT, process.env.NEXT_DIST_DIR || ".next-cli-build", "standalone");
    if (!existsSync(path.join(standalone, "server.js"))) {
      throw new Error(`Next standalone build not found at ${standalone} — run the build first`);
    }
    command = process.execPath;
    args = ["custom-server.js"];
    cwd = standalone;
    healthPath = "/api/health";
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${mode}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${mode}] ${d}`));
  return { child, healthPath, mode };
}

async function waitHealthy(healthPath, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${healthPath}`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("server did not become healthy in time");
}

async function warmup(mode) {
  const base = `http://127.0.0.1:${PORT}`;
  const post = (p, body, headers = {}) =>
    fetch(base + p, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    }).catch(() => {});
  const get = (p) => fetch(base + p, { signal: AbortSignal.timeout(15000) }).catch(() => {});

  // Every route group once, in deterministic order. Error-path requests still
  // execute the full handler pipeline (auth check, DB access, translators).
  await get("/api/health");
  await get("/v1/models");
  await get("/api/v1/models");
  await get("/v1/models/image");
  await get("/v1/models/openai/gpt-4o");
  await post("/v1/messages/count_tokens", { model: "x", messages: [{ role: "user", content: "warm" }] });
  await post("/v1/chat/completions",
    { model: "warmup-model", messages: [{ role: "user", content: "warm" }] },
    { Authorization: "Bearer bench-warmup-invalid-key" });
  await post("/v1/messages",
    { model: "warmup-model", max_tokens: 1, messages: [{ role: "user", content: "warm" }] },
    { "x-api-key": "bench-warmup-invalid-key", "anthropic-version": "2023-06-01" });
  await post("/v1/embeddings", { model: "warmup-model", input: "warm" });
  await get("/v1beta/models");
  await post("/v1beta/models/warmup:generateContent", { contents: [{ parts: [{ text: "warm" }] }] });
  await get("/v1/audio/voices?provider=edge-tts");

  // "full": additionally load the dashboard/admin route bundles (auth-guarded
  // routes return 401 but their module bundles still load — that is the memory
  // cost of Next carrying the whole API surface). Hono's end-state never pays
  // for these, so this measures the real long-run gap, not a like-for-like one.
  if (mode === "next" && process.env.BENCH_WARMUP === "full") {
    await get("/api/auth/status");
    await get("/api/providers");
    await get("/api/provider-nodes");
    await get("/api/keys");
    await get("/api/combos");
    await get("/api/proxy-pools");
    await get("/api/settings");
    await get("/api/usage/summary");
    await get("/api/usage/requests");
    await get("/api/pricing");
    await get("/api/models");
    await get("/api/models/custom");
    await get("/api/cli-tools");
    await get("/api/media-providers");
    await get("/api/tunnel/status");
    await get("/api/version");
    await get("/api/tags");
    await get("/api/headroom/status");
    await get("/api/mcp");
    await get("/api/translator");
  }
}

async function bench(mode) {
  const { child, healthPath } = startServer(mode);
  const result = { mode, ok: false };
  try {
    await waitHealthy(healthPath, child);
    result.coldRssMb = mb(rssKb(child.pid));

    await warmup(mode);

    // Give V8/allocator a moment to return transient warmup allocations.
    await sleep(SETTLE_MS);

    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const kb = rssKb(child.pid);
      if (kb) samples.push(kb);
      await sleep(SAMPLE_INTERVAL_MS);
    }
    if (!samples.length) throw new Error("no RSS samples collected");

    result.warmIdleRssMb = mb(median(samples));
    result.minMb = mb(Math.min(...samples));
    result.maxMb = mb(Math.max(...samples));
    result.p20Mb = mb(percentile(samples, 20));
    result.p80Mb = mb(percentile(samples, 80));
    result.samples = samples.length;
    result.ok = true;
  } catch (e) {
    result.error = e.message;
  } finally {
    child.kill("SIGTERM");
    await sleep(1500);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  return result;
}

const modes = process.argv.slice(2);
if (!modes.length) {
  console.error("Usage: node scripts/mem-bench.mjs <next|hono> [more modes...]");
  process.exit(1);
}

const results = [];
for (const mode of modes) {
  console.log(`\n──── benchmarking ${mode} (port ${PORT}) ────`);
  const r = await bench(mode);
  results.push(r);
  if (r.ok) {
    console.log(`[${mode}] cold RSS:      ${r.coldRssMb} MB`);
    console.log(`[${mode}] warm-idle RSS: ${r.warmIdleRssMb} MB (median of ${r.samples}, p20 ${r.p20Mb} / p80 ${r.p80Mb}, min ${r.minMb} / max ${r.maxMb})`);
  } else {
    console.error(`[${mode}] FAILED: ${r.error}`);
  }
  await sleep(2000); // port release between runs
}

console.log("\n─── summary (JSON) ───");
console.log(JSON.stringify(results, null, 2));

const next = results.find((r) => r.mode === "next" && r.ok);
const hono = results.find((r) => r.mode === "hono" && r.ok);
if (next && hono) {
  const saved = next.warmIdleRssMb - hono.warmIdleRssMb;
  const pct = Math.round((saved / next.warmIdleRssMb) * 100);
  console.log(`\nHono warm-idle is ${saved > 0 ? saved + " MB lower" : Math.abs(saved) + " MB HIGHER"} than Next (${pct > 0 ? "-" : "+"}${Math.abs(pct)}%).`);
}
