import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LENS, INITIALIZE, INIT_BLOCK, TICKET_MINTED, RECEIVER_705B, distributionWatch, poolKey, decodeReserves, indexedHolders, x9ReceiptBurn, aggregateCandidates } from './evidence.mjs';
import monitoring from '../monitoring.js';

const DATA = path.join(path.resolve(process.cwd()), "data");
const RPC = process.env.DORY_RPC_URL || process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
const POOL = "0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb";
const GT = `https://api.geckoterminal.com/api/v2/networks/arbitrum/pools/${POOL}`;
const DORY = "0x33b49f2264e85bb124d2730dc180182717d436ae";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const PM = "0x360e68faccca8ca495c1b759fd9eee466db9fb32";
const X9 = "0xecdda172d2e8aa8eff55500fd28da828cffbc5b0";
const ZERO_TOPIC = "0x" + "0".repeat(64);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"), verified with web3_sha3.
const SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const START_DATE = Date.parse("2025-09-09T00:00:00Z");
const hex = n => "0x" + BigInt(n).toString(16);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const budgetValue = (name, fallback, min, max) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
};

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function beijingDay(when = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(when);
  const value = type => parts.find(p => p.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
export function validatePool(response) {
  const p = response?.data;
  if (p?.id?.toLowerCase() !== `arbitrum_${POOL}` || p?.attributes?.address?.toLowerCase() !== POOL)
    throw new Error("GeckoTerminal response does not identify the configured pool");
  if (p?.relationships?.dex?.data?.id !== "uniswap-v4-arbitrum")
    throw new Error("Configured pool is not identified as Uniswap v4 on Arbitrum");
  const relation = name => p.relationships?.[name]?.data?.id?.toLowerCase();
  const base = relation("base_token"), quote = relation("quote_token");
  if (![base, quote].includes(`arbitrum_${DORY}`) || ![base, quote].includes(`arbitrum_${USDC}`))
    throw new Error("Configured pool token relations are not DORY/USDC");
  for (const [address, decimals] of [[DORY, 18], [USDC, 6]]) {
    const token = response.included?.find(x => x.id?.toLowerCase() === `arbitrum_${address}`);
    if (token?.attributes?.address?.toLowerCase() !== address || token?.attributes?.decimals !== decimals)
      throw new Error("Configured token address/decimals could not be verified");
  }
  // v4 requires currency0 < currency1 by address, regardless of GT base/quote presentation.
  const currencies = [DORY, USDC].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  return { currency0: currencies[0], currency1: currencies[1], dory_is_base: base === `arbitrum_${DORY}`,
    evidence: "GeckoTerminal token relations and included decimals; Uniswap v4 address ordering" };
}
function signedWord(word) {
  if (!/^[0-9a-f]{64}$/i.test(word)) throw new Error("Invalid ABI integer word");
  const n = BigInt("0x" + word);
  return n >> 255n ? n - (1n << 256n) : n;
}
export function decodeSwap(log, identity) {
  if (!identity || ![identity.currency0, identity.currency1].includes(DORY) ||
      ![identity.currency0, identity.currency1].includes(USDC)) throw new Error("Unverified pool currencies");
  if (log.address?.toLowerCase() !== PM || log.topics?.[0]?.toLowerCase() !== SWAP ||
      log.topics?.[1]?.toLowerCase() !== POOL) throw new Error("Swap log is outside the configured pool");
  const data = log.data?.slice(2) || "";
  const amount0 = signedWord(data.slice(0, 64)), amount1 = signedWord(data.slice(64, 128));
  return { dory: Number(identity.currency0 === DORY ? amount0 : amount1) / 1e18,
    usdc: Number(identity.currency0 === USDC ? amount0 : amount1) / 1e6 };
}
export function isX9Mint(log) {
  // ERC721 Transfer has three indexed arguments. Arbitrary X9 logs do not prove a Mint.
  return log?.address?.toLowerCase() === X9 && log.topics?.length === 4 &&
    log.topics[0]?.toLowerCase() === TRANSFER && log.topics[1]?.toLowerCase() === ZERO_TOPIC &&
    /^0x0{24}[0-9a-f]{40}$/i.test(log.topics[2]) && log.topics[2]?.toLowerCase() !== ZERO_TOPIC &&
    /^0x[0-9a-f]{64}$/i.test(log.topics[3]) && log.data === "0x";
}
export function isDirectZeroTransfer(tx) {
  return tx?.to?.toLowerCase() === DORY && /^0xa9059cbb0{64}[0-9a-f]{64}$/i.test(tx.input || "");
}
function makeClient() {
  const deadline = Date.now() + budgetValue("DORY_MAX_RUN_MS", 600000, 1000, 1800000);
  const maxRequests = budgetValue("DORY_MAX_REQUESTS", 2400, 1, 10000);
  const timeout = budgetValue("DORY_REQUEST_TIMEOUT_MS", 12000, 100, 30000);
  let requests = 0;
  async function request(url, options = {}, label = "data source") {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() >= deadline || requests >= maxRequests) throw new Error("Collection request/time budget exhausted");
      requests++;
      try {
        const r = await fetch(url, { ...options, cache: 'no-store',
          headers: {'user-agent': 'DoryDashboard/1.0', 'cache-control': 'no-store', ...options.headers},
          signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, deadline - Date.now()))) });
        if (!r.ok) {
          const payload = await r.json().catch(() => null);
          const detail = String(payload?.error?.message || '').replace(/https?:\/\/\S+/g, '[source URL]').slice(0, 200);
          const e = new Error(`${label}: HTTP ${r.status}${detail ? '; ' + detail : ''}`);
          const limit = detail.match(/ranges over (\d+) blocks|up to (?:a )?(\d+) block|0\s*-\s*(\d+) blocks/i);
          if (limit) e.maxBlockRange = Number(limit[1] || limit[2] || limit[3]);
          e.retryable = r.status === 429 || r.status >= 500;
          e.rangeRetryable = e.retryable;
          throw e;
        }
        return await r.json();
      } catch (e) {
        const transient = e.retryable || ["TypeError", "AbortError", "TimeoutError"].includes(e.name);
        e.rangeRetryable ||= transient;
        if (!transient || attempt === 2) throw e;
        await sleep(Math.min(4000, 500 * 2 ** attempt));
      }
    }
  }
  async function rpcAt(url, method, params = []) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try { response = await request(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, "Arbitrum RPC"); }
      catch (e) { if (method === 'eth_getLogs' && /HTTP (400|413)/.test(e.message)) e.rangeRetryable = true; throw e; }
      if (response.error) {
        const e = new Error(`${method}: ${response.error.message || "RPC error"}`);
        e.rangeRetryable = /range|too many|limit|response size|timeout|timed out/i.test(e.message);
        if (attempt < 2 && /rate limit|too many requests|temporar|timeout|timed out/i.test(e.message)) {
          await sleep(500 * 2 ** attempt); continue;
        }
        throw e;
      }
      if (response.result === null || response.result === undefined) throw new Error(`${method}: missing RPC result`);
      return response.result;
    }
  }
  const archiveEvidence = new Map(), verifiedChains = new Set();
  const rpcProviders = [...new Set([RPC, 'https://arbitrum.gateway.tenderly.co', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org', 'https://arbitrum-one.public.blastapi.io'])];
  let preferred = RPC;
  let logsPreferred = process.env.DORY_RPC_URL || process.env.ARBITRUM_RPC_URL ? RPC : 'https://arbitrum.gateway.tenderly.co';
  let logQueue = Promise.resolve();
  async function verifyChain(url) {
    if (!verifiedChains.has(url)) {
      if (BigInt(await rpcAt(url, 'eth_chainId', [])) !== 42161n) throw Error('RPC chain mismatch');
      verifiedChains.add(url);
    }
  }
  async function rpcUnqueued(method, params = []) {
    let last;
    const failures = [];
    for (const url of [...new Set(method === 'eth_getLogs' ? [logsPreferred, RPC, 'https://arbitrum.gateway.tenderly.co', 'https://arbitrum.drpc.org'] : [preferred, ...rpcProviders])]) {
      try { await verifyChain(url); const value = await rpcAt(url, method, params);
        if (method === 'eth_getLogs') logsPreferred = url; else preferred = url; return value; }
      catch (e) { last = e; failures.push((url === RPC ? 'configured RPC' : new URL(url).hostname) + ': ' + e.message); if (/budget exhausted/.test(e.message)) throw e;
        if (!/HTTP|timeout|fetch failed|temporar|rate limit|too many requests|missing trie|state .*not available|not supported|chain mismatch/i.test(e.message)) throw e;
      }
    }
    last.message = failures.join('; '); throw last;
  }
  async function rpc(method, params = []) {
    if (method !== 'eth_getLogs') return rpcUnqueued(method, params);
    const previous = logQueue;
    let release;
    logQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await rpcUnqueued(method, params); }
    finally { await sleep(250); release(); }
  }
  async function pinnedCall(contract, data, block) {
    const providers = [...new Set(contract === LENS ? ['https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum-one.public.blastapi.io', RPC] :
      [preferred, RPC, 'https://arbitrum-one.public.blastapi.io', 'https://arbitrum-one-rpc.publicnode.com'])];
    let last;
    for (const url of providers) {
      try {
        await verifyChain(url);
        const actual = await rpcAt(url, 'eth_getBlockByNumber', [block.number, false]);
        if (actual.hash?.toLowerCase() !== block.hash?.toLowerCase()) throw Error('Archive RPC block hash mismatch');
        const value = await rpcAt(url, 'eth_call', [{to: contract, data}, block.number]);
        if (!/^0x(?:[0-9a-f]{64})+$/i.test(value)) throw Error('Empty or malformed historical eth_call');
        const provider = url === RPC ? 'configured RPC' : new URL(url).hostname;
        archiveEvidence.set(provider + ':' + block.number, {provider, block: Number(BigInt(block.number)), hash: block.hash});
        return value;
      } catch (e) { last = e; if (/budget exhausted/.test(e.message)) throw e; }
    }
    throw last;
  }
  async function batchTransactions(hashes) {
    const output = [];
    for (let i = 0; i < hashes.length; i += 20) {
      const chunk = hashes.slice(i, i + 20);
      try {
        const responses = await request(RPC, {method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify(chunk.map((hash, id) => ({jsonrpc: '2.0', id, method: 'eth_getTransactionByHash', params: [hash]})))}, 'RPC transaction batch');
        if (!Array.isArray(responses) || responses.length !== chunk.length || new Set(responses.map(r => r.id)).size !== chunk.length)
          throw Error('Incomplete transaction batch');
        const verified = chunk.map((hash, id) => {
          const r = responses.find(r => r.id === id);
          if (r?.error || r?.result?.hash?.toLowerCase() !== hash.toLowerCase()) throw Error('Transaction batch identity mismatch');
          return r.result;
        });
        output.push(...verified);
      } catch (e) {
        if (/budget exhausted/.test(e.message)) throw e;
        output.push(...await mapLimit(chunk, 4, hash => rpc('eth_getTransactionByHash', [hash])));
      }
    }
    return output;
  }
  return { rpc, request, pinnedCall, batchTransactions,
    diagnostics: () => ({ requests, max_requests: maxRequests, rpc_provider: preferred === RPC ? 'configured RPC' : new URL(preferred).hostname,
      pinned_reads: [...archiveEvidence.values()] }) };
}
export async function getLogs(rpc, address, from, to, topics, options = {}) {
  const out = [], minimum = options.minStep || 128;
  let maximum = options.maxStep || 8000;
  let cursor = from, step = maximum;
  while (cursor <= to) {
    const end = Math.min(to, cursor + step - 1);
    try {
      const logs = await rpc("eth_getLogs", [{ address, fromBlock: hex(cursor), toBlock: hex(end), topics }]);
      if (!Array.isArray(logs)) throw new Error("eth_getLogs: result is not an array");
      out.push(...logs); cursor = end + 1; step = Math.min(maximum, step * 2);
    } catch (e) {
      if (!e.rangeRetryable || step <= minimum) throw e;
      if (Number.isSafeInteger(e.maxBlockRange) && e.maxBlockRange > 0) maximum = Math.min(maximum, e.maxBlockRange);
      step = Math.min(maximum, Math.max(minimum, Math.floor(step / 2)));
    }
  }
  return out;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0, error = null;
  async function worker() {
    while (!error && cursor < items.length) {
      const i = cursor++;
      try { out[i] = await fn(items[i]); } catch (e) { error = e; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (error) throw error;
  return out;
}
async function blockAt(rpc, target, latest) {
  const timestamp = async n => Number(BigInt((await rpc("eth_getBlockByNumber", [hex(n), false])).timestamp));
  let distance = 400000, lo = Math.max(0, latest - distance), hi = latest;
  while (lo > 0 && await timestamp(lo) > target) { distance *= 2; lo = Math.max(0, latest - distance); }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await timestamp(mid) < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function tokenAmount(log) {
  if (log.address?.toLowerCase() !== DORY || log.topics?.[0]?.toLowerCase() !== TRANSFER || log.topics?.length !== 3)
    throw new Error("Not a DORY ERC20 Transfer log");
  return Number(BigInt(log.data)) / 1e18;
}

export async function collect() {
  const client = makeClient(), { rpc, request, pinnedCall, batchTransactions } = client;
  const result = {
    schema_version: 2, generated_at: new Date().toISOString(), date_bj: null, status: "evidence_insufficient", blocks: null,
    market: { price_usd: null, price_usdc: null, change_24h_pct: null, change_7d_pct: null, volume_24h: null,
      liquidity_usd: null, buys: null, sells: null, buyers: null, sellers: null, buy_usdc: null, sell_usdc: null,
      sell_buy_amount_ratio: null },
    pool: { liquidity_usd: null, usdc_reserve: null, dory_reserve: null, swap_net_usdc: null, swap_net_dory: null },
    supply: { total_supply: null, change_24h: null, change_7d: null, minted_24h: null, minted_7d: null }, holders: { count: null, status: "unverified" },
    zero_burn: { total_dory: null, transactions: null, categories: {
      sell_swap: { dory: null, txs: null }, buy_swap: { dory: null, txs: null },
      direct_transfer: { dory: null, txs: null }, pending_burn: { dory: null, txs: null }, other: { dory: null, txs: null } } },
    x9c_dead_burn: { total_dory: null, transactions: null, total_7d: null, transactions_7d: null, absorption_24h_pct: null },
    distribution_705b: {address: RECEIVER_705B, balance_dory: null, day: null, week: null},
    pool_candidates: { candidate_pools: null, candidate_usdc: null, transactions: null, max_usdc: null,
      rule: "BUY near 5000 USDC integer multiples ±8%; candidate_pools counts amount-size units, not mining positions or users. Participation has no minimum amount; this filter is not total mining capital." },
    ohlcv: [], sources: {}, errors: [],
    notes: ["Zero Address DORY Transfer and X9C Mint→dEaD are separate metrics.",
      "Zero Address Transfer alone does not prove an equal reduction in totalSupply; no supply reconciliation is inferred.",
      "Pool reserves are fee-excluded core liquidity principal, not PoolManager balances or TVL/2.",
      "Holder count is an indexer snapshot, with retrieval time rather than an exact indexed block.",
      "7d totals scan the exact block window; rolling daily snapshots are never summed to synthesize seven days.",
      "7d price change compares the latest daily close with a close at least seven days earlier."]
  };
  async function component(name, fn) {
    try {
      const value = await fn(); result.sources[name] = { status: "ok", collected_at: new Date().toISOString() };
      if (process.env.DORY_PROGRESS === '1') console.error(JSON.stringify({component: name, status: 'ok', requests: client.diagnostics().requests}));
      return value;
    } catch (e) {
      const message = String(e.message).replace(/https?:\/\/\S+/g, "[source URL]").slice(0, 300);
      if (process.env.DORY_PROGRESS === '1') console.error(JSON.stringify({component:name,status:'failed',message,requests:client.diagnostics().requests}));
      result.sources[name] = { status: "failed", error: message }; result.errors.push({ source: name, message }); return null;
    }
  }
  const [poolResponse, window] = await Promise.all([
    component("market", async () => {
      const response = await request(`${GT}?include=base_token,quote_token`, {}, "GeckoTerminal");
      const identity = validatePool(response); result.sources.pool_identity = { status: "ok", ...identity };
      const a = response.data.attributes, tx = a.transactions?.h24 || {}, prefix = identity.dory_is_base ? "base" : "quote";
      result.market.price_usd = finiteNumber(a[`${prefix}_token_price_usd`]);
      result.market.price_usdc = finiteNumber(a[identity.dory_is_base ? "base_token_price_quote_token" : "quote_token_price_base_token"]);
      result.market.change_24h_pct = identity.dory_is_base ? finiteNumber(a.price_change_percentage?.h24) : null;
      result.market.volume_24h = finiteNumber(a.volume_usd?.h24);
      result.market.liquidity_usd = result.pool.liquidity_usd = finiteNumber(a.reserve_in_usd);
      for (const [key, reversed] of [['buys','sells'],['sells','buys'],['buyers','sellers'],['sellers','buyers']])
        result.market[key] = finiteNumber(tx[identity.dory_is_base ? key : reversed]);
      if (result.market.price_usd === null || result.market.volume_24h === null || result.market.liquidity_usd === null)
        throw new Error("GeckoTerminal market response is missing required numeric fields");
      return { response, identity };
    }),
    component("chain_window", async () => {
      if (BigInt(await rpc('eth_chainId', [])) !== 42161n) throw Error('RPC is not Arbitrum One');
      const latest = Number(BigInt(await rpc("eth_blockNumber")));
      const latestBlock = await rpc("eth_getBlockByNumber", [hex(latest), false]);
      const endTs = Number(BigInt(latestBlock.timestamp)), startTs = endTs - 86400;
      const start = await blockAt(rpc, startTs, latest);
      const start7 = await blockAt(rpc, endTs - 7 * 86400, latest);
      const [startBlock, baseline24, baseline7] = await Promise.all([rpc('eth_getBlockByNumber', [hex(start), false]),
        rpc('eth_getBlockByNumber', [hex(start - 1), false]), rpc('eth_getBlockByNumber', [hex(start7 - 1), false])]);
      const actualStartTs = Number(BigInt(startBlock.timestamp));
      result.blocks = { from: start, to: latest, from_ts: new Date(actualStartTs * 1000).toISOString(),
        to_ts: new Date(endTs * 1000).toISOString(), requested_from_ts: new Date(startTs * 1000).toISOString(),
        hash: latestBlock.hash, from_7d: start7, baseline_24h: start - 1, baseline_7d: start7 - 1,
        baseline_24h_ts: new Date(Number(BigInt(baseline24.timestamp)) * 1000).toISOString(),
        baseline_7d_ts: new Date(Number(BigInt(baseline7.timestamp)) * 1000).toISOString() };
      const decimals = Number(BigInt(await rpc("eth_call", [{ to: DORY, data: "0x313ce567" }, hex(latest)])));
      if (decimals !== 18) throw new Error("DORY decimals do not match the configured scale");
      return { start, start7, latest, latestBlock, baseline24, baseline7 };
    })
  ]);
  if (!result.sources.pool_identity) result.sources.pool_identity = { status: "unverified" };
  await component('holders', async () => {
    result.holders = indexedHolders(await request('https://arbitrum.blockscout.com/api/v2/tokens/' + DORY, {}, 'Blockscout token index'), new Date().toISOString());
  });
  let key = null;
  if (window && poolResponse) {
    key = await component('pool_key', async () => {
      const logs = await getLogs(rpc, PM, INIT_BLOCK, INIT_BLOCK, [INITIALIZE, POOL]);
      if (logs.length !== 1) throw Error('Pool Initialize event missing/ambiguous');
      const k = poolKey(logs[0]);
      if ((await rpc('web3_sha3', ['0x' + k.encoded])).toLowerCase() !== POOL) throw Error('PoolKey hash mismatch');
      result.pool.key = k; return k;
    });
    if (key) {
      const data = '0xf95138f2' + PM.slice(2).padStart(64, '0') + key.encoded;
      const read = async block => decodeReserves(await pinnedCall(LENS, data, block), key, block);
      await component('pool_reserves', async () => {
        if (await rpc('eth_getCode', [LENS, hex(window.latest)]) === '0x') throw Error('Reserve lens not deployed');
        const r = await read(window.latestBlock);
        // Custom-accounting pools require explicit approximation, never an absolute-reserve claim.
        result.pool.core_principal = r;
        if (!r.has_custom_accounting) Object.assign(result.pool, {dory_reserve: r.dory_reserve, usdc_reserve: r.usdc_reserve});
      });
      await component('pool_reserves_24h', async () => {
        if (!result.pool.core_principal || result.pool.core_principal.has_custom_accounting) throw Error('Exact current core reserves unavailable');
        const p = await read(window.baseline24);
        if (p.has_custom_accounting) throw Error('Historical hook custom accounting requires approximation');
        result.pool.usdc_change_24h = result.pool.usdc_reserve - p.usdc_reserve;
        result.pool.dory_change_24h = result.pool.dory_reserve - p.dory_reserve;
        result.pool.baseline_24h = p;
      });
    }
  }
  if (poolResponse) await component("ohlcv", async () => {
    const url = `${GT}/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=${DORY}`;
    const response = await request(url, {}, "GeckoTerminal OHLCV");
    const candles = response?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(candles)) throw new Error("OHLCV response is missing its candle list");
    const normalize = candles => candles.map(x => ({ t: finiteNumber(x[0]) === null ? null : Number(x[0]) * 1000,
      o: finiteNumber(x[1]), h: finiteNumber(x[2]), l: finiteNumber(x[3]), c: finiteNumber(x[4]), v: finiteNumber(x[5]) }))
      .filter(x => Object.values(x).every(v => v !== null) && x.t >= START_DATE && x.l >= 0 &&
        x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c) && x.v >= 0).sort((a, b) => a.t - b.t);
    const byTime = new Map();
    if (fs.existsSync(path.join(DATA, 'latest.json'))) {
      try {
        const cached = JSON.parse(fs.readFileSync(path.join(DATA, 'latest.json'), 'utf8'));
        if (cached.sources?.pool_identity?.status === 'ok' && cached.sources.pool_identity.currency0 === DORY && cached.sources.pool_identity.currency1 === USDC)
          for (const c of normalize((cached.ohlcv || []).map(c => [c.t / 1000, c.o, c.h, c.l, c.c, c.v]))) byTime.set(c.t, c);
      } catch { /* A broken optional cache never prevents collecting the current official series. */ }
    }
    const fresh = normalize(candles);
    if (!fresh.length) throw Error('Official pool returned no valid current DORY daily candles');
    for (const c of fresh) byTime.set(c.t, c);
    let boundary = '';
    for (let page = 0; page < 4; page++) {
      const earliest = Math.min(...byTime.keys());
      if (earliest <= START_DATE) break;
      try {
        const older = await request(url + '&before_timestamp=' + (Math.floor(earliest / 1000) - 1), {}, 'GeckoTerminal history');
        const list = older?.data?.attributes?.ohlcv_list;
        if (!Array.isArray(list)) throw Error('Historical candle list missing');
        const valid = normalize(list).filter(c => c.t < earliest);
        if (!valid.length) { boundary = '历史接口未返回更早的有效日K'; break; }
        for (const c of valid) byTime.set(c.t, c);
      } catch (e) { boundary = /HTTP 401|HTTP 403/.test(e.message) ? '更早历史需要数据商授权（HTTP 401/403）' : '更早历史请求失败，保留已取得日K'; break; }
    }
    result.ohlcv = [...byTime.values()].sort((a, b) => a.t - b.t);
    if (!result.ohlcv.length) throw new Error("Official pool returned no valid DORY daily candles");
    const last = result.ohlcv.at(-1), previous = result.ohlcv.filter(x => x.t <= last.t - 7 * 86400000).at(-1);
    result.market.change_7d_pct = previous?.c > 0 ? (last.c / previous.c - 1) * 100 : null;
    result.ohlcv_coverage = {requested_from: new Date(START_DATE).toISOString(), actual_from: new Date(result.ohlcv[0].t).toISOString(),
      actual_to: new Date(last.t).toISOString(), candles: result.ohlcv.length, complete: result.ohlcv[0].t <= START_DATE, reason: boundary || '已取得的真实范围'};
    result.sources.ohlcv_history = {status: result.ohlcv_coverage.complete ? 'ok' : 'partial', reason: result.ohlcv_coverage.reason};
  });
  else result.sources.ohlcv = { status: "unverified", reason: "Pool token relations were not verified" };
  let swapByTx = null;
  if (window && poolResponse) swapByTx = await component("swaps", async () => {
    const logs = await getLogs(rpc, PM, window.start, window.latest, [SWAP, POOL]);
    const byTx = new Map();
    let buy = 0, sell = 0, poolUsdc = 0, poolDory = 0;
    for (const log of logs) {
      const { dory, usdc } = decodeSwap(log, poolResponse.identity);
      const aggregate = byTx.get(log.transactionHash) || { dory: 0, usdc: 0, buy_usdc: 0, sell_usdc: 0 };
      aggregate.dory += dory; aggregate.usdc += usdc; byTx.set(log.transactionHash, aggregate);
      poolUsdc -= usdc; poolDory -= dory;
      if (dory > 0 && usdc < 0) {
        const paid = -usdc; buy += paid; aggregate.buy_usdc += paid;
      } else if (dory < 0 && usdc > 0) { sell += usdc; aggregate.sell_usdc += usdc; }
    }
    result.market.buy_usdc = buy; result.market.sell_usdc = sell; result.market.sell_buy_amount_ratio = buy > 0 ? sell / buy : null;
    result.pool.swap_net_usdc = poolUsdc; result.pool.swap_net_dory = poolDory;
    result.pool_candidates = aggregateCandidates(byTx);
    return byTx;
  });
  else result.sources.swaps = { status: "unverified", reason: "Verified pool identity and chain window are required" };
  let zeroLogs7 = null;
  if (window) await Promise.all([
    component("supply", async () => {
      const now = await pinnedCall(DORY, '0x18160ddd', window.latestBlock);
      result.supply.total_supply = Number(BigInt(now)) / 1e18;
      await Promise.all([
        component('supply_24h', async () => {
          const previous = await pinnedCall(DORY, '0x18160ddd', window.baseline24);
          result.supply.change_24h = Number(BigInt(now) - BigInt(previous)) / 1e18;
          result.supply.baseline_24h = Number(BigInt(previous)) / 1e18;
        }),
        component('supply_7d', async () => {
          const previous = await pinnedCall(DORY, '0x18160ddd', window.baseline7);
          result.supply.change_7d = Number(BigInt(now) - BigInt(previous)) / 1e18;
          result.supply.baseline_7d = Number(BigInt(previous)) / 1e18;
        })
      ]);
    }),
    component("zero_burn", async () => {
      const all = await getLogs(rpc, DORY, window.start7, window.latest, [TRANSFER, null, ZERO_TOPIC], {maxStep: 100000});
      result.zero_burn.total_7d = all.reduce((sum, log) => sum + tokenAmount(log), 0);
      zeroLogs7 = all;
      result.zero_burn.transactions_7d = new Set(all.map(l => l.transactionHash)).size;
      const logs = all.filter(l => Number(BigInt(l.blockNumber)) >= window.start);
      const byTx = new Map();
      for (const log of logs) byTx.set(log.transactionHash, (byTx.get(log.transactionHash) || 0) + tokenAmount(log));
      result.zero_burn.total_dory = [...byTx.values()].reduce((a, b) => a + b, 0);
      result.zero_burn.transactions = byTx.size;
      await component("zero_burn_categories", async () => {
        if (!swapByTx) throw new Error("Complete Swap data is required for buy/sell Burn classification");
        const categories = Object.fromEntries(["sell_swap", "buy_swap", "direct_transfer", "explicit_pending_call", "other"].map(k => [k, { dory: 0, txs: 0 }]));
        const needsTx = [...byTx.keys()].filter(hash => !swapByTx.has(hash));
        const txs = await batchTransactions(needsTx);
        const lookup = new Map(needsTx.map((hash, i) => [hash, txs[i]]));
        for (const [hash, amount] of byTx) {
          const swap = swapByTx.get(hash), tx = lookup.get(hash);
          let category = "other";
          if (swap?.dory < 0 && swap?.usdc > 0) category = "sell_swap";
          else if (swap?.dory > 0 && swap?.usdc < 0) category = "buy_swap";
          else if (isDirectZeroTransfer(tx)) category = "direct_transfer";
          else if (tx?.to?.toLowerCase() === DORY && /^0x62a124b70{24}[0-9a-f]{40}$/i.test(tx.input || '') &&
            logs.filter(l => l.transactionHash === hash).every(l => l.topics[1]?.toLowerCase() === '0x' + tx.input.slice(10).toLowerCase()))
            category = 'explicit_pending_call';
          categories[category].dory += amount; categories[category].txs++;
        }
        result.zero_burn.categories = { ...categories, pending_burn: { dory: null, txs: null } };
      });
    }),
    component("x9c_mint", async () => {
      const verified = await request('https://arbitrum.blockscout.com/api/v2/smart-contracts/' + X9, {}, 'X9 verified contract');
      const code = await rpc('eth_getCode', [X9, hex(window.latest)]);
      if (!verified.is_fully_verified || verified.deployed_bytecode?.toLowerCase() !== code.toLowerCase())
        throw Error('X9 runtime differs from verified source');
      // Original TicketMinted is required; ERC721 mint alone can also be a split.
      const logs = await getLogs(rpc, X9, window.start7, window.latest, [TICKET_MINTED], {maxStep: 100000});
      const hashes = [...new Set(logs.map(log => log.transactionHash))];
      const receipts = await mapLimit(hashes, 4, hash => rpc("eth_getTransactionReceipt", [hash]));
      let amount = 0n, total7 = 0n, transactions = 0;
      for (const receipt of receipts) {
        const value = x9ReceiptBurn(receipt); total7 += value;
        if (Number(BigInt(receipt.blockNumber)) >= window.start) { amount += value; transactions++; }
      }
      Object.assign(result.x9c_dead_burn, { total_dory: Number(amount) / 1e18, transactions, total_7d: Number(total7) / 1e18,
        transactions_7d: hashes.length, verification: 'original TicketMinted + matching ERC721 mint + exact payer→dEaD transfer; splits excluded' });
    }),
    component('mint_emissions', async () => {
      const logs = (await getLogs(rpc, DORY, window.start7, window.latest, [TRANSFER, ZERO_TOPIC], {maxStep: 8000}))
        .filter(l => l.topics?.[2]?.toLowerCase() !== ZERO_TOPIC);
      result.supply.minted_7d = logs.reduce((sum, l) => sum + tokenAmount(l), 0);
      result.supply.minted_24h = logs.filter(l => Number(BigInt(l.blockNumber)) >= window.start).reduce((sum, l) => sum + tokenAmount(l), 0);
    })
  ]);
  else for (const name of ["supply", "zero_burn", "zero_burn_categories", "x9c_mint"])
    result.sources[name] = { status: "unverified", reason: "Chain window or DORY decimals could not be verified" };
  if (window) await Promise.all([
    component('distribution_705b', async () => {
      if (!zeroLogs7 || result.sources.zero_burn?.status !== 'ok') throw Error('Complete Zero Transfer window required for distribution matching');
      const target = '0x' + RECEIVER_705B.slice(2).padStart(64, '0');
      const incoming = await getLogs(rpc, DORY, window.start7, window.latest, [TRANSFER, null, target], {maxStep: 100000});
      const week = distributionWatch(zeroLogs7, incoming, window.start7, window.latest);
      const inDay = logs => logs.filter(log => Number(BigInt(log.blockNumber)) >= window.start);
      const day = distributionWatch(inDay(zeroLogs7), inDay(incoming), window.start, window.latest);
      Object.assign(result.distribution_705b, {day, week, block: window.latest, block_hash: window.latestBlock.hash,
        semantics: 'DORY Transfer inflows; one Zero and one 705B leg in the same transaction from the same sender, 90/10 with integer rounding. Overlay only; not mining/NFT attribution or full Pending detection.'});
    }),
    component('distribution_705b_balance', async () => {
      const data = '0x70a08231' + RECEIVER_705B.slice(2).padStart(64, '0');
      result.distribution_705b.balance_dory = Number(BigInt(await pinnedCall(DORY, data, window.latestBlock))) / 1e18;
    })
  ]);
  if (result.supply.minted_24h > 0 && result.x9c_dead_burn.total_dory !== null)
    result.x9c_dead_burn.absorption_24h_pct = result.x9c_dead_burn.total_dory / result.supply.minted_24h * 100;
  await component('supply_event_reconciliation', async () => {
    for (const [windowName, mint, burn, change] of [['24h',result.supply.minted_24h,result.zero_burn.total_dory,result.supply.change_24h],
      ['7d',result.supply.minted_7d,result.zero_burn.total_7d,result.supply.change_7d]]) {
      if (![mint,burn,change].every(n => typeof n === 'number' && Number.isFinite(n))) throw Error('Supply and full Transfer windows are required for reconciliation');
      const discrepancy = mint - burn - change;
      result.supply['event_discrepancy_' + windowName] = discrepancy;
      if (Math.abs(discrepancy) > 0.000001) throw Error(windowName + ' totalSupply and Mint/Zero Transfer differ; semantics or data completeness require review');
    }
  });
  if (window) await component('chain_consistency', async () => {
    const after = await rpc('eth_getBlockByNumber', [hex(window.latest), false]);
    if (after.hash !== window.latestBlock.hash) {
      result.market.buy_usdc = result.market.sell_usdc = result.market.sell_buy_amount_ratio = null;
      result.pool = {liquidity_usd: result.pool.liquidity_usd}; result.supply = {}; result.zero_burn = {};
      result.x9c_dead_burn = {}; result.pool_candidates = {}; result.distribution_705b = {};
      throw Error('Chain snapshot reorganized during collection; onchain values discarded');
    }
  });
  const core = ["market", "pool_identity", "chain_window", "swaps", "supply", 'supply_24h', 'supply_7d', 'holders', 'pool_key',
    'pool_reserves', 'pool_reserves_24h', "zero_burn", "zero_burn_categories", "x9c_mint", 'mint_emissions', 'supply_event_reconciliation', 'chain_consistency', 'distribution_705b', 'distribution_705b_balance'];
  const complete = core.every(name => result.sources[name]?.status === "ok");
  const hasEvidence = ["market", "supply", "zero_burn", "x9c_mint"].some(name => result.sources[name]?.status === "ok");
  result.status = complete ? "ok" : hasEvidence ? "partial" : "evidence_insufficient";
  result.generated_at = new Date().toISOString(); result.date_bj = beijingDay(new Date(result.generated_at));
  result.monitoring = monitoring.build(result);
  result.notes.push('Business monitoring retains unverified values for eligibility, shared quota, active principal, NFT dividends and application usage. Rules version: ' + monitoring.rules.version);
  result.diagnostics = client.diagnostics(); return result;
}
function writeAtomic(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n"); fs.renameSync(temporary, filename);
}
export function saveResult(result, directory = DATA) {
  fs.mkdirSync(directory, { recursive: true });
  const historyPath = path.join(directory, "history.json");
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, "utf8")) : { schema_version: 1, snapshots: [] };
  if (!Array.isArray(history.snapshots)) throw new Error("History snapshots must be an array; history was preserved");
  const date = beijingDay(new Date(result.generated_at));
  const { ohlcv, ...daily } = result; // Keep the candle series once in latest.json, rather than duplicating it every day.
  history.snapshots = history.snapshots.filter(row => row.date !== date); history.snapshots.push({ date, ...daily });
  history.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  writeAtomic(historyPath, history); writeAtomic(path.join(directory, "latest.json"), result); return date;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await collect(), date = saveResult(result);
  console.log(JSON.stringify({ date, status: result.status, sources: result.sources, requests: result.diagnostics.requests }));
}
