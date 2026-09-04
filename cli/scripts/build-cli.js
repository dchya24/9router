#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const cliDir = path.resolve(__dirname, "..");
const appDir = path.resolve(cliDir, "..");
const rootDir = path.resolve(appDir, "..");
const cliAppDir = process.env.NINEROUTER_CLI_APP_DIR || path.join(cliDir, "app");
const buildHomeDir = path.join(cliDir, ".build-home");
const buildDistDirName = ".next-cli-build";
const buildDistDir = path.join(appDir, buildDistDirName);

// Exclude patterns for files/folders we don't want to copy
const EXCLUDE_PATTERNS = [
  "@img",           // Sharp image processing (not needed with unoptimized images)
  "sharp",          // Sharp core lib (not needed with unoptimized images)
  "detect-libc",    // Sharp dependency
  ".env",           // Environment files
  ".env.local",
  ".env.*.local",
  "*.log",          // Log files
  "tmp",            // Temp files
  ".DS_Store",      // macOS files
];

function shouldExclude(name) {
  return EXCLUDE_PATTERNS.some(pattern => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return regex.test(name);
    }
    return name === pattern;
  });
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`Warning: Source ${src} does not exist`);
    return;
  }
  
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip broken symlinks (common in workspace setups)
    try {
      fs.accessSync(srcPath);
    } catch {
      continue;
    }

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Resolve and copy target (avoid linking outside bundle)
      try {
        const real = fs.realpathSync(srcPath);
        if (fs.statSync(real).isDirectory()) {
          copyRecursive(real, destPath);
        } else {
          fs.copyFileSync(real, destPath);
        }
      } catch {}
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {}
    }
  }
}

function resolveStandaloneBuild(appDir, buildDistDir) {
  const legacyStandaloneRoot = path.join(appDir, ".next", "standalone");
  const resolvedStandaloneRoot = path.join(buildDistDir, "standalone");
  let standaloneRoot = fs.existsSync(resolvedStandaloneRoot)
    ? resolvedStandaloneRoot
    : legacyStandaloneRoot;

  // Next.js 16 nests standalone output under the project name when
  // NEXT_TRACING_ROOT_MODE=workspace, e.g. standalone/9router/server.js.
  const pkgName = path.basename(appDir);
  const nestedRoot = path.join(standaloneRoot, pkgName);
  if (fs.existsSync(path.join(nestedRoot, "server.js")) && !fs.existsSync(path.join(standaloneRoot, "server.js"))) {
    console.log(`ℹ️  Detected nested standalone output: ${pkgName}/`);
    standaloneRoot = nestedRoot;
  }

  const standaloneApp = fs.existsSync(path.join(standaloneRoot, "server.js"))
    ? standaloneRoot
    : path.join(standaloneRoot, "app");
  if (!fs.existsSync(standaloneApp)) {
    throw new Error(
      "Next.js standalone build not found under .next/standalone; " +
      "expected either .next/standalone/server.js or .next/standalone/app/",
    );
  }

  return { standaloneApp, standaloneRoot };
}

