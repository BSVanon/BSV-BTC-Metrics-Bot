// Post BTC vs BSV fees/ETA/data + backlog, then tweet.
// Verbose logs for self-diagnosis.

import { TwitterApi } from 'twitter-api-v2';

const START = Date.now();
const log = (...a) => console.log('[bot]', ...a);

// ======= CONFIG =======
const BTC_SIMPLE_VBYTES = 140;   // P2WPKH approx
const BSV_SIMPLE_BYTES  = 226;   // Legacy approx
const ONE_KB = 1000;
const BTC_TIER = process.env.BTC_TIER || 'hourFee';
const BTC_TIER_TO_BLOCKS = { fastestFee:1, halfHourFee:3, hourFee:6, economyFee:12, minimumFee:18 };
const EXPLAINER_URL = process.env.EXPLAINER_URL || '';

const BSV_MEMPOOL_TO_BLOCKS = (txCount) => {
  const n = Number(txCount || 0);
  if (n <= 20000) return 1;
  if (n <= 100000) return 2;
  return 3;
};

// ======= HELPERS =======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp280 = (t) => (t.length <= 280 ? t : t.slice(0, 277) + '...');
const abbr = (n) => {
  if (n === null || n === undefined) return '';
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000) return (n/1_000).toFixed(1).replace(/\.0$/,'')+'k';
  if (abs < 1_000_000_000) return (n/1_000_000).toFixed(1).replace(/\.0$/,'')+'M';
  return (n/1_000_000_000).toFixed(1).replace(/\.0$/,'')+'B';
};
const safeNum = (n, label) => {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error(`Bad number for ${label}`);
  return v;
};
const requireKey = (obj, key, hint) => {
  if (!obj || !(key in obj)) throw new Error(`Missing key ${key}${hint ? ` (${hint})` : ''}`);
  return obj[key];
};

// ======= DATA FETCHERS =======
async function fetchBtcFeesAndMempool() {
  log('fetch: BTC fees');
  const feesRes = await fetch('https://mempool.space/api/v1/fees/recommended', { headers: { accept:'application/json' }});
  if (!feesRes.ok) throw new Error(`BTC fees HTTP ${feesRes.status}`);
  const fees = await feesRes.json();

  log('fetch: BTC mempool');
  const mpRes = await fetch('https://mempool.space/api/mempool', { headers: { accept:'application/json' }});
  if (!mpRes.ok) throw new Error(`BTC mempool HTTP ${mpRes.status}`);
  const mp = await mpRes.json(); // { count, vsize, ... }
  return { fees, mempool: mp };
}

async function fetchBsvFeeQuoteAndMempool() {
  log('fetch: BSV MAPI feeQuote');
  const mapiRes = await fetch('https://mapi.gorillapool.io/mapi/feeQuote', { headers: { accept:'application/json' }});
  if (!mapiRes.ok) throw new Error(`BSV MAPI HTTP ${mapiRes.status}`);
  const mapi = await mapiRes.json();

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

  const standardFee = payloadJson.fees.find(f => f.feeType?.toLowerCase() === 'standard');
  const dataFee = payloadJson.fees.find(f => f.feeType?.toLowerCase() === 'data') || standardFee;
  if (!standardFee) throw new Error('BSV MAPI: standard fee not found');

  log('fetch: BSV mempool (WOC)');
  const wocRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/mempool/info', { headers: { accept:'application/json' }});
  if (!wocRes.ok) throw new Error(`BSV WOC HTTP ${wocRes.status}`);
  const woc = await wocRes.json(); // { size, count }

  return { standardFee, dataFee, mempool: woc };
}

// ======= CALCS =======
const calcBtcSimpleFeeSats = (fees) => {
  requireKey(fees, BTC_TIER, `BTC_TIER='${BTC_TIER}' not in fees`);
  const satPerVb = safeNum(fees[BTC_TIER], 'btc feerate');
  return Math.round(satPerVb * BTC_SIMPLE_VBYTES);
};
const calcBtcEtaMinutes = () => (BTC_TIER_TO_BLOCKS[BTC_TIER] ?? 6) * 10;
const calcBtcOneKbSats = (fees) => Math.round(safeNum(fees[BTC_TIER], 'btc feerate') * ONE_KB);

