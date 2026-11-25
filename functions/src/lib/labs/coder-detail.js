/**
 * labs/coder-detail.js — what the labs status read asks Coder (coder-status.js
 * has the header that explains it): whether it answers, and with the status
 * token, its templates and running workspaces for the card. A refused token
 * is warned about by status only.
 */
import { errorFacts } from '../http/error-response.js';
import { MAX_TEMPLATES, TOKEN_REFUSED_401_LOG, UUID, coderGet } from './coder-api.js';

/** Whether Coder answers: the unauthenticated build info, in its documented shape. Throws otherwise. */
export async function readReachable(fetchImpl, config) {
  const info = await coderGet(fetchImpl, config, '/api/v2/buildinfo', '');
  if (typeof info?.version !== 'string' || !info.version) {
    throw new Error('Coder build info carried no version');
  }
}

/** The active version's name, or null when it cannot be resolved — never the uuid. */
async function resolveVersionName(fetchImpl, config, versionId, context) {
  if (typeof versionId !== 'string' || !UUID.test(versionId)) return null;
  try {
    const version = await coderGet(
      fetchImpl,
      config,
      `/api/v2/templateversions/${encodeURIComponent(versionId)}`,
      config.token
    );
    return typeof version?.name === 'string' && version.name ? version.name : null;
  } catch (error) {
    context?.warn?.(`coder-status: template version lookup failed: ${errorFacts(error)}`);
    return null;
  }
}

/**
 * The token's detail, shaped for the card. Throws on anything but the
 * documented shape, so the caller reports the detail as unknown rather than
 * guessing at fields.
 */
async function readDetail({ fetchImpl, config, context }) {
  const running = new URLSearchParams({ q: 'status:running' });
  const [templates, workspaces] = await Promise.all([
    coderGet(fetchImpl, config, '/api/v2/templates', config.token),
    coderGet(fetchImpl, config, `/api/v2/workspaces?${running}`, config.token),
  ]);

  if (!Array.isArray(templates)) throw new Error('Coder templates response was not a list');
  if (!workspaces || typeof workspaces !== 'object') {
    throw new Error('Coder workspaces response was not an object');
  }

  const shown = templates
    .filter((t) => typeof t?.name === 'string' && t.name.trim())
    .slice(0, MAX_TEMPLATES);
  const versions = await Promise.all(
    shown.map((t) => resolveVersionName(fetchImpl, config, t.active_version_id, context))
  );

  const count = Number.isInteger(workspaces.count)
    ? workspaces.count
    : Array.isArray(workspaces.workspaces)
      ? workspaces.workspaces.length
      : null;
  if (count === null) throw new Error('Coder workspaces response carried no count');

  return {
    templates: shown.map((t, i) => ({ name: t.name.trim(), activeVersion: versions[i] })),
    running: count,
  };
}

/**
 * The card's templates and capacity: the token's detail, or unknown with a
 * warning that names the setting and why. Never throws, because Coder has
 * already answered by the time this runs, and missing detail must not close
 * the panes.
 */
export async function readDetailOrUnknown({ fetchImpl, config, context, onTokenAnswer = null }) {
  const unknown = { templates: [], capacity: { running: null, max: config.max } };
  if (!config.token) {
    context?.warn?.(
      'coder-status: CODER_STATUS_TOKEN is not set or does not resolve; templates and running workspaces are reported as unknown'
    );
    return unknown;
  }
  try {
    const detail = await readDetail({ fetchImpl, config, context });
    await onTokenAnswer?.(null);
    return { templates: detail.templates, capacity: { running: detail.running, max: config.max } };
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      warnRefusal(context, error.status, 'templates and running workspaces are reported as unknown');
    } else {
      context?.warn?.(
        `coder-status: the templates and workspaces read failed, and both are reported as unknown: ${errorFacts(error)}`
      );
    }
    if (error?.status === 401 || error?.status === 403) await onTokenAnswer?.(error.status);
    return unknown;
  }
}

/**
 * The warning a refused status token writes: a 401 starts with
 * TOKEN_REFUSED_401_LOG, which a log alert matches; a 403 names the scope
 * and does not match it. Content-free.
 */
export function warnRefusal(context, status, consequence) {
  context?.warn?.(
    status === 401
      ? `${TOKEN_REFUSED_401_LOG}: it has expired or been revoked; ${consequence}`
      : `coder-status: Coder refused CODER_STATUS_TOKEN (403): it lacks the template:read or workspace:read scope; ${consequence}`
  );
}