function buildCliPackage() {
  console.log("📦 Building 9Router CLI package with Next.js...\n");

  fs.mkdirSync(buildHomeDir, { recursive: true });
  fs.mkdirSync(path.join(buildHomeDir, "AppData", "Roaming"), { recursive: true });
  fs.mkdirSync(path.join(buildHomeDir, "AppData", "Local"), { recursive: true });

  // Step 0: Sync version from app/cli/package.json to app/package.json
  console.log("0️⃣  Syncing version to app/package.json...");
  const cliPkg = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8"));
  const appPkgPath = path.join(appDir, "package.json");
  const appPkg = JSON.parse(fs.readFileSync(appPkgPath, "utf8"));
  if (appPkg.version !== cliPkg.version) {
    appPkg.version = cliPkg.version;
    fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + "\n");
    console.log(`✅ Version synced: ${cliPkg.version}\n`);
  } else {
    console.log(`✅ Version already synced: ${cliPkg.version}\n`);
  }

  // Step 1: Build the static dashboard export.
  console.log("1️⃣  Building static dashboard export...");
  try {
    execSync("npx next build --webpack", {
      stdio: "inherit",
      cwd: appDir,
      env: {
        ...process.env,
        HOME: buildHomeDir,
        USERPROFILE: buildHomeDir,
        APPDATA: path.join(buildHomeDir, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(buildHomeDir, "AppData", "Local"),
        NEXT_DIST_DIR: buildDistDirName,
      }
    });
    console.log("✅ Static export build completed\n");
  } catch (error) {
    console.error("❌ Next.js build failed");
    process.exit(1);
  }

  // Step 2: Clean old app/cli/app if exists
  console.log("2️⃣  Cleaning old app/cli/app...");
  if (fs.existsSync(cliAppDir)) {
    fs.rmSync(cliAppDir, { recursive: true, force: true });
  }
  console.log("✅ Cleaned\n");

  // Step 3: Copy the Hono runtime layout (no Next standalone anymore).
  console.log("3️⃣  Copying hono-server runtime to app/cli/app...");
  for (const dir of ["hono-server", "src", "open-sse"]) {
    const srcDir = path.join(appDir, dir);
    if (!fs.existsSync(srcDir)) {
      console.error(`❌ Required runtime directory missing: ${dir}`);
      process.exit(1);
    }
    copyRecursive(srcDir, path.join(cliAppDir, dir));
  }
  // Server code paths the app resolves at runtime (peer deps of src/):
  // keep node_modules with production deps only.
  console.log("✅ Copied hono-server runtime\n");

  // Step 3b: Configure SQLite drivers (unchanged policy: better-sqlite3 lives
  // in ~/.9router/runtime, sql.js is bundled, node:sqlite/bun:sqlite built-in).
  console.log("3️⃣ b Configuring SQLite drivers...");
  function ensureModuleInBundle(pkg) {
    const dest = path.join(cliAppDir, "node_modules", pkg);
    if (fs.existsSync(dest)) {
      console.log(`✅ ${pkg} already bundled`);
      return;
    }
    const candidates = [
      path.join(appDir, "node_modules", pkg),
      path.join(rootDir, "node_modules", pkg),
    ];
    const srcM = candidates.find((p) => fs.existsSync(p));
    if (!srcM) {
      console.warn(`⚠️  ${pkg} not found locally — bundle will rely on node:sqlite or runtime install`);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyRecursive(srcM, dest);
    console.log(`✅ Bundled ${pkg}`);
  }
  ensureModuleInBundle("sql.js");
  ensureModuleInBundle("open");
  console.log("");

  // Step 4: Copy the static dashboard export (dist dir IS the site root).
  console.log("4️⃣  Copying static dashboard export...");
  const exportSrc = path.join(appDir, buildDistDirName);
  if (fs.existsSync(path.join(exportSrc, "index.html"))) {
    const exportDest = path.join(cliAppDir, "out");
    if (fs.existsSync(exportDest)) fs.rmSync(exportDest, { recursive: true, force: true });
    copyRecursive(exportSrc, exportDest);
    console.log("✅ Copied static export\n");
  } else {
    console.error("❌ Static dashboard export not found — run `NEXT_DIST_DIR=.next-export-build npx next build --webpack` first.");
    process.exit(1);
  }

  // Step 5: Copy public folder if exists
  console.log("5️⃣  Copying public folder...");
  const publicSrc = path.join(appDir, "public");
  const publicDest = path.join(cliAppDir, "public");
  if (fs.existsSync(publicSrc)) {
    copyRecursive(publicSrc, publicDest);
    console.log("✅ Copied public folder\n");
  } else {
    console.log("⏭️  No public folder found\n");
  }

  // Step 6: production package.json so the bundle can npm-install missing
  // runtime deps on first boot (same self-heal as before).
  fs.writeFileSync(path.join(cliAppDir, "package.json"), JSON.stringify({
    name: "9router-bundle",
    version: cliPkg.version,
    private: true,
  }, null, 2));
  console.log("✅ Wrote bundle package.json\n");

  // Step 7: Copy MITM server files (not bundled by Next.js standalone)
  console.log("7️⃣  Copying MITM server files...");
  const mitmSrc = path.join(appDir, "src", "mitm");
  const mitmDest = path.join(cliAppDir, "src", "mitm");
  if (fs.existsSync(mitmSrc)) {
    copyRecursive(mitmSrc, mitmDest);
    console.log("✅ Copied MITM files\n");
  } else {
    console.log("⏭️  No MITM files found\n");
  }

  // Step 7b: Copy standalone updater (headless Node process for install progress)
  console.log("7️⃣ b Copying updater files...");
  const updaterSrc = path.join(appDir, "src", "lib", "updater");
  const updaterDest = path.join(cliAppDir, "src", "lib", "updater");
  if (fs.existsSync(updaterSrc)) {
    copyRecursive(updaterSrc, updaterDest);
    console.log("✅ Copied updater files\n");
  } else {
    console.log("⏭️  No updater files found\n");
  }

  // Step 8: Build MITM server (config driven - see app/cli/scripts/buildMitm.js)
  console.log("8️⃣  Building MITM server...");
  try {
    execSync("node scripts/buildMitm.js", { stdio: "inherit", cwd: cliDir });
    console.log("✅ MITM server build completed\n");
  } catch (error) {
    console.error("❌ MITM build failed");
    process.exit(1);
  }

  console.log("✨ CLI package build completed!");
  console.log(`📁 Output: ${cliAppDir}`);

  try {
    const { execSync: exec } = require("child_process");
    const size = exec(`du -sh "${cliAppDir}"`, { encoding: "utf8" }).trim();
    console.log(`📊 Package size: ${size.split("\t")[0]}`);
  } catch (e) {
    // Silent fail on size check
  }
}

module.exports = {};

if (require.main === module) {
  buildCliPackage();
}
