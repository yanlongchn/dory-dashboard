import {verifyPublishedSite} from './site-health.mjs';
import fs from 'node:fs';

const terminalFailures = new Set(['deployment_failed', 'deployment_perms_error', 'deployment_content_failed',
  'deployment_cancelled', 'deployment_lost']);

export async function deployPages({github, core, context, artifactId, expected,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), verify = verifyPublishedSite}) {
  if (!/^\d+$/.test(String(artifactId))) throw Error('Upload did not return a Pages artifact ID');
  const {owner, repo} = context.repo;
  const oidcToken = await core.getIDToken();
  core.setSecret(oidcToken);
  // Use the upload result directly. The artifact listing service can return an empty list after a successful upload.
  const {data: deployment} = await github.request('POST /repos/{owner}/{repo}/pages/deployments', {
    owner, repo, artifact_id: Number(artifactId), pages_build_version: context.sha, oidc_token: oidcToken,
  });
  const deploymentId = deployment.id || deployment.status_url?.split('/').pop();
  if (!deploymentId) throw Error('Pages did not return a deployment ID');
  core.info('Created Pages deployment ' + deploymentId + ' from uploaded artifact ' + artifactId);
  let statusErrors = 0;
  for (let attempt = 0; attempt < 120; attempt++) {
    await wait(5000);
    let status;
    try {
      const {data} = await github.request('GET /repos/{owner}/{repo}/pages/deployments/{deployment_id}', {
        owner, repo, deployment_id: deploymentId,
      });
      status = data.status;
      statusErrors = 0;
    } catch (error) {
      if (++statusErrors < 6) continue;
      await cancel();
      throw Error('Pages status checks repeatedly failed with HTTP ' + error.status);
    }
    if (status === 'succeed') {
      const health = await verify(expected);
      core.setOutput('page_url', 'https://' + owner + '.github.io/' + repo + '/');
      await core.summary.addHeading('Deployment verified').addCodeBlock(JSON.stringify(health, null, 2), 'json').write();
      return health;
    }
    if (terminalFailures.has(status)) throw Error('Pages reported ' + status);
    core.info('Pages deployment status ' + status);
  }
  await cancel();
  throw Error('Pages deployment exceeded 10 minutes');

  async function cancel() {
    try {
      await github.request('POST /repos/{owner}/{repo}/pages/deployments/{deployment_id}/cancel', {
        owner, repo, deployment_id: deploymentId,
      });
    } catch (error) { core.warning('Deployment cancellation returned HTTP ' + error.status); }
  }
}

export function writeManifest(directory, env = process.env) {
  const read = name => JSON.parse(fs.readFileSync(directory + '/data/' + name + '.json', 'utf8'));
  const manifest = {schema_version: 1, commit: env.SITE_COMMIT, run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT, built_at: new Date().toISOString(),
    market_generated_at: read('market').generated_at, daily_generated_at: read('latest').generated_at};
  if (!/^[a-f0-9]{40}$/.test(manifest.commit || '') || !/^\d+$/.test(manifest.run_id || '') ||
      !/^\d+$/.test(manifest.run_attempt || '')) throw Error('Invalid deployment manifest context');
  fs.writeFileSync(directory + '/deployment.json', JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
