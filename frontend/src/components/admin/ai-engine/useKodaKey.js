/**
 * The Koda tab's read and writes (ADR 0037), over the shared race-safe
 * loader: one `cms/agent-content/key` read, re-read after every write so the
 * card shows what the API holds, never what the browser assumed.
 *
 * The generated secret is NOT part of the loaded data: the writes return the
 * API's answer to the caller, and the tab keeps the secret in its own state
 * for the one reveal.
 *
 * Each write resolves `{ answer, refreshed }`: the API's answer, and whether
 * the re-read after it landed. A failed re-read is NOT thrown: the write
 * happened, and for Generate the answer carries the only copy of the key, so
 * the tab shows it and says the card could not be re-read, rather than
 * telling the owner nothing changed and losing the key.
 */
import { useCallback } from 'react';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { useAuthReady } from '@/hooks/useAuthReady';
import {
  generateKodaKey,
  readKodaKey,
  revokeKodaKey,
  setKodaCapabilities,
} from '@/lib/agentContent';

export const EMPTY = Object.freeze({
  key: { present: false, active: false, capabilities: {} },
  capabilities: [],
  limits: { requestsPerMinute: 120 },
  basePath: '/api/agent-content/v1',
  endpoints: [],
});

const describeError = (error) => error?.message || 'The agent key could not be read.';

export default function useKodaKey() {
  const { authReady } = useAuthReady();
  const load = useCallback(() => readKodaKey(), []);
  const { data, loaded, error, refresh } = useGuardedLoad(load, {
    enabled: authReady,
    empty: EMPTY,
    describeError,
  });

  const generate = useCallback(async () => {
    const answer = await generateKodaKey();
    const refreshed = await refresh();
    return { answer, refreshed };
  }, [refresh]);

  const setCapability = useCallback(
    async (id, on) => {
      const answer = await setKodaCapabilities({ [id]: on });
      const refreshed = await refresh();
      return { answer, refreshed };
    },
    [refresh]
  );

  const revoke = useCallback(async () => {
    const answer = await revokeKodaKey();
    const refreshed = await refresh();
    return { answer, refreshed };
  }, [refresh]);

  return { data: data || EMPTY, loaded, error, refresh, generate, setCapability, revoke };
}
