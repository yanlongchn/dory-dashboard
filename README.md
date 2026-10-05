# DORY 每日监控 Dashboard

静态 Dashboard：自动显示 GitHub Actions 保存的每日快照，可手动刷新官方池行情。无法可靠取得的数据保持 `null / 未验证`，系统关键证据不足时显示“证据不足”。

## 发布地址

https://yanlongchn.github.io/dory-dashboard/

## 数据口径

- 网络：Arbitrum One
- DORY：`0x33b49f2264e85bB124d2730DC180182717D436Ae`
- USDC：`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`
- Uniswap v4 Pool ID：`0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb`
- PoolManager：`0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`
- X9 Charter：`0xecdDa172D2E8aa8efF55500fD28Da828CFfbc5B0`
- Zero Transfer与X9C原始认购销毁永久分列。X9C需原始TicketMinted、对应tokenId的ERC721 Mint、准确payer→dEaD金额三重一致；剔除拆分费用。dEaD不视为totalSupply减少。
- 7日Zero Transfer、X9C认购和Mint新增发行直接扫描完整7日范围，不累加可能重叠的滚动快照。X9C比率分母为Zero→非Zero新增发行，不称矿工理论产出。
- Swap解码前核验指定池的币种与精度；初始化事件的PoolKey哈希必须等于指定Pool ID。初始化基础费为1%，与用户提供的3%–5%总费用情景分列。
- 两侧本金通过官方ReservesLens固定区块读取全流动性曲线，不含未领取费用、捐赠或hook持有资产；不使用共享合约余额或TVL/2。该池hook没有return-delta权限。
- 归档调用验证chainId与相同L2区块哈希；lens在Arbitrum返回L1 NUMBER，与区块l1BlockNumber对照。供应比较从起始事件块前一块至固定终点。
- Blockscout持币数为核对币种、地址、精度后的索引快照；显示取回时间，不称精确链上更新时间。无同源7日前快照时不计算周变化。
- 5000U整数倍±8%的BUY按整笔交易归并，并剔除同笔BUY+SELL往返。`candidate_pools`为兼容历史快照保留的字段名，表示5000U金额份数，不表示实际矿池数、参与门槛或全量矿工本金；跨交易套利与复投仍未全量识别，不称新增用户。
- 手续费区间仍为用户早期提供的3%–5%情景，补充截图没有新的费率依据；不称 X9 已实现收入。示例计产美元额度与实际产币数量、领取、卖出分别展示。

## 最新挖矿口径（2026-10-05）

来源为用户补充的16张图片（IMG_0024—IMG_0039）及用户随后确认的结算口径；属于资料/业务定义，不自动视为合约已核验事实。完整定义、公式与修正边界见[挖矿规则](docs/mining-rules.md)。

- 参与金额不限；5000USD只作为示例及历史BUY金额筛选单位。
- 本金E按美元计，累计产出额度H=2×E（200%），不是即时现金回款。
- 日计产比例0.0085（0.85%）；每15分钟一次，每天96次。单次比例保持`0.0085/96`计算，不采用已撤回的48次或0.00017708。
- 第i次币数`q_i=(E*0.0085/96)/P_i`，`P_i`为当次结算价格（USD/DORY）；日产DORY为96次币数之和，不能用当前行情、日末价格或普通算术均价替代逐次价格。
- 5000USD示例：日计产美元额度42.50USD，单次0.442708333…USD；实际日产币数缺少96次结算记录时保持未知，不当作实际卖压。
- 社区/SVIP加速最高70%，替换早期约30%的机制表述；不是全体矿工统一奖励，不擅自叠加到基础日产出。六项收益为个人、邀请、社区、级别、合伙人、办公室；邀请不改变200%本金公式，Claim由钱包自行签名。
- 报价源、链上舍入、额度消耗和奖励等级分配仍未核验；课程已有直推、小区档位和级差口述，须与正式规则及流水区分；截图“总量只减不增”及权限陈述不替代totalSupply、Mint−Zero对账和全协议权限检查。

## 每日更新与部署

工作流 `.github/workflows/dory-daily.yml` 每天 `00:00 UTC`（北京时间 08:00）计划运行，也支持手动运行和代码推送触发。GitHub 的定时任务可能延迟，页面始终显示实际快照时间。

流程：验证脚本 → 行情及链上24h/7日采集 → 保存 `data/latest.json` → 按北京时间日期更新 `data/history.json` → 提交快照 → 部署 GitHub Pages。重复运行覆盖同一天快照；部分采集失败以状态和错误记录保留，不填虚假零值。超过36小时的快照显示过期并关闭风险灯颜色。

