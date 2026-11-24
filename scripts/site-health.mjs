import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const SITE_URL = 'https://yanlongchn.github.io/dory-dashboard/';
const POOL = '0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb';
const ageMinutes = (time, now) => (now - Date.parse(time)) / 60000;

export async function checkSite({expected = null, now = Date.now(), fetcher = fetch} = {}) {
  async function read(file, json = true) {
    const url = new URL(file, SITE_URL);
    url.searchParams.set('health', String(now));
    const response = await fetcher(url, {cache: 'no-store', signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw Error(file + ' HTTP ' + response.status);
    return json ? response.json() : response.text();
  }
  const [manifest, market, daily, html, script] = await Promise.all([
    read('deployment.json'), read('data/market.json'), read('data/latest.json'), read('', false), read('dashboard.js', false),
  ]);
  if (!/^\d+$/.test(String(manifest.run_id)) || !/^[a-f0-9]{40}$/.test(manifest.commit || ''))
    throw Error('Online deployment manifest is invalid');
  if (!html.includes('DORY') || !html.includes('dashboard.js') || !script.includes('DATA_MARKET'))
    throw Error('Online page or dashboard script is incomplete');
  if (market.provider !== 'Uniswap' || market.pool_id !== POOL || market.chain_id !== 42161 ||
      typeof market.market?.price_usd !== 'number' || !(market.market.price_usd > 0))
    throw Error('Online Uniswap pool quote is invalid');
  if (!['ok', 'partial'].includes(daily.status)) throw Error('Online daily snapshot has no usable evidence');
  for (const [name, time, maxAge] of [['market', market.generated_at, 90], ['daily', daily.generated_at, 36 * 60]]) {
    const age = ageMinutes(time, now);
    if (!Number.isFinite(age) || age < -5 || age > maxAge) throw Error(name + ' snapshot is stale or has an invalid timestamp');
  }
  if (manifest.market_generated_at !== market.generated_at || manifest.daily_generated_at !== daily.generated_at)
    throw Error('Online deployment and data timestamps do not match');
  if (expected && (manifest.run_id !== expected.run_id || manifest.run_attempt !== expected.run_attempt ||
      manifest.commit !== expected.commit)) throw Error('Online version has not reached the expected deployment');
  return {run_id: manifest.run_id, run_attempt: manifest.run_attempt, commit: manifest.commit,
    market_generated_at: market.generated_at, daily_generated_at: daily.generated_at,
    market_age_minutes: Math.round(ageMinutes(market.generated_at, now)),
    daily_age_minutes: Math.round(ageMinutes(daily.generated_at, now))};
}

export async function verifyPublishedSite(expected, {attempts = 12, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), ...options} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await checkSite({expected, ...options}); }
    catch (error) { lastError = error; }
    if (attempt < attempts) await wait(10000);
  }
  throw lastError;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const expected = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : null;
  console.log(JSON.stringify(await verifyPublishedSite(expected)));
}
