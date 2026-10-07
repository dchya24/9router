// Aggregate 9router bench sampler CSVs.
// Rows: ts,leg,pid,rss_kb,swap_kb,hwm_kb — junk launcher-pids are filtered by whitelist.
const fs = require("fs");

const APP_PIDS = new Set(["2636207", "2636249", "2636778"]); // cli, next-server, hono node

function load(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
  const byTs = new Map();
  for (const line of lines) {
    const [ts, leg, pid, rss, swap, hwm] = line.split(",");
    if (!APP_PIDS.has(pid)) continue; // drop launcher/bash junk rows
    if (!byTs.has(ts)) byTs.set(ts, { stock: 0, fork: 0, stockSwap: 0, forkSwap: 0 });
    const row = byTs.get(ts);
    if (leg === "stock") { row.stock += +rss; row.stockSwap += +swap; }
    else { row.fork += +rss; row.forkSwap += +swap; }
  }
  return [...byTs.entries()].map(([ts, r]) => ({ ts: +ts, ...r })).sort((a, b) => a.ts - b.ts);
}

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function stats(vals) {
  const s = [...vals].sort((a, b) => a - b);
  return {
    min: s[0], p20: pct(s, 20), p50: pct(s, 50), p80: pct(s, 80), max: s[s.length - 1],
    mean: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
  };
}

const mb = (kb) => (kb / 1024).toFixed(1);

for (const [phase, file] of [["idle", "/tmp/9r-bench-dist/samples-idle.csv"], ["load", "/tmp/9r-bench-dist/samples-load.csv"]]) {
  const rows = load(file);
  if (!rows.length) { console.log(phase, "NO DATA"); continue; }
  const t0 = rows[0].ts;
  // steady state: drop first 300s (warm-up)
  const steady = rows.filter((r) => r.ts - t0 >= 300);
  for (const leg of ["stock", "fork"]) {
    const vals = steady.map((r) => r[leg]);
    const swaps = steady.map((r) => r[leg + "Swap"]);
    const st = stats(vals);
    console.log(
      `${phase.toUpperCase().padEnd(4)} ${leg.padEnd(5)} n=${String(steady.length).padStart(3)}  ` +
      `min=${mb(st.min)} p20=${mb(st.p20)} p50=${mb(st.p50)} mean=${mb(st.mean)} p80=${mb(st.p80)} max=${mb(st.max)} MB  ` +
      `swapMax=${mb(Math.max(...swaps))} MB`
    );
  }
  // HWM from raw rows (HWM is per-process high-water, take max seen in phase)
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
  for (const leg of ["stock", "fork"]) {
    const hwms = lines.map((l) => l.split(",")).filter(([, l2, pid]) => l2 === leg && APP_PIDS.has(pid)).map((r) => +r[5]);
    console.log(`${phase.toUpperCase().padEnd(4)} ${leg.padEnd(5)} hwmMax=${mb(Math.max(...hwms))} MB`);
  }
}
