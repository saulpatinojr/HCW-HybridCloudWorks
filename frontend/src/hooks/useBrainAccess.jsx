import React, { createContext, useContext, useEffect, useState } from 'react';
import { brainApi } from '@/lib/brainApi';
const BrainAccess = createContext({ enabled: false, loading: false });
export function BrainAccessProvider({ children }) {
  const [state, setState] = useState({ enabled: false, loading: true });
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => brainApi.status())
      .then((result) => {
        if (alive) setState({ ...result, enabled: result.enabled === true, loading: false });
      })
      .catch(() => {
        if (alive) setState({ enabled: false, loading: false });
      });
    return () => {
      alive = false;
    };
  }, []);
  return <BrainAccess.Provider value={state}>{children}</BrainAccess.Provider>;
}
export const useBrainAccess = () => useContext(BrainAccess);
