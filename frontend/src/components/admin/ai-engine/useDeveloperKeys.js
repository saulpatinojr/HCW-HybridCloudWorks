/**
 * The Developer API tab's read and writes (ADR 0042), over the shared
 * race-safe loader: one `cms/developer-api/keys` read, re-read after every
 * write so the list shows what the API holds, never what the browser assumed.
 * Follows useKodaKey.js.
 *
 * The plaintext secret from Make or Rotate is NOT part of the loaded data:
 * the write returns the API's answer to the caller, and the tab keeps the
 * secret in its own state for the one reveal.
 *
 * Each write resolves `{ answer, refreshed }`. A failed re-read is not thrown:
 * the write happened, and for Make and Rotate the answer carries the only copy
 * of the key, so the tab still shows it and says the list may be stale.
 */
import { useCallback } from 'react';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { useAuthReady } from '@/hooks/useAuthReady';
import {
  createDeveloperKey,
  listDeveloperKeys,
  revokeDeveloperKey,
  rotateDeveloperKey,
  updateDeveloperKey,
} from '@/lib/developerApi';

export const EMPTY = Object.freeze({
  keys: [],
  scopes: [],
  limits: { keyedRequestsPerMinute: 120 },
  basePath: '/api/developer/v1',
  endpoints: [],
});

const describeError = (error) => error?.message || 'The organizer keys could not be read.';

export default function useDeveloperKeys() {
  const { authReady } = useAuthReady();
  const load = useCallback(() => listDeveloperKeys(), []);
  const { data, loaded, error, refresh } = useGuardedLoad(load, {
    enabled: authReady,
    empty: EMPTY,
    describeError,
  });

  const then = useCallback(
    async (write) => {
      const answer = await write();
      const refreshed = await refresh();
      return { answer, refreshed };
    },
    [refresh]
  );

  const create = useCallback((organizer) => then(() => createDeveloperKey(organizer)), [then]);
  const rotate = useCallback((keyId) => then(() => rotateDeveloperKey(keyId)), [then]);
  const update = useCallback(
    (keyId, change) => then(() => updateDeveloperKey(keyId, change)),
    [then]
  );
  const revoke = useCallback((keyId) => then(() => revokeDeveloperKey(keyId)), [then]);

  return { data: data || EMPTY, loaded, error, refresh, create, rotate, update, revoke };
}
