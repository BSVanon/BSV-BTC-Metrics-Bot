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
  if (txCount <= 20000) return 1;
  if (txCount <= 100000) return 2;
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

// BSV (GorillaPool MAPI + WhatsOnChain)
async function fetchBsvFeeQuoteAndMempool() {
  // GorillaPool MAPI feeQuote (public)
  // Shape: { payload: base64(json), signature, publicKey, encoding }
  const mapiRes = await fetch('https://mapi.gorillapool.io/mapi/feeQuote', { headers: { 'accept': 'application/json' }});
  if (!mapiRes.ok) throw new Error(`BSV MAPI HTTP ${mapiRes.status}`);
  const mapi = await mapiRes.json();
  const payloadJson = JSON.parse(Buffer.from(mapi.payload, 'base64').toString('utf8'));
  // payloadJson.fees => [{ feeType: 'standard'|'data', miningFee: { satoshis, bytes }, relayFee: {...} }, ...]
  // Prefer miningFee for pricing.
  const standardFee = payloadJson.fees.find(f => f.feeType.toLowerCase() === 'standard');
  const dataFee = payloadJson.fees.find(f => f.feeType.toLowerCase() === 'data') || standardFee;

  // WhatsOnChain mempool info (public)
  const wocRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/mempool/info', { headers: { 'accept': 'application/json' }});
  if (!wocRes.ok) throw new Error(`BSV WOC HTTP ${wocRes.status}`);
  const woc = await wocRes.json(); // { size, count }

  return { standardFee, dataFee, mempool: woc };
}

// ======= CALCULATIONS =======

function calcBtcSimpleFeeSats(fees) {
  const satPerVb = Number(fees[BTC_TIER]);
  return Math.round(satPerVb * BTC_SIMPLE_VBYTES); // sats
}

function calcBtcEtaMinutes(fees) {
  const blocks = BTC_TIER_TO_BLOCKS[BTC_TIER] ?? 6;
  return blocks * 10; // ~10 min/block
}

function calcBtcOneKbSats(fees) {
  const satPerVb = Number(fees[BTC_TIER]);
  return Math.round(satPerVb * ONE_KB);
}

function calcBsvSimpleFeeSats(standardFee) {
  // standardFee.miningFee = { satoshis, bytes }
  const satPerByte = Number(standardFee.miningFee.satoshis) / Number(standardFee.miningFee.bytes);
  return Math.max(1, Math.round(satPerByte * BSV_SIMPLE_BYTES));
}

function calcBsvOneKbSats(dataFee) {
  const satPerByte = Number(dataFee.miningFee.satoshis) / Number(dataFee.miningFee.bytes);
  return Math.max(1, Math.round(satPerByte * ONE_KB));
}

function calcBsvEtaMinutes(mempool) {
  const blocks = BSV_MEMPOOL_TO_BLOCKS(Number(mempool.count ?? 0));
  return blocks * 10;
}

// ======= TWEET BUILDER =======

function buildTweet({
  btcFeeSats, btcEtaMin, btc1kbSats, btcBacklogCount, btcBacklogBlocks,
  bsvFeeSats, bsvEtaMin, bsv1kbSats, bsvBacklogCount, bsvBacklogBlocks
}) {
  // 3-line human-friendly format + link
  const line1 = `BTC fee:${btcFeeSats}s ~${btcEtaMin}m | BSV fee:${bsvFeeSats}s ~${bsvEtaMin}m`;
  const line2 = `1KB data — BTC:${btc1kbSats}s | BSV:${bsv1kbSats}s`;
  const line3 = `Backlog — BTC:${abbr(btcBacklogCount)}tx(~${btcBacklogBlocks}b) | BSV:${abbr(bsvBacklogCount)}tx(~${bsvBacklogBlocks}b)`;
  const more = EXPLAINER_URL ? `\nMore: ${EXPLAINER_URL}` : '';

  return clamp280(`${line1}\n${line2}\n${line3}${more}`);
}

// ======= MAIN =======

async function main() {
  // Fetch
  const [{ fees: btcFees, mempool: btcMp }, { standardFee, dataFee, mempool: bsvMp }] = await Promise.all([
    fetchBtcFeesAndMempool(),
    fetchBsvFeeQuoteAndMempool()
  ]);

  // Compute BTC
  const btcFeeSats  = calcBtcSimpleFeeSats(btcFees);
  const btcEtaMin   = calcBtcEtaMinutes(btcFees);
  const btc1kbSats  = calcBtcOneKbSats(btcFees);
  // Approx backlog in "blocks": mempool vsize / 1,000,000 vB per block (4M weight units → 1M vB)
  const btcBacklogBlocks = Math.max(0, Math.round((Number(btcMp.vsize || 0) / 1_000_000) * 10) / 10); // 1 decimal
  const btcBacklogCount  = Number(btcMp.count || 0);

  // Compute BSV
  const bsvFeeSats  = calcBsvSimpleFeeSats(standardFee);
  const bsvEtaMin   = calcBsvEtaMinutes(bsvMp);
  const bsv1kbSats  = calcBsvOneKbSats(dataFee);
  // BSV backlog "blocks": very rough; assume default 1 block unless mempool grows.
  const bsvBacklogBlocks = Math.max(1, calcBsvEtaMinutes(bsvMp) / 10); // same buckets as ETA
  const bsvBacklogCount  = Number(bsvMp.count || 0);

  const text = buildTweet({
    btcFeeSats, btcEtaMin, btc1kbSats, btcBacklogCount, btcBacklogBlocks,
    bsvFeeSats, bsvEtaMin, bsv1kbSats, bsvBacklogCount, bsvBacklogBlocks
  });

  // Post
  const client = new TwitterApi({
    appKey: process.env.X_APP_KEY,
    appSecret: process.env.X_APP_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

  const res = await client.v2.tweet(text);
  console.log('Tweet posted:', res?.data?.id, text);
}

main().catch(async (e) => {
  console.error('Fatal error:', e?.message || e);
  // Optional: backoff retry once if a transient network error
  try {
    await sleep(2000);
    await main();
  } catch (e2) {
    console.error('Retry failed:', e2?.message || e2);
    process.exit(1);
  }
});
