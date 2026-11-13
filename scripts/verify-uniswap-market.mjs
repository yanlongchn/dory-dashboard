import test from 'node:test';
import assert from 'node:assert/strict';
import {POOL, DORY, USDC, validateUniswapPool, pricePoints, historyChange, collectUniswapMarket} from './uniswap-market.mjs';
const now = Date.parse('2026-11-13T00:00:00Z');
const pool = () => ({pool: {poolIdentifier: POOL, chainId: 42161, protocolVersion: 'V4', token0Address: DORY,
  token1Address: USDC, token0Metadata: {decimals: 18}, token1Metadata: {decimals: 6}, feeTier: 10000,
  token0PriceUsd: '100', token1PriceUsd: '0.999', tvlUsd: 100000, volumeUsd1d: 0}});
test('official quote validates the exact pool and preserves zero volume', () => {
  const result = validateUniswapPool(pool());
  assert.equal(result.market.price_usd, 100);
  assert.equal(result.market.volume_24h, 0);
  assert.equal(result.market.price_usdc, 100 / .999);
  for (const change of [{chainId:1},{protocolVersion:'V3'},{token0Address:USDC},{token0Metadata:{decimals:6}},
    {token0PriceUsd:null},{volumeUsd1d:null},{volumeUsd1d:-1}]) {
    assert.throws(() => validateUniswapPool({pool:{...pool().pool,...change}}));
  }
});
test('historical prices remain points, reject invalid values and use explicit change windows', () => {
  const point = (t,p) => ({timestamp:String(t/1000),priceToken0InToken1:p});
  const points = pricePoints({points:[point(now,100),point(now-86400000,80)]},now);
  assert.deepEqual(historyChange(points,86400000,600000), {value:25,
    from:'2026-11-12T00:00:00.000Z',to:'2026-11-13T00:00:00.000Z'});
  assert.equal(historyChange(points,7*86400000,3600000).value,null);
  for(const bad of [point(now,-1),point(now,null),point(now+600000,100)])
    assert.throws(()=>pricePoints({points:[bad]},now));
});
test('history failure retains the official quote and exposes the missing component', async () => {
  const result = await collectUniswapMarket(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.pool.addressOrId, POOL);
    assert.equal(body.pool.chainId, 42161);
    if(url.endsWith('/GetPool')) return pool();
    if(body.duration==='HISTORY_DURATION_DAY') throw Error('history timeout');
    return {points:[{timestamp:String(Math.floor(Date.now()/1000)-86400),priceToken0InToken1:90},
      {timestamp:String(Math.floor(Date.now()/1000)),priceToken0InToken1:100}]};
  });
  assert.equal(result.market.price_usd,100);
  assert.equal(result.market.change_24h_pct,null);
  assert.equal(result.sources.DAY.status,'failed');
  assert.equal(result.status,'partial');
  assert.equal(result.price_history.length,2);
});
