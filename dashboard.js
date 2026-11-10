const DATA_LATEST='./data/latest.json', DATA_HISTORY='./data/history.json';
const MARKET_REFRESH_MS=30*60*1000;
const DORY='0x33b49f2264e85bb124d2730dc180182717d436ae', USDC='0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const POOL='0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb';
const API='https://api.geckoterminal.com/api/v2/networks/arbitrum/pools/'+POOL;
const $=id=>document.getElementById(id), known=n=>typeof n==='number'&&Number.isFinite(n);
const fmt=(n,d=2)=>known(n)?n.toLocaleString('zh-CN',{maximumFractionDigits:d,minimumFractionDigits:d}):'暂无数据';
const money=n=>known(n)?'$'+n.toLocaleString('en-US',{maximumFractionDigits:0}):'暂无数据';
const signed=(n,d=2,suffix='')=>known(n)?(n>0?'+':'')+fmt(n,d)+suffix:'暂无数据';
let chartGeometry=null, chartHoverIndex=null, chartSelectedIndex=null;
let candlesAll=[], chartRange='all', history=[], snapshot=null;
let liveMarket=null, liveCandles=[], lastMarketAttempt=null, marketRefreshTimer;
const sourceNames={pool_state:'官方StateView池状态',lp_activity:'24h LP加减事件',market:'官方池行情',pool_identity:'池币种与精度',chain_window:'24h / 7日区块窗口',holders:'持币地址索引',pool_key:'初始化参数与Pool ID',pool_reserves:'当前两侧本金',pool_reserves_24h:'24h本金变化',ohlcv:'真实日K',ohlcv_history:'日K历史覆盖',swaps:'24h买卖资金',supply:'当前供应',supply_24h:'24h历史供应',supply_7d:'7日历史供应',zero_burn:'24h / 7日Zero Transfer',zero_burn_categories:'24h销毁分类',x9c_mint:'24h / 7日原始X9C认购',mint_emissions:'24h / 7日新增发行',supply_event_reconciliation:'供应与事件窗口对账',chain_consistency:'采集区块一致性',distribution_705b:'705B流入与同笔分流',distribution_705b_balance:'705B快照DORY余额',mining_funding:'开矿双腿资金与销毁',mining_routed:'X9 合并买回与销毁'};
function tableRow(values){const tr=document.createElement('tr');tr.replaceChildren(...values.map(value=>{const td=document.createElement('td');td.textContent=value;return td}));return tr}
function historyMetric(d,key,value,decimals=2){
 const source=d.sources?.[key];
 if(source?.status==='failed')return /HTTP (401|402|403)|API authorization|API restricted/.test(source.error||'')?'接口受限':'采集失败';
 return fmt(value,decimals);
}
function holderCountDisplay(d){
 const value=historyMetric(d,'holders',d.holders?.count,0);
 if(!known(d.holders?.count)||d.sources?.holders?.status==='failed')return value;
 const date=d.date||d.date_bj;
 const time=Date.parse(date+'T00:00:00+08:00');
 const previousDate=Number.isFinite(time)?bjDate(time-86400000):null;
 const old=history.find(h=>h.date===previousDate);
 const comparable=old?.sources?.holders?.status==='ok'&&d.sources?.holders?.status==='ok'&&known(old.holders?.count)&&!!d.holders?.source&&old.holders?.source===d.holders.source;
 const change=comparable?d.holders.count-old.holders.count:null;
 return value+'('+(known(change)?(change>=0?'+':'')+fmt(change,0):'无同源基线')+')';
}
function evidencePanels(d){
 const rows=Object.entries(sourceNames).map(([key,label])=>{const s=d.sources?.[key];return tableRow([label,s?.status==='ok'?'采集完成':s?.status==='partial'?'部分覆盖':s?.status==='failed'?'采集失败':'暂无采集',s?.error||s?.reason||(s?.collected_at?asOf(s.collected_at):s?.evidence||'等待来源')])});$('sourceRows').replaceChildren(...rows);
 const old=history.find(h=>h.date===(new Date(Date.parse((d.date_bj||bjDate())+'T00:00:00+08:00')-7*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})));
 const delta=known(old?.holders?.count)&&old.holders?.source===d.holders?.source&&known(d.holders?.count)?d.holders.count-old.holders.count:null;
 $('holdersDelta7').textContent=known(delta)?signed(delta,0,' 地址'):'无同源7日前基线';
 const recent=history.slice(-7);$('historyRows').replaceChildren(...recent.map(h=>tableRow([h.date,asOf(h.generated_at),money(h.pool?.usdc_reserve),signed(h.supply?.change_24h),fmt(h.zero_burn?.total_dory),historyMetric(h,'x9c_mint',h.x9c_dead_burn?.total_dory),holderCountDisplay(h)])));
 renderHistoryPicker();
 $('historyNote').textContent=recent.length<2?'当前仅有'+recent.length+'个日期；每日更新后形成趋势，同日重跑覆盖当日。':'持币地址以总数(本日净增)展示，净增为相邻两日同源索引差额，非首次持币地址数；前日缺失不跨日补算。不同采集时刻的滚动24h窗口不能直接累加为7日。';
}
function pctClass(el,v){const base=(el.className||'').split(/\s+/).filter(c=>c&&!['up','down','muted'].includes(c));el.className=[...base,known(v)?v>0?'up':v<0?'down':'muted':'muted'].join(' ')}
function setSource(id,text,state=''){const e=$(id);e.textContent=text;e.className='pill '+state}
function setLight(id,textId,state,text){$(id).className='dot '+(state||'');$(textId).textContent=text}
function setPct(id,v){const e=$(id);e.textContent=signed(v,2,'%');pctClass(e,v)}
function bjDate(ts=Date.now()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ts))}
function asOf(ts){return ts?new Date(ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' 北京时间':'未采集'}
async function getJSON(url){const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
function ratio(buy,sell){return known(buy)&&known(sell)?buy>0?sell/buy:sell>0?Infinity:null:null}
function sourceKnown(name){return snapshot?.sources?.[name]?.status==='ok'}
const miningTiers=[['5000U 档','tier_5000'],['10000U 档','tier_10000'],['临界或跨档','unclassified']];
function miningResult(d,key,source='mining_funding'){
 return d.sources?.[source]?.status==='ok'&&d.sources?.chain_consistency?.status==='ok'
   ?d[source]?.[key]:null;
}
function renderRoutedMining(d){
 $('miningRoutedRows').replaceChildren(...miningTiers.slice(0,2).map(([label,key])=>{
   const tier=miningResult(d,key,'mining_routed');
   return tableRow([label,fmt(tier?.matches,0),fmt(tier?.wallets,0),fmt(tier?.cash_usdc,2),fmt(tier?.dory_proceeds_usdc,2)]);
 }));
 $('miningRoutedStatus').textContent=miningResult(d,'tier_5000','mining_routed')?'滚动 24h · X9 路由候选'
   :d.sources?.mining_routed?.status==='failed'?'采集失败':'暂无数据';
}
function renderMiningFunding(d){
 $('miningFundingRows').replaceChildren(...miningTiers.map(([label,key])=>{
   const tier=miningResult(d,key);
   return tableRow([label,fmt(tier?.matches,0),fmt(tier?.wallets,0),fmt(tier?.buy_usdc,2),fmt(tier?.transfer_usdc_estimate,2)]);
 }));
 $('miningFundingStatus').textContent=miningResult(d,'tier_5000')?'滚动 24h · 链上双腿候选'
   :d.sources?.mining_funding?.status==='failed'?'采集失败':'暂无数据';
}
function renderMonitoring(d){
 const model=DoryMonitoring.build(d),day=model.flow.day,week=model.flow.week,usable=day.status==='ok';
 $('monitorStatus').textContent=model.chain_flow_status==='ok'?'链上发行、销毁与供应对账一致':model.chain_flow_status==='stale'?'历史快照 · 等待新采集':'部分窗口缺少对账数据';
 $('monitorMint').textContent=usable?fmt(day.minted)+' DORY':'暂无数据';$('monitorZero').textContent=usable?fmt(day.zero_transfer)+' DORY':'暂无数据';
 $('monitorNet').textContent=usable?signed(day.supply_change,2,' DORY'):'暂无数据';
 $('monitorUnknown').textContent=known(model.flow.unknown_burn_pct)?fmt(model.flow.unknown_burn_pct,1)+'%':model.flow.unknown_burn_24h===0&&day.zero_transfer===0?'无销毁分母':'暂无数据';
 $('monitorUnknownNote').textContent=known(model.flow.unknown_burn_24h)?'其他 / 未知 '+fmt(model.flow.unknown_burn_24h)+' DORY':'等待完整销毁分类';
 $('monitorFlowRows').replaceChildren(...[['24h',day],['7日',week]].map(([label,w])=>tableRow([label,w.status==='ok'?fmt(w.minted):'暂无数据',w.status==='ok'?fmt(w.zero_transfer):'暂无数据',w.status==='ok'?signed(w.supply_change):'暂无数据',w.status==='ok'?known(w.zero_cover_pct)?fmt(w.zero_cover_pct,1)+'%':'新增发行0，无分母':'暂无数据',w.status==='ok'?'Mint − Zero 与供应变化一致':w.status==='inconsistent'?'对账不一致，暂停解释':'暂无完整窗口数据'])));
 $('monitorX9').textContent='X9C原始认购 → dEaD：'+(known(model.flow.x9c_dead_24h)?fmt(model.flow.x9c_dead_24h)+' DORY / 24h':historyMetric(d,'x9c_mint',null))+'。此转出不从totalSupply对账中扣除，也不代表705B分红或平台全部应用销毁。';
 const watch=model.distribution;
 $('receiverBalance').textContent=known(watch.balance_dory)?fmt(watch.balance_dory)+' DORY':'暂无数据';
 $('receiverStatus').textContent=(model.fresh?'当前快照':'历史快照')+' · '+(watch.day.status==='ok'&&watch.week.status==='ok'?'完整窗口分流统计已采集':'暂无完整分流数据');
 $('receiverRows').replaceChildren(...[['24h',watch.day],['7日',watch.week]].map(([label,w])=>tableRow([label,...(w.status==='ok'?[fmt(w.incoming_dory),fmt(w.matched_pairs,0),fmt(w.matched_wallets,0),fmt(w.matched_zero_dory),fmt(w.matched_receiver_dory),known(w.zero_share_pct)?fmt(w.zero_share_pct,1)+'%':'无Zero分母',fmt(w.unmatched_incoming_dory)]:Array(7).fill('暂无数据'))])));
 $('courseRows').replaceChildren(...DoryMonitoring.rules.course.levels.map(tier=>tableRow(['V'+tier.level,fmt(tier.small_area_usd,0)+' U',fmt(tier.rate*100,0)+'%'])));
 const v=d.pool?.state_view,lp=d.pool?.lp_activity,chainOK=d.sources?.chain_consistency?.status==='ok';
 const stateOK=chainOK&&d.sources?.pool_state?.status==='ok';
 $('stateViewPrice').textContent=stateOK&&known(v?.price_usdc_per_dory)?'$'+fmt(v.price_usdc_per_dory,4):'暂无数据';
 $('virtualDepth').textContent=stateOK&&known(v?.virtual_equivalent_tvl_usdc)?fmt(v.virtual_equivalent_tvl_usdc,0)+' USDC（虚拟）':'暂无数据';
 $('actualUsdcPrincipal').textContent=chainOK&&d.sources?.pool_reserves?.status==='ok'?fmt(d.pool?.usdc_reserve,0)+' USDC（本金）':'暂无数据';
 $('stateViewFee').textContent=stateOK&&known(v?.lp_fee)?fmt(v.lp_fee/10000)+'%':'暂无数据';
 $('lpActivity').textContent=chainOK&&d.sources?.lp_activity?.status==='ok'?'加仓 '+fmt(lp.add_events,0)+' / 减仓 '+fmt(lp.remove_events,0)+' / 零变动 '+fmt(lp.zero_delta_events,0)+' 个事件':'暂无数据';
 $('lpRoute').textContent=chainOK&&d.sources?.lp_activity?.status==='ok'?fmt(lp.position_manager_events,0)+' / '+fmt(lp.total_events,0)+' 个事件':'暂无数据';
 $('miningFingerprint').textContent='新开矿/复投指纹候选 · 24h：'+(watch.day.status==='ok'?fmt(watch.day.matched_wallets,0)+' 个地址（'+fmt(watch.day.matched_transactions,0)+' 笔），匹配总额 '+fmt(watch.day.matched_total_dory)+' DORY':'暂无数据')+'。地址数不能视为人数，链上无法区分新开矿与复投；匹配量与池内买卖量、有效本金分开看。';
 renderScenario();
}
function renderScenario(){
 const input=id=>{const value=$(id).value;return typeof value==='string'&&value.trim()!==''?Number(value):NaN};
 const value=DoryMonitoring.scenario({principal:input('scenarioPrincipal'),remaining:input('scenarioRemaining')});
 $('scenarioTotal').textContent=value.valid?fmt(value.quota)+' U':'输入待修正';
 $('scenarioUsed').textContent=value.valid?fmt(value.used)+' U':'输入待修正';
 $('scenarioBase').textContent=value.valid?fmt(value.daily)+' U / 日':'输入待修正';
 $('scenarioBlock').textContent=value.valid?fmt(value.settlement,8)+' U / 次':'输入待修正';
 $('scenarioDays').textContent=value.valid?fmt(value.arithmetic_days)+'天（基础计产假设）':'输入待修正';
 $('scenarioNote').textContent=!value.valid?'本金需大于0，剩余U额度须在0至2×本金之间。':value.quota_finished?'剩余U额度为0；不能视为仍可领取。':'U本位核算：每次qᵢ=(E×0.0085/96)/Pᵢ DORY，日产币为96次合计；币价变化不将累计U上限变成固定币数。天数只假设基础日额不变，无动态加速、追加或费用；不代表实际领取、卖出到账或现金回本。';
}
function marketPrice(m){return known(m.price_usd)?'$'+fmt(m.price_usd,4):'暂无数据'}
function renderMarket(m){
 $('price').textContent=marketPrice(m);$('volume').textContent=money(m.volume_24h);
 $('buys').textContent=known(m.buys)?fmt(m.buys,0)+' 笔':'暂无数据';$('sells').textContent=known(m.sells)?fmt(m.sells,0)+' 笔':'暂无数据';
 setPct('chg24',m.change_24h_pct);setPct('chg7',m.change_7d_pct);
}
function renderSnapshot(d){snapshot=d;const m=d.market||{}, p=d.pool||{}, s=d.supply||{}, z=d.zero_burn||{}, x=d.x9c_dead_burn||{}, c=d.pool_candidates||{};
 renderMarket(liveMarket?{...liveMarket,change_7d_pct:liveMarket.change_7d_pct??m.change_7d_pct}:m);
 $('tbPrice').textContent=marketPrice(m);$('tbVol').textContent=money(m.volume_24h);
 $('reserveUsd').textContent=money(m.liquidity_usd);$('tbLiq').textContent=money(m.liquidity_usd);$('tb24').textContent=signed(m.change_24h_pct,2,'%');
 const lpFee=p.state_view?.lp_fee;
 $('feeRange').textContent=known(m.volume_24h)&&d.sources?.pool_state?.status==='ok'&&d.sources?.chain_consistency?.status==='ok'&&known(lpFee)?money(m.volume_24h*lpFee/1e6):'暂无数据';
 $('buyAmt').textContent=money(m.buy_usdc);$('sellAmt').textContent=money(m.sell_usdc);$('usdcNet').textContent=signed(p.swap_net_usdc,0,' U');$('doryNet').textContent=signed(p.swap_net_dory,2,' DORY');
 $('supply').textContent=fmt(s.total_supply);$('supplyDelta').textContent=signed(s.change_24h,2);pctClass($('supplyDelta'),known(s.change_24h)?-s.change_24h:null);
 $('supplyDelta7').textContent=signed(s.change_7d,2,' DORY');$('minted24').textContent=known(s.minted_24h)?fmt(s.minted_24h)+' DORY':'暂无数据';
 $('reserveUsdc').textContent=money(p.usdc_reserve);$('reserveDory').textContent=fmt(p.dory_reserve);$('reserveDelta').textContent=signed(p.usdc_change_24h,0,' U');
 $('poolFee').textContent=known(p.key?.fee)?fmt(p.key.fee/10000,2)+'%':'暂无数据';
 $('zeroBurn').textContent=fmt(z.total_dory);for(const [id,key] of [['zbSell','sell_swap'],['zbBuy','buy_swap'],['zbDirect','direct_transfer'],['zbOther','other']])$(id).textContent=fmt(z.categories?.[key]?.dory);
 $('x9burn').textContent=known(x.total_dory)?fmt(x.total_dory)+' DORY':'暂无数据';$('x9mintTx').textContent=known(x.transactions)?fmt(x.transactions,0)+' 笔':'暂无数据';
 $('zero7').textContent=fmt(z.total_7d);$('zbExplicit').textContent=fmt(z.categories?.explicit_pending_call?.dory);
 $('x9burn7').textContent=known(x.total_7d)?fmt(x.total_7d)+' DORY':'暂无数据';$('x9Absorption').textContent=known(x.absorption_24h_pct)?fmt(x.absorption_24h_pct,2)+'%':s.minted_24h===0?'新增发行为0，无分母':'暂无数据';
 $('pools').textContent=known(c.candidate_pools)?fmt(c.candidate_pools,0)+' 份金额单位':'暂无数据';$('poolTxs').textContent=known(c.transactions)?fmt(c.transactions,0)+' 笔':'暂无数据';$('poolCapital').textContent=money(c.candidate_usdc);$('poolMax').textContent=money(c.max_usdc);
 $('holders').textContent=holderCountDisplay(d);$('holdersAsOf').textContent=d.holders?.as_of?asOf(d.holders.as_of):'暂无数据';
 $('poolRoundtrip').textContent=known(c.same_tx_roundtrips_excluded)?fmt(c.same_tx_roundtrips_excluded,0)+' 笔':'暂无数据';
 $('tbReserve').textContent=money(p.usdc_reserve);$('tbReservePrev').textContent=money(p.baseline_24h?.usdc_reserve);$('tbSupply7').textContent=signed(s.change_7d);$('tbZero7').textContent=fmt(z.total_7d);$('tbX97').textContent=fmt(x.total_7d);$('tbHolders').textContent=holderCountDisplay(d);
 $('tbUsdcNet').textContent=signed(p.swap_net_usdc,0,' U');$('tbZero').textContent=fmt(z.total_dory);$('tbX9').textContent=fmt(x.total_dory);$('tbPools').textContent=known(c.candidate_pools)?fmt(c.candidate_pools,0)+' 份':'暂无数据';$('tbSupplyDelta').textContent=signed(s.change_24h);
 const values=[m.price_usd,m.volume_24h,m.liquidity_usd,p.swap_net_usdc,z.total_dory,x.total_dory,c.candidate_pools,s.change_24h,p.usdc_reserve,s.change_7d,z.total_7d,x.total_7d,d.holders?.count]; document.querySelectorAll('#metricRows tr').forEach((row,i)=>{row.cells[3].textContent=known(values[i])?i===6?'金额筛选':i===12?'索引快照':'已取得（快照）':'暂无数据'});
 const inconsistent=d.sources?.chain_consistency?.status==='failed'||d.sources?.supply_event_reconciliation?.status==='failed';
 const timestamp=Date.parse(d.generated_at), stale=!Number.isFinite(timestamp)||timestamp>Date.now()+300000||Date.now()-timestamp>36*3600000||inconsistent;
 setSource('srcChain','每日快照：'+(!d.generated_at?'未采集':stale?inconsistent?'证据不一致':'已过期':d.status==='ok'?'采集完成':'部分采集缺失'),stale||d.status==='not_collected'?'err':d.status==='ok'?'ok':'busy');
 if(lastMarketAttempt===null)setSource('srcMarket','行情快照：'+(known(m.price_usd)?'已取得':'暂无数据'),known(m.price_usd)&&!stale?'ok':'busy');
 setSource('srcRpc','链上采集：'+(known(s.total_supply)?'供应已取得':'暂无数据'),known(s.total_supply)&&!stale?'ok':'busy');
 setSource('srcHolders','持币地址：'+(known(d.holders?.count)?'索引快照':'暂无数据'),known(d.holders?.count)&&!stale?'ok':'busy');
 const coverage=values.filter(known).length;$('coverageSummary').textContent='核心表格 '+coverage+' / '+values.length+' 项已取得（含候选与索引）。';$('progressBar').style.width=Math.round(coverage/values.length*100)+'%';
 $('asof').textContent='快照 '+asOf(d.generated_at);$('scanStatus').textContent='快照 '+asOf(d.generated_at)+'；'+(d.blocks?.from&&d.blocks?.to?'滚动24h区块 '+d.blocks.from+'–'+d.blocks.to+'；':'')+(stale?inconsistent?'区块或供应事件对账未通过，观察灯保持灰色。':'当前快照已过期，观察灯保持灰色。':'缺失指标保持灰色。');
 setLight('lUsdc','tUsdc',!stale&&known(p.usdc_change_24h)?p.usdc_change_24h>0?'green':p.usdc_change_24h<0?'red':'yellow':'',known(p.usdc_change_24h)?signed(p.usdc_change_24h,0,' U / 24h本金'):'暂无本金变化数据');
 const priceChange=m.change_24h_pct;
 setLight('lPrice','tPrice',!stale&&known(priceChange)?priceChange>3?'green':priceChange<-3?'red':'yellow':'',signed(priceChange,1,'% / 24h'));
 setLight('lSupply','tSupply',!stale&&known(s.change_24h)?s.change_24h<0?'green':s.change_24h>0?'red':'yellow':'',signed(s.change_24h,1,' DORY'));
 const absorption=x.absorption_24h_pct;setLight('lX9','tX9','',known(absorption)?fmt(absorption,1)+'% · 流通转出参考':s.minted_24h===0?'新增发行为0，无分母':'暂无新增发行数据');const r=ratio(m.buy_usdc,m.sell_usdc);
 setLight('lTrade','tTrade',!stale&&r!==null?r>1.1?'red':r<.9?'green':'yellow':'',r===Infinity?'仅SELL，无BUY':r===null?'暂无成交金额':'金额 SELL/BUY '+fmt(r,2)+'×');
 const date=d.date_bj||bjDate(d.generated_at||Date.now()), prev=history.filter(h=>h.date<date).at(-1);
 $('prevUsdcNet').textContent=prev?signed(prev.pool?.swap_net_usdc,0,' U'):'无历史基线';$('prevZero').textContent=prev?fmt(prev.zero_burn?.total_dory):'无历史基线';$('prevX9').textContent=prev?fmt(prev.x9c_dead_burn?.total_dory):'无历史基线';$('prevPools').textContent=known(prev?.pool_candidates?.candidate_pools)?fmt(prev.pool_candidates.candidate_pools,0)+' 份':'无历史基线';
 setLight('lPool','tPool','','地址与交易仅按链上特征统计');
 if(stale)for(const [id,tid] of [['lPool','tPool'],['lUsdc','tUsdc'],['lSupply','tSupply'],['lPrice','tPrice'],['lX9','tX9'],['lTrade','tTrade']])setLight(id,tid,'',inconsistent?'证据不一致':'快照已过期');
 const stress=[known(p.usdc_change_24h)?p.usdc_change_24h<0:null,known(s.change_24h)?s.change_24h>0:null,r===null?null:r>1.1].filter(v=>v===true).length;
 $('systemState').textContent=!stale&&stress>=2?'资金 / 供应承压':stale?'历史快照':known(p.usdc_change_24h)&&known(s.change_24h)?'资金与供应快照':'部分数据缺失';$('systemState').className=!stale&&stress>=2?'down':'muted';
 const risks=[];if(stale)risks.push(inconsistent?'区块或供应事件对账未通过，请核对来源表。':'当前快照已过期，请检查每日采集工作流。');
 if(known(m.sell_usdc)&&known(m.buy_usdc))risks.push('官方池24h BUY '+money(m.buy_usdc)+' / SELL '+money(m.sell_usdc)+'；Swap净额不含LP增减。');
 if(known(p.usdc_change_24h)&&known(s.change_24h))risks.push('官方池USDC本金24h '+signed(p.usdc_change_24h,0,' U')+'；净供应 '+signed(s.change_24h,2,' DORY')+'。');
 const monitor=DoryMonitoring.build(d);if(known(monitor.flow.unknown_burn_pct)&&monitor.flow.unknown_burn_pct>0)risks.push('Zero Transfer中 '+fmt(monitor.flow.unknown_burn_pct,1)+'%仍归其他 / 未知，不能整体归因为应用消费或Pending自动结算；同笔90% / 10%分流模式另列观察。');
 const errors=d.errors||[];if(errors.length)risks.unshift('部分采集失败：'+errors.map(e=>typeof e==='string'?e:e.component||e.source||e.message||'暂无数据').join('；'));
 $('riskList').replaceChildren(...risks.slice(0,4).map(text=>{const li=document.createElement('li');li.textContent=text;return li}));
 $('reportDate').textContent=(d.date_bj||bjDate(d.generated_at||Date.now())).replace(/-/g,' / ')+' · 每日数据观察';
 evidencePanels(d);
 renderMonitoring(d);
 renderMiningFunding(d);
 renderRoutedMining(d);
 useCandles([...candleRows(d.ohlcv),...liveCandles]);
}
function candleRows(input){
 const rows=Array.isArray(input)?input:input?.candles||input?.ohlcv_list;
 return Array.isArray(rows)?rows:[];
}
function useCandles(input){const rows=candleRows(input);
 const valid=rows.map(x=>Array.isArray(x)?{t:x[0]*1000,o:x[1],h:x[2],l:x[3],c:x[4],v:x[5]}:x).filter(x=>[x.t,x.o,x.h,x.l,x.c,x.v].every(known)&&x.t>=Date.parse('2025-09-09T00:00:00Z')&&x.l>=0&&x.h>=Math.max(x.o,x.c)&&x.l<=Math.min(x.o,x.c)&&x.v>=0).sort((a,b)=>a.t-b.t);
 candlesAll=[...new Map([...candlesAll,...valid].map(c=>[c.t,c])).values()].sort((a,b)=>a.t-b.t);
 if(candlesAll.length)drawChart();else{$('chartMeta').textContent='OHLCV 未取得';$('chartNote').textContent='未取得官方池真实OHLCV，保留空白，不生成替代K线。'}
}
const flashIds=['price','volume','reserveUsdc','reserveDelta','supplyDelta'];
function captureValues(){return new Map(flashIds.map(id=>[id,$(id).textContent]))}
function highlightChanges(before){if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;for(const id of flashIds){const el=$(id);if(before.get(id)!==el.textContent&&before.get(id)!=='暂无数据')el.animate?.([{backgroundColor:themeColor('--flash','#e7ddc6')},{backgroundColor:'transparent'}],{duration:650,easing:'ease-out'})}}
async function deepScan(){const b=$('chainBtn'),label=b.textContent,before=captureValues(),hadSnapshot=!!snapshot;b.disabled=true;b.textContent='加载中…';$('refreshNote').textContent='正在读取已采集的每日快照';try{const [d,h]=await Promise.all([getJSON(DATA_LATEST),getJSON(DATA_HISTORY)]);history=(h.snapshots||[]).sort((a,b)=>a.date.localeCompare(b.date));renderSnapshot(d);if(hadSnapshot)highlightChanges(before);$('refreshNote').textContent='快照已加载 · 采集时间见今日观察'}catch(e){setSource('srcChain','每日快照：加载失败','err');$('scanStatus').textContent='快照加载失败：'+e.message+'；已有结果及时间保留。';$('refreshNote').textContent='加载失败，保留已有快照'}finally{b.disabled=false;b.textContent=label}}
function refreshMarketWhenVisible(){
 if(!document.hidden&&(lastMarketAttempt===null||Date.now()-lastMarketAttempt>=MARKET_REFRESH_MS))void loadMarket(true);
}
async function loadMarket(automatic=false){
 const b=$('marketBtn'),label=b.textContent,before=captureValues();if(b.disabled)return;
 lastMarketAttempt=Date.now();
 window.clearTimeout(marketRefreshTimer);
 marketRefreshTimer=window.setTimeout(()=>{if(!document.hidden)void loadMarket(true)},MARKET_REFRESH_MS);
 b.disabled=true;b.textContent='刷新中…';
 if(!automatic)$('refreshNote').textContent='正在读取官方池行情';
 setSource('srcMarket','行情：刷新中','busy');
 try{
 const pool=await getJSON(API+'?include=base_token,quote_token');const rel=pool.data.relationships;
 const base=rel.base_token.data.id.toLowerCase(),quote=rel.quote_token.data.id.toLowerCase();
 if(pool.data.id.toLowerCase()!=='arbitrum_'+POOL||pool.data.attributes.address.toLowerCase()!==POOL||rel.dex?.data?.id!=='uniswap-v4-arbitrum'||
   ![base,quote].includes('arbitrum_'+DORY)||![base,quote].includes('arbitrum_'+USDC))throw new Error('行情返回的池币种与 DORY/USDC 不一致');
 for(const [address,decimals] of [[DORY,18],[USDC,6]]){const t=pool.included?.find(t=>t.id.toLowerCase()==='arbitrum_'+address);if(t?.attributes?.address?.toLowerCase()!==address||t?.attributes?.decimals!==decimals)throw Error('行情返回的代币精度不一致')}
 const token=base==='arbitrum_'+DORY?'base':'quote',a=pool.data.attributes,tx=a.transactions?.h24||{};
 const number=x=>x===null||x===undefined||x===''?null:Number.isFinite(Number(x))?Number(x):null;
 const price=number(token==='base'?a.base_token_price_usd:a.quote_token_price_usd);
 if(!known(price)||price<=0)throw Error('行情接口未返回有效价格');
 liveMarket={price_usd:price,volume_24h:number(a.volume_usd?.h24),
   change_24h_pct:token==='base'?number(a.price_change_percentage?.h24):null,
   change_7d_pct:liveMarket?.change_7d_pct??snapshot?.market?.change_7d_pct,
   buys:number(token==='base'?tx.buys:tx.sells),sells:number(token==='base'?tx.sells:tx.buys)};
 renderMarket(liveMarket);
 setSource('srcMarket','行情更新：'+asOf(new Date().toISOString()),'ok');
 highlightChanges(before);
 if(!automatic)$('refreshNote').textContent='行情已更新 · 每日快照时间保留';
 try{
   const o=await getJSON(API+'/ohlcv/day?aggregate=1&limit=1000&currency=usd&token='+DORY);
   if(!Array.isArray(o.data?.attributes?.ohlcv_list)||!o.data.attributes.ohlcv_list.length)throw Error('行情接口未返回日K');
   liveCandles=o.data.attributes.ohlcv_list;
   useCandles(liveCandles);
   const last=candlesAll.at(-1),seven=last&&candlesAll.findLast(x=>x.t<=last.t-7*86400000);
   if(seven?.c>0){
     liveMarket.change_7d_pct=(last.c/seven.c-1)*100;
     setPct('chg7',liveMarket.change_7d_pct);
   }
 }catch(e){$('chartNote').textContent='K线刷新失败：'+e.message+'，保留已有日K。'}
 }catch(e){
   setSource('srcMarket','行情刷新失败：'+e.message+'，保留已有行情','err');
   if(!automatic)$('refreshNote').textContent='行情刷新失败，保留已有行情';
 }finally{b.disabled=false;b.textContent=label}
}

function visibleCandles(){return chartRange==='all'?candlesAll:candlesAll.slice(-Number(chartRange))}
function candleDate(t){return new Intl.DateTimeFormat('zh-CN',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t))}
function setRange(r,el){chartRange=r;chartHoverIndex=null;chartSelectedIndex=null;document.querySelectorAll('.cbtn').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-pressed','false')});el.classList.add('active');el.setAttribute('aria-pressed','true');drawChart();if(!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)$('chart').animate?.([{opacity:.45},{opacity:1}],{duration:220})}
function themeColor(name,fallback){return window.getComputedStyle?.(document.documentElement).getPropertyValue(name).trim()||fallback}
function drawChart(){
 const c=visibleCandles(),cv=$('chart'),box=cv.getBoundingClientRect(),dpr=devicePixelRatio||1;if(!c.length||box.width<=0||box.height<=0)return;
 cv.width=box.width*dpr;cv.height=box.height*dpr;const x=cv.getContext('2d');x.scale(dpr,dpr);
 const palette={grid:themeColor('--chart-grid','#e5e8df'),label:themeColor('--chart-label','#748078'),up:themeColor('--green','#168365'),down:themeColor('--red','#b84646'),guide:themeColor('--gold','#95723c')};
 const W=box.width,H=box.height,L=W<400?43:56,R=12,T=18,B=34,VH=H<300?43:58,PH=H-T-B-VH-12;
 const highs=c.map(z=>z.h),sorted=[...highs].sort((a,b)=>a-b),cap=sorted[Math.floor((sorted.length-1)*.995)]||Math.max(...highs),lo=Math.min(...c.map(z=>z.l));let hi=Math.max(...highs.filter(v=>v<=cap));if(hi<=lo)hi=lo+1;
 const maxV=Math.max(...c.map(z=>z.v)),px=i=>L+(i+.5)*(W-L-R)/c.length,py=v=>T+(hi-Math.min(hi,Math.max(lo,v)))/(hi-lo)*PH;
 chartGeometry={candles:c,W,H,L,R,T,PH,px,py};x.clearRect(0,0,W,H);x.strokeStyle=palette.grid;x.lineWidth=1;x.fillStyle=palette.label;x.font='10px sans-serif';
 for(let j=0;j<=4;j++){const y=T+j*PH/4,val=hi-j*(hi-lo)/4;x.beginPath();x.moveTo(L,y);x.lineTo(W-R,y);x.stroke();x.fillText(fmt(val,1),2,y+3)}
 const cw=Math.max(1,Math.min(7,(W-L-R)/c.length*.6));c.forEach((z,i)=>{const xx=px(i),up=z.c>=z.o;x.strokeStyle=up?palette.up:palette.down;x.fillStyle=x.strokeStyle;x.beginPath();x.moveTo(xx,py(z.h));x.lineTo(xx,py(z.l));x.stroke();const y=Math.min(py(z.o),py(z.c)),hh=Math.max(1,Math.abs(py(z.o)-py(z.c)));x.fillRect(xx-cw/2,y,cw,hh);const vh=maxV>0?(z.v/maxV)*VH:0;x.globalAlpha=.32;x.fillRect(xx-cw/2,T+PH+12+VH-vh,cw,vh);x.globalAlpha=1});
 const step=Math.max(1,Math.ceil(c.length/(W<500?4:8)));x.fillStyle=palette.label;for(let i=0;i<c.length;i+=step){const dt=new Date(c[i].t);x.fillText((dt.getUTCMonth()+1)+'/'+dt.getUTCDate(),px(i)-11,H-6)}
 const last=c.at(-1),maxC=c.reduce((a,b)=>b.h>a.h?b:a),minC=c.reduce((a,b)=>b.l<a.l?b:a);$('chartMeta').textContent='最新 '+fmt(last.c,3)+' · 高 '+fmt(maxC.h,2)+' · 低 '+fmt(minC.l,2)+' · '+c.length+'根';$('chartNote').textContent='范围：'+candleDate(c[0].t)+' 至 '+candleDate(last.t)+'（UTC日K）；当日未收盘。纵轴对极端上影采用99.5%分位可视裁剪，原始极值保留在统计与逐日读数中。';
 const slider=$('chartScrubber');slider.disabled=false;slider.max=c.length-1;const selected=Math.min(chartSelectedIndex??c.length-1,c.length-1);slider.value=selected;renderCandleReading(selected,chartHoverIndex!==null);
 if(chartHoverIndex!==null){const z=c[chartHoverIndex];if(z){x.save();x.strokeStyle=palette.guide;x.setLineDash([3,4]);x.beginPath();x.moveTo(px(chartHoverIndex),T);x.lineTo(px(chartHoverIndex),H-B);x.moveTo(L,py(z.c));x.lineTo(W-R,py(z.c));x.stroke();x.restore()}}
}
function renderCandleReading(index,tooltip=false){const g=chartGeometry,z=g?.candles[index];if(!z)return;const text=candleDate(z.t)+' · 开 '+fmt(z.o,3)+' / 高 '+fmt(z.h,3)+' / 低 '+fmt(z.l,3)+' / 收 '+fmt(z.c,3)+' · 成交额 '+money(z.v);
 $('chartReadout').textContent=candleDate(z.t);$('chartAccessible').textContent=text;$('chartScrubber').setAttribute?.('aria-valuetext',text);
 const tip=$('chartTooltip');tip.hidden=!tooltip;if(tooltip){tip.textContent=candleDate(z.t)+' · USD\n开 '+fmt(z.o,3)+' · 收 '+fmt(z.c,3)+'\n高 '+fmt(z.h,3)+' · 低 '+fmt(z.l,3)+'\n成交额 '+money(z.v);tip.style.left=Math.max(12,Math.min(g.px(index)+20,g.W-235))+'px';tip.style.top='22px'}
}
function renderHistoryPicker(){const select=$('historyDate'),chosen=select.value;select.replaceChildren(...history.slice().reverse().map(h=>{const o=document.createElement('option');o.value=h.date;o.textContent=h.date;return o}));if(!history.length){select.disabled=true;$('historySummary').textContent='尚无每日留档；不生成替代记录。';return}select.disabled=false;select.value=history.some(h=>h.date===chosen)?chosen:history.at(-1).date;showHistoryDay(select.value)}
function showHistoryDay(date){const d=history.find(h=>h.date===date);if(!d)return;const failures=['x9c_mint','holders','mining_funding','mining_routed'].filter(key=>d.sources?.[key]?.status==='failed').map(key=>sourceNames[key]+'：'+d.sources[key].error);$('historySummary').textContent=date+' · USDC本金 '+money(d.pool?.usdc_reserve)+'，24h净供应 '+signed(d.supply?.change_24h,2,' DORY')+'，Zero Transfer '+fmt(d.zero_burn?.total_dory)+' DORY。采集于 '+asOf(d.generated_at)+'。X9 路由销毁 · '+miningTiers.slice(0,2).map(([label,key])=>label+' '+fmt(miningResult(d,key,'mining_routed')?.matches,0)).join(' / ')+'。开矿双腿候选 · '+miningTiers.map(([label,key])=>label+' '+fmt(miningResult(d,key)?.matches,0)).join(' / ')+'。'+(failures.length?' 当日缺口：'+failures.join('；')+'。未采集不等于0，不用其他日期补填。':'');document.querySelectorAll('#historyRows tr').forEach(row=>row.classList.toggle('selected',row.cells[0].textContent===date))}
function initEditorial(){
 if(typeof DoryTheme!=='undefined'){DoryTheme.syncButton();$('themeToggle').addEventListener?.('click',()=>DoryTheme.toggle());DoryTheme.subscribe(()=>{if(candlesAll.length)drawChart()})}
 const cv=$('chart');
 const point=e=>{if(!chartGeometry)return;const g=chartGeometry,box=cv.getBoundingClientRect(),index=Math.max(0,Math.min(g.candles.length-1,Math.floor((e.clientX-box.left-g.L)/(g.W-g.L-g.R)*g.candles.length)));chartHoverIndex=index;chartSelectedIndex=index;drawChart()};
 cv.addEventListener?.('pointermove',e=>{if(e.pointerType!=='touch')point(e)});cv.addEventListener?.('click',point);cv.addEventListener?.('pointerleave',()=>{chartHoverIndex=null;$('chartTooltip').hidden=true;if(candlesAll.length)drawChart()});
 $('chartScrubber').addEventListener?.('input',e=>{chartSelectedIndex=Number(e.target.value);chartHoverIndex=chartSelectedIndex;drawChart()});$('chartScrubber').addEventListener?.('blur',()=>{chartHoverIndex=null;$('chartTooltip').hidden=true;if(candlesAll.length)drawChart()});
 $('historyDate').addEventListener?.('change',e=>showHistoryDay(e.target.value));
 for(const id of ['scenarioPrincipal','scenarioRemaining'])$(id).addEventListener?.('input',e=>{if(id==='scenarioPrincipal'){$('scenarioRemaining').value=Number(e.target.value)*2}renderScenario()});
 if(typeof IntersectionObserver!=='undefined'){const sections=[...document.querySelectorAll('main>section[id]')],links=[...document.querySelectorAll('.nav a')];const observer=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top)[0];if(!visible)return;const id=visible.target.id;links.forEach(a=>{const active=a.getAttribute('href')==='#'+id||(id==='observations'&&a.getAttribute('href')==='#trend')||(id==='history'&&a.getAttribute('href')==='#metrics');a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current')})},{rootMargin:'-75px 0px -60% 0px',threshold:0});sections.forEach(s=>observer.observe(s))}
}
function startDashboard(){
 window.addEventListener('beforeprint',()=>{if(candlesAll.length)drawChart()});
 window.addEventListener('afterprint',()=>{if(candlesAll.length)drawChart()});
 window.addEventListener('resize',()=>{if(candlesAll.length)drawChart()});
 initEditorial();
 void deepScan();
 document.addEventListener('visibilitychange',refreshMarketWhenVisible);
 refreshMarketWhenVisible();
}
startDashboard();
