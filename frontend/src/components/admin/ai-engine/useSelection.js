/**
 * The selection document's reads and writes on the page (ADR 0034 §4, §6;
 * slice 4, #859): the document itself (`GET cms/ai-routing`) beside the
 * resolver's answer for every task (`GET cms/ai-routing/effective`), and
 * one save path that PUTs the whole document with the `updatedAt` it read.
 *
 * A 409 — the document changed underneath — reloads both reads and says so,
 * never overwrites. A refused document (400) is thrown with the API's own
 * sentence, for the row that asked to show inline. After a successful save
 * the effective answer is read again, because the resolver's answer is the
 * only thing the page shows as "what a call will use".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/ui/use-toast';
import { aiEngine } from '@/lib/aiEngine';
import { normalizeSelection } from './selectionModel';

const INITIAL = {
  status: 'loading',
  selection: null,
  effective: null,
  catalogue: {},
  providers: [],
  migrated: false,
  error: null,
};

/**
 * @returns {{
 *   state: typeof INITIAL,
 *   saving: boolean,
 *   reload: () => Promise<void>,
 *   save: (next: object) => Promise<object>,
 * }}
 */
export default function useSelection(catalog = null) {
  const { toast } = useToast();
  const [state, setState] = useState(INITIAL);
  const [saving, setSaving] = useState(false);
  const readId = useRef(0);

  const load = useCallback(async () => {
    const read = ++readId.current;
    try {
      const [routing, effective] = await Promise.all([
        aiEngine.getAiRouting(),
        aiEngine.getEffectiveRouting(),
      ]);
      if (read !== readId.current) return;
      setState({
        status: 'ready',
        selection: normalizeSelection(routing.selection),
        effective,
        catalogue: routing.catalogue,
        providers: routing.providers,
        migrated: routing.migrated,
        error: null,
      });
    } catch (err) {
      if (read !== readId.current) return;
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: err?.message || 'The AI routing could not be read.',
      }));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, catalog]);

  const reload = useCallback(() => {
    setState((prev) => ({ ...prev, status: 'loading', error: null }));
    return load();
  }, [load]);

  const save = useCallback(
    async (next) => {
      setSaving(true);
      try {
        const saved = await aiEngine.saveAiRouting({
          ...next,
          updatedAt: state.selection?.updatedAt ?? null,
        });
        const effective = await aiEngine.getEffectiveRouting();
        setState((prev) => ({
          ...prev,
          selection: normalizeSelection(saved.selection),
          effective,
          migrated: false,
        }));
        return saved;
      } catch (err) {
        if (err?.status === 409) {
          toast({
            title: 'Changed elsewhere',
            description:
              'The AI routing was saved from another window since this page read it. It has been reloaded; apply the change again.',
            variant: 'destructive',
          });
          await load();
        }
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [load, state.selection, toast]
  );

  return { state, saving, reload, save };
}
