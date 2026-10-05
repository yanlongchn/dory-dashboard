(function (root) {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const sourceOK = (snapshot, name) => snapshot.sources?.[name]?.status === 'ok';
  const rules = {
    version: '2026-10-05-course-v1',
    confirmed: {daily_rate: 0.0085, settlements_per_day: 96, minutes_per_settlement: 15, quota_multiple: 2},
    course: {
      source: '用户提供的2026-10-05课堂录音；重点片段二次转写复核，尚未独立链上核验',
      direct_rate: 0.1, shared_quota: true,
      levels: [
        {level: 1, small_area_usd: 1000, rate: 0.1},
        {level: 2, small_area_usd: 10000, rate: 0.2},
        {level: 3, small_area_usd: 30000, rate: 0.3},
        {level: 4, small_area_usd: 100000, rate: 0.4},
        {level: 5, small_area_usd: 300000, rate: 0.5},
        {level: 6, small_area_usd: 900000, rate: 0.6},
        {level: 7, small_area_usd: 2700000, rate: 0.7}
      ],
      timestamps: {direct_and_quota: '61:48–63:09', levels: '63:11–64:25', differential: '66:18–66:34', atlas: '66:53–68:18', nft: '61:03–61:44', applications: '26:23–34:38'},
      atlas: {name: '阿特拉斯（暂按音译）', status: 'unverified', personal_ratio: null,
        factors: ['本人矿机规模', '追加后的存续时间', '小区增长'],
        note: '25%出现在探讨语境，不作为已生效门槛或资格判定'},
      nft: {address: null, dividend_base: null, claimed_rate: 0.1, status: 'unverified',
        note: '录音仅给705B尾号及10%口述；未确认与X9 Charter的对应关系，未来平台分红另列'},
      applications: ['会议付费销毁', '直播质押', '打赏转账', '持仓准入', '信号与内容置顶']
    }
  };

  // These are required business evidence, not failed RPC calls and not measured zeroes.
  const requiredEvidence = [
    {id: 'atlas', title: '新协议与奖励资格', basis: '录音66:53–68:18；讲师称仍在探讨', need: '正式名称、版本、生效时间；本人规模、存续时间及小区增长算法', impact: '不能判断现有等级示例是否仍适用'},
    {id: 'shared_quota', title: '静态 / 动态共用200%额度', basis: '录音61:48–63:09；直推10%扣本人额度', need: '六项奖励、NFT分红是否扣额度；超额截断及满额结束流水', impact: '不能把日奖励视为持续无限产出'},
    {id: 'active_principal', title: '有效本金与96次计价', basis: '日率0.0085及96次已由用户确认', need: '未到顶本金、逐次价格、计产币数、领取及实际卖出记录', impact: '全网日产币与矿工卖压保持未知'},
    {id: 'community', title: '小区、等级与级差', basis: '录音63:11–66:34；按小区计产、存在级差', need: '小区定义、有效业绩、平级 / 多分支扣减及奖励资格', impact: '70%不能统一叠加本人基础计产'},
    {id: 'nft_dividends', title: 'NFT分红来源与权益', basis: '录音61:03–61:44；705B相关10%口述', need: '完整地址、10%基数、合约对应、个人份额与来源到账链路', impact: 'X9C认购不能代替NFT收入或股权证明'},
    {id: 'applications', title: '实际应用付费与消耗', basis: '会议、质押、打赏、准入各有不同用途', need: '付费订单与链上记录；活跃用户统计周期及去重方法', impact: '不能把全部转账或质押计作销毁 / 平台收入'},
    {id: 'permissions', title: '权限与LP控制凭证', basis: '录音44:47–45:44称双向权限放弃', need: 'LP NFT合约与tokenId、持有人、全组件权限及升级路径', impact: '代币或单个LP头寸信息不足以证明全协议安全'},
    {id: 'pending', title: 'Pending自动 / 嵌套结算', basis: '当前仅直接调用可单列', need: 'Pending产生、触发、清零与最终销毁的逐笔链路', impact: '其他 / 未知销毁不归因为应用或自动结算'},
    {id: 'cash_exit', title: '领取、卖出与实际到账', basis: '计产 / 领取 / 卖出分列', need: '完整费用、接收方、成交价格、滑点与稳定币到账', impact: '名义计产不能当作现金回本或保本承诺'}
  ];

  function flowWindow(snapshot, window) {
    const isDay = window === '24h';
    const required = ['mint_emissions', 'zero_burn', isDay ? 'supply_24h' : 'supply_7d', 'supply_event_reconciliation', 'chain_consistency'];
    const mint = snapshot.supply?.[isDay ? 'minted_24h' : 'minted_7d'];
    const zero = snapshot.zero_burn?.[isDay ? 'total_dory' : 'total_7d'];
    const supplyChange = snapshot.supply?.[isDay ? 'change_24h' : 'change_7d'];
    const usable = required.every(name => sourceOK(snapshot, name)) && [mint, zero, supplyChange].every(finite) && mint >= 0 && zero >= 0;
    if (!usable) return {status: 'unverified', minted: null, zero_transfer: null, event_net: null, supply_change: null, zero_cover_pct: null, discrepancy: null};
    const eventNet = mint - zero, discrepancy = eventNet - supplyChange;
    if (Math.abs(discrepancy) > 0.000001) return {status: 'inconsistent', minted: mint, zero_transfer: zero, event_net: eventNet, supply_change: supplyChange, zero_cover_pct: null, discrepancy};
    return {status: 'ok', minted: mint, zero_transfer: zero, event_net: eventNet, supply_change: supplyChange,
      zero_cover_pct: mint > 0 ? zero / mint * 100 : null, discrepancy};
  }

  function build(snapshot, now = Date.now()) {
    const time = Date.parse(snapshot.generated_at);
    const fresh = Number.isFinite(time) && time <= now + 300000 && now - time <= 36 * 3600000;
    const day = flowWindow(snapshot, '24h'), week = flowWindow(snapshot, '7d');
    const categories = snapshot.zero_burn?.categories;
    const other = categories?.other?.dory;
    const values = ['sell_swap', 'buy_swap', 'direct_transfer', 'explicit_pending_call', 'other'].map(key => categories?.[key]?.dory);
    const attributionOK = day.status === 'ok' && sourceOK(snapshot, 'zero_burn_categories') && values.every(value => finite(value) && value >= 0)
      && Math.abs(values.reduce((sum, value) => sum + value, 0) - day.zero_transfer) <= 0.000001;
    const x9 = sourceOK(snapshot, 'x9c_mint') && sourceOK(snapshot, 'chain_consistency') && finite(snapshot.x9c_dead_burn?.total_dory)
      ? snapshot.x9c_dead_burn.total_dory : null;
    return {
      rules_version: rules.version, generated_at: snapshot.generated_at, fresh,
      chain_flow_status: !fresh ? 'stale' : day.status === 'ok' && week.status === 'ok' ? 'ok' : 'unverified',
      business_status: 'evidence_incomplete',
      flow: {day, week, x9c_dead_24h: x9,
        unknown_burn_24h: attributionOK ? other : null,
        unknown_burn_pct: attributionOK && day.zero_transfer > 0 ? other / day.zero_transfer * 100 : null},
      required_evidence: requiredEvidence.map(item => ({...item, status: 'unverified', value: null})),
      boundaries: ['Mint是实际新增发行，不自动等于矿工基础产出', 'X9C→dEaD不从totalSupply对账中扣除',
        '其他销毁不自动归为应用付费', '课堂规则与链上采集状态分别展示', '实际卖压、NFT收入及新协议资格均不补造']
    };
  }

  function scenario({principal, remaining, smallArea, level}) {
    if (![principal, remaining, smallArea].every(finite) || principal <= 0 || remaining < 0 || remaining > principal * 2 || smallArea < 0
      || !Number.isInteger(level) || level < 0 || level > 7) return {valid: false};
    const tier = rules.course.levels.find(item => item.level === level);
    const base = principal * rules.confirmed.daily_rate;
    const community = smallArea * rules.confirmed.daily_rate * (tier?.rate || 0);
    const total = base + community;
    return {valid: true, base, settlement: base / 96, community, total,
      arithmetic_days: remaining / total,
      below_course_threshold: !!tier && smallArea < tier.small_area_usd,
      quota_finished: remaining === 0,
      eligibility: 'unverified', actual_income: null};
  }
  const api = {rules, requiredEvidence, build, scenario};
  root.DoryMonitoring = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
