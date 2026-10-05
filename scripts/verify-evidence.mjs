import test from 'node:test';
import assert from 'node:assert/strict';
import {DORY, USDC, PM, POOL, X9, INITIALIZE, INIT_BLOCK, TICKET_MINTED, poolKey, decodeReserves, indexedHolders, x9ReceiptBurn, aggregateCandidates} from './evidence.mjs';
const word = n => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const topic = n => '0x' + word(n), data = values => '0x' + values.map(word).join('');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hook = '0x6b70fef40d3925881251c018164dbcec6bc94040';
const init = () => ({address:PM,topics:[INITIALIZE,POOL,topic(DORY),topic(USDC)],
  data:data([10000,200,hook,100,-280000]),blockNumber:'0x'+INIT_BLOCK.toString(16),transactionHash:'0xinit'});
test('PoolKey comes from the exact initialization, including currency ordering and fee', () => {
  const k=poolKey(init());assert.equal(k.fee,10000);assert.equal(k.encoded.length,320);
  assert.throws(()=>poolKey({...init(),topics:[INITIALIZE,POOL,topic(USDC),topic(DORY)]}),/identity/);
  assert.throws(()=>poolKey({...init(),data:data([500,200,hook,100,-280000])}),/key/);
});
test('Arbitrum reserve lens validates L1 NUMBER and preserves its L2 block reference', () => {
  const k=poolKey(init()),b={number:'0x1e7d389d',hash:'0xabc',l1BlockNumber:'0x18e8548'};
  const result=data([2n*10n**18n,3000000,0,0,0,0,100,-280000,10,BigInt(b.l1BlockNumber),hook,64,0,1]);
  const r=decodeReserves(result,k,b);assert.equal(r.dory_reserve,2);assert.equal(r.usdc_reserve,3);assert.equal(r.block,Number(BigInt(b.number)));
  assert.equal(r.has_custom_accounting,false);
  assert.throws(()=>decodeReserves(result,k,{...b,l1BlockNumber:'0x1'}),/L1 snapshot/);
  assert.throws(()=>decodeReserves('0x',k,b),/Incomplete/);
});
test('Holder index validates token, decimals and nonnegative integer count', () => {
  const j={address_hash:DORY,decimals:'18',type:'ERC-20',holders_count:'38235'};
  assert.equal(indexedHolders(j,'2026-10-04T06:00:00Z').count,38235);
  assert.throws(()=>indexedHolders({...j,address_hash:USDC},''),/mismatch/);
  assert.throws(()=>indexedHolders({...j,holders_count:'-1'},''),/mismatch/);
});
function receipt() {
  const amount=2n*10n**18n,recipient=topic(1),payer=topic(2);
  return {status:'0x1',logs:[
    {address:X9,topics:[TICKET_MINTED,topic(7),recipient,payer],data:data([amount,100n*10n**18n,50n*10n**18n,0])},
    {address:X9,topics:[TRANSFER,topic(0),recipient,topic(7)],data:'0x'},
    {address:DORY,topics:[TRANSFER,payer,topic('0xdead')],data:data([amount])},
    {address:DORY,topics:[TRANSFER,topic(3),topic('0xdead')],data:data([999n*10n**18n])}
  ]};
}
test('Original X9 mint requires matching token, payer and exact amount; unrelated dEaD transfers are excluded', () => {
  assert.equal(x9ReceiptBurn(receipt()),2n*10n**18n);
  const wrong=receipt();wrong.logs[2].data=data([1]);assert.throws(()=>x9ReceiptBurn(wrong),/amount differs/);
  const wrongToken=receipt();wrongToken.logs[1].topics[3]=topic(8);assert.throws(()=>x9ReceiptBurn(wrongToken),/matching ERC721/);
});
test('ERC721 mints created by a split never count as original subscription burns', () => {
  const split=receipt();split.logs.shift();assert.throws(()=>x9ReceiptBurn(split),/splits are excluded/);
});
test('5000U amount-size units aggregate whole transactions and exclude simultaneous BUY/SELL', () => {
  const m=new Map([['split-buy',{buy_usdc:5000,sell_usdc:0}],['round-trip',{buy_usdc:10000,sell_usdc:9990}],['ordinary',{buy_usdc:6000,sell_usdc:0}]]);
  const r=aggregateCandidates(m);assert.equal(r.candidate_pools,1);assert.equal(r.transactions,1);assert.equal(r.same_tx_roundtrips_excluded,1);assert.equal(r.candidate_usdc,5000);assert.deepEqual(r.examples,[],'candidate identifiers are never published');
});
