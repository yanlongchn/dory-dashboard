import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finiteNumber, beijingDay, validatePool, decodeSwap, isX9Mint, isDirectZeroTransfer, getLogs, collect, saveResult } from "./update-data.mjs";

const DORY = "0x33b49f2264e85bb124d2730dc180182717d436ae";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const POOL = "0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb";
const PM = "0x360e68faccca8ca495c1b759fd9eee466db9fb32";
const X9 = "0xecdda172d2e8aa8eff55500fd28da828cffbc5b0";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const ZERO = "0x" + "0".repeat(64);
const word = n => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
function poolResponse() {
  return { data: { id: `arbitrum_${POOL}`, attributes: { address: POOL }, relationships: {
    base_token: { data: { id: `arbitrum_${USDC}` } }, quote_token: { data: { id: `arbitrum_${DORY}` } },
    dex: { data: { id: "uniswap-v4-arbitrum" } } } }, included: [DORY, USDC].map(address =>
    ({ id: `arbitrum_${address}`, attributes: { address, decimals: address === DORY ? 18 : 6 } })) };
}
test("missing numeric data remains unverified while a real zero survives", () => {
  for (const missing of [null, undefined, "", "not a number"]) assert.equal(finiteNumber(missing), null);
  assert.equal(finiteNumber("0"), 0);
});
test("verified token order remains correct when API base/quote is reversed", () => {
  const response = poolResponse(), identity = validatePool(response);
  assert.equal(identity.currency0, DORY); assert.equal(identity.currency1, USDC); assert.equal(identity.dory_is_base, false);
  const delta = decodeSwap({ address: PM, topics: [SWAP, POOL], data: "0x" + word(2n * 10n ** 18n) + word(-5000n * 10n ** 6n) }, identity);
  assert.deepEqual(delta, { dory: 2, usdc: -5000 });
  response.data.relationships.base_token.data.id = "arbitrum_0x0000000000000000000000000000000000000001";
  assert.throws(() => validatePool(response), /not DORY\/USDC/);
});
test("X9 arbitrary logs are not ERC721 Mints", () => {
  const mint = { address: X9, topics: [TRANSFER, ZERO, "0x" + "0".repeat(24) + DORY.slice(2), "0x" + word(1)], data: "0x" };
  assert.equal(isX9Mint(mint), true);
  assert.equal(isX9Mint({ ...mint, topics: mint.topics.slice(0, 3) }), false);
  assert.equal(isX9Mint({ ...mint, topics: [TRANSFER, mint.topics[2], mint.topics[2], mint.topics[3]] }), false);
});
test("direct transfer classification requires the encoded Zero recipient", () => {
  assert.equal(isDirectZeroTransfer({ to: DORY, input: "0xa9059cbb" + word(0) + word(100) }), true);
  assert.equal(isDirectZeroTransfer({ to: DORY, input: "0xa9059cbb" + word(1) + word(100) }), false);
});
test("adaptive log splitting covers every requested block without gaps or duplicates", async () => {
  let rejected = 0;
  const rpc = async (_, [filter]) => {
    const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
    if (to - from + 1 > 2) { rejected++; const e = new Error("block range limit"); e.rangeRetryable = true; throw e; }
    return Array.from({ length: to - from + 1 }, (_, i) => ({ blockNumber: from + i }));
  };
  const logs = await getLogs(rpc, PM, 10, 18, [], { maxStep: 8, minStep: 1 });
  assert.deepEqual(logs.map(x => x.blockNumber), [10, 11, 12, 13, 14, 15, 16, 17, 18]); assert.ok(rejected > 0);
});
test("failed source requests produce null evidence rather than successful zeroes", async () => {
  const originalFetch = globalThis.fetch, originalLimit = process.env.DORY_MAX_REQUESTS;
  process.env.DORY_MAX_REQUESTS = "1";
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  try {
    const result = await collect();
    assert.equal(result.status, "evidence_insufficient"); assert.equal(result.market.buy_usdc, null);
    assert.equal(result.zero_burn.total_dory, null); assert.equal(result.x9c_dead_burn.total_dory, null);
    assert.ok(result.errors.length > 0); assert.deepEqual(result.ohlcv, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLimit === undefined) delete process.env.DORY_MAX_REQUESTS; else process.env.DORY_MAX_REQUESTS = originalLimit;
  }
});
test("Beijing dates cross UTC midnight and same local day replaces its earlier snapshot", () => {
  assert.equal(beijingDay(new Date("2026-10-03T20:00:00Z")), "2026-10-04");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dory-data-contract-"));
  try {
    saveResult({ generated_at: "2026-10-03T20:00:00Z", status: "partial", ohlcv: [] }, directory);
    saveResult({ generated_at: "2026-10-04T08:00:00Z", status: "ok", ohlcv: [] }, directory);
    const history = JSON.parse(fs.readFileSync(path.join(directory, "history.json"), "utf8"));
    assert.equal(history.snapshots.length, 1); assert.equal(history.snapshots[0].date, "2026-10-04");
    assert.equal(history.snapshots[0].status, "ok"); assert.equal(history.snapshots[0].ohlcv, undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
