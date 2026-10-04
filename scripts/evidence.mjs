export const DORY = '0x33b49f2264e85bb124d2730dc180182717d436ae';
export const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
export const POOL = '0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb';
export const PM = '0x360e68faccca8ca495c1b759fd9eee466db9fb32';
export const X9 = '0xecdda172d2e8aa8eff55500fd28da828cffbc5b0';
export const LENS = '0x0000001b173c3bbf3984d417d8614e3eed34865b';
export const INITIALIZE = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
export const TICKET_MINTED = '0x198510318e8a0a0f84388126ae30950196f55711a4151dfa18a50b0e415c06fa';
export const INIT_BLOCK = 377333322;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x' + '0'.repeat(64), DEAD = '0x' + '0'.repeat(60) + 'dead';
export function words(data, count) {
  if (!new RegExp('^0x[0-9a-f]{' + count * 64 + '}$', 'i').test(data || '')) throw Error('Incomplete ABI response');
  return Array.from({length: count}, (_, i) => BigInt('0x' + data.slice(2 + i * 64, 66 + i * 64)));
}
export function poolKey(log) {
  const w = words(log?.data, 5);
  if (log.removed || log.address?.toLowerCase() !== PM || log.topics?.length !== 4 ||
      log.topics[0]?.toLowerCase() !== INITIALIZE || log.topics[1]?.toLowerCase() !== POOL ||
      log.topics[2]?.toLowerCase() !== '0x' + DORY.slice(2).padStart(64, '0') ||
      log.topics[3]?.toLowerCase() !== '0x' + USDC.slice(2).padStart(64, '0') ||
      Number(BigInt(log.blockNumber)) !== INIT_BLOCK) throw Error('Pool Initialize identity mismatch');
  if (w[0] !== 10000n || w[1] !== 200n || w[2] !== BigInt('0x6b70fef40d3925881251c018164dbcec6bc94040')) throw Error('Unexpected pool key');
  return {currency0: DORY, currency1: USDC, fee: Number(w[0]), tick_spacing: Number(w[1]),
    hooks: '0x' + w[2].toString(16).padStart(40, '0'), encoded: log.topics[2].slice(2) + log.topics[3].slice(2) + log.data.slice(2, 194),
    initialize_tx: log.transactionHash, block: INIT_BLOCK};
}
export function decodeReserves(data, key, block) {
  const w = words(data, 14), permissions = Number(BigInt(key.hooks) & 0x3fffn);
  if (w[11] !== BigInt(permissions) || w[12] > 1n || (w[12] === 1n) !== !!(permissions & 15) || w[13] > 7n)
    throw Error('Reserve lens hook flags mismatch');
  // Arbitrum EVM NUMBER is the L1 block, unlike eth_getBlockByNumber's L2 number.
  if (block.l1BlockNumber && w[9] !== BigInt(block.l1BlockNumber)) throw Error('Reserve lens L1 snapshot mismatch');
  if (w[6] <= 0n || w[6] >= 2n ** 160n || w[8] >= 2n ** 128n) throw Error('Invalid pool state');
  return {dory_reserve: Number(w[0]) / 1e18, usdc_reserve: Number(w[1]) / 1e6,
    has_custom_accounting: w[12] === 1n, hook_stats_status: Number(w[13]),
    semantics: 'fee-excluded core liquidity principal; excludes fees, donations and hook-held assets',
    block: Number(BigInt(block.number)), block_hash: block.hash, lens_l1_block: Number(w[9]), lens: LENS};
}
export function indexedHolders(j, collectedAt) {
  if (j?.address_hash?.toLowerCase() !== DORY || j.type !== 'ERC-20' || j.decimals !== '18' ||
      !/^\d+$/.test(j.holders_count) || !Number.isSafeInteger(Number(j.holders_count))) throw Error('Holder index token identity/count mismatch');
  return {count: Number(j.holders_count), status: 'indexed', as_of: collectedAt,
    source: 'https://arbitrum.blockscout.com/api/v2/tokens/' + DORY,
    timing: 'retrieval time; indexer does not expose an exact indexed block or update timestamp'};
}
export function x9ReceiptBurn(receipt) {
  if (receipt?.status !== '0x1' || !Array.isArray(receipt.logs)) throw Error('Unsuccessful/incomplete X9 receipt');
  const events = receipt.logs.filter(l => l.address?.toLowerCase() === X9 && l.topics?.[0]?.toLowerCase() === TICKET_MINTED);
  if (!events.length) throw Error('Receipt has no original TicketMinted; splits are excluded');
  const expected = new Map(), ids = new Set();
  for (const e of events) {
    const w = words(e.data, 4);
    if (e.topics.length !== 4 || w[0] <= 0n || w[3] > 2n || ids.has(e.topics[1])) throw Error('Invalid/duplicate TicketMinted');
    ids.add(e.topics[1]);
    if (!receipt.logs.some(l => l.address?.toLowerCase() === X9 && l.topics?.length === 4 &&
      l.topics[0]?.toLowerCase() === TRANSFER && l.topics[1]?.toLowerCase() === ZERO &&
      l.topics[2]?.toLowerCase() === e.topics[2]?.toLowerCase() && l.topics[3]?.toLowerCase() === e.topics[1]?.toLowerCase()))
      throw Error('TicketMinted has no matching ERC721 mint');
    const payer = e.topics[3].toLowerCase(); expected.set(payer, (expected.get(payer) || 0n) + w[0]);
  }
  let total = 0n;
  for (const [payer, amount] of expected) {
    const received = receipt.logs.filter(l => l.address?.toLowerCase() === DORY && l.topics?.length === 3 &&
      l.topics[0]?.toLowerCase() === TRANSFER && l.topics[1]?.toLowerCase() === payer && l.topics[2]?.toLowerCase() === DEAD)
      .reduce((a, l) => a + words(l.data, 1)[0], 0n);
    if (received !== amount) throw Error('X9 payer→dEaD amount differs from original mint');
    total += amount;
  }
  return total;
}
export function aggregateCandidates(swaps) {
  let pools = 0, capital = 0, max = 0, roundtrips = 0;
  const evidence = [];
  for (const [hash, tx] of swaps) {
    if (tx.buy_usdc > 0 && tx.sell_usdc > 0) { roundtrips++; continue; }
    const paid = tx.buy_usdc, n = Math.max(1, Math.round(paid / 5000));
    if (paid >= 4500 && Math.abs(paid - n * 5000) / (n * 5000) <= .08) {
      pools += n; capital += paid; max = Math.max(max, paid); evidence.push({hash, usdc: paid, units: n});
    }
  }
  return {candidate_pools: pools, candidate_usdc: capital, transactions: evidence.length, max_usdc: max,
    same_tx_roundtrips_excluded: roundtrips, examples: evidence.slice(0, 5),
    rule: 'Aggregate BUY per transaction; exclude same-transaction BUY+SELL; 5000 USDC multiples ±8%. Not verified new users.'};
}
