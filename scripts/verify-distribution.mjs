import test from 'node:test';
import assert from 'node:assert/strict';
import {DORY, USDC, PM, RECEIVER_705B, distributionWatch, distributionMatches, isMiningBuy, miningBuyReceipt, miningFundingWatch, isRoutedMiningBuy, routedMiningCredit, routedMiningWatch} from './evidence.mjs';
const topic = address => '0x' + address.slice(2).padStart(64, '0');
const zero = '0x' + '0'.repeat(40), payer = '0x' + 'a'.repeat(40), other = '0x' + 'b'.repeat(40);
const hash = '0x' + 'c'.repeat(64), unit = 10n ** 18n;
function log(to, amount, index, from = payer) {
  return {address:DORY,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',topic(from),topic(to)],
    data:'0x'+amount.toString(16).padStart(64,'0'),transactionHash:hash,blockNumber:'0x64',blockHash:'0x'+'d'.repeat(64),logIndex:'0x'+index.toString(16)};
}
const run = (zs, rs) => distributionWatch(zs, rs, 100, 101);
test('same transaction and sender match in integer precision and publish only aggregates',()=>{
  const value=run([log(zero,90n*unit,1)],[log(RECEIVER_705B,10n*unit,2)]);
  assert.equal(value.matched_pairs,1);assert.equal(value.matched_wallets,1);assert.equal(value.matched_transactions,1);
  assert.equal(value.matched_zero_dory,90);assert.equal(value.matched_receiver_dory,10);assert.equal(value.matched_total_dory,100);
  assert.equal(value.unmatched_incoming_dory,0);assert.ok(!JSON.stringify(value).includes(payer));
});
test('floor rounding supports all residual wei; a larger discrepancy remains unmatched',()=>{
  for (const residual of [0n,1n,9n]) assert.equal(run([log(zero,90n*unit+residual,1)],[log(RECEIVER_705B,10n*unit,2)]).matched_pairs,1);
  assert.equal(run([log(zero,90n*unit+10n,1)],[log(RECEIVER_705B,10n*unit,2)]).matched_pairs,0);
  assert.equal(run([log(zero,89n*unit,1)],[log(RECEIVER_705B,10n*unit,2)]).matched_pairs,0);
});
test('different transactions, different senders, Mint and ambiguous extra legs are not forced into matches',()=>{
  const z=log(zero,90n*unit,1),r=log(RECEIVER_705B,10n*unit,2);
  assert.equal(run([z],[{...r,transactionHash:'0x'+'e'.repeat(64)}]).matched_pairs,0);
  assert.equal(run([z],[log(RECEIVER_705B,10n*unit,2,other)]).matched_pairs,0);
  const mint=run([log(zero,90n*unit,1,zero)],[log(RECEIVER_705B,10n*unit,2,zero)]);
  assert.equal(mint.matched_pairs,0);assert.equal(mint.incoming_dory,10);
  assert.equal(run([z,log(zero,1n,3)],[r]).matched_pairs,0);
});
test('duplicate logs are counted once; conflicting, malformed, removed or outside-window evidence fails closed',()=>{
  const z=log(zero,90n*unit,1),r=log(RECEIVER_705B,10n*unit,2);
  assert.equal(run([z,z],[r,r]).incoming_dory,10);
  for(const broken of [{...r,data:'0x01'},{...r,removed:true},{...r,blockNumber:'0x63'},{...r,blockHash:undefined},{...r,address:other}])assert.throws(()=>run([z],[broken]));
  assert.throws(()=>run([z],[r,{...r,data:log(RECEIVER_705B,11n*unit,2).data}]));
});
test('real empty windows are zero, and unmatched inflows remain separate from matched Zero totals',()=>{
  assert.equal(run([],[]).incoming_dory,0);assert.equal(run([],[]).matched_pairs,0);
  const value=run([log(zero,90n*unit,1)],[log(RECEIVER_705B,10n*unit,2),log(RECEIVER_705B,3n*unit,3,other)]);
  assert.equal(value.incoming_dory,13);assert.equal(value.unmatched_incoming_dory,3);assert.equal(value.matched_zero_dory,90);
});


