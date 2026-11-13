export const POOL = '0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb';
export const DORY = '0x33b49f2264e85bb124d2730dc180182717d436ae';
export const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
export const PAGE = 'https://app.uniswap.org/explore/pools/arbitrum/' + POOL + '?chart=price';
export const SERVICE = 'https://liquidity.backend-prod.api.uniswap.org/uniswap.liquidity.v2.LiquidityService/';
const reference = {chainId: 42161, addressOrId: POOL, version: 'POOL_PROTOCOL_V4'};

export function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validateUniswapPool(response) {
  const pool = response?.pool;
  if (pool?.poolIdentifier?.toLowerCase() !== POOL || pool.chainId !== 42161 || pool.protocolVersion !== 'V4' ||
      pool.token0Address?.toLowerCase() !== DORY || pool.token1Address?.toLowerCase() !== USDC ||
      pool.token0Metadata?.decimals !== 18 || pool.token1Metadata?.decimals !== 6 || pool.feeTier !== 10000)
    throw Error('Uniswap returned a different pool, chain, token order, decimals or fee tier');
  const price = numeric(pool.token0PriceUsd), quote = numeric(pool.token1PriceUsd);
  const liquidity = numeric(pool.tvlUsd), volume = numeric(pool.volumeUsd1d);
  if (!(price > 0) || !(quote > 0) || liquidity === null || liquidity < 0 || volume === null || volume < 0)
    throw Error('Uniswap pool price, liquidity or volume is missing');
  return {pool, market: {price_usd: price, price_usdc: price / quote, liquidity_usd: liquidity,
    volume_24h: volume, change_24h_pct: null, change_7d_pct: null},
    identity: {currency0: DORY, currency1: USDC, evidence: 'Uniswap GetPool pool identity and token metadata'}};
}

export function pricePoints(response, now = Date.now()) {
  if (!Array.isArray(response?.points) || !response.points.length) throw Error('Uniswap price history is empty');
  const seen = new Map();
  for (const point of response.points) {
    const timestamp = numeric(point.timestamp), price = numeric(point.priceToken0InToken1);
    const t = timestamp === null ? null : timestamp * 1000;
    if (!Number.isSafeInteger(t) || t < Date.parse('2025-09-09T00:00:00Z') || t > now + 300000 || !(price > 0))
      throw Error('Uniswap price history has an invalid timestamp or price');
    if (seen.has(t) && seen.get(t) !== price) throw Error('Uniswap price history has conflicting points');
    seen.set(t, price);
  }
  return [...seen].map(([t, p]) => ({t, p})).sort((a, b) => a.t - b.t);
}

export function historyChange(points, periodMs, spacingMs) {
  const latest = points.at(-1), target = latest.t - periodMs;
  const baseline = points.reduce((best, point) => Math.abs(point.t - target) < Math.abs(best.t - target) ? point : best);
  return Math.abs(baseline.t - target) <= spacingMs ? {
    value: (latest.p / baseline.p - 1) * 100,
    from: new Date(baseline.t).toISOString(), to: new Date(latest.t).toISOString(),
  } : {value: null, from: null, to: new Date(latest.t).toISOString()};
}

async function requestJson(url, options) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw Error('Uniswap HTTP ' + response.status);
  return response.json();
}

export async function collectUniswapMarket(request = requestJson) {
  const result = {schema_version: 1, generated_at: null, chain_id: 42161, pool_id: POOL,
    provider: 'Uniswap', source_url: PAGE, status: 'partial', market: null, price_history: [], sources: {}, errors: []};
  const get = (method, duration) => request(SERVICE + method, {
    method: 'POST', headers: {'content-type': 'application/json', 'connect-protocol-version': '1'},
    body: JSON.stringify({pool: reference, ...(duration ? {duration: 'HISTORY_DURATION_' + duration} : {})}),
  }, 'Uniswap ' + method);
  const {market, identity} = validateUniswapPool(await get('GetPool'));
  result.market = market;
  result.identity = identity;
  result.sources.pool = {status: 'ok'};
  await Promise.all(['DAY', 'WEEK', 'MAX'].map(async duration => {
    try {
      const points = pricePoints(await get('GetPoolHistoryPrice', duration));
      result.sources[duration] = {status: 'ok', from: new Date(points[0].t).toISOString(),
        to: new Date(points.at(-1).t).toISOString(), points: points.length};
      if (duration === 'MAX') result.price_history = points;
      else {
        const day = duration === 'DAY';
        const change = historyChange(points, (day ? 1 : 7) * 86400000, (day ? 10 : 60) * 60000);
        result.market[day ? 'change_24h_pct' : 'change_7d_pct'] = change.value;
        result.sources[duration].change_window = {from: change.from, to: change.to};
      }
    } catch (error) {
      result.sources[duration] = {status: 'failed', error: String(error.message).slice(0, 200)};
      result.errors.push({source: duration, message: String(error.message).slice(0, 200)});
    }
  }));
  result.generated_at = new Date().toISOString();
  result.status = result.errors.length ? 'partial' : 'ok';
  return result;
}
