// Extra-loud diagnostics to prove what file is running and where.

// Print banner immediately (before any imports)
console.log("[preflight] starting");
console.log("[preflight] node=%s", process.version);
console.log("[preflight] cwd=%s", process.cwd());
console.log("[preflight] argv=%j", process.argv);
console.log("[preflight] env: DRY_RUN=%s BTC_TIER=%s EXPLAINER_URL=%s",
  process.env.DRY_RUN || "", process.env.BTC_TIER || "", process.env.EXPLAINER_URL || "");

// Show workspace contents (top-level)
const { execSync } = require("node:child_process");
try {
  const top = execSync("ls -la", { stdio: ["ignore", "pipe", "pipe"] }).toString();
  console.log("[preflight] ls -la (top):\n" + top);
} catch (e) {
  console.log("[preflight] ls -la failed:", e?.message || e);
}

// Prove the file exists and dump first lines
const fs = require("node:fs");
const path = require("node:path");
const target = path.resolve(process.cwd(), "post-metrics.js");
console.log("[preflight] resolved post-metrics.js -> %s", target);

if (!fs.existsSync(target)) {
  console.log("[preflight] ERROR: post-metrics.js not found at %s", target);
  process.exit(2);
}

try {
  const head = fs.readFileSync(target, "utf8").split("\n").slice(0, 12).join("\n");
  console.log("[preflight] first 12 lines of post-metrics.js:\n" + head);
} catch (e) {
  console.log("[preflight] read post-metrics.js failed:", e?.message || e);
}

// Try a trivial require to ensure CJS works
try {
  require("twitter-api-v2");
  console.log("[preflight] twitter-api-v2 is resolvable");
} catch (e) {
  console.log("[preflight] twitter-api-v2 require failed:", e?.message || e);
}

// Done
console.log("[preflight] done");
