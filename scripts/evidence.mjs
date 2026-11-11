export const DORY = '0x33b49f2264e85bb124d2730dc180182717d436ae';
export const RECEIVER_705B = '0x0135f06fbb34cad4a4c0a321efe964b38d2c705b';
export const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
export const POOL = '0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb';
export const PM = '0x360e68faccca8ca495c1b759fd9eee466db9fb32';
export const X9 = '0xecdda172d2e8aa8eff55500fd28da828cffbc5b0';
export const LENS = '0x0000001b173c3bbf3984d417d8614e3eed34865b';
export const INITIALIZE = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
export const TICKET_MINTED = '0x198510318e8a0a0f84388126ae30950196f55711a4151dfa18a50b0e415c06fa';
export const INIT_BLOCK = 377333322;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const addressTopic = address => '0x' + address.slice(2).padStart(64, '0');
const ZERO = '0x' + '0'.repeat(64), DEAD = '0x' + '0'.repeat(60) + 'dead';
// An observable transfer pattern, not a decoded Pending/mining/NFT function.
export function distributionMatches(zeroLogs, receiverLogs, firstBlock, lastBlock) {
  const receiver = addressTopic(RECEIVER_705B);
  const seen = new Map(), groups = new Map();
  let incoming = 0n;
  for (const [logs, target, kind] of [[zeroLogs, ZERO, 'zero'], [receiverLogs, receiver, 'receiver']]) {
    for (const log of logs) {
      if (log.removed || log.address?.toLowerCase() !== DORY || log.topics?.length !== 3 ||
          log.topics[0]?.toLowerCase() !== TRANSFER || log.topics[2]?.toLowerCase() !== target ||
          !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[1] || '') ||
          !/^0x[0-9a-f]{64}$/i.test(log.transactionHash || '') || !/^0x[0-9a-f]{64}$/i.test(log.blockHash || '') ||
          !/^0x[0-9a-f]+$/i.test(log.logIndex || '') || !/^0x[0-9a-f]+$/i.test(log.blockNumber || ''))
        throw Error('Incomplete distribution Transfer identity');
      const block = Number(BigInt(log.blockNumber)), amount = words(log.data, 1)[0];
      if (block < firstBlock || block > lastBlock) throw Error('Distribution log outside requested window');
      const id = log.transactionHash.toLowerCase() + ':' + BigInt(log.logIndex);
      const fingerprint = [log.blockHash.toLowerCase(), block, log.topics[1].toLowerCase(), target, amount].join(':');
      if (seen.has(id)) { if (seen.get(id) !== fingerprint) throw Error('Conflicting distribution log'); continue; }
      seen.set(id, fingerprint);
      if (kind === 'receiver') incoming += amount;
      if (amount === 0n || log.topics[1].toLowerCase() === ZERO) continue;
      const key = log.transactionHash.toLowerCase() + ':' + log.topics[1].toLowerCase();
      const group = groups.get(key) || {zero: [], receiver: [], blockHash: log.blockHash.toLowerCase()};
      if (group.blockHash !== log.blockHash.toLowerCase()) throw Error('Distribution transaction block mismatch');
      group[kind].push({amount, index: Number(BigInt(log.logIndex))});
      group.block = block; groups.set(key, group);
    }
  }
  const matches = [];
  for (const [key, group] of groups) {
    // Multiple transfers are ambiguous: do not force a match by summing unrelated legs.
    if (group.zero.length !== 1 || group.receiver.length !== 1) continue;
    const [zero] = group.zero, [receiverLeg] = group.receiver;
    const z = zero.amount, r = receiverLeg.amount, remainder = z - 9n * r;
    if (remainder < 0n || remainder > 9n) continue; // floor(total/10) in raw wei
    matches.push({id: key, hash: key.slice(0, 66), wallet: key.slice(67), block: group.block,
      index: Math.min(zero.index, receiverLeg.index), zero: z, receiver: r, amount: z + r});
  }
  return {incoming, matches};
}

