// ---- BOOT BANNER (prints even if require fails) ----
console.log("[metrics-bot] starting post-metrics.js");

// Use CommonJS so it runs whether or not package.json has "type":"module"
let TwitterApi;
try {
  ({ TwitterApi } = require('twitter-api-v2'));
  console.log("[metrics-bot] twitter-api-v2 loaded");
} catch (e) {
  console.error("[metrics-bot] require('twitter-api-v2') failed:", e && e.message || e);
  process.exit(1);
}

// Node 18+ has global fetch. Double-check:
if (typeof fetch !== 'function') {
  console.error("[metrics-bot] global fetch not available");
  process.exit(1);
}

// ======= CONFIG =======
const BTC_SIMPLE_VBYTES = 140;
const BSV_SIMPLE_BYTES  = 226;
const ONE_KB = 1000;

const BTC_TIER = process.env.BTC_TIER || 'hourFee';
const BTC_TIER_TO_BLOCKS = { fastestFee:1, halfHourFee:3, hourFee:6, economyFee:12, minimumFee:18 };
const EXPLAINER_URL = process.env.EXPLAINER_URL || "";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const abbr = n => (n==null) ? '' :
  Math.abs(n) < 1e3 ? String(n) :
  Math.abs(n) < 1e6 ? (n/1e3).toFixed(1).replace(/\.0$/,'') + 'k' :
  Math.abs(n) < 1e9 ? (n/1e6).toFixed(1).replace(/\.0$/,'') + 'M' :
                      (n/1e9).toFixed(1).replace(/\.0$/,'') + 'B';
const clamp280 = t => t.length<=280? t : (t.slice(0,277)+'...');
const reqKey = (o,k,h) => { if(!o || !(k in o)) throw new Error(`Missing key ${k}${h?` (${h})`:''}`); return o[k]; };

const BSV_MEMPOOL_TO_BLOCKS = (txCount) => {
  const n = Number(txCount||0);
  if (n <= 20000) return 1;
  if (n <= 100000) return 2;
  return 3;
};

// ======= FETCHERS =======
async function fetchBtc() {
  console.log("[metrics-bot] fetching BTC fees & mempool…");
  const feesRes = await fetch('https://mempool.space/api/v1/fees/recommended', { headers:{accept:'application/json'} });
  if (!feesRes.ok) throw new Error(`BTC fees HTTP ${feesRes.status}`);
  const fees = await feesRes.json();

  const mpRes = await fetch('https://mempool.space/api/mempool', { headers:{accept:'application/json'} });
  if (!mpRes.ok) throw new Error(`BTC mempool HTTP ${mpRes.status}`);
  const mempool = await mpRes.json();
  return { fees, mempool };
}

async function fetchBsv() {
  console.log("[metrics-bot] fetching BSV feeQuote & mempool…");
  const mapiRes = await fetch('https://mapi.gorillapool.io/mapi/feeQuote', { headers:{accept:'application/json'} });
  if (!mapiRes.ok) throw new Error(`BSV MAPI HTTP ${mapiRes.status}`);
  const mapi = await mapiRes.json();

  let payloadJson;
  try {
    payloadJson = JSON.parse(mapi.payload);
  } catch {
    try {
      payloadJson = JSON.parse(Buffer.from(String(mapi.payload), 'base64').toString('utf8'));
    } catch {
      throw new Error('BSV MAPI payload parse failed');
    }
  }

  const fees = reqKey(payloadJson, 'fees', 'fee list');
  const standardFee = fees.find(f => String(f.feeType).toLowerCase()==='standard');
  const dataFee = fees.find(f => String(f.feeType).toLowerCase()==='data') || standardFee;
  if (!standardFee) throw new Error('BSV: no standard fee');

  const wocRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/mempool/info', { headers:{accept:'application/json'} });
  if (!wocRes.ok) throw new Error(`BSV WOC HTTP ${wocRes.status}`);
  const mempool = await wocRes.json();

  return { standardFee, dataFee, mempool };
}

