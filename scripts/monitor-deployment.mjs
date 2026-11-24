import {checkSite} from './site-health.mjs';

const WORKFLOW = 'dory-daily.yml';
const runningStatuses = new Set(['queued', 'in_progress', 'requested', 'pending', 'waiting']);

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
  const ages = stored.map(item => (now - Date.parse(item.generated_at)) / 60000);
  const needsCollection = ages.some((age, index) => !Number.isFinite(age) || age < -5 || age > [90, 36 * 60][index]);
  if (needsCollection) error = 'Repository data needs a fresh collection';
  else if (health && stored.some((item, index) =>
    Date.parse(item.generated_at) > Date.parse(health[index ? 'daily_generated_at' : 'market_generated_at']) &&
      ages[index] > 15)) error = 'Collected data is newer than the online deployment';
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
    if (!needsCollection || failedCollection) {
      await github.rest.actions.reRunWorkflowFailedJobs({owner, repo, run_id: latest.id});
      await report('Recovery started', 'Retried failed jobs in ' + latest.html_url);
      return {action: 'rerun_failed_jobs', run_id: latest.id, error};
    }
  }
  if (error) {
    const consecutiveRepairs = data.workflow_runs.findIndex(run =>
      !(run.event === 'workflow_dispatch' && run.display_title === 'DORY automatic recovery'));
    if (consecutiveRepairs >= 3 || consecutiveRepairs === -1)
      throw Error('Site remains unhealthy after 3 deployment recoveries. ' + error);
    await github.rest.actions.createWorkflowDispatch({owner, repo, workflow_id: WORKFLOW, ref: 'main', inputs: {mode: needsCollection ? 'collect_and_deploy' : 'deploy_only', recovery: 'true'}});
    await report('Recovery started', (needsCollection ? 'Requested fresh collection and deployment. ' : 'Requested deployment of the latest collected data. ') + error);
    return {action: 'dispatch_deployment', error};
  }
  throw Error('Latest DORY workflow ended with ' + latest.conclusion);

  async function report(title, message) {
    core.info(title + '. ' + message);
    await core.summary.addHeading(title).addRaw(message).write();
  }
}