export function distributionWatch(zeroLogs, receiverLogs, firstBlock, lastBlock) {
  const {incoming, matches} = distributionMatches(zeroLogs, receiverLogs, firstBlock, lastBlock);
  const zero = matches.reduce((sum, entry) => sum + entry.zero, 0n);
  const received = matches.reduce((sum, entry) => sum + entry.receiver, 0n);
  const pairs = matches.length;
  const transactions = new Set(matches.map(entry => entry.hash));
  const wallets = new Set(matches.map(entry => entry.wallet));
  const number = amount => Number(amount) / 1e18;
  return {incoming_dory: number(incoming), matched_pairs: pairs, matched_transactions: transactions.size,
    matched_wallets: wallets.size, matched_zero_dory: number(zero), matched_receiver_dory: number(received),
    matched_total_dory: number(zero + received), unmatched_incoming_dory: number(incoming - received)};
}
const poolTopic = addressTopic(PM);
const appDistribution = addressTopic('0xa51afafe0263b40edaef0df8781ea9aa03e381a3');
const appFee = addressTopic('0x5af3b5bca2b49478f75aa8d3f8320e326337f22f');
const protocolTopics = new Set([ZERO, DEAD, poolTopic, appDistribution, appFee, addressTopic(RECEIVER_705B)]);
const beforeTransfer = (a, b) => a.block < b.block || a.block === b.block && a.index < b.index;
const byWallet = (map, wallet, value) => {
  const entries = map.get(wallet) || [];
  entries.push(value);
  map.set(wallet, entries);
};

function tokenTransfer(log, token = DORY) {
  if (log.removed || log.address?.toLowerCase() !== token || log.topics?.length !== 3 ||
      log.topics[0]?.toLowerCase() !== TRANSFER ||
      !log.topics.slice(1).every(topic => /^0x0{24}[0-9a-f]{40}$/i.test(topic)) ||
      !/^0x[0-9a-f]{64}$/i.test(log.transactionHash || '') || !/^0x[0-9a-f]{64}$/i.test(log.blockHash || '') ||
      !/^0x[0-9a-f]+$/i.test(log.logIndex || '') || !/^0x[0-9a-f]+$/i.test(log.blockNumber || ''))
    throw Error('Invalid mining Transfer identity');
  return {index: Number(BigInt(log.logIndex)), block: Number(BigInt(log.blockNumber)),
    from: log.topics[1].toLowerCase(), wallet: log.topics[2].toLowerCase(), amount: words(log.data, 1)[0]};
}

export function miningBuyReceipt(hash, swap, receipt) {
  if (receipt.transactionHash?.toLowerCase() !== hash || receipt.blockHash?.toLowerCase() !== swap.block_hash ||
      receipt.status !== '0x1' || !Array.isArray(receipt.logs)) throw Error('Mining BUY receipt identity mismatch');
  const transfers = receipt.logs.filter(log => log.address?.toLowerCase() === DORY && log.topics?.[0]?.toLowerCase() === TRANSFER).map(log => tokenTransfer(log));
  const settlements = transfers.filter(entry => entry.from === poolTopic && entry.amount > 0n);
  if (settlements.length !== 1 || settlements[0].amount !== swap.buy_dory_raw) return null;
  let credit = settlements[0];
  while (credit.wallet !== ZERO && credit.wallet !== DEAD) {
    const outgoing = transfers.filter(entry => entry.from === credit.wallet && entry.amount > 0n && beforeTransfer(credit, entry));
    const forwarded = outgoing.filter(entry => !protocolTopics.has(entry.wallet) || entry.wallet === appDistribution);
    const fees = outgoing.filter(entry => entry.wallet === appFee);
    if (forwarded.length !== 1 || outgoing.length !== forwarded.length + fees.length ||
        forwarded[0].amount + fees.reduce((sum, entry) => sum + entry.amount, 0n) !== credit.amount) break;
    credit = forwarded[0];
  }
  if (protocolTopics.has(credit.wallet)) return null;
  return {...credit, poolAmount: swap.buy_dory_raw};
}

