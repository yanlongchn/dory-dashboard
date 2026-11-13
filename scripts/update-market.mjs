import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectUniswapMarket} from './uniswap-market.mjs';

export async function updateMarket(directory = path.resolve('data')) {
  const file = path.join(directory, 'market.json');
  const result = await collectUniswapMarket();
  // Retain the last complete curve when a history request fails and record its original time.
  if (!result.price_history.length && fs.existsSync(file)) {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (previous.provider === result.provider && previous.pool_id === result.pool_id && previous.price_history?.length) {
      result.price_history = previous.price_history;
      result.history_generated_at = previous.history_generated_at || previous.generated_at;
    }
  }
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(file + '.tmp', JSON.stringify(result, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
  console.log(JSON.stringify({provider: result.provider, status: result.status,
    generated_at: result.generated_at, price: result.market.price_usd, points: result.price_history.length}));
  return result;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await updateMarket();