// ======= MATH =======
const btcFeeSats = (fees) => Math.round(Number(fees[BTC_TIER]) * BTC_SIMPLE_VBYTES);
const btcEtaMin  = () => (BTC_TIER_TO_BLOCKS[BTC_TIER] ?? 6) * 10;
const btc1kbSats = (fees) => Math.round(Number(fees[BTC_TIER]) * ONE_KB);

const bsvSimpleSats = (standardFee) => {
  const spp = Number(standardFee.miningFee.satoshis) / Number(standardFee.miningFee.bytes);
  return Math.max(1, Math.round(spp * BSV_SIMPLE_BYTES));
};
const bsv1kbSats = (dataFee) => {
  const spp = Number(dataFee.miningFee.satoshis) / Number(dataFee.miningFee.bytes);
  return Math.max(1, Math.round(spp * ONE_KB));
};
const bsvEtaMin = (mp) => BSV_MEMPOOL_TO_BLOCKS(Number(mp.count||0)) * 10;

function buildTweet(o){
  const line1 = `BTC fee:${o.btcFee}s ~${o.btcEta}m | BSV fee:${o.bsvFee}s ~${o.bsvEta}m`;
  const line2 = `1KB data — BTC:${o.btc1k}s | BSV:${o.bsv1k}s`;
  const line3 = `Backlog — BTC:${abbr(o.btcCnt)}tx(~${o.btcBlks}b) | BSV:${abbr(o.bsvCnt)}tx(~${o.bsvBlks}b)`;
  const more = EXPLAINER_URL ? `\nMore: ${EXPLAINER_URL}` : '';
  return clamp280(`${line1}\n${line2}\n${line3}${more}`);
}

// ======= MAIN =======
async function main() {
  console.log("[metrics-bot] checking secrets…");
  const hasSecrets = !!process.env.X_APP_KEY && !!process.env.X_APP_SECRET && !!process.env.X_ACCESS_TOKEN && !!process.env.X_ACCESS_SECRET;
  if (!hasSecrets) throw new Error("X secrets missing in environment");

  console.log("[metrics-bot] auth to X…");
  const client = new TwitterApi({
    appKey: process.env.X_APP_KEY,
    appSecret: process.env.X_APP_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

  const me = await client.v2.me();
  const handle = me?.data?.username || 'unknown';
  console.log(`[metrics-bot] Auth OK as @${handle}`);

  const [btc, bsv] = await Promise.all([fetchBtc(), fetchBsv()]);

  const btcFee  = btcFeeSats(btc.fees);
  const btcEta  = btcEtaMin(btc.fees);
  const btc1k   = btc1kbSats(btc.fees);
  const btcBlks = Math.max(0, Math.round((Number(btc.mempool.vsize||0)/1_000_000)*10)/10);
  const btcCnt  = Number(btc.mempool.count||0);

  const bsvFee  = bsvSimpleSats(bsv.standardFee);
  const bsvEta  = bsvEtaMin(bsv.mempool);
  const bsv1k   = bsv1kbSats(bsv.dataFee);
  const bsvBlks = Math.max(1, bsvEta/10);
  const bsvCnt  = Number(bsv.mempool.count||0);

  const text = buildTweet({ btcFee, btcEta, btc1k, btcCnt, btcBlks, bsvFee, bsvEta, bsv1k, bsvCnt, bsvBlks });
  console.log("[metrics-bot] tweet text:\n" + text);

  if (process.env.DRY_RUN === '1') {
    console.log("[metrics-bot] DRY_RUN=1 — not posting.");
    return;
  }

  const res = await client.v2.tweet(text);
  if (!res?.data?.id) throw new Error("Tweet API returned no id: " + JSON.stringify(res));
  console.log(`[metrics-bot] Tweet posted: https://x.com/${handle}/status/${res.data.id}`);
}

(async function run(){
  try {
    await main();
  } catch (e) {
    console.error("[metrics-bot] Fatal:", e && e.message || e);
    try {
      console.error("[metrics-bot] Retrying after 2s…");
      await sleep(2000);
      await main();
    } catch (e2) {
      console.error("[metrics-bot] Retry failed:", e2 && e2.message || e2);
      process.exit(1);
    }
  }
})();