const routedTargets = {tier_5000: 2520, tier_10000: 5040};
const nearTarget = (value, target) => Math.abs(value - target) <= target * .08;

export function isRoutedMiningBuy(swap) {
  return swap.buy_dory_raw > 0n && swap.sell_dory_raw > 0n &&
    Object.values(routedTargets).some(target => nearTarget(swap.buy_usdc, 2 * target) && nearTarget(swap.sell_usdc, target));
}

export function routedMiningCredit(credit, swap, receipt) {
  if (!credit || credit.from !== appDistribution || credit.amount >= credit.poolAmount) return null;
  const transfers = token => receipt.logs.filter(log => log.address?.toLowerCase() === token &&
    log.topics?.[0]?.toLowerCase() === TRANSFER).map(log => tokenTransfer(log, token));
  const dory = transfers(DORY), cash = transfers(USDC);
  const sum = (entries, from, to, before) => entries.filter(entry => entry.from === from &&
    entry.wallet === to && beforeTransfer(entry, before)).reduce((total, entry) => total + entry.amount, 0n);
  const rebuy = cash.find(entry => entry.from === appDistribution && entry.wallet === poolTopic &&
    entry.amount === swap.buy_usdc_raw && beforeTransfer(entry, credit));
  if (!rebuy) return null;
  const soldDory = sum(dory, credit.wallet, poolTopic, rebuy);
  const sellProceeds = sum(cash, poolTopic, appDistribution, rebuy);
  const walletCash = sum(cash, credit.wallet, appDistribution, rebuy);
  const cashFee = sum(cash, appDistribution, appFee, rebuy);
  const tokenFee = sum(dory, appDistribution, appFee, credit);
  if (soldDory !== swap.sell_dory_raw || sellProceeds !== swap.sell_usdc_raw ||
      walletCash <= 0n || cashFee <= 0n || sellProceeds + walletCash - cashFee !== rebuy.amount ||
      tokenFee !== credit.poolAmount - credit.amount) return null;
  const cashUsdc = Number(walletCash) / 1e6;
  const doryUsdc = Number(sellProceeds - cashFee) / 1e6;
  const totalUsdc = Number(walletCash + sellProceeds - cashFee) / 1e6;
  const tier = Object.keys(routedTargets).find(key => nearTarget(totalUsdc, 2 * routedTargets[key]));
  return tier ? {...credit, tier, cashUsdc, doryUsdc} : null;
}

export function routedMiningWatch(credits, burns) {
  const byAddress = new Map();
  const wallets = new Set(credits.map(credit => credit.wallet));
  for (const burn of burns) if (wallets.has(burn.wallet)) byWallet(byAddress, burn.wallet, burn);
  const candidates = credits.map(credit => ({credit, burns: (byAddress.get(credit.wallet) || []).filter(burn =>
    beforeTransfer(credit, burn) && (burn.amount === credit.poolAmount || burn.amount === credit.amount))}));
  const usage = new Map();
  for (const candidate of candidates) for (const burn of candidate.burns)
    usage.set(burn.id, (usage.get(burn.id) || 0) + 1);
  const groups = {tier_5000: [], tier_10000: []};
  for (const {credit, burns: matches} of candidates) {
    if (matches.length !== 1 || usage.get(matches[0].id) !== 1) continue;
    groups[credit.tier].push(credit);
  }
  return Object.fromEntries(Object.entries(groups).map(([tier, entries]) => [tier, {
    matches: entries.length,
    wallets: new Set(entries.map(entry => entry.wallet)).size,
    cash_usdc: entries.reduce((total, entry) => total + entry.cashUsdc, 0),
    dory_proceeds_usdc: entries.reduce((total, entry) => total + entry.doryUsdc, 0),
  }]));
}

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
    same_tx_roundtrips_excluded: roundtrips, examples: [], // Public monitoring exposes totals, never individual candidate hashes.
    rule: 'Aggregate BUY per transaction; exclude same-transaction BUY+SELL; 5000 USDC multiples ±8%. candidate_pools counts amount-size units, not mining positions or users. Participation has no minimum amount; this filter is not total mining capital.'};
}

