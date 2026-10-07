// Aggregate 3-leg (stock/node/bun) sampler CSVs: ts,leg,rss_kb,swap_kb,hwm_kb
const fs = require("fs");

function load(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
  const byTs = new Map();
  for (const line of lines) {
    if (line === "DONE") continue;
    const [ts, leg, rss, swap, hwm] = line.split(",");
    if (!byTs.has(ts)) byTs.set(ts, {});
    byTs.get(ts)[leg] = { rss: +rss, swap: +swap, hwm: +hwm };
  }
  return [...byTs.entries()].map(([ts, v]) => ({ ts: +ts, ...v })).sort((a, b) => a.ts - b.ts);
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function stats(vals) {
  const s = [...vals].sort((a, b) => a - b);
  return { min: s[0], p20: pct(s, 20), p50: pct(s, 50), p80: pct(s, 80), max: s[s.length - 1] };
}
const mb = (kb) => (kb / 1024).toFixed(1);

for (const [phase, file] of [["idle", "/tmp/9r-bench-dist/s3-idle.csv"], ["load", "/tmp/9r-bench-dist/s3-load.csv"]]) {
  const rows = load(file).filter((r) => r.stock && r.node && r.bun);
  const t0 = rows[0].ts;
  const steady = rows.filter((r) => r.ts - t0 >= 300); // drop 5-min warm-up
  console.log(`\n=== ${phase.toUpperCase()} (steady n=${steady.length}, warm-up dropped) ===`);
  for (const leg of ["stock", "node", "bun"]) {
    const st = stats(steady.map((r) => r[leg].rss));
    const hwmMax = Math.max(...steady.map((r) => r[leg].hwm));
    const swapMax = Math.max(...steady.map((r) => r[leg].swap));
    console.log(
      `${leg.padEnd(5)} min=${mb(st.min)} p20=${mb(st.p20)} p50=${mb(st.p50)} p80=${mb(st.p80)} max=${mb(st.max)} MB | hwmMax=${mb(hwmMax)} MB | swapMax=${mb(swapMax)} MB`
    );
  }
}
