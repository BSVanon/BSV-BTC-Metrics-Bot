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
  if (n === null || n === undefined) return '';
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (abs < 1_000_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
}

function clamp280(text) {
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
  const feesRes = await fetch('https://mempool.space/api/v1/fees/recommended', { headers: { 'accept': 'application/json' }});
  if (!feesRes.ok) throw new Error(`BTC fees HTTP ${feesRes.status}`);
  const fees = await feesRes.json();

  const mpRes = await fetch('https://mempool.space/api/mempool', { headers: { 'accept': 'application/json' }});
  if (!mpRes.ok) throw new Error(`BTC mempool HTTP ${mpRes.status}`);
  const mp = await mpRes.json(); // { count, vsize, total_fee, fee_histogram }

  return { fees, mempool: mp };
}

// BSV (GorillaPool MAPI + WhatsOnChain)
async function fetchBsvFeeQuoteAndMempool() {
  // GorillaPool MAPI feeQuote (public)
  const mapiRes = await fetch('https://mapi.gorillapool.io/mapi/feeQuote', { headers: { 'accept': 'application/json' }});
  if (!mapiRes.ok) throw new Error(`BSV MAPI HTTP ${mapiRes.status}`);
  const mapi = await mapiRes.json();

  // Some MAPI servers return payload as plain JSON string; others use base64.
  // Try direct JSON parse first, then fall back to base64 decode.
  let payloadJson;
  try {
    payloadJson = JSON.parse(mapi.payload);
  } catch {
    try {
      const decoded = Buffer.from(String(mapi.payload), 'base64').toString('utf8');
      payloadJson = JSON.parse(decoded);
    } catch {
      throw new Error('BSV MAPI payload parse failed');
    }
  }

  if (!payloadJson?.fees?.length) throw new Error('BSV MAPI: no fees array in payload');

  // Prefer miningFee for pricing.
  const standardFee = payloadJson.fees.find(f => f.feeType?.toLowerCase() === 'standard');
  const dataFee = payloadJson.fees.find(f => f.feeType?.toLowerCase() === 'data') || standardFee;
  if (!standardFee) throw new Error('BSV MAPI: standard fee not found');

  // WhatsOnChain mempool info (public)
  const wocRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/mempool/info', { headers: { 'accept': 'application/json' }});
  if (!wocRes.ok) throw new Error(`BSV WOC HTTP ${wocRes.status}`);
  const woc = await wocRes.json(); // { size, count }

  return { standardFee, dataFee, mempool: woc };
}

// ======= CALCULATIONS =======

function calcBtcSimpleFeeSats(fees) {
  requireKey(fees, BTC_TIER, `BTC_TIER='${BTC_TIER}' not in fees response`);
  const satPerVb = safeNum(fees[BTC_TIER], 'btc feerate');
  return Math.round(satPerVb * BTC_SIMPLE_VBYTES); // sats
}

function calcBtcEtaMinutes() {
  const blocks = BTC_TIER_TO_BLOCKS[BTC_TIER] ?? 6;
  return blocks * 10; // ~10 min/block
}

function calcBtcOneKbSats(fees) {
  const satPerVb = safeNum(fees[BTC_TIER], 'btc feerate');
  return Math.round(satPerVb * ONE_KB);
}

function calcBsvSimpleFeeSats(standardFee) {
  // standardFee.miningFee = { satoshis, bytes }
  const satPerByte = safeNum(standardFee?.miningFee?.satoshis, 'bsv miningFee.satoshis')
                   / safeNum(standardFee?.miningFee?.bytes, 'bsv miningFee.bytes');
  return Math.max(1, Math.round(satPerByte * BSV_SIMPLE_BYTES));
}

function calcBsvOneKbSats(dataFee) {
  const satPerByte = safeNum(dataFee?.miningFee?.satoshis, 'bsv dataFee.satoshis')
                   / safeNum(dataFee?.miningFee?.bytes, 'bsv dataFee.bytes');
  return Math.max(1, Math.round(satPerByte * ONE_KB));
}

function calcBsvEtaMinutes(mempool) {
  const blocks = BSV_MEMPOOL_TO_BLOCKS(Number(mempool?.count ?? 0));
  return blocks * 10;
}

