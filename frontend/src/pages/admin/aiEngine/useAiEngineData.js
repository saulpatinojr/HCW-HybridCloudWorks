/**
 * The AI Engine page's data, in two parts: the configuration seed with the
 * provider and tool-server lists it unlocks, and the model catalogue with the
 * writes the tabs and the drawer share. Both were written inline in
 * AIEnginePage.jsx until the page grew too long to follow.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  aiEngine,
  seedAiEngineIfEmpty,
  subscribeProviders,
  subscribeMcpServers,
} from '@/lib/aiEngine';
import { describeRefreshSummary } from '@/components/admin/ai-engine/ServicesTab';

/**
 * Seed the configuration, then follow the provider and server lists. A
 * failed seed is said, with a retry: until ADR 0033 the promise had no catch,
 * so a 403 or an offline API left the spinner turning forever.
 */
export function useAiEngineSeed() {
  const [providers, setProviders] = useState([]);
  const [servers, setServers] = useState([]);
  const [seed, setSeed] = useState({ status: 'seeding', error: null });

  const runSeed = useCallback(() => {
    seedAiEngineIfEmpty()
      .then(() => setSeed({ status: 'ready', error: null }))
      .catch((err) =>
        setSeed({ status: 'error', error: err?.message || 'The configuration could not be read.' })
      );
  }, []);

  useEffect(() => {
    runSeed();
  }, [runSeed]);

  const retrySeed = () => {
    setSeed({ status: 'seeding', error: null });
    runSeed();
  };

  useEffect(() => {
    if (seed.status !== 'ready') return undefined;
    const unsubP = subscribeProviders(setProviders);
    const unsubS = subscribeMcpServers(setServers);
    return () => {
      unsubP();
      unsubS();
    };
  }, [seed.status]);

  return { providers, servers, seed, retrySeed };
}

/**
 * The model catalogue (#857): read once the seed is ready, and again after
 * a hide or a refresh. A catalogue that cannot be read leaves the cards on
 * whatever their stored documents carry rather than emptying the selects —
 * and says so (AP-F12, #936). The failure used to be logged and nothing
 * else, so a page whose dropdowns held only the provider default looked
 * like a page with no models rather than a page that could not read them.
 */
export function useModelCatalog(ready, toast) {
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState(null);
  // ONLY THE LATEST READ LANDS (AP-F12, #936). Try again pressed twice, or a
  // hide's re-read beside a refresh's, puts two reads in flight, and they can
  // settle in either order: an earlier failure would bring the notice back
  // over a later success, and an older catalogue could replace a newer one.
  // Each read takes a number; one that is no longer the latest is logged if
  // it failed and otherwise ignored.
  const catalogRead = useRef(0);
  /** Read the catalogue and show it, or say it failed — unless a newer read has started since. */
  const loadCatalog = useCallback(() => {
    const read = ++catalogRead.current;
    const latest = () => read === catalogRead.current;
    return aiEngine
      .fetchModelCatalog()
      .then((next) => {
        if (!latest()) return;
        setCatalog(next);
        setCatalogError(null);
      })
      .catch((err) => {
        console.error('[aiEngine] model catalogue load failed:', err);
        if (!latest()) return;
        setCatalogError(err?.message || 'The model catalogue could not be read.');
      });
  }, []);
  useEffect(() => {
    if (!ready) return;
    loadCatalog();
  }, [ready, loadCatalog]);

  // The catalogue's writes (#857) live here because two tabs and the drawer
  // share them: a hide or a refresh lands on the API, then the page
  // re-reads the document so every card and dropdown shows what it holds.
  const [refreshing, setRefreshing] = useState(false);
  const handleHideModel = async (id, model, hidden) => {
    try {
      await aiEngine.setModelHidden(id, model, hidden);
      await loadCatalog();
    } catch (err) {
      toast({
        title: hidden ? 'Could not hide the model' : 'Could not show the model',
        description: err?.message || 'Nothing was changed.',
        variant: 'destructive',
      });
    }
  };
  const handleRefreshCatalog = async () => {
    setRefreshing(true);
    try {
      const summary = await aiEngine.refreshModelCatalog();
      const { text, failed: anyFailed } = describeRefreshSummary(summary);
      toast({
        title: anyFailed ? 'Model lists refreshed, with errors' : 'Model lists refreshed',
        description: text,
        ...(anyFailed ? { variant: 'destructive' } : {}),
      });
      await loadCatalog();
    } catch (err) {
      toast({
        title: 'Could not refresh the model lists',
        description: err?.message || 'Nothing was changed.',
        variant: 'destructive',
      });
    } finally {
      setRefreshing(false);
    }
  };

  return {
    catalog,
    catalogError,
    dismissCatalogError: () => setCatalogError(null),
    loadCatalog,
    refreshing,
    handleHideModel,
    handleRefreshCatalog,
  };
}
