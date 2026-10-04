import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = path.join(path.resolve(process.cwd()), "data");
const RPC = process.env.DORY_RPC_URL || process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
const POOL = "0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb";
const GT = `https://api.geckoterminal.com/api/v2/networks/arbitrum/pools/${POOL}`;
const DORY = "0x33b49f2264e85bb124d2730dc180182717d436ae";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const PM = "0x360e68faccca8ca495c1b759fd9eee466db9fb32";
const X9 = "0xecdda172d2e8aa8eff55500fd28da828cffbc5b0";
const ZERO_TOPIC = "0x" + "0".repeat(64);
const DEAD_TOPIC = "0x" + "0".repeat(60) + "dead";
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
  const maxRequests = budgetValue("DORY_MAX_REQUESTS", 1200, 1, 10000);
  const timeout = budgetValue("DORY_REQUEST_TIMEOUT_MS", 12000, 100, 30000);
  let requests = 0;
  async function request(url, options = {}, label = "data source") {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() >= deadline || requests >= maxRequests) throw new Error("Collection request/time budget exhausted");
      requests++;
      try {
        const r = await fetch(url, { ...options,
          signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, deadline - Date.now()))) });
        if (!r.ok) {
          const e = new Error(`${label}: HTTP ${r.status}`);
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
  async function rpc(method, params = []) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, "Arbitrum RPC");
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
  return { rpc, request, diagnostics: () => ({ requests, max_requests: maxRequests }) };
}
export async function getLogs(rpc, address, from, to, topics, options = {}) {
  const out = [], maximum = options.maxStep || 8000, minimum = options.minStep || 128;
  let cursor = from, step = maximum;
  while (cursor <= to) {
    const end = Math.min(to, cursor + step - 1);
    try {
      const logs = await rpc("eth_getLogs", [{ address, fromBlock: hex(cursor), toBlock: hex(end), topics }]);
      if (!Array.isArray(logs)) throw new Error("eth_getLogs: result is not an array");
      out.push(...logs); cursor = end + 1; step = Math.min(maximum, step * 2);
    } catch (e) {
      if (!e.rangeRetryable || step <= minimum) throw e;
      step = Math.max(minimum, Math.floor(step / 2));
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
  const client = makeClient(), { rpc, request } = client;
  const result = {
    schema_version: 1, generated_at: new Date().toISOString(), date_bj: null, status: "evidence_insufficient", blocks: null,
    market: { price_usd: null, price_usdc: null, change_24h_pct: null, change_7d_pct: null, volume_24h: null,
      liquidity_usd: null, buys: null, sells: null, buyers: null, sellers: null, buy_usdc: null, sell_usdc: null,
      sell_buy_amount_ratio: null },
    pool: { liquidity_usd: null, usdc_reserve: null, dory_reserve: null, swap_net_usdc: null, swap_net_dory: null },
    supply: { total_supply: null, change_24h: null }, holders: { count: null, status: "unverified" },
    zero_burn: { total_dory: null, transactions: null, categories: {
      sell_swap: { dory: null, txs: null }, buy_swap: { dory: null, txs: null },
      direct_transfer: { dory: null, txs: null }, pending_burn: { dory: null, txs: null }, other: { dory: null, txs: null } } },
    x9c_dead_burn: { total_dory: null, transactions: null },
    pool_candidates: { candidate_pools: null, candidate_usdc: null, transactions: null, max_usdc: null,
      rule: "BUY near 5000 USDC integer multiples ±8%; raw candidates, not verified new users" },
    ohlcv: [], sources: {}, errors: [],
    notes: ["Zero Address DORY Transfer and X9C Mint→dEaD are separate metrics.",
      "Zero Address Transfer alone does not prove an equal reduction in totalSupply; no supply reconciliation is inferred.",
      "Swap net flow excludes LP changes and hook-specific transfers; absolute v4 reserves remain unverified.",
      "Holder count remains unverified.", "7d change compares the latest daily close with a close at least seven days earlier."]
  };
  async function component(name, fn) {
    try {
      const value = await fn(); result.sources[name] = { status: "ok", collected_at: new Date().toISOString() }; return value;
    } catch (e) {
      const message = String(e.message).replace(/https?:\/\/\S+/g, "[source URL]").slice(0, 300);
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
      for (const key of ["buys", "sells", "buyers", "sellers"]) result.market[key] = finiteNumber(tx[key]);
      if (result.market.price_usd === null || result.market.volume_24h === null || result.market.liquidity_usd === null)
        throw new Error("GeckoTerminal market response is missing required numeric fields");
      return { response, identity };
    }),
    component("chain_window", async () => {
      const latest = Number(BigInt(await rpc("eth_blockNumber")));
      const latestBlock = await rpc("eth_getBlockByNumber", [hex(latest), false]);
      const endTs = Number(BigInt(latestBlock.timestamp)), startTs = endTs - 86400;
      const start = await blockAt(rpc, startTs, latest);
      const actualStartTs = Number(BigInt((await rpc("eth_getBlockByNumber", [hex(start), false])).timestamp));
      result.blocks = { from: start, to: latest, from_ts: new Date(actualStartTs * 1000).toISOString(),
        to_ts: new Date(endTs * 1000).toISOString(), requested_from_ts: new Date(startTs * 1000).toISOString() };
      const decimals = Number(BigInt(await rpc("eth_call", [{ to: DORY, data: "0x313ce567" }, hex(latest)])));
      if (decimals !== 18) throw new Error("DORY decimals do not match the configured scale");
      return { start, latest };
    })
  ]);
  if (!result.sources.pool_identity) result.sources.pool_identity = { status: "unverified" };
  if (poolResponse) await component("ohlcv", async () => {
    const response = await request(`${GT}/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=${DORY}`, {}, "GeckoTerminal OHLCV");
    const candles = response?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(candles)) throw new Error("OHLCV response is missing its candle list");
    result.ohlcv = candles.map(x => ({ t: finiteNumber(x[0]) === null ? null : Number(x[0]) * 1000,
      o: finiteNumber(x[1]), h: finiteNumber(x[2]), l: finiteNumber(x[3]), c: finiteNumber(x[4]), v: finiteNumber(x[5]) }))
      .filter(x => Object.values(x).every(v => v !== null) && x.t >= START_DATE && x.l >= 0 &&
        x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c) && x.v >= 0).sort((a, b) => a.t - b.t);
    if (!result.ohlcv.length) throw new Error("Official pool returned no valid DORY daily candles");
    const last = result.ohlcv.at(-1), previous = result.ohlcv.filter(x => x.t <= last.t - 7 * 86400000).at(-1);
    result.market.change_7d_pct = previous?.c > 0 ? (last.c / previous.c - 1) * 100 : null;
  });
  else result.sources.ohlcv = { status: "unverified", reason: "Pool token relations were not verified" };
  let swapByTx = null;
  if (window && poolResponse) swapByTx = await component("swaps", async () => {
    const logs = await getLogs(rpc, PM, window.start, window.latest, [SWAP, POOL]);
    const byTx = new Map();
    let buy = 0, sell = 0, poolUsdc = 0, poolDory = 0, count = 0, capital = 0, candidates = 0, maximum = 0;
    for (const log of logs) {
      const { dory, usdc } = decodeSwap(log, poolResponse.identity);
      const aggregate = byTx.get(log.transactionHash) || { dory: 0, usdc: 0 };
      aggregate.dory += dory; aggregate.usdc += usdc; byTx.set(log.transactionHash, aggregate);
      poolUsdc -= usdc; poolDory -= dory;
      if (dory > 0 && usdc < 0) {
        const paid = -usdc; buy += paid; const n = Math.max(1, Math.round(paid / 5000));
        if (paid >= 4500 && Math.abs(paid - n * 5000) / (n * 5000) <= 0.08) {
          count += n; capital += paid; candidates++; maximum = Math.max(maximum, paid);
        }
      } else if (dory < 0 && usdc > 0) sell += usdc;
    }
    result.market.buy_usdc = buy; result.market.sell_usdc = sell; result.market.sell_buy_amount_ratio = buy > 0 ? sell / buy : null;
    result.pool.swap_net_usdc = poolUsdc; result.pool.swap_net_dory = poolDory;
    Object.assign(result.pool_candidates, { candidate_pools: count, candidate_usdc: capital, transactions: candidates, max_usdc: maximum });
    return byTx;
  });
  else result.sources.swaps = { status: "unverified", reason: "Verified pool identity and chain window are required" };
  if (window) await Promise.all([
    component("supply", async () => {
      const now = await rpc("eth_call", [{ to: DORY, data: "0x18160ddd" }, hex(window.latest)]);
      result.supply.total_supply = Number(BigInt(now)) / 1e18;
      const previous = await rpc("eth_call", [{ to: DORY, data: "0x18160ddd" }, hex(window.start)]);
      result.supply.change_24h = Number(BigInt(now) - BigInt(previous)) / 1e18;
    }),
    component("zero_burn", async () => {
      const logs = await getLogs(rpc, DORY, window.start, window.latest, [TRANSFER, null, ZERO_TOPIC]);
      const byTx = new Map();
      for (const log of logs) byTx.set(log.transactionHash, (byTx.get(log.transactionHash) || 0) + tokenAmount(log));
      result.zero_burn.total_dory = [...byTx.values()].reduce((a, b) => a + b, 0);
      result.zero_burn.transactions = byTx.size;
      await component("zero_burn_categories", async () => {
        if (!swapByTx) throw new Error("Complete Swap data is required for buy/sell Burn classification");
        const categories = Object.fromEntries(["sell_swap", "buy_swap", "direct_transfer", "other"].map(k => [k, { dory: 0, txs: 0 }]));
        const needsTx = [...byTx.keys()].filter(hash => !swapByTx.has(hash));
        const txs = await mapLimit(needsTx, 4, hash => rpc("eth_getTransactionByHash", [hash]));
        const lookup = new Map(needsTx.map((hash, i) => [hash, txs[i]]));
        for (const [hash, amount] of byTx) {
          const swap = swapByTx.get(hash), tx = lookup.get(hash);
          let category = "other";
          if (swap?.dory < 0 && swap?.usdc > 0) category = "sell_swap";
          else if (swap?.dory > 0 && swap?.usdc < 0) category = "buy_swap";
          else if (isDirectZeroTransfer(tx)) category = "direct_transfer";
          categories[category].dory += amount; categories[category].txs++;
        }
        result.zero_burn.categories = { ...categories, pending_burn: { dory: null, txs: null } };
      });
    }),
    component("x9c_mint", async () => {
      const logs = await getLogs(rpc, X9, window.start, window.latest, [TRANSFER, ZERO_TOPIC]);
      const hashes = [...new Set(logs.filter(isX9Mint).map(log => log.transactionHash))];
      const receipts = await mapLimit(hashes, 4, hash => rpc("eth_getTransactionReceipt", [hash]));
      let amount = 0, transactions = 0;
      for (const receipt of receipts) {
        if (receipt.status !== "0x1" || !Array.isArray(receipt.logs)) throw new Error("Incomplete or unsuccessful X9 Mint receipt");
        if (!receipt.logs.some(isX9Mint)) throw new Error("X9 Mint could not be reverified in its receipt");
        const burns = receipt.logs.filter(log => log.address?.toLowerCase() === DORY &&
          log.topics?.[0]?.toLowerCase() === TRANSFER && log.topics?.[2]?.toLowerCase() === DEAD_TOPIC);
        const value = burns.reduce((sum, log) => sum + tokenAmount(log), 0);
        if (value > 0) { amount += value; transactions++; }
      }
      result.x9c_dead_burn = { total_dory: amount, transactions };
    })
  ]);
  else for (const name of ["supply", "zero_burn", "zero_burn_categories", "x9c_mint"])
    result.sources[name] = { status: "unverified", reason: "Chain window or DORY decimals could not be verified" };
  const core = ["market", "pool_identity", "chain_window", "swaps", "supply", "zero_burn", "zero_burn_categories", "x9c_mint"];
  const complete = core.every(name => result.sources[name]?.status === "ok");
  const hasEvidence = ["market", "supply", "zero_burn", "x9c_mint"].some(name => result.sources[name]?.status === "ok");
  result.status = complete ? "ok" : hasEvidence ? "partial" : "evidence_insufficient";
  result.generated_at = new Date().toISOString(); result.date_bj = beijingDay(new Date(result.generated_at));
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
