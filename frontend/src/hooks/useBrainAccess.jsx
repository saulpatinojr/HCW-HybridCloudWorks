import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { brainApi } from '@/lib/brainApi';
const BrainAccess = createContext({ enabled: false, loading: false });
export function BrainAccessProvider({ children, accountLabel }) {
  const [state, setState] = useState({ enabled: false, loading: true });
  const alive = useRef(false);
  const generation = useRef(null);
  const lastChecked = useRef(0);
  const refresh = useCallback(async () => {
    if (!alive.current) return;
    const request = Symbol('brain-access-check');
    generation.current = request;
    lastChecked.current = Date.now();
    setState((previous) => ({ ...previous, loading: !previous.enabled }));
    try {
      const result = await brainApi.status();
      if (alive.current && request === generation.current)
        setState({ ...result, enabled: result.enabled === true, loading: false });
    } catch (error) {
      if (alive.current && request === generation.current)
        setState({ enabled: false, loading: false, errorStatus: error.status || null });
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    Promise.resolve().then(refresh);
    const onFocus = () => {
      if (Date.now() - lastChecked.current >= 10000) refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      generation.current = null;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);
  const value = useMemo(
    () => ({ ...state, accountLabel, refresh }),
    [state, accountLabel, refresh]
  );
  return <BrainAccess.Provider value={value}>{children}</BrainAccess.Provider>;
}
export const useBrainAccess = () => useContext(BrainAccess);