const calcBsvSimpleFeeSats = (standardFee) => {
  const satPerByte = safeNum(standardFee?.miningFee?.satoshis, 'bsv miningFee.satoshis')
                   / safeNum(standardFee?.miningFee?.bytes, 'bsv miningFee.bytes');
  return Math.max(1, Math.round(satPerByte * BSV_SIMPLE_BYTES));
};
const calcBsvOneKbSats = (dataFee) => {
  const satPerByte = safeNum(dataFee?.miningFee?.satoshis, 'bsv dataFee.satoshis')
                   / safeNum(dataFee?.miningFee?.bytes, 'bsv dataFee.bytes');
  return Math.max(1, Math.round(satPerByte * ONE_KB));
};
const calcBsvEtaMinutes = (mempool) => BSV_MEMPOOL_TO_BLOCKS(Number(mempool?.count ?? 0)) * 10;

function buildTweet({
  btcFeeSats, btcEtaMin, btc1kbSats, btcBacklogCount, btcBacklogBlocks,
  bsvFeeSats, bsvEtaMin, bsv1kbSats, bsvBacklogCount, bsvBacklogBlocks
}) {
  const line1 = `BTC fee:${btcFeeSats}s ~${btcEtaMin}m | BSV fee:${bsvFeeSats}s ~${bsvEtaMin}m`;
  const line2 = `1KB data — BTC:${btc1kbSats}s | BSV:${bsv1kbSats}s`;
  const line3 = `Backlog — BTC:${abbr(btcBacklogCount)}tx(~${btcBacklogBlocks}b) | BSV:${abbr(bsvBacklogCount)}tx(~${bsvBacklogBlocks}b)`;
  const more = EXPLAINER_URL ? `\nMore: ${EXPLAINER_URL}` : '';
  const text = `${line1}\n${line2}\n${line3}${more}`;
  log('tweet length =', text.length);
  return clamp280(text);
}

// ======= MAIN =======
async function main() {
  log('boot');

  // Env sanity
  const reqEnv = ['X_APP_KEY','X_APP_SECRET','X_ACCESS_TOKEN','X_ACCESS_SECRET'];
  for (const k of reqEnv) {
    if (!process.env[k]) throw new Error(`Missing env: ${k}`);
  }
  log('env ok');

  // X client + auth preflight
  const client = new TwitterApi({
    appKey: process.env.X_APP_KEY,
    appSecret: process.env.X_APP_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
  log('auth: calling v2.me()');
  const me = await client.v2.me().catch(e => {
    const detail = e?.data?.title || e?.data?.detail || e?.message || String(e);
    throw new Error(`Auth check failed: ${detail}`);
  });
  log('auth ok as @' + me?.data?.username + ' (' + me?.data?.id + ')');

  // Fetch data
  const [btc, bsv] = await Promise.all([
    fetchBtcFeesAndMempool(),
    fetchBsvFeeQuoteAndMempool()
  ]);
  log('fetch ok');

  // Compute
  const btcFeeSats  = calcBtcSimpleFeeSats(btc.fees);
  const btcEtaMin   = calcBtcEtaMinutes();
  const btc1kbSats  = calcBtcOneKbSats(btc.fees);
  const btcBacklogBlocks = Math.max(0, Math.round((safeNum(btc?.mempool?.vsize || 0, 'btc vsize') / 1_000_000) * 10) / 10);
  const btcBacklogCount  = safeNum(btc?.mempool?.count || 0, 'btc count');

  const bsvFeeSats  = calcBsvSimpleFeeSats(bsv.standardFee);
  const bsvEtaMin   = calcBsvEtaMinutes(bsv.mempool);
  const bsv1kbSats  = calcBsvOneKbSats(bsv.dataFee);
  const bsvBacklogBlocks = Math.max(1, bsvEtaMin / 10);
  const bsvBacklogCount  = safeNum(bsv?.mempool?.count || 0, 'bsv count');
  log('calc ok');

  const text = buildTweet({
    btcFeeSats, btcEtaMin, btc1kbSats, btcBacklogCount, btcBacklogBlocks,
    bsvFeeSats, bsvEtaMin, bsv1kbSats, bsvBacklogCount, bsvBacklogBlocks
  });

  // Post
  log('tweeting…');
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
  log('Tweet posted:', url);

  log('done in', (Date.now()-START)+'ms');
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
