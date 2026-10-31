/**
 * The Koda tab's read and writes (ADR 0037), over the shared race-safe
 * loader: one `cms/agent-content/key` read, re-read after every write so the
 * card shows what the API holds, never what the browser assumed.
 *
 * The generated secret is NOT part of the loaded data: the writes return the
 * API's answer to the caller, and the tab keeps the secret in its own state
 * for the one reveal.
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
    await refresh();
    return answer;
  }, [refresh]);

  const setCapability = useCallback(
    async (id, on) => {
      const answer = await setKodaCapabilities({ [id]: on });
      await refresh();
      return answer;
    },
    [refresh]
  );

  const revoke = useCallback(async () => {
    const answer = await revokeKodaKey();
    await refresh();
    return answer;
  }, [refresh]);

  return { data: data || EMPTY, loaded, error, refresh, generate, setCapability, revoke };
}
