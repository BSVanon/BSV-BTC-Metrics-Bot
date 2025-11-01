// Post BTC vs BSV fees/ETA/data + backlog, then tweet.
// Uses public APIs only; no extra accounts beyond X needed.

import { TwitterApi } from 'twitter-api-v2';

// ======= CONFIG (constants you can tune later) =======

// Assumed tx sizes for a "simple send": 1 input -> 2 outputs (recipient + change)
const BTC_SIMPLE_VBYTES = 140;   // P2WPKH approx: 10 + 68 + 31 + 31
const BSV_SIMPLE_BYTES  = 226;   // Legacy approx: 10 + 148 + 34 + 34

// 1KB data benchmark (bytes/vbytes)
const ONE_KB = 1000;

// BTC fee tier to use for stability ("fastestFee", "halfHourFee", "hourFee", "economyFee", "minimumFee")
const BTC_TIER = process.env.BTC_TIER || 'hourFee';

// ETA mapping in blocks for BTC fee tiers (rough conventions)
const BTC_TIER_TO_BLOCKS = {
  fastestFee: 1,
  halfHourFee: 3,
  hourFee: 6,
  economyFee: 12,
  minimumFee: 18
};

// For BSV ETA, use a simple backlog heuristic
// If mempool tx count is small, assume 1 block; increase if it grows.
// Tune thresholds later if you want.
const BSV_MEMPOOL_TO_BLOCKS = (txCount) => {
  const n = Number(txCount || 0);
  if (n <= 20000) return 1;
  if (n <= 100000) return 2;
  return 3;
};

// Pinned explainer link (t.co counts as 23 chars). Optional.
const EXPLAINER_URL = process.env.EXPLAINER_URL || "";

// ======= HELPERS =======

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function abbr(n) {
  // Abbreviate large integers: 1234 -> 1.2k, 1_230_000 -> 1.2M
  if (n === null || n === undefined) return '';
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (abs < 1_000_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
}

function clamp280(text) {
  // If we ever exceed 280 chars, trim safely (shouldn't happen with our format).
  if (text.length <= 280) return text;
  return text.slice(0, 277) + '...';
}

function safeNum(n, label) {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error(`Bad number for ${label}`);
  return v;
}

function requireKey(obj, key, hint) {
  if (!obj || !(key in obj)) throw new Error(`Missing key ${key}${hint ? ` (${hint})` : ''}`);
  return obj[key];
}

// ======= DATA FETCHERS =======

// BTC (mempool.space)
async function fetchBtcFeesAndMempool() {
  // Recommended fees
  const feesRes = await fetch('https://mempool.space/api/v1/fees/recommended', { headers: { 'accept': 'application/json' }});
  if (!feesRes.ok) throw new Error(`BTC fees HTTP ${feesRes.status}`);
  const fees = await feesRes.json();

  // Mempool stats
  const mpRes = await fetch('https://mempool.space/api/mempool', { headers: { 'accept': 'application/json' }});
  if (!mpRes.ok) throw new Error(`BTC mempool HTTP ${mpRes.status}`);
  const mp = await mpRes.json(); // { count, vsize, total_fee, fee_histogram }

  return { fees, mempool: mp };
}

// BSV (GorillaPool MAPI + W