test('mining funding requires both credits and the same wallet’s exact 90/10 spending', () => {
  const a='0x'+'ab'.repeat(20), b='0x'+'cd'.repeat(20);
  const poolTx='0x'+'12'.repeat(32), depositTx='0x'+'23'.repeat(32), burnTx='0x'+'34'.repeat(32), extraTx='0x'+'45'.repeat(32);
  const blockHash='0x'+'56'.repeat(32), unit=10n**18n;
  const topic=address=>'0x'+address.slice(2).padStart(64,'0');
  const transfer=(tx,index,from,to,amount)=>({address:DORY,transactionHash:tx,blockHash,blockNumber:'0x64',
    logIndex:'0x'+index.toString(16),topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',topic(from),topic(to)],
    data:'0x'+amount.toString(16).padStart(64,'0')});
  const swap={buy_usdc:5020,sell_usdc:0,buy_dory_raw:100n*unit,block_hash:blockHash};
  const receipt={transactionHash:poolTx,blockHash,status:'0x1',logs:[transfer(poolTx,2,PM,a,100n*unit)]};
  const deposit=transfer(depositTx,1,b,a,100n*unit);
  const zero='0x'+'0'.repeat(40);
  const combined=distributionMatches([transfer(burnTx,3,a,zero,180n*unit)],
    [transfer(burnTx,4,a,RECEIVER_705B,20n*unit)],100,100).matches;
  const separate=distributionMatches([transfer(burnTx,3,a,zero,90n*unit),transfer(extraTx,5,a,zero,90n*unit)],
    [transfer(burnTx,4,a,RECEIVER_705B,10n*unit),transfer(extraTx,6,a,RECEIVER_705B,10n*unit)],100,100).matches;
  const find=(buySwap,incoming,burns)=>miningFundingWatch([miningBuyReceipt(poolTx,buySwap,receipt)],incoming,burns,new Map([[poolTx,buySwap]]));
  assert.equal(isMiningBuy(swap),true);
  assert.equal(isMiningBuy({...swap,buy_usdc:10000}),false);
  assert.equal(isMiningBuy({...swap,sell_usdc:50}),false);
  assert.deepEqual(find(swap,[deposit],combined).tier_5000,{matches:1,wallets:1,buy_usdc:5020,transfer_usdc_estimate:5020});
  assert.equal(find({...swap,buy_usdc:5040},[deposit],combined).tier_10000.matches,1);
  assert.equal(find({...swap,buy_usdc:5030},[deposit],combined).unclassified.matches,1);
  assert.equal(find(swap,[deposit],separate).tier_5000.matches,1);
  assert.equal(find(swap,[],combined).tier_5000.matches,0,'buy and burn alone omit the transfer leg');
  assert.equal(find(swap,[deposit],[]).tier_5000.matches,0,'both credits need subsequent 90/10 spending');
  assert.equal(find(swap,[deposit,transfer(extraTx,1,b,a,100n*unit)],combined).tier_5000.matches,0,'ambiguous competing credits are not reused');
  assert.equal(find(swap,[transfer(depositTx,5,b,a,100n*unit)],combined).tier_5000.matches,0,'a later deposit cannot fund an earlier burn');
  assert.equal(find(swap,[transfer(poolTx,1,b,a,100n*unit)],combined).tier_5000.matches,1,'separately sourced credit may share the buy transaction');
  const crossAmount=101n*unit;
  const crossBurn=distributionMatches([transfer(burnTx,3,a,zero,1809n*unit/10n)],
    [transfer(burnTx,4,a,RECEIVER_705B,201n*unit/10n)],100,100).matches;
  assert.equal(find(swap,[transfer(depositTx,1,b,a,crossAmount)],crossBurn).unclassified.matches,1);
});

test('X9 route reconciles both funding legs and matches the gross buyback to a later burn', () => {
  const app='0xa51afafe0263b40edaef0df8781ea9aa03e381a3';
  const fee='0x5af3b5bca2b49478f75aa8d3f8320e326337f22f';
  const gross=12n*unit, doryFee=42n*unit/1000n, million=1000000n;
  const cash=(from,to,amount,index)=>({...log(to,amount,index,from),address:USDC});
  const swap={buy_usdc:5010,sell_usdc:2499,buy_usdc_raw:5010n*million,sell_usdc_raw:2499n*million,
    buy_dory_raw:gross,sell_dory_raw:6n*unit,block_hash:'0x'+'d'.repeat(64)};
  const receipt={transactionHash:hash,blockHash:swap.block_hash,status:'0x1',logs:[
    log(PM,6n*unit,0,payer),cash(PM,app,2499n*million,1),cash(app,fee,9n*million,2),
    cash(payer,app,2520n*million,3),cash(app,PM,5010n*million,4),
    log(app,gross,5,PM),log(fee,doryFee,6,app),log(payer,gross-doryFee,7,app)
  ]};
  const route=routedMiningCredit(miningBuyReceipt(hash,swap,receipt),swap,receipt);
  assert.equal(isMiningBuy(swap),false);
  assert.equal(isRoutedMiningBuy(swap),true);
  assert.equal(route.tier,'tier_5000');
  assert.equal(route.cashUsdc,2520);
  assert.equal(route.doryUsdc,2490);
  const burnHash='0x'+'e'.repeat(64);
  const burnLogs=distributionMatches([{...log(zero,108n*unit/10n,9),transactionHash:burnHash}],
    [{...log(RECEIVER_705B,12n*unit/10n,10),transactionHash:burnHash}],100,100).matches;
  assert.equal(routedMiningWatch([route],burnLogs).totals.tier_5000.matches,1);
  assert.equal(routedMiningWatch([route],[]).totals.tier_5000.matches,0);
  assert.equal(routedMiningWatch([route,{...route,id:'another'}],burnLogs).totals.tier_5000.matches,0);
  const noCash={...receipt,logs:receipt.logs.filter((_,i)=>i!==3)};
  assert.equal(routedMiningCredit(miningBuyReceipt(hash,swap,noCash),swap,noCash),null);
});