仓库 Settings → Pages → Source 设为 **GitHub Actions**。发布产物只含页面脚本和数据，不包含研究交接文档或采集源代码。

公共 RPC 有超时、限流和历史日志范围限制。可在仓库 Actions secrets 中配置 `ARBITRUM_RPC_URL` 作为可选 RPC；不要提交任何凭据。

## 本地验证

需要 Node.js 22 或更新版本，无第三方 npm 依赖。

```sh
node --check dashboard.js
node --check monitoring.js
node --check scripts/update-data.mjs
node scripts/check-dashboard.mjs
node scripts/verify-data.mjs
node scripts/verify-evidence.mjs
node scripts/verify-monitoring.mjs
node scripts/update-data.mjs
python3 -m http.server 8080
```

打开 http://127.0.0.1:8080 。采用系统 HTTP 代理的 Node 版本可用 `NODE_USE_ENV_PROXY=1` 运行采集。

活跃矿池本金、复投/跨交易套利与Pending自动或嵌套结算缺少可靠证据时保持未验证。显式processPendingBurn仅在直接调用参数与Zero Transfer账户匹配时单列。采集完成不会自动判定结构安全。

观察灯阈值：USDC本金与供应按增减方向；价格24h超过±3%；SELL/BUY超过1.1为红、低于0.9为绿；X9C/新增发行仅作中性流通转出参考，不以20%/100%阈值判定经营安全。无分母、无证据或过期保持灰色。本金减少、供应增加、SELL/BUY>1.1中至少两项出现时提示资金/供应承压，否则保留结构待核验。K线仅显示取得的真实官方池 OHLCV，实际覆盖范围与当日未收盘提示在图下展示。

依据：[Uniswap v4储备口径](https://developers.uniswap.org/docs/protocols/v4/guides/reading-pool-reserves)、[X9C已验证源码](https://arbitrum.blockscout.com/address/0xecdda172d2e8aa8eff55500fd28da828cffbc5b0?tab=contract)、[Blockscout索引](https://arbitrum.blockscout.com/api/v2/tokens/0x33b49f2264e85bb124d2730dc180182717d436ae)。

供应与事件对账分别读取真实totalSupply变化，再对照同窗口Mint与Zero Transfer净额（1e-6 DORY容差）；不以事件净额替代供应调用。对账不一致时记录差额、保留原始证据并关闭观察灯。日K按before_timestamp分页回溯并缓存已取得历史，数据商401/403权限边界明确显示，不能补造缺失K线。

## 课程补充后的每日机制监控

规则版本`2026-10-05-course-v1`，来源为用户提供的课程录音及重点片段二次转写。完整口径与边界见[每日监控规则](docs/monitoring-rules.md)。公开产物只发布必要规则摘要，不含录音、私密案例或本地路径。

- 直推一次性10%、V1—V7小区档位、级差、静态/动态共用200%额度标注为课堂口述；不自动当成链上已验证规则。
- 社区口述公式为小区金额×0.0085×等级比例，不能把70%统一加在个人基础日产上。“阿特拉斯”新协议的25%讨论意见不作为正式门槛。
- 新`monitoring.js`供页面与采集器共用，每日快照保留`monitoring`规则版本、24h/7日Mint−Zero与独立供应变化对账、其他/未知销毁比例及九项经营证据缺口。经营状态独立于采集status；缺失值保持null。
- 705B完整收款地址已确认；NFT身份及相关10%分红基数未知；与X9 Charter对应、实际分红与未来平台权益分别待核。X9C→dEaD不抵扣totalSupply，也不冒充平台收入。
- 会议付费销毁、直播质押、打赏转账、持仓准入各自追踪；不以未分类销毁或历史宣传用户数填充应用指标。
- 奖励演算提供本金、剩余额度、小区、等级四项输入，展示课堂公式及额度算术天数；保留级差、资格、新协议和现金兑现限制。剩余额度0与无效输入明确提示。
- 页面新增脚本与公开口径文档由Pages工作流一并发布；每日08:00任务继续，原13项核心表格与真实日K保留。

### 705B链上观察

新增完整24h/7日DORY流入、同区块DORY余额、同笔同转出方90%→Zero / 10%→705B分流组数、去重转出地址数、对应金额及未匹配流入。仅观察Transfer模式，不替代Pending状态、开矿本金或NFT分红核验。Zero分流腿已包含在原销毁总量中，五类销毁分类继续保持互斥。新来源失败时整体快照为partial，旧快照显示未验证。实测样本已见Pending清零，全网自动触发规则仍未验证。
