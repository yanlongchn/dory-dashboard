import test from 'node:test';
import assert from 'node:assert/strict';
import monitoring from '../monitoring.js';

const now = Date.parse('2026-10-05T06:00:00Z');
function snapshot() {
  return {generated_at: new Date(now).toISOString(), sources: Object.fromEntries([
    'mint_emissions','zero_burn','zero_burn_categories','supply_24h','supply_7d','supply_event_reconciliation','chain_consistency','x9c_mint'
  ].map(key => [key,{status:'ok'}])),
    supply:{minted_24h:10,minted_7d:100,change_24h:2,change_7d:-20},
    zero_burn:{total_dory:8,total_7d:120,categories:{sell_swap:{dory:1},buy_swap:{dory:1},direct_transfer:{dory:0},explicit_pending_call:{dory:0},other:{dory:6}}},
    x9c_dead_burn:{total_dory:999}};
}
test('same-window actual supply reconciles Mint minus Zero without subtracting X9C dead transfers',()=>{
  const value=monitoring.build(snapshot(),now);
  assert.equal(value.chain_flow_status,'ok');assert.equal(value.flow.day.event_net,2);assert.equal(value.flow.week.event_net,-20);
  assert.equal(value.flow.day.zero_cover_pct,80);assert.equal(value.flow.unknown_burn_pct,75);assert.equal(value.flow.x9c_dead_24h,999);
  assert.ok(value.required_evidence.every(item=>item.value===null&&item.status==='unverified'));
  assert.equal(value.business_status,'evidence_incomplete');
});
test('missing and contradictory source evidence cannot populate a seemingly valid derived ratio',()=>{
  const value=snapshot();delete value.sources.mint_emissions;
  const absent=monitoring.build(value,now);assert.equal(absent.flow.day.minted,null);assert.equal(absent.flow.unknown_burn_pct,null);
  const contradictory=snapshot();contradictory.supply.change_24h=3;
  const mismatch=monitoring.build(contradictory,now);assert.equal(mismatch.flow.day.status,'inconsistent');assert.equal(mismatch.flow.day.zero_cover_pct,null);
});
test('true zero issuance is retained without synthesizing a coverage denominator',()=>{
  const value=snapshot();Object.assign(value.supply,{minted_24h:0,change_24h:0});value.zero_burn.total_dory=0;
  for(const category of Object.values(value.zero_burn.categories))category.dory=0;
  const result=monitoring.build(value,now);assert.equal(result.flow.day.minted,0);assert.equal(result.flow.day.zero_cover_pct,null);
  assert.equal(result.flow.unknown_burn_24h,0);assert.equal(result.flow.unknown_burn_pct,null);
});
test('incomplete burn classification is unknown, not an attributed zero',()=>{
  const value=snapshot();value.zero_burn.categories.other.dory=5;
  const result=monitoring.build(value,now);assert.equal(result.flow.unknown_burn_24h,null);assert.equal(result.flow.unknown_burn_pct,null);
});
test('stale and future snapshots retain provenance but cannot report current monitoring status',()=>{
  const value=snapshot();value.generated_at=new Date(now-37*3600000).toISOString();
  assert.equal(monitoring.build(value,now).chain_flow_status,'stale');
  value.generated_at=new Date(now+600000).toISOString();assert.equal(monitoring.build(value,now).fresh,false);
});
test('V4 course arithmetic uses small-area production and shared remaining quota, with eligibility explicitly unknown',()=>{
  const result=monitoring.scenario({principal:10000,remaining:20000,smallArea:100000,level:4});
  assert.equal(result.base,85);assert.ok(Math.abs(result.community-340)<1e-8);assert.ok(Math.abs(result.total-425)<1e-8);
  assert.ok(Math.abs(result.arithmetic_days-20000/425)<1e-10);assert.equal(result.eligibility,'unverified');assert.equal(result.actual_income,null);
  const ended=monitoring.scenario({principal:10000,remaining:0,smallArea:100000,level:4});assert.equal(ended.quota_finished,true);
});
test('invalid inputs and below-course thresholds cannot turn into a statement of eligibility',()=>{
  assert.equal(monitoring.scenario({principal:0,remaining:0,smallArea:0,level:0}).valid,false);
  assert.equal(monitoring.scenario({principal:100,remaining:201,smallArea:0,level:0}).valid,false);
  assert.equal(monitoring.scenario({principal:NaN,remaining:0,smallArea:0,level:0}).valid,false);
  const below=monitoring.scenario({principal:5000,remaining:10000,smallArea:1000,level:7});
  assert.equal(below.below_course_threshold,true);assert.equal(below.eligibility,'unverified');
  assert.equal(monitoring.rules.course.atlas.personal_ratio,null);assert.equal(monitoring.rules.course.nft.address,null);
});
