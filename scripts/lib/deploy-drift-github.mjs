/** Reading GitHub's and HCP Terraform's records for check-deploy-drift.mjs, with a timeout and one retry. */
import { API, COMMITS_PER_PAGE, MAX_COMMIT_PAGES, RETRY_DELAY_MS, TIMEOUT_MS } from './deploy-drift-settings.mjs';
import { lastSuccessfulRun, missingTfcTokenMessage, parseLastAppliedRun } from './deploy-drift-baselines.mjs';
import { tfc } from '../tfc-workspace-busy.mjs';

/** Rejects with the signal's reason once it aborts; never resolves. */
function abortedBy(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * The JSON of one GitHub read, after at most one retry, or an error naming
 * why not. One attempt is the headers and the body under one deadline of
 * `timeoutMs`, and a 5xx, a 429, a dropped connection, a stalled body or a
 * body that cannot be read is asked once more after `retryDelayMs`; a 4xx
 * other than 429 is a refusal and is not. The same shape as
 * `check-functions-deploy-in-progress.mjs`'s reader (#1564).
 *
 * The body is raced against the same signal rather than left to the fetch:
 * `AbortSignal.timeout` on the request covers the headers, and a body that
 * GitHub starts and never finishes would otherwise wait on undici's own
 * defaults, past the deadline and outside the retry (raised in CodeRabbit's
 * review of #1567). The timeout is a parameter so a test can see it fire.
 */
export async function ghJson(
  fetchImpl,
  url,
  token,
  { retryDelayMs = RETRY_DELAY_MS, timeoutMs = TIMEOUT_MS } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt === 2;
    const outcome = await ghAttempt(fetchImpl, url, token, timeoutMs);
    if ('value' in outcome) return outcome.value;
    if (last || !outcome.retry) throw outcome.error;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

/** A 5xx or a 429 is worth asking again; any other refusal is not. */
const retryableStatus = (status) => status >= 500 || status === 429;

/**
 * One attempt of ghJson, headers and body under one deadline: `{ value }`, or
 * `{ error, retry }` saying what went wrong and whether to ask again.
 */
async function ghAttempt(fetchImpl, url, token, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal,
    });
  } catch (error) {
    return { error: new Error(`GitHub did not answer ${url}: ${error?.message || String(error)}`), retry: true };
  }
  if (!res.ok) return { error: new Error(`GitHub answered ${res.status} for ${url}`), retry: retryableStatus(res.status) };
  try {
    return { value: await Promise.race([res.json(), abortedBy(signal)]) };
  } catch (error) {
    return {
      error: new Error(`GitHub answered ${url} but its body could not be read: ${error?.message || String(error)}`),
      retry: true,
    };
  }
}

/**
 * The head of a workflow's last successful run, or null when it has none.
 * `lastSuccessfulRun` does the reading and says why the listing's
 * `status=success` filter is no longer asked (#1564).
 */
export async function workflowBaseline(service, { token, owner, repo, fetchImpl, retryDelayMs, timeoutMs }) {
  return lastSuccessfulRun(service.workflow, (path) =>
    ghJson(fetchImpl, `${API}/repos/${owner}/${repo}${path}`, token, { retryDelayMs, timeoutMs })
  );
}

/**
 * The commit the workspace's newest applied run was planned from, or null
 * when nothing has applied. Two calls, both reads: the workspace by name for
 * its id, as the other two HCP Terraform scripts resolve it, then one run.
 */
export async function appliedBaseline(service, { tfcToken, fetchImpl }) {
  if (!tfcToken) throw new Error(missingTfcTokenMessage());
  const { organization, workspace } = service.terraform;
  const ws = await tfc(tfcToken, `/organizations/${organization}/workspaces/${workspace}`, {
    fetchImpl,
  });
  if (typeof ws?.id !== 'string' || !ws.id) {
    throw new Error(
      `HCP Terraform returned no id for workspace ${organization}/${workspace}. Expected the ` +
        'response of GET /organizations/:org/workspaces/:name.'
    );
  }
  const payload = await tfc(
    tfcToken,
    `/workspaces/${ws.id}/runs?filter%5Bstatus%5D=applied&page%5Bsize%5D=1` +
      '&include=configuration_version.ingress_attributes',
    { raw: true, fetchImpl }
  );
  return parseLastAppliedRun(payload);
}

/**
 * Is `sha` on `main`? Asked only of the Terraform baseline. A deploy
 * workflow's head is `main` by construction — both deploys refuse any other
 * ref — but HCP Terraform applies whatever commit the workspace was pointed
 * at, and a baseline off `main` would otherwise count as zero drift.
 *
 * `compare/:sha...main` describes main relative to the sha: `ahead` or
 * `identical` means the sha is an ancestor of main (or main itself);
 * `behind` or `diverged` means main does not contain it. A status this does
 * not recognise is thrown on, in the direction the rest of the file takes.
 */
export async function compareWithMain(sha, { token, owner, repo, fetchImpl, retryDelayMs, timeoutMs }) {
  const body = await ghJson(fetchImpl, `${API}/repos/${owner}/${repo}/compare/${sha}...main`, token, {
    retryDelayMs,
    timeoutMs,
  });
  const status = body?.status;
  if (status === 'ahead' || status === 'identical') return { onMain: true, status };
  if (status === 'behind' || status === 'diverged') return { onMain: false, status };
  throw new Error(
    `GitHub returned a compare payload with status ${JSON.stringify(status ?? null)} for ${sha}...main. ` +
      'Expected ahead, identical, behind or diverged from GET /repos/:owner/:repo/compare/:base...:head.'
  );
}

/**
 * The commits on main since the deploy that touched one path, onto `seen` by
 * sha, the deployed commit itself left out.
 */
export async function collectPathCommits({ path, since, deployedSha, owner, repo, gh, seen }) {
  // PAGINATED. One page is 100 commits, and drift matters MOST when it is
  // large — the frontend was 35 behind, and a longer gap is exactly the case
  // a first-page-only read under-reports, returning a too-recent "oldest"
  // and therefore a healthier age than the truth.
  for (let page = 1; page <= MAX_COMMIT_PAGES; page += 1) {
    const batch = await gh(
      `${API}/repos/${owner}/${repo}/commits?sha=main&path=${encodeURIComponent(path)}` +
        `&since=${encodeURIComponent(since)}&per_page=${COMMITS_PER_PAGE}&page=${page}`
    );
    // THROWN, not defaulted to []. Silently treating an unreadable payload
    // as an empty page reports the service as up to date — the same
    // healthier-than-reality direction as every other defect found in this
    // file, and the one the whole check exists to avoid. driftFor's catch
    // turns this into a ⚠️ row, which says "could not read" rather than
    // "nothing to deploy". parseRunIds and parseCommitDate above
    // already work this way; this line did not, which was the
    // inconsistency review caught.
    if (!Array.isArray(batch)) {
      throw new Error(
        `GitHub returned a non-array commits payload for ${path} (page ${page}). Expected ` +
          'the response of GET /repos/:owner/:repo/commits.'
      );
    }
    // `since` is inclusive of the boundary commit, which is the deployed
    // one when it touched this path. Excluding it by sha keeps a
    // just-deployed service from reporting itself one commit behind.
    for (const c of batch) if (c?.sha && c.sha !== deployedSha) seen.set(c.sha, c);
    if (batch.length < COMMITS_PER_PAGE) return;
  }
}
