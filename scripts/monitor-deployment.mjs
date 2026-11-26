import {checkSite} from './site-health.mjs';

const WORKFLOW = 'dory-daily.yml';
export const runningStatuses = new Set(['queued', 'in_progress', 'requested', 'pending', 'waiting']);

const minute = 60_000;

export function overdueCollection({market, daily}, now) {
  const marketTime = Date.parse(market), dailyTime = Date.parse(daily);
  // Beijing 22:00 is 14:00 UTC year-round. Give the scheduled run 25 minutes to finish.
  const graceTime = now - 25 * minute;
  const todayCutoff = new Date(graceTime).setUTCHours(14, 0, 0, 0);
  const cutoff = graceTime < todayCutoff ? todayCutoff - 24 * 60 * minute : todayCutoff;
  const invalidTime = time => !Number.isFinite(time) || time > now + 5 * minute;
  if (invalidTime(dailyTime) || dailyTime < cutoff) return 'collect_and_deploy';
  if (invalidTime(marketTime) || marketTime < now - 45 * minute) return 'market_only';
  return null;
}

export async function monitorDeployment({github, core, context, check = checkSite, now = Date.now()}) {
  const {owner, repo} = context.repo;
  const {data} = await github.rest.actions.listWorkflowRuns({owner, repo, workflow_id: WORKFLOW, branch: 'main', per_page: 10});
  const latest = data.workflow_runs[0];
  if (!latest) throw Error('No DORY workflow runs exist');
  let health = null, error = null;
  try { health = await check({now}); } catch (failure) { error = failure.message; }
  const stored = await Promise.all(['market', 'latest'].map(async name => {
    const {data: content} = await github.rest.repos.getContent({owner, repo, path: 'data/' + name + '.json', ref: 'main'});
    return JSON.parse(Buffer.from(content.content, 'base64').toString());
  }));
  const [market, daily] = stored;
  const mode = overdueCollection({market: market.generated_at, daily: daily.generated_at}, now);
  if (mode) error = mode === 'market_only' ? 'Uniswap quote is over 45 minutes old or invalid' : 'The expected 22:00 Beijing daily snapshot is missing';
  else if (health && stored.some((item, index) =>
    Date.parse(item.generated_at) > Date.parse(health[index ? 'daily_generated_at' : 'market_generated_at']) &&
      now - Date.parse(item.generated_at) > 15 * minute)) error = 'Collected data is newer than the online deployment';
  const active = data.workflow_runs.find(run => runningStatuses.has(run.status));
  if (active) {
    core.info('DORY workflow ' + active.id + ' is already running');
    await report('Run in progress', error || 'Waiting for the active collection and deployment');
    return {action: 'wait', run_id: active.id, health, error};
  }
  if (!error && latest.conclusion === 'success') {
    await report('Healthy', JSON.stringify(health));
    return {action: 'healthy', health};
  }
  if (latest.conclusion === 'failure') {
    if ((latest.run_attempt || 1) >= 3) throw Error('DORY workflow failed after 3 attempts. ' + (error || latest.html_url));
    const {data: jobs} = await github.rest.actions.listJobsForWorkflowRun({owner, repo, run_id: latest.id, filter: 'latest'});
    const failedCollection = jobs.jobs.some(job => job.name === 'collect' && job.conclusion === 'failure');
    if (!mode || (mode === 'market_only' && failedCollection)) {
      await github.rest.actions.reRunWorkflowFailedJobs({owner, repo, run_id: latest.id});
      await report('Recovery started', 'Retried failed jobs in ' + latest.html_url);
      return {action: 'rerun_failed_jobs', run_id: latest.id, error};
    }
  }
  if (error) {
    const consecutiveRepairs = data.workflow_runs.findIndex(run =>
      !(run.event === 'workflow_dispatch' && run.display_title === 'DORY automatic recovery' &&
        (!mode || run.conclusion !== 'success')));
    if (consecutiveRepairs >= 3 || consecutiveRepairs === -1)
      throw Error('Site remains unhealthy after 3 deployment recoveries. ' + error);
    await github.rest.actions.createWorkflowDispatch({owner, repo, workflow_id: WORKFLOW, ref: 'main', inputs: {mode: mode || 'deploy_only', recovery: 'true'}});
    await report('Recovery started', (mode ? 'Requested ' + mode + '. ' : 'Requested deployment of the latest collected data. ') + error);
    return {action: 'dispatch_deployment', error};
  }
  throw Error('Latest DORY workflow ended with ' + latest.conclusion);

  async function report(title, message) {
    core.info(title + '. ' + message);
    await core.summary.addHeading(title).addRaw(message).write();
  }
}
