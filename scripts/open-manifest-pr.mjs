/**
 * Open the manifest pull request and ask for auto-merge (T-726).
 *
 * The nightly refresh used to push straight to `main`. The ruleset refuses
 * that: `pull_request` is one of its rules and it lists no bypass actors
 * (verified 2026-08-31). So the push had been failing since 2026-08-25, and
 * nothing said so, because the published set did not move in that window and
 * the push path was never reached.
 *
 * Opening a pull request is how the refresh reaches `main` at all. The checks
 * run because it is opened with a GitHub App installation token rather than
 * `GITHUB_TOKEN`: GitHub deliberately does not trigger workflows for events its
 * own token creates, which is exactly why the obvious version of this idea does
 * not work.
 *
 * An earlier version of this header said this removed a ruleset bypass. There
 * was no bypass to remove.
 *
 * AUTO-MERGE IS REQUESTED, NOT REQUIRED. `allow_auto_merge` was false on this
 * repository when this was written, so the request fails until an owner enables
 * it in Settings → General → Pull Requests. That failure leaves an open pull
 * request that a human can merge — a worse outcome than automatic, and a much
 * better one than a red nightly job and no manifest. It is reported as a notice
 * naming the setting, so the cause is legible without reading this file.
 */
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';
const GRAPHQL = 'https://api.github.com/graphql';

/**
 * Throws on a shape it cannot read rather than returning null, following
 * `check-unresolved-secrets.mjs`. "The pull request was not created" and "I
 * could not read the answer" are different facts, and the second reported as
 * the first would leave a branch pushed with nothing tracking it.
 */
export function parseCreatedPullRequest(body) {
  const number = body?.number;
  const nodeId = body?.node_id;
  if (!Number.isInteger(number) || typeof nodeId !== 'string' || !nodeId) {
    throw new Error(
      'GitHub returned a pull-request payload without an integer `number` and a `node_id` ' +
        'string. Expected the response of POST /repos/:owner/:repo/pulls.'
    );
  }
  return { number, nodeId, url: body.html_url ?? null };
}

/**
 * GraphQL answers 200 with an `errors` array, so `response.ok` says nothing
 * about whether the mutation ran. Checked explicitly, because treating a 200
 * as success here would report auto-merge as armed when it was refused.
 */
export function autoMergeOutcome(body) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  if (errors.length === 0) return { enabled: true, reason: null };

  const reason = errors.map((e) => e?.message).filter(Boolean).join('; ');
  return { enabled: false, reason: reason || 'GraphQL refused the mutation without a message' };
}

export async function openManifestPullRequest({
  token,
  owner,
  repo,
  head,
  base = 'main',
  title,
  body,
  fetchImpl = fetch,
}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  const created = await fetchImpl(`${API}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title, body, head, base }),
  });
  if (!created.ok) {
    throw new Error(
      `GitHub answered ${created.status} creating the pull request. A 422 here usually means the ` +
        `branch ${head} was not pushed, or a pull request for it is already open.`
    );
  }
  const pull = parseCreatedPullRequest(await created.json());

  const mutation = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query:
        'mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){clientMutationId}}',
      variables: { id: pull.nodeId },
    }),
  });

  // A transport failure and a refused mutation are both "not armed", and
  // neither should fail the job — the pull request exists either way.
  const outcome = mutation.ok
    ? autoMergeOutcome(await mutation.json())
    : { enabled: false, reason: `GitHub answered ${mutation.status}` };

  return { ...pull, autoMerge: outcome };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  const head = process.env.MANIFEST_BRANCH;
  const routes = process.env.MANIFEST_ROUTES ?? 'an unknown number of';

  if (!token) {
    console.error('GITHUB_TOKEN must hold the App installation token.');
    return 2;
  }
  if (!owner || !repo || !head) {
    console.error('GITHUB_REPOSITORY and MANIFEST_BRANCH must both be set.');
    return 2;
  }

  const pull = await openManifestPullRequest({
    token,
    owner,
    repo,
    head,
    title: `chore: refresh content manifest (${routes} content routes)`,
    body:
      `The nightly refresh found the published set had moved: **${routes} content routes**.\n\n` +
      'Opened by the manifest App rather than pushed to `main`, so the required checks run on ' +
      'it (T-726). The only file it may touch is `frontend/data/content-manifest.json`.\n\n' +
      '---\n_Generated by [Claude Code](https://claude.ai/code)_',
  });

  console.log(`pull request #${pull.number}: ${pull.url ?? '(no url)'}`);
  if (pull.autoMerge.enabled) {
    console.log('auto-merge armed; it will merge once the checks pass.');
    return 0;
  }

  // A notice rather than an error: the pull request is open and mergeable by
  // hand, which is the degraded outcome this deliberately accepts.
  console.log(
    `::notice::Auto-merge was not armed (${pull.autoMerge.reason}). The pull request is open and ` +
      'can be merged by hand. If this says auto-merge is disabled, enable it at Settings → ' +
      'General → Pull Requests → Allow auto-merge.'
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`\n${error.message}`);
      process.exit(2);
    });
}
