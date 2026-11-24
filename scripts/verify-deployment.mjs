import test from 'node:test';
import assert from 'node:assert/strict';
import {checkSite, verifyPublishedSite} from './site-health.mjs';
import {deployPages, writeManifest} from './deploy-pages.mjs';
import {monitorDeployment} from './monitor-deployment.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const now = Date.parse('2026-11-25T00:00:00Z');
const timestamp = new Date(now - 10 * 60000).toISOString();
const manifest = {run_id: '123', run_attempt: '1', commit: 'a'.repeat(40), market_generated_at: timestamp, daily_generated_at: timestamp};
const market = {generated_at: timestamp, provider: 'Uniswap', chain_id: 42161,
  pool_id: '0xec6e37b2d66aa5ef5a9fc296b4da3474b121f512428dd425a51c6424955fc5eb', market: {price_usd: 718}};
const daily = {generated_at: timestamp, status: 'ok'};
const health = {...manifest};
const context = {repo: {owner: 'yanlongchn', repo: 'dory-dashboard'}, sha: 'a'.repeat(40)};
function coreMock() {
  const messages = [], outputs = {};
  const summary = {addHeading() {return this;}, addRaw() {return this;}, addCodeBlock() {return this;}, async write() {}};
  return {messages, outputs, summary, info: m => messages.push(m), warning: m => messages.push(m),
    getIDToken: async () => 'secret-oidc', setSecret() {}, setOutput: (key,value) => outputs[key] = value};
}
function fetchMock(changes = {}) {
  const files = {'deployment.json': manifest, 'data/market.json': market, 'data/latest.json': daily,
    '': '<title>DORY</title><script src="dashboard.js"></script>', 'dashboard.js': 'const DATA_MARKET = "data/market.json";', ...changes};
  return async url => {
    const name = url.pathname.replace('/dory-dashboard/', '');
    const value = files[name];
    return {ok: value !== null, status: value === null ? 503 : 200,
      json: async () => value, text: async () => value};
  };
}
test('online checks require fresh pool data, matching manifest, and actual page assets', async () => {
  assert.equal((await checkSite({now, expected: manifest, fetcher: fetchMock()})).run_id, '123');
  for (const [changes, pattern] of [
    [{'deployment.json': {...manifest, run_id: '122'}}, /expected deployment/],
    [{'data/market.json': {...market, generated_at: new Date(now - 91 * 60000).toISOString()}}, /stale/],
    [{'data/latest.json': {...daily, generated_at: new Date(now - 37 * 3600000).toISOString()}}, /stale/],
    [{'data/market.json': {...market, pool_id: 'wrong'}}, /quote/],
    [{'deployment.json': {...manifest, market_generated_at: 'old'}}, /timestamps/],
    [{'dashboard.js': 'broken'}, /incomplete/],
    [{'data/market.json': null}, /HTTP 503/],
  ]) await assert.rejects(checkSite({now, expected: manifest, fetcher: fetchMock(changes)}), pattern);
});
test('publication verification tolerates a CDN version delay then succeeds', async () => {
  let requests = 0, waits = 0;
  const fresh = fetchMock();
  const result = await verifyPublishedSite(manifest, {now, wait: async () => waits++, attempts: 2,
    fetcher: async (...args) => {
      if (++requests <= 5) return fetchMock({'deployment.json': {...manifest, run_id: '122'}})(...args);
      return fresh(...args);
    }});
  assert.equal(result.run_id, '123'); assert.equal(waits, 1);
});
test('deployment uses the uploaded artifact ID without listing artifacts and verifies production', async () => {
  const calls = [], core = coreMock();
  const github = {request: async (route, params) => {
    calls.push({route, params});
    return {data: route.startsWith('POST') ? {id: 'deployment-1'} : {status: 'succeed'}};
  }};
  let verified = false;
  await deployPages({github, core, context, artifactId: '14972550808', expected: manifest, wait: async () => {},
    verify: async expected => {assert.deepEqual(expected, manifest); verified = true; return health;}});
  assert.equal(calls[0].params.artifact_id, 14972550808);
  assert.equal(calls[0].params.oidc_token, 'secret-oidc');
  assert.equal(calls.length, 2); assert.ok(verified);
  assert.ok(core.outputs.page_url.endsWith('/dory-dashboard/'));
  assert.ok(!core.messages.join('').includes('secret-oidc'));
  await assert.rejects(deployPages({github, core, context, artifactId: undefined}), /artifact ID/);
});
test('deployment fails on terminal status or unsuccessful online verification', async () => {
  for (const status of ['deployment_failed', 'succeed']) {
    await assert.rejects(deployPages({context, core: coreMock(), artifactId: '1', expected: manifest,
      github: {request: async route => ({data: route.startsWith('POST') ? {id: '1'} : {status}})},
      wait: async () => {}, verify: async () => {throw Error('CDN still old');}}),
    status === 'succeed' ? /CDN still old/ : /deployment_failed/);
  }
});
test('manifest binds the uploaded data to the run and actual checked-out commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dory-manifest-'));
  try {
    fs.mkdirSync(dir + '/data');
    fs.writeFileSync(dir + '/data/market.json', JSON.stringify(market));
    fs.writeFileSync(dir + '/data/latest.json', JSON.stringify(daily));
    const result = writeManifest(dir, {SITE_COMMIT: manifest.commit, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2'});
    assert.equal(result.run_attempt, '2'); assert.equal(result.market_generated_at, timestamp);
    assert.deepEqual(JSON.parse(fs.readFileSync(dir + '/deployment.json')), result);
    assert.throws(() => writeManifest(dir, {}), /Invalid deployment/);
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});
function monitorMock({runs, storedMarket = market, storedDaily = daily, result = health, failure = null, jobs = []}) {
  const actions = [];
  const github = {rest: {actions: {
    listWorkflowRuns: async () => ({data: {workflow_runs: runs}}),
    listJobsForWorkflowRun: async () => ({data: {jobs}}),
    reRunWorkflowFailedJobs: async params => actions.push({type: 'rerun', ...params}),
    createWorkflowDispatch: async params => actions.push({type: 'dispatch', ...params}),
  }, repos: {getContent: async ({path: name}) => ({data: {content: Buffer.from(JSON.stringify(name.includes('market') ? storedMarket : storedDaily)).toString('base64')}})}}};
  return {actions, run: () => monitorDeployment({github, context, core: coreMock(), now,
    check: async () => {if (failure) throw Error(failure); return result;}})};
}
const run = {id: 123, status: 'completed', conclusion: 'success', run_attempt: 1, event: 'schedule', html_url: 'https://github.com/example/run/123'};
test('monitor confirms healthy production and avoids duplicate recovery while a run is active', async () => {
  const healthy = monitorMock({runs: [run]});
  assert.equal((await healthy.run()).action, 'healthy'); assert.equal(healthy.actions.length, 0);
  const active = monitorMock({runs: [{...run, status: 'in_progress'}], failure: 'offline'});
  assert.equal((await active.run()).action, 'wait'); assert.equal(active.actions.length, 0);
});
test('monitor retries only failed jobs and stops at three attempts', async () => {
  const failure = monitorMock({runs: [{...run, conclusion: 'failure'}], failure: 'offline'});
  assert.equal((await failure.run()).action, 'rerun_failed_jobs');
  assert.equal(failure.actions[0].run_id, 123);
  const capped = monitorMock({runs: [{...run, conclusion: 'failure', run_attempt: 3}], failure: 'offline'});
  await assert.rejects(capped.run(), /3 attempts/); assert.equal(capped.actions.length, 0);
});
test('monitor republishes fresh stored data but collects again when repository data is stale', async () => {
  const offline = monitorMock({runs: [run], failure: 'offline'});
  assert.equal((await offline.run()).action, 'dispatch_deployment');
  assert.equal(offline.actions[0].inputs.mode, 'deploy_only');
  const stale = {...market, generated_at: new Date(now - 120 * 60000).toISOString()};
  const refresh = monitorMock({runs: [{...run, conclusion: 'failure'}], storedMarket: stale, failure: 'stale'});
  await refresh.run(); assert.equal(refresh.actions[0].inputs.mode, 'collect_and_deploy');
  const collectionFailed = monitorMock({runs: [{...run, conclusion: 'failure'}], storedMarket: stale,
    jobs: [{name: 'collect', conclusion: 'failure'}]});
  await collectionFailed.run(); assert.equal(collectionFailed.actions[0].type, 'rerun');
});
test('monitor catches data collected but missing online and bounds successive recovery dispatches', async () => {
  const newer = {...market, generated_at: new Date(now - 20 * 60000).toISOString()};
  const mismatch = monitorMock({runs: [run], storedMarket: newer, result: {...health, market_generated_at: new Date(now - 60 * 60000).toISOString()}});
  await mismatch.run(); assert.equal(mismatch.actions[0].inputs.mode, 'deploy_only');
  const recoveries = Array.from({length: 3}, () => ({...run, event: 'workflow_dispatch', display_title: 'DORY automatic recovery'}));
  const capped = monitorMock({runs: [...recoveries, run], failure: 'offline'});
  await assert.rejects(capped.run(), /3 deployment recoveries/); assert.equal(capped.actions.length, 0);
});