// ======= TWEET BUILDER =======

function buildTweet({
  btcFeeSats, btcEtaMin, btc1kbSats, btcBacklogCount, btcBacklogBlocks,
  bsvFeeSats, bsvEtaMin, bsv1kbSats, bsvBacklogCount, bsvBacklogBlocks
}) {
  const line1 = `BTC fee:${btcFeeSats}s ~${btcEtaMin}m | BSV fee:${bsvFeeSats}s ~${bsvEtaMin}m`;
  const line2 = `1KB data — BTC:${btc1kbSats}s | BSV:${bsv1kbSats}s`;
  const line3 = `Backlog — BTC:${abbr(btcBacklogCount)}tx(~${btcBacklogBlocks}b) | BSV:${abbr(bsvBacklogCount)}tx(~${bsvBacklogBlocks}b)`;
  const more = EXPLAINER_URL ? `\nMore: ${EXPLAINER_URL}` : '';

  const text = `${line1}\n${line2}\n${line3}${more}`;
  console.log(`Tweet length: ${text.length}`);
  return clamp280(text);
}

// ======= MAIN =======

async function main() {
  // Env checks for OAuth 1.0a keys
  const reqEnv = ['X_APP_KEY', 'X_APP_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
  for (const k of reqEnv) if (!process.env[k]) throw new Error(`Missing env: ${k}`);

  // Prepare X client
  const client = new TwitterApi({
    appKey: process.env.X_APP_KEY,
    appSecret: process.env.X_APP_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

  // Auth preflight: who are we posting as?
  const me = await client.v2.me().catch(e => {
    const detail = e?.data?.title || e?.data?.detail || e?.message || String(e);
    throw new Error(`Auth check failed: ${detail}`);
  });
  console.log(`Authenticated as @${me?.data?.username} (id ${me?.data?.id})`);

  // Fetch data in parallel
  const [{ fees: btcFees, mempool: btcMp }, { standardFee, dataFee, mempool: bsvMp }] = await Promise.all([
    fetchBtcFeesAndMempool(),
    fetchBsvFeeQuoteAndMempool()
  ]);

  // Compute BTC
  const btcFeeSats  = calcBtcSimpleFeeSats(btcFees);
  const btcEtaMin   = calcBtcEtaMinutes();
  const btc1kbSats  = calcBtcOneKbSats(btcFees);
  const btcBacklogBlocks = Math.max(0, Math.round((safeNum(btcMp?.vsize || 0, 'btc mempool vsize') / 1_000_000) * 10) / 10);
  const btcBacklogCount  = safeNum(btcMp?.count || 0, 'btc mempool count');

  // Compute BSV
  const bsvFeeSats  = calcBsvSimpleFeeSats(standardFee);
  const bsvEtaMin   = calcBsvEtaMinutes(bsvMp);
  const bsv1kbSats  = calcBsvOneKbSats(dataFee);
  const bsvBacklogBlocks = Math.max(1, bsvEtaMin / 10);
  const bsvBacklogCount  = safeNum(bsvMp?.count || 0, 'bsv mempool count');

  const text = buildTweet({
    btcFeeSats, btcEtaMin, btc1kbSats, btcBacklogCount, btcBacklogBlocks,
    bsvFeeSats, bsvEtaMin, bsv1kbSats, bsvBacklogCount, bsvBacklogBlocks
  });

  // Post and print URL
  let res;
  try {
    res = await client.v2.tweet(text);
  } catch (e) {
    const title = e?.data?.title || e?.message || 'Unknown X error';
    const detail = e?.data?.detail || '';
    throw new Error(`Tweet failed: ${title}${detail ? ` — ${detail}` : ''}`);
  }
  const tweetId = res?.data?.id;
  if (!tweetId) throw new Error(`X API returned no tweet id: ${JSON.stringify(res)}`);
  const url = `https://x.com/${me?.data?.username}/status/${tweetId}`;
  console.log('Tweet posted:', url);
}

main().catch(async (e) => {
  console.error('Fatal error:', e?.message || e);
  try {
    await sleep(2000);
    await main();
  } catch (e2) {
    console.error('Retry failed:', e2?.message || e2);
    process.exit(1);
  }
});
