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
- Zero Transfer 与 X9C Mint 同笔 DORY→dEaD 永久分列。dEaD 不视为 totalSupply 减少。
- Swap 解码前核验指定池的 DORY/USDC 关系与 decimals；Swap 净额不包含 LP 增减，也不替代绝对储备。
- 5000U 整数倍 BUY 仅为原始矿池候选，尚未完整剔除套利/拆分复投，不称新增用户。
- 手续费区间与单池理论产出按用户提供机制估算；不称 X9 已实现收入。

## 每日更新与部署

工作流 `.github/workflows/dory-daily.yml` 每天 `00:00 UTC`（北京时间 08:00）计划运行，也支持手动运行和代码推送触发。GitHub 的定时任务可能延迟，页面始终显示实际快照时间。

流程：验证脚本 → 行情及链上滚动24h采集 → 保存 `data/latest.json` → 按北京时间日期更新 `data/history.json` → 提交快照 → 部署 GitHub Pages。重复运行覆盖同一天快照；部分采集失败以状态和错误记录保留，不填虚假零值。超过36小时的快照显示过期并关闭风险灯颜色。

仓库 Settings → Pages → Source 设为 **GitHub Actions**。发布产物只含页面脚本和数据，不包含研究交接文档或采集源代码。

公共 RPC 有超时、限流和历史日志范围限制。可在仓库 Actions secrets 中配置 `ARBITRUM_RPC_URL` 作为可选 RPC；不要提交任何凭据。

## 本地验证

需要 Node.js 22 或更新版本，无第三方 npm 依赖。

```sh
node --check dashboard.js
node --check scripts/update-data.mjs
node scripts/check-dashboard.mjs
node scripts/update-data.mjs
python3 -m http.server 8080
```

打开 http://127.0.0.1:8080 。采用系统 HTTP 代理的 Node 版本可用 `NODE_USE_ENV_PROXY=1` 运行采集。

持币地址、官方池绝对两侧储备、活跃矿池、套利/复投拆分、pendingBurn 分类与消化率没有可靠来源时保持未验证。K线仅显示取得的真实官方池 OHLCV，实际覆盖范围与当日未收盘提示在图下展示。
