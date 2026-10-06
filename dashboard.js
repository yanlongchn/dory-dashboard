const DATA_LATEST='./data/latest.json', DATA_HISTORY='./data/history.json';
const DORY='0x33b49f2264e85bb124d2730dc180182717d436ae', USDC='0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const POOL='0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb';
const API='https://api.geckoterminal.com/api/v2/networks/arbitrum/pools/'+POOL;
const $=id=>document.getElementById(id), known=n=>typeof n==='number'&&Number.isFinite(n);
const fmt=(n,d=2)=>known(n)?n.toLocaleString('zh-CN',{maximumFractionDigits:d,minimumFractionDigits:d}):'未验证';
const money=n=>known(n)?'$'+n.toLocaleString('en-US',{maximumFractionDigits:0}):'未验证';
const signed=(n,d=2,suffix='')=>known(n)?(n>0?'+':'')+fmt(n,d)+suffix:'未验证';
let chartGeometry=null, chartHoverIndex=null, chartSelectedIndex=null;
let candlesAll=[], chartRange='all', marketState={}, chainState={}, history=[], snapshot=null;
const sourceNames={market:'官方池行情',pool_identity:'池币种与精度',chain_window:'24h / 7日区块窗口',holders:'持币地址索引',pool_key:'初始化参数与Pool ID',pool_reserves:'当前两侧本金',pool_reserves_24h:'24h本金变化',ohlcv:'真实日K',ohlcv_history:'日K历史覆盖',swaps:'24h买卖资金',supply:'当前供应',supply_24h:'24h历史供应',supply_7d:'7日历史供应',zero_burn:'24h / 7日Zero Transfer',zero_burn_categories:'24h销毁分类',x9c_mint:'24h / 7日原始X9C认购',mint_emissions:'24h / 7日新增发行',supply_event_reconciliation:'供应与事件窗口对账',chain_consistency:'采集区块一致性',distribution_705b:'705B流入与同笔分流',distribution_705b_balance:'705B快照DORY余额'};
function tableRow(values){const tr=document.createElement('tr');tr.replaceChildren(...values.map(value=>{const td=document.createElement('td');td.textContent=value;return td}));return tr}
function evidencePanels(d){
 const rows=Object.entries(sourceNames).map(([key,label])=>{const s=d.sources?.[key];return tableRow([label,s?.status==='ok'?'采集完成':s?.status==='partial'?'部分覆盖':s?.status==='failed'?'采集失败':'未核验',s?.error||s?.reason||(s?.collected_at?asOf(s.collected_at):s?.evidence||'等待来源')])});$('sourceRows').replaceChildren(...rows);
 const pending=['实际日产DORY与全网卖压：缺少有效本金及96次结算价格、产出和实际卖出记录。','新增参与、新钱包、复投、跨交易套利：5000U筛选只反映金额特征，不是开矿门槛或全量矿池数。','奖励规则：直推、小区档位及级差已有课堂口述，正式分配、共用额度和新协议资格仍待核验。','NFT与应用：705B完整收款地址已确认；NFT身份、10%分红基数及会议 / 直播 / 打赏链路仍待核验。'];
 const old=history.find(h=>h.date===(new Date(Date.parse((d.date_bj||bjDate())+'T00:00:00+08:00')-7*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})));
 const delta=known(old?.holders?.count)&&old.holders?.source===d.holders?.source&&known(d.holders?.count)?d.holders.count-old.holders.count:null;
 $('holdersDelta7').textContent=known(delta)?signed(delta,0,' 地址'):'无同源7日前基线';
 if(!known(delta))pending.push('持币地址7日变化：尚未累积同源7日前快照。');
 if(!known(d.pool?.usdc_reserve))pending.push('官方池两侧本金：当前读取失败或hook存在自定义记账。');
 if(!known(d.supply?.change_7d))pending.push('7日供应：缺少相同区块哈希的归档状态。');
 if(d.ohlcv_coverage&&!d.ohlcv_coverage.complete)pending.push('日K目标2025-09-09：实际最早'+d.ohlcv_coverage.actual_from.slice(0,10)+'；'+d.ohlcv_coverage.reason+'。');
 $('pendingEvidence').replaceChildren(...pending.map(text=>{const li=document.createElement('li');li.textContent=text;return li}));
 const recent=history.slice(-7);$('historyRows').replaceChildren(...recent.map(h=>tableRow([h.date,asOf(h.generated_at),money(h.pool?.usdc_reserve),signed(h.supply?.change_24h),fmt(h.zero_burn?.total_dory),fmt(h.x9c_dead_burn?.total_dory),fmt(h.holders?.count,0)])));
 renderHistoryPicker();
 $('historyNote').textContent=recent.length<2?'当前仅有'+recent.length+'个日期；每日更新后形成趋势，同日重跑覆盖当日。':'展示真实每日记录；不同采集时刻的滚动24h窗口不能直接累加为7日。';
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
function renderMonitoring(d){
 const model=DoryMonitoring.build(d),day=model.flow.day,week=model.flow.week,usable=day.status==='ok';
 $('monitorStatus').textContent=model.chain_flow_status==='ok'?'链上流量对账通过 · 经营证据仍待补齐':model.chain_flow_status==='stale'?'历史快照 · 等待新采集':'流量证据未齐 · 不作机制判断';
 $('monitorMint').textContent=usable?fmt(day.minted)+' DORY':'未验证';$('monitorZero').textContent=usable?fmt(day.zero_transfer)+' DORY':'未验证';
 $('monitorNet').textContent=usable?signed(day.supply_change,2,' DORY'):'未验证';
 $('monitorUnknown').textContent=known(model.flow.unknown_burn_pct)?fmt(model.flow.unknown_burn_pct,1)+'%':model.flow.unknown_burn_24h===0&&day.zero_transfer===0?'无销毁分母':'未验证';
 $('monitorUnknownNote').textContent=known(model.flow.unknown_burn_24h)?'其他 / 未知 '+fmt(model.flow.unknown_burn_24h)+' DORY':'等待完整销毁分类';
 $('monitorFlowRows').replaceChildren(...[['24h',day],['7日',week]].map(([label,w])=>tableRow([label,w.status==='ok'?fmt(w.minted):'未验证',w.status==='ok'?fmt(w.zero_transfer):'未验证',w.status==='ok'?signed(w.supply_change):'未验证',w.status==='ok'?known(w.zero_cover_pct)?fmt(w.zero_cover_pct,1)+'%':'新增发行0，无分母':'未验证',w.status==='ok'?'Mint − Zero 与供应变化一致':w.status==='inconsistent'?'对账不一致，暂停解释':'窗口证据未齐'])));
 $('monitorX9').textContent='X9C原始认购 → dEaD：'+fmt(model.flow.x9c_dead_24h)+' DORY / 24h。此转出不从totalSupply对账中扣除，也不代表705B分红或平台全部应用销毁。';
 const watch=model.distribution;
 $('receiverBalance').textContent=fmt(watch.balance_dory)+' DORY';
 $('receiverStatus').textContent=(model.fresh?'当前快照':'历史快照')+' · '+(watch.day.status==='ok'&&watch.week.status==='ok'?'完整窗口分流统计已采集':'等待完整窗口分流证据');
 $('receiverRows').replaceChildren(...[['24h',watch.day],['7日',watch.week]].map(([label,w])=>tableRow([label,...(w.status==='ok'?[fmt(w.incoming_dory),fmt(w.matched_pairs,0),fmt(w.matched_wallets,0),fmt(w.matched_zero_dory),fmt(w.matched_receiver_dory),known(w.zero_share_pct)?fmt(w.zero_share_pct,1)+'%':'无Zero分母',fmt(w.unmatched_incoming_dory)]:Array(7).fill('未验证'))])));
 $('mechanismRows').replaceChildren(...model.required_evidence.map(item=>tableRow([item.title,'待补证',item.need,item.impact])));
 $('mechanismCount').textContent=model.required_evidence.length+'项经营依据待补齐 · 与链上采集完成分别展示';
 $('courseRows').replaceChildren(...DoryMonitoring.rules.course.levels.map(tier=>tableRow(['V'+tier.level,fmt(tier.small_area_usd,0)+' U',fmt(tier.rate*100,0)+'%'])));
 renderScenario();
}
function renderScenario(){
 const input=id=>{const value=$(id).value;return typeof value==='string'&&value.trim()!==''?Number(value):NaN};
 const value=DoryMonitoring.scenario({principal:input('scenarioPrincipal'),remaining:input('scenarioRemaining'),smallArea:input('scenarioSmallArea'),level:input('scenarioLevel')});
 for(const [id,key] of [['scenarioBase','base'],['scenarioBlock','settlement'],['scenarioCommunity','community'],['scenarioTotal','total']])$(id).textContent=value.valid?fmt(value[key],id==='scenarioBlock'?8:2)+' USD':'输入待修正';
 $('scenarioDays').textContent=value.valid?fmt(value.arithmetic_days,2)+'天（算术）':'输入待修正';
 $('scenarioNote').textContent=!value.valid?'本金需大于0，剩余额度须在0至2×本金之间，小区金额不得为负；请填写完整数值。':value.quota_finished?'剩余额度为0；口述产满即止。上方金额仅为公式值，不能视为仍可领取。':(value.below_course_threshold?'小区金额低于所选等级的课堂门槛。':'')+'仅演算课堂公式，不判断等级或新协议资格。社区项未扣级差；算术天数假设金额持续不变、共用额度、无追加 / 直推及其他奖励。实际计产、领取与现金到账均待核验。';
}
function renderMarket(m){marketState=m||{};const p=m?.price_usd;const price=known(p)?'$'+fmt(p,4):'未验证';$('price').textContent=price;$('tbPrice').textContent=price;
 $('volume').textContent=money(m?.volume_24h);$('tbVol').textContent=money(m?.volume_24h);$('reserveUsd').textContent=money(m?.liquidity_usd);$('tbLiq').textContent=money(m?.liquidity_usd);
 $('buys').textContent=known(m?.buys)?fmt(m.buys,0)+' 笔':'未验证';$('sells').textContent=known(m?.sells)?fmt(m.sells,0)+' 笔':'未验证';setPct('chg24',m?.change_24h_pct);setPct('chg7',m?.change_7d_pct);$('tb24').textContent=signed(m?.change_24h_pct,2,'%');
 $('feeRange').textContent=known(m?.volume_24h)?money(m.volume_24h*.03)+'–'+money(m.volume_24h*.05):'未验证';
 const v=m?.change_24h_pct;setLight('lPrice','tPrice',known(v)?v>3?'green':v<-3?'red':'yellow':'',signed(v,1,'% / 24h'));
}
function renderSnapshot(d){snapshot=d;const m=d.market||{}, p=d.pool||{}, s=d.supply||{}, z=d.zero_burn||{}, x=d.x9c_dead_burn||{}, c=d.pool_candidates||{};
 renderMarket(m);chainState={buyAmt:m.buy_usdc,sellAmt:m.sell_usdc,usdcPoolNet:p.swap_net_usdc,doryPoolNet:p.swap_net_dory,supply:s.total_supply,supplyDelta:s.change_24h,zeroTotal:z.total_dory,x9burn:x.total_dory,poolCount:c.candidate_pools};
 $('buyAmt').textContent=money(m.buy_usdc);$('sellAmt').textContent=money(m.sell_usdc);$('usdcNet').textContent=signed(p.swap_net_usdc,0,' U');$('doryNet').textContent=signed(p.swap_net_dory,2,' DORY');
 $('supply').textContent=fmt(s.total_supply);$('supplyDelta').textContent=signed(s.change_24h,2);pctClass($('supplyDelta'),known(s.change_24h)?-s.change_24h:null);
 $('supplyDelta7').textContent=signed(s.change_7d,2,' DORY');$('minted24').textContent=known(s.minted_24h)?fmt(s.minted_24h)+' DORY':'未验证';
 $('reserveUsdc').textContent=money(p.usdc_reserve);$('reserveDory').textContent=fmt(p.dory_reserve);$('reserveDelta').textContent=signed(p.usdc_change_24h,0,' U');
 $('poolFee').textContent=known(p.key?.fee)?fmt(p.key.fee/10000,2)+'%':'未验证';
 $('zeroBurn').textContent=fmt(z.total_dory);for(const [id,key] of [['zbSell','sell_swap'],['zbBuy','buy_swap'],['zbDirect','direct_transfer'],['zbOther','other']])$(id).textContent=fmt(z.categories?.[key]?.dory);
 $('x9burn').textContent=known(x.total_dory)?fmt(x.total_dory)+' DORY':'未验证';$('x9mintTx').textContent=known(x.transactions)?fmt(x.transactions,0)+' 笔':'未验证';
 $('zero7').textContent=fmt(z.total_7d);$('zbExplicit').textContent=fmt(z.categories?.explicit_pending_call?.dory);
 $('x9burn7').textContent=known(x.total_7d)?fmt(x.total_7d)+' DORY':'未验证';$('x9Absorption').textContent=known(x.absorption_24h_pct)?fmt(x.absorption_24h_pct,2)+'%':s.minted_24h===0?'新增发行为0，无分母':'未验证';
 $('pools').textContent=known(c.candidate_pools)?fmt(c.candidate_pools,0)+' 份金额单位':'未验证';$('poolTxs').textContent=known(c.transactions)?fmt(c.transactions,0)+' 笔':'未验证';$('poolCapital').textContent=money(c.candidate_usdc);$('poolMax').textContent=money(c.max_usdc);
 $('holders').textContent=fmt(d.holders?.count,0);$('holdersAsOf').textContent=d.holders?.as_of?asOf(d.holders.as_of):'未验证';
 $('poolRoundtrip').textContent=known(c.same_tx_roundtrips_excluded)?fmt(c.same_tx_roundtrips_excluded,0)+' 笔':'未验证';
 $('tbReserve').textContent=money(p.usdc_reserve);$('tbReservePrev').textContent=money(p.baseline_24h?.usdc_reserve);$('tbSupply7').textContent=signed(s.change_7d);$('tbZero7').textContent=fmt(z.total_7d);$('tbX97').textContent=fmt(x.total_7d);$('tbHolders').textContent=fmt(d.holders?.count,0);
 $('tbUsdcNet').textContent=signed(p.swap_net_usdc,0,' U');$('tbZero').textContent=fmt(z.total_dory);$('tbX9').textContent=fmt(x.total_dory);$('tbPools').textContent=known(c.candidate_pools)?fmt(c.candidate_pools,0)+' 份':'未验证';$('tbSupplyDelta').textContent=signed(s.change_24h);
 const values=[m.price_usd,m.volume_24h,m.liquidity_usd,p.swap_net_usdc,z.total_dory,x.total_dory,c.candidate_pools,s.change_24h,p.usdc_reserve,s.change_7d,z.total_7d,x.total_7d,d.holders?.count]; document.querySelectorAll('#metricRows tr').forEach((row,i)=>{row.cells[3].textContent=known(values[i])?i===6?'金额筛选':i===12?'索引快照':'已取得（快照）':'未验证'});
 const inconsistent=d.sources?.chain_consistency?.status==='failed'||d.sources?.supply_event_reconciliation?.status==='failed';
 const timestamp=Date.parse(d.generated_at), stale=!Number.isFinite(timestamp)||timestamp>Date.now()+300000||Date.now()-timestamp>36*3600000||inconsistent;
 setSource('srcChain','每日快照：'+(!d.generated_at?'未采集':stale?inconsistent?'证据不一致':'已过期':d.status==='ok'?'采集完成':'部分指标未验证'),stale||d.status==='not_collected'?'err':d.status==='ok'?'ok':'busy');
 setSource('srcMarket','行情快照：'+(known(m.price_usd)?'已取得':'未验证'),known(m.price_usd)&&!stale?'ok':'busy');setSource('srcRpc','链上采集：'+(known(s.total_supply)?'供应已取得':'未验证'),known(s.total_supply)&&!stale?'ok':'busy');
 setSource('srcHolders','持币地址：'+(known(d.holders?.count)?'索引快照':'未验证'),known(d.holders?.count)&&!stale?'ok':'busy');
 const coverage=values.filter(known).length;$('coverageSummary').textContent='核心表格 '+coverage+' / '+values.length+' 项已取得（含候选与索引）；经营结构仍需补证。';$('progressBar').style.width=Math.round(coverage/values.length*100)+'%';
 $('asof').textContent='快照 '+asOf(d.generated_at);$('scanStatus').textContent='快照 '+asOf(d.generated_at)+'；'+(d.blocks?.from&&d.blocks?.to?'滚动24h区块 '+d.blocks.from+'–'+d.blocks.to+'；':'')+(stale?inconsistent?'区块或供应事件对账未通过，观察灯保持灰色。':'当前快照已过期，观察灯保持灰色。':'未核验指标保持灰色。');
 setLight('lUsdc','tUsdc',!stale&&known(p.usdc_change_24h)?p.usdc_change_24h>0?'green':p.usdc_change_24h<0?'red':'yellow':'',known(p.usdc_change_24h)?signed(p.usdc_change_24h,0,' U / 24h本金'):'本金变化未验证');
 setLight('lSupply','tSupply',!stale&&known(s.change_24h)?s.change_24h<0?'green':s.change_24h>0?'red':'yellow':'',signed(s.change_24h,1,' DORY'));
 const absorption=x.absorption_24h_pct;setLight('lX9','tX9','',known(absorption)?fmt(absorption,1)+'% · 流通转出参考':s.minted_24h===0?'新增发行为0，无分母':'新增发行分母未验证');const r=ratio(m.buy_usdc,m.sell_usdc);
 setLight('lTrade','tTrade',!stale&&r!==null?r>1.1?'red':r<.9?'green':'yellow':'',r===Infinity?'仅SELL，无BUY':r===null?'金额未验证':'金额 SELL/BUY '+fmt(r,2)+'×');
 const date=d.date_bj||bjDate(d.generated_at||Date.now()), prev=history.filter(h=>h.date<date).at(-1);
 $('prevUsdcNet').textContent=prev?signed(prev.pool?.swap_net_usdc,0,' U'):'无历史基线';$('prevZero').textContent=prev?fmt(prev.zero_burn?.total_dory):'无历史基线';$('prevX9').textContent=prev?fmt(prev.x9c_dead_burn?.total_dory):'无历史基线';$('prevPools').textContent=known(prev?.pool_candidates?.candidate_pools)?fmt(prev.pool_candidates.candidate_pools,0)+' 份':'无历史基线';
 setLight('lPool','tPool','','新钱包/复投/套利未验证');
 if(stale)for(const [id,tid] of [['lPool','tPool'],['lUsdc','tUsdc'],['lSupply','tSupply'],['lPrice','tPrice'],['lX9','tX9'],['lTrade','tTrade']])setLight(id,tid,'',inconsistent?'证据不一致':'快照已过期');
 const stress=[known(p.usdc_change_24h)?p.usdc_change_24h<0:null,known(s.change_24h)?s.change_24h>0:null,r===null?null:r>1.1].filter(v=>v===true).length;
 $('systemState').textContent=!stale&&stress>=2?'资金 / 供应承压':!stale&&known(p.usdc_change_24h)&&known(s.change_24h)?'结构仍待核验':'证据不足';$('systemState').className=!stale&&stress>=2?'down':'muted';
 const risks=[];if(stale)risks.push(inconsistent?'区块或供应事件对账未通过，请核对来源表。':'当前快照已过期，请检查每日采集工作流。');
 if(known(m.sell_usdc)&&known(m.buy_usdc))risks.push('官方池24h BUY '+money(m.buy_usdc)+' / SELL '+money(m.sell_usdc)+'；Swap净额不含LP增减。');
 if(known(p.usdc_change_24h)&&known(s.change_24h))risks.push('官方池USDC本金24h '+signed(p.usdc_change_24h,0,' U')+'；净供应 '+signed(s.change_24h,2,' DORY')+'。');
 const monitor=DoryMonitoring.build(d);if(known(monitor.flow.unknown_burn_pct)&&monitor.flow.unknown_burn_pct>0)risks.push('Zero Transfer中 '+fmt(monitor.flow.unknown_burn_pct,1)+'%仍归其他 / 未知，不能整体归因为应用消费或Pending自动结算；同笔90% / 10%分流模式另列观察。');
 risks.push('新协议资格与静态 / 动态共用200%额度需正式规则及流水；活跃本金、实际产币与卖压不补数。');
 const errors=d.errors||[];if(errors.length)risks.unshift('部分采集失败：'+errors.map(e=>typeof e==='string'?e:e.component||e.source||e.message||'未验证').join('；'));
 $('riskList').replaceChildren(...risks.slice(0,4).map(text=>{const li=document.createElement('li');li.textContent=text;return li}));
 $('reportDate').textContent=(d.date_bj||bjDate(d.generated_at||Date.now())).replace(/-/g,' / ')+' · 每日数据观察';
 evidencePanels(d);
 renderMonitoring(d);
 useCandles(d.ohlcv);
}
function useCandles(input){const rows=Array.isArray(input)?input:input?.candles||input?.ohlcv_list||[]; if(!Array.isArray(rows))return;
 const valid=rows.map(x=>Array.isArray(x)?{t:x[0]*1000,o:x[1],h:x[2],l:x[3],c:x[4],v:x[5]}:x).filter(x=>[x.t,x.o,x.h,x.l,x.c,x.v].every(known)&&x.t>=Date.parse('2025-09-09T00:00:00Z')&&x.l>=0&&x.h>=Math.max(x.o,x.c)&&x.l<=Math.min(x.o,x.c)&&x.v>=0).sort((a,b)=>a.t-b.t);
 candlesAll=[...new Map([...candlesAll,...valid].map(c=>[c.t,c])).values()].sort((a,b)=>a.t-b.t);
 if(candlesAll.length)drawChart();else{$('chartMeta').textContent='OHLCV 未取得';$('chartNote').textContent='未取得官方池真实OHLCV，保留空白，不生成替代K线。'}
}
const flashIds=['price','volume','reserveUsdc','reserveDelta','supplyDelta'];
function captureValues(){return new Map(flashIds.map(id=>[id,$(id).textContent]))}
function highlightChanges(before){if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;for(const id of flashIds){const el=$(id);if(before.get(id)!==el.textContent&&before.get(id)!=='未验证')el.animate?.([{backgroundColor:themeColor('--flash','#e7ddc6')},{backgroundColor:'transparent'}],{duration:650,easing:'ease-out'})}}
async function deepScan(){const b=$('chainBtn'),label=b.textContent,before=captureValues(),hadSnapshot=!!snapshot;b.disabled=true;b.textContent='加载中…';$('refreshNote').textContent='正在读取已采集的每日快照';try{const [d,h]=await Promise.all([getJSON(DATA_LATEST),getJSON(DATA_HISTORY)]);history=(h.snapshots||[]).sort((a,b)=>a.date.localeCompare(b.date));renderSnapshot(d);if(hadSnapshot)highlightChanges(before);$('refreshNote').textContent='快照已加载 · 采集时间见今日观察'}catch(e){setSource('srcChain','每日快照：加载失败','err');$('scanStatus').textContent='快照加载失败：'+e.message+'；已有结果及时间保留。';$('refreshNote').textContent='加载失败，保留已有快照'}finally{b.disabled=false;b.textContent=label}}
async function loadMarket(){const b=$('marketBtn'),label=b.textContent,before=captureValues();if(b.disabled)return;b.disabled=true;b.textContent='刷新中…';$('refreshNote').textContent='正在读取官方池行情';setSource('srcMarket','行情：刷新中','busy');try{
 const pool=await getJSON(API+'?include=base_token,quote_token');const rel=pool.data.relationships;
 const base=rel.base_token.data.id.toLowerCase(),quote=rel.quote_token.data.id.toLowerCase();
 if(pool.data.id.toLowerCase()!=='arbitrum_'+POOL||pool.data.attributes.address.toLowerCase()!==POOL||rel.dex?.data?.id!=='uniswap-v4-arbitrum'||
   ![base,quote].includes('arbitrum_'+DORY)||![base,quote].includes('arbitrum_'+USDC))throw new Error('官方池DORY/USDC关系未核验');
 for(const [address,decimals] of [[DORY,18],[USDC,6]]){const t=pool.included?.find(t=>t.id.toLowerCase()==='arbitrum_'+address);if(t?.attributes?.address?.toLowerCase()!==address||t?.attributes?.decimals!==decimals)throw Error('行情Token精度未核验')}
 const token=base==='arbitrum_'+DORY?'base':'quote',a=pool.data.attributes,tx=a.transactions?.h24||{};
 const number=x=>x===null||x===undefined||x===''?null:Number.isFinite(Number(x))?Number(x):null;
 renderMarket({...marketState,price_usd:number(token==='base'?a.base_token_price_usd:a.quote_token_price_usd),volume_24h:number(a.volume_usd?.h24),liquidity_usd:number(a.reserve_in_usd),change_24h_pct:token==='base'?number(a.price_change_percentage?.h24):null,change_7d_pct:null,buys:number(token==='base'?tx.buys:tx.sells),sells:number(token==='base'?tx.sells:tx.buys)});
 setSource('srcMarket','行情：手动刷新 '+asOf(new Date().toISOString()),'ok');highlightChanges(before);$('refreshNote').textContent='行情已更新 · 每日快照时间保留';
 try{const o=await getJSON(API+'/ohlcv/day?aggregate=1&limit=1000&currency=usd&token='+DORY);useCandles(o.data.attributes.ohlcv_list);const last=candlesAll.at(-1);const seven=last&&candlesAll.filter(x=>x.t<=last.t-7*86400000).at(-1);if(seven?.c>0)setPct('chg7',(last.c/seven.c-1)*100)}catch(e){$('chartNote').textContent='K线刷新失败：'+e.message+'；保留快照K线。'}
 }catch(e){setSource('srcMarket','行情：刷新失败；保留快照','err');$('scanStatus').textContent='行情接口失败：'+e.message+'；快照时间保留。';$('refreshNote').textContent='行情刷新失败，保留快照'}finally{b.disabled=false;b.textContent=label}}

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
function showHistoryDay(date){const d=history.find(h=>h.date===date);if(!d)return;$('historySummary').textContent=date+' · USDC本金 '+money(d.pool?.usdc_reserve)+'，24h净供应 '+signed(d.supply?.change_24h,2,' DORY')+'，Zero Transfer '+fmt(d.zero_burn?.total_dory)+' DORY。采集于 '+asOf(d.generated_at)+'；这里只切换每日留档，今日快照保持原值。';document.querySelectorAll('#historyRows tr').forEach(row=>row.classList.toggle('selected',row.cells[0].textContent===date))}
function initEditorial(){
 if(typeof DoryTheme!=='undefined'){DoryTheme.syncButton();$('themeToggle').addEventListener?.('click',()=>DoryTheme.toggle());DoryTheme.subscribe(()=>{if(candlesAll.length)drawChart()})}
 const cv=$('chart');
 const point=e=>{if(!chartGeometry)return;const g=chartGeometry,box=cv.getBoundingClientRect(),index=Math.max(0,Math.min(g.candles.length-1,Math.floor((e.clientX-box.left-g.L)/(g.W-g.L-g.R)*g.candles.length)));chartHoverIndex=index;chartSelectedIndex=index;drawChart()};
 cv.addEventListener?.('pointermove',e=>{if(e.pointerType!=='touch')point(e)});cv.addEventListener?.('click',point);cv.addEventListener?.('pointerleave',()=>{chartHoverIndex=null;$('chartTooltip').hidden=true;if(candlesAll.length)drawChart()});
 $('chartScrubber').addEventListener?.('input',e=>{chartSelectedIndex=Number(e.target.value);chartHoverIndex=chartSelectedIndex;drawChart()});$('chartScrubber').addEventListener?.('blur',()=>{chartHoverIndex=null;$('chartTooltip').hidden=true;if(candlesAll.length)drawChart()});
 $('historyDate').addEventListener?.('change',e=>showHistoryDay(e.target.value));
 for(const id of ['scenarioPrincipal','scenarioRemaining','scenarioSmallArea','scenarioLevel'])$(id).addEventListener?.('input',e=>{if(id==='scenarioPrincipal'){$('scenarioRemaining').value=Number(e.target.value)*2}renderScenario()});
 if(typeof IntersectionObserver!=='undefined'){const sections=[...document.querySelectorAll('main>section[id]')],links=[...document.querySelectorAll('.nav a')];const observer=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top)[0];if(!visible)return;const id=visible.target.id;links.forEach(a=>{const active=a.getAttribute('href')==='#'+id||(id==='observations'&&a.getAttribute('href')==='#trend')||(id==='history'&&a.getAttribute('href')==='#metrics');a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current')})},{rootMargin:'-75px 0px -60% 0px',threshold:0});sections.forEach(s=>observer.observe(s))}
}
window.addEventListener('beforeprint',()=>{if(candlesAll.length)drawChart()});window.addEventListener('afterprint',()=>{if(candlesAll.length)drawChart()});
window.addEventListener('resize',()=>{if(candlesAll.length)drawChart()});initEditorial();deepScan();
