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
- 5000U整数倍±8%的BUY按整笔交易归并，并剔除同笔BUY+SELL往返；跨交易套利与复投仍未全量识别，不称新增用户。
- 手续费区间与单池理论产出按用户提供机制估算；不称 X9 已实现收入。

## 每日更新与部署

工作流 `.github/workflows/dory-daily.yml` 每天 `00:00 UTC`（北京时间 08:00）计划运行，也支持手动运行和代码推送触发。GitHub 的定时任务可能延迟，页面始终显示实际快照时间。

流程：验证脚本 → 行情及链上24h/7日采集 → 保存 `data/latest.json` → 按北京时间日期更新 `data/history.json` → 提交快照 → 部署 GitHub Pages。重复运行覆盖同一天快照；部分采集失败以状态和错误记录保留，不填虚假零值。超过36小时的快照显示过期并关闭风险灯颜色。

仓库 Settings → Pages → Source 设为 **GitHub Actions**。发布产物只含页面脚本和数据，不包含研究交接文档或采集源代码。

公共 RPC 有超时、限流和历史日志范围限制。可在仓库 Actions secrets 中配置 `ARBITRUM_RPC_URL` 作为可选 RPC；不要提交任何凭据。

## 本地验证

需要 Node.js 22 或更新版本，无第三方 npm 依赖。

```sh
node --check dashboard.js
node --check scripts/update-data.mjs
node scripts/check-dashboard.mjs
node scripts/verify-data.mjs
node scripts/verify-evidence.mjs
node scripts/update-data.mjs
python3 -m http.server 8080
```

打开 http://127.0.0.1:8080 。采用系统 HTTP 代理的 Node 版本可用 `NODE_USE_ENV_PROXY=1` 运行采集。

活跃矿池本金、复投/跨交易套利与Pending自动或嵌套结算缺少可靠证据时保持未验证。显式processPendingBurn仅在直接调用参数与Zero Transfer账户匹配时单列。采集完成不会自动判定结构安全。

观察灯阈值：USDC本金与供应按增减方向；价格24h超过±3%；SELL/BUY超过1.1为红、低于0.9为绿；X9C/新增发行低于20%为红、至少100%为绿。无分母、无证据或过期保持灰色。本金减少、供应增加、SELL/BUY>1.1中至少两项出现时提示资金/供应承压，否则保留结构待核验。K线仅显示取得的真实官方池 OHLCV，实际覆盖范围与当日未收盘提示在图下展示。

依据：[Uniswap v4储备口径](https://developers.uniswap.org/docs/protocols/v4/guides/reading-pool-reserves)、[X9C已验证源码](https://arbitrum.blockscout.com/address/0xecdda172d2e8aa8eff55500fd28da828cffbc5b0?tab=contract)、[Blockscout索引](https://arbitrum.blockscout.com/api/v2/tokens/0x33b49f2264e85bb124d2730dc180182717d436ae)。

供应与事件对账分别读取真实totalSupply变化，再对照同窗口Mint与Zero Transfer净额（1e-6 DORY容差）；不以事件净额替代供应调用。对账不一致时记录差额、保留原始证据并关闭观察灯。日K按before_timestamp分页回溯并缓存已取得历史，数据商401/403权限边界明确显示，不能补造缺失K线。
