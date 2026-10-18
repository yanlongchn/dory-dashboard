(function (root) {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const sourceOK = (snapshot, name) => snapshot.sources?.[name]?.status === 'ok';
  const rules = {
    version: '2026-10-18-atlas-v3',
    confirmed: {daily_rate: 0.0085, settlements_per_day: 96, minutes_per_settlement: 15, quota_multiple: 2, quota_unit: 'DORY', daily_rate_basis: 'E USD from earlier user-confirmed settlement rule; actual conversion and quota deduction require records', quota_source: '用户2026-10-18确认币本位；不与USD日计产直接相除'},
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
      atlas: {name: 'Atlas Protocol', status: 'announcement_verified', effective_status: 'unverified', personal_ratio: null,
        source: 'https://dapp.dory.global/notice/atlas/',
        formula: 'Ψ = H + min(C, μH)', activation: 'μ = Λ × Γ(S) × Θ(τ)',
        factors: ['自身有效算力H', '小区算力S', '金额加权算力龄τ'],
        parameters: {Lambda:null,kappa:null,S0:null,Sstar:null,tau_star:null,epsilon:null,delta:null,Delta0:null},
        note: '已核对官方公式；生效时间、当期参数及账户状态仍待核验，不以25%或V等级直接计算激活额度'},
      nft: {address: null, dividend_base: null, claimed_rate: 0.1, status: 'unverified',
        note: '705B完整收款地址已由Transfer记录确认；NFT身份、10%分红基数及与X9 Charter的对应关系仍未确认'},
      applications: ['会议付费销毁', '直播质押', '打赏转账', '持仓准入', '信号与内容置顶']
    }
  };

  // These are required business evidence, not failed RPC calls and not measured zeroes.
  const requiredEvidence = [
    {id: 'atlas', title: 'Atlas实际激活资格', basis: '官方公告公式已核对：Ψ=H+min(C,μH)', need: '生效时间、全部当期参数、本人H/C/S及未出局分笔时间', impact: '公告有公式不等于账户已生效；不按V等级直接推算实际社区收益'},
    {id: 'shared_quota', title: '币本位200%额度与扣减', basis: '用户2026-10-18确认：投入DORY数量的两倍', need: '六项奖励、NFT是否扣币额度；USD计产转换、超额截断及满额流水', impact: '不能把日奖励视为持续无限产出'},
    {id: 'active_principal', title: '有效本金与96次计价', basis: '日率0.0085及96次已由用户确认', need: '未到顶本金、逐次价格、计产币数、领取及实际卖出记录', impact: '全网日产币与矿工卖压保持未知'},
    {id: 'community', title: '小区、等级与级差', basis: '旧课堂档位保留历史；Atlas激活系数按小区连续变化', need: '小区定义、有效业绩、平级 / 多分支扣减及奖励资格', impact: '70%不能统一叠加本人基础计产'},
    {id: 'nft_dividends', title: 'NFT分红来源与权益', basis: '705B完整收款地址已确认；NFT关联仍为课堂口述', need: 'NFT合约对应、10%分红基数、个人份额与来源到账链路', impact: '705B流入不能代替NFT收入或股权证明'},
    {id: 'applications', title: '实际应用付费与消耗', basis: '会议、质押、打赏、准入各有不同用途', need: '付费订单与链上记录；活跃用户统计周期及去重方法', impact: '不能把全部转账或质押计作销毁 / 平台收入'},
    {id: 'permissions', title: '权限与LP控制凭证', basis: '官方部署表已确认PositionManager；路由合约不等于实际LP所有人', need: 'LP NFT合约与tokenId、持有人、全组件权限及升级路径', impact: '代币或单个LP头寸信息不足以证明全协议安全'},
    {id: 'pending', title: 'Pending触发与全量归因', basis: '已有样本前后Pending归零及90% / 10%分流；直接调用可单列', need: '实现合约、触发条件、舍入规则、更多前后状态及全量逐笔链路', impact: '样本清零不证明所有自动结算；分流模式不直接改写销毁用途'},
    {id: 'cash_exit', title: '领取、卖出与实际到账', basis: '新资料称App卖出销毁DORY并由金库兑付USDC；与池内Swap分列', need: '金库地址、订单/销毁/USDC付款对应、App报价、到账及小额提现凭证', impact: '池内USDC本金不能证明App金库准备金或提现畅通'}
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
      distribution: distribution(snapshot, day, week),
      required_evidence: requiredEvidence.map(item => ({...item, status: 'unverified', value: null})),
      boundaries: ['Mint是实际新增发行，不自动等于矿工基础产出', 'X9C→dEaD不从totalSupply对账中扣除',
        '其他销毁不自动归为应用付费', '课堂规则与链上采集状态分别展示', '实际卖压、NFT收入及新协议资格均不补造']
    };
  }

  const receiver705b = '0x0135f06fbb34cad4a4c0a321efe964b38d2c705b';
  function distribution(snapshot, day, week) {
    const data = snapshot.distribution_705b;
    const identityOK = data?.address === receiver705b && sourceOK(snapshot, 'chain_consistency');
    const windowValue = (value, flow) => {
      const numbers = ['incoming_dory','matched_zero_dory','matched_receiver_dory','matched_total_dory','unmatched_incoming_dory'];
      const counts = ['matched_pairs','matched_transactions','matched_wallets'];
      if (!identityOK || !sourceOK(snapshot, 'distribution_705b') || flow.status !== 'ok' || !value ||
          !numbers.every(key => finite(value[key]) && value[key] >= 0) ||
          !counts.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
          value.matched_wallets > value.matched_pairs || value.matched_transactions > value.matched_pairs ||
          value.matched_zero_dory > flow.zero_transfer + 1e-6 ||
          Math.abs(value.matched_total_dory - value.matched_zero_dory - value.matched_receiver_dory) > 1e-6 ||
          Math.abs(value.incoming_dory - value.matched_receiver_dory - value.unmatched_incoming_dory) > 1e-6)
        return {status: 'unverified'};
      return {...value, status: 'ok', zero_share_pct: flow.zero_transfer > 0 ? value.matched_zero_dory / flow.zero_transfer * 100 : null};
    };
    return {address: receiver705b,
      balance_dory: identityOK && sourceOK(snapshot, 'distribution_705b_balance') && finite(data.balance_dory) && data.balance_dory >= 0 ? data.balance_dory : null,
      day: windowValue(data?.day, day), week: windowValue(data?.week, week)};
  }

  function scenario({principal, remaining, dailyDory}) {
    if (![principal, remaining, dailyDory].every(finite) || principal <= 0 || remaining < 0 || remaining > principal * 2 || dailyDory < 0) return {valid:false};
    return {valid:true, unit:'DORY', quota:principal*2, used:principal*2-remaining, remaining,
      arithmetic_days:dailyDory>0?remaining/dailyDory:null, quota_finished:remaining===0,
      eligibility:'unverified', actual_income:null};
  }
  const api = {rules, requiredEvidence, build, scenario};
  root.DoryMonitoring = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
