/**
 * `GET cms/secrets`, owned by whichever tab mounts it (#570).
 *
 * Each tab that needs the credential lights calls this itself, so a failure
 * belongs to that tab alone and never blanks the tab bar or another tab.
 *
 * Race-safety, as the Newsletter Hub hardened it in #555:
 *   - every load takes a generation number, and only the newest may write
 *     state, so a slow first load cannot land over a Refresh;
 *   - unmounting bumps the generation, so nothing writes after the tab closes;
 *   - a failed load CLEARS the data it replaces. Lights from before a refused
 *     refresh are not lights any more, and showing them beside the error would
 *     be the page contradicting itself.
 *
 * The response never carries a value (the route has no read path for one), and
 * nothing here asks for one.
 */

import useGuardedRouteRead from './useGuardedRouteRead';

export const SECRETS_ROUTE = 'cms/secrets';

// The read, its generation guard and its wait for sign-in are shared with the
// credential register (useGuardedRouteRead.js).
export default function useSecretStatus() {
  const { data, loading, error, reload } = useGuardedRouteRead(
    SECRETS_ROUTE,
    'Could not load credential status.'
  );
  return { data, loading, error, reload };
}
