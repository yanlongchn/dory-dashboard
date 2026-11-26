import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {overdueCollection, runningStatuses} from './monitor-deployment.mjs';
import {checkSite} from './site-health.mjs';

const repo = 'yanlongchn/dory-dashboard';
const monitor = 'dory-monitor.yml';
const production = 'dory-daily.yml';

function runGh(args) {
  return execFileSync('gh', [...args, '--repo', repo], {encoding: 'utf8', timeout: 30_000}).trim();
}

export async function runWatchdog({check = checkSite, gh = runGh, now = Date.now()} = {}) {
  let issue;
  try {
    const health = await check({now});
    issue = overdueCollection({market: health.market_generated_at, daily: health.daily_generated_at}, now);
    if (!issue) return {action: 'healthy', market: health.market_generated_at, daily: health.daily_generated_at};
  } catch (error) {
    issue = error.message;
  }

  for (const workflow of [production, monitor]) {
    const runs = JSON.parse(gh(['run', 'list', '--workflow', workflow, '--branch', 'main', '--limit', '5', '--json', 'databaseId,status,createdAt']));
    const recent = runs.find(run => runningStatuses.has(run.status) ||
      (workflow === monitor && now - Date.parse(run.createdAt) < 10 * 60_000));
    if (recent) return {action: 'wait', workflow, run_id: recent.databaseId, issue};
  }

  const url = gh(['workflow', 'run', monitor, '--ref', 'main']);
  return {action: 'monitor_dispatched', issue, url};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    console.log(JSON.stringify({at: new Date().toISOString(), ...await runWatchdog()}));
  } catch (error) {
    console.error(new Date().toISOString() + ' DORY watchdog: ' + error.message);
    process.exitCode = 1;
  }
}