export const STATE_VIEW = '0x76fd297e2d437cd7f76d50f01afe6160f86e9990';
export const POSITION_MANAGER = '0xd88f38f930b7952f2db2432cb002e7abbf3dd869';
export const MODIFY_LIQUIDITY = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';
export function decodeSlot0(data) {
  const w=words(data,4);
  const tick=w[1] >= 1n<<255n?w[1]-(1n<<256n):w[1];
  if(w[0]<=0n||w[0]>=1n<<160n||tick < -887272n||tick>887272n||w[2]>=1n<<24n||w[3]>1000000n)throw Error('Invalid StateView slot0');
  return {sqrt_price_x96:w[0].toString(),tick:Number(tick),protocol_fee:Number(w[2]),lp_fee:Number(w[3]),
    price_usdc_per_dory:(Number(w[0])/2**96)**2*1e12};
}
export function liquidityActivity(logs,firstBlock,lastBlock){
  let adds=0,removes=0,zero=0,official=0;const seen=new Set(),txs=new Set();
  for(const l of logs){
    if(l.removed||l.address?.toLowerCase()!==PM||l.topics?.length!==3||l.topics[0]?.toLowerCase()!==MODIFY_LIQUIDITY||l.topics[1]?.toLowerCase()!==POOL||!/^0x0{24}[0-9a-f]{40}$/i.test(l.topics[2]||'')||!/^0x[0-9a-f]{64}$/i.test(l.transactionHash||'')||!/^0x[0-9a-f]+$/i.test(l.logIndex||'')||!/^0x[0-9a-f]+$/i.test(l.blockNumber||''))throw Error('Invalid ModifyLiquidity log');
    const block=Number(BigInt(l.blockNumber));if(block<firstBlock||block>lastBlock)throw Error('LP event outside requested window');
    const id=l.transactionHash.toLowerCase()+':'+BigInt(l.logIndex);if(seen.has(id))throw Error('Duplicate LP event');seen.add(id);txs.add(l.transactionHash.toLowerCase());
    const w=words(l.data,4),delta=w[2]>=1n<<255n?w[2]-(1n<<256n):w[2];
    if(delta>0n)adds++;else if(delta<0n)removes++;else zero++;
    if(l.topics[2].slice(-40).toLowerCase()===POSITION_MANAGER.slice(2))official++;
  }
  return {add_events:adds,remove_events:removes,zero_delta_events:zero,total_events:logs.length,transactions:txs.size,position_manager_events:official,
    single_withdrawal_pct:null,lp_owner:null,automation_status:'unverified',note:'Event sender is a routing contract, not proof of NFT ownership or automated operation; no withdrawal value percentage inferred from liquidityDelta.'};
}

export function virtualDepth(state,liquidityData){
 const L=words(liquidityData,1)[0];if(L>=1n<<128n)throw Error('Invalid active liquidity');
 const sqrt=Number(BigInt(state.sqrt_price_x96))/2**96;
 if(!Number.isFinite(sqrt)||sqrt<=0)throw Error('Invalid square root price for virtual reserves');
 const virtualUSDC=Number(L)*sqrt/1e6;
 return {active_liquidity:L.toString(),virtual_dory:Number(L)/sqrt/1e18,virtual_usdc:virtualUSDC,virtual_equivalent_tvl_usdc:2*virtualUSDC,
  virtual_semantics:'Local constant-active-L virtual reserves, not fee-excluded principal, withdrawable funds or treasury backing; crossing ticks requires a new liquidity curve.'};
}
