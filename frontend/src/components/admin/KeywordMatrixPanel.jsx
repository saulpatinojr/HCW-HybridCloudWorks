import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Plus, Save, Trash2, RotateCcw } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { useImagePrompts } from '@/hooks/useImagePrompts';

function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function csvToList(s) {
  return String(s || '')
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function listToCsv(arr) {
  return Array.isArray(arr) ? arr.join(', ') : '';
}

const BLANK_SYN = { id: '', canonical: '', patternsCsv: '' };
const BLANK_AUG = { id: '', label: '', patternsCsv: '', directive: '' };

export default function KeywordMatrixPanel() {
  const { toast } = useToast();
  const {
    fetchKeywordSynonyms,
    saveKeywordSynonym,
    deleteKeywordSynonym,
    fetchKeywordAugmentations,
    saveKeywordAugmentation,
    deleteKeywordAugmentation,
  } = useImagePrompts();

  const [synonyms, setSynonyms] = useState([]);
  const [augmentations, setAugmentations] = useState([]);
  const [synDraft, setSynDraft] = useState(BLANK_SYN);
  const [augDraft, setAugDraft] = useState(BLANK_AUG);
  const [testInput, setTestInput] = useState('');
  // The delete waiting on its confirmation (ADR 0033 §2: state, not a
  // browser dialog) — `{ kind: 'synonym' | 'augmentation', item }` — and
  // whether its request is running, which holds the modal open and busy
  // (AP-F12, #936).
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const reload = useCallback(async () => {
    const [syns, augs] = await Promise.all([fetchKeywordSynonyms(), fetchKeywordAugmentations()]);
    setSynonyms(syns);
    setAugmentations(augs);
  }, [fetchKeywordSynonyms, fetchKeywordAugmentations]);

  useEffect(() => {
    const timer = setTimeout(() => {
      reload();
    }, 0);
    return () => clearTimeout(timer);
  }, [reload]);

  // ---------- Synonyms ----------
  const handleSaveSyn = async () => {
    if (!synDraft.canonical.trim()) {
      toast({ title: 'Canonical tag required', variant: 'destructive' });
      return;
    }
    const id = synDraft.id || slugify(synDraft.canonical);
    const ok = await saveKeywordSynonym(id, {
      canonical: synDraft.canonical,
      patterns: csvToList(synDraft.patternsCsv),
    });
    if (ok) {
      toast({ title: 'Synonym group saved', description: synDraft.canonical });
      setSynDraft(BLANK_SYN);
      reload();
    }
  };

  const handleEditSyn = (s) => {
    setSynDraft({ id: s.id, canonical: s.canonical, patternsCsv: listToCsv(s.patterns) });
  };

  const handleDeleteSyn = (s) => setPendingDelete({ kind: 'synonym', item: s });

  // ---------- Augmentations ----------
  const handleSaveAug = async () => {
    if (!augDraft.label.trim() || !augDraft.directive.trim()) {
      toast({ title: 'Label and directive required', variant: 'destructive' });
      return;
    }
    const id = augDraft.id || slugify(augDraft.label);
    const ok = await saveKeywordAugmentation(id, {
      label: augDraft.label,
      patterns: csvToList(augDraft.patternsCsv),
      directive: augDraft.directive,
    });
    if (ok) {
      toast({ title: 'Augmentation saved', description: augDraft.label });
      setAugDraft(BLANK_AUG);
      reload();
    }
  };

  const handleEditAug = (a) => {
    setAugDraft({
      id: a.id,
      label: a.label,
      patternsCsv: listToCsv(a.patterns),
      directive: a.directive,
    });
  };

  const handleDeleteAug = (a) => setPendingDelete({ kind: 'augmentation', item: a });

  // ---------- The confirmed delete ----------
  const deleteCopy = (pending) =>
    pending.kind === 'synonym'
      ? { title: `Delete synonym group "${pending.item.canonical}"?`, name: pending.item.canonical }
      : { title: `Delete augmentation "${pending.item.label}"?`, name: pending.item.label };

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    const { kind, item } = pendingDelete;
    setDeleting(true);
    try {
      const ok =
        kind === 'synonym'
          ? await deleteKeywordSynonym(item.id)
          : await deleteKeywordAugmentation(item.id);
      if (ok) {
        toast({ title: 'Deleted', description: deleteCopy(pendingDelete).name });
        reload();
      }
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  // ---------- Live tester ----------
  const testResult = useMemo(() => {
    const text = testInput.toLowerCase();
    if (!text) return { canonical: [], augmentations: [] };
    const matchedCanonical = [];
    for (const s of synonyms) {
      if (s.patterns.some((p) => p && text.includes(p.toLowerCase()))) {
        matchedCanonical.push(s.canonical);
      }
    }
    const matchedAugs = [];
    for (const a of augmentations) {
      if (a.patterns.some((p) => p && text.includes(p.toLowerCase()))) {
        matchedAugs.push(a);
      }
    }
    return {
      canonical: Array.from(new Set(matchedCanonical)),
      augmentations: matchedAugs,
    };
  }, [testInput, synonyms, augmentations]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">Keyword Matrix</CardTitle>
        <Button variant="outline" size="sm" onClick={reload}>
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Reload
        </Button>
      </CardHeader>
      <CardContent className="space-y-8">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          The matrix collapses messy article wording into canonical concepts and adds a scene
          directive when a keyword appears. It is applied, case-insensitively, to the title and
          summary of whatever is being illustrated, by every generator: the AI cover from the review
          queue and the change feed, the Submit URLs preview slots, curated news images, and a set
          sample from this page. Saved changes apply to the next generation; images already made
          keep the prompt they were made with (shown on each image in the gallery).
        </p>

        {/* Live tester */}
        <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/50">
          <p className="text-sm font-semibold mb-2">Live test</p>
          <textarea
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            placeholder="Paste an article title, summary, or comma-separated tags here to see what the matrix would do."
            className="w-full h-20 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
          />
          {testInput && (
            <div className="mt-3 space-y-2 text-xs">
              <div>
                <span className="font-mono text-slate-500">canonical →</span>{' '}
                {testResult.canonical.length > 0 ? (
                  testResult.canonical.map((c) => (
                    <span
                      key={c}
                      className="inline-block px-2 py-0.5 mr-1 rounded-full bg-slate-200 dark:bg-slate-700"
                    >
                      {c}
                    </span>
                  ))
                ) : (
                  <span className="text-slate-400">(none)</span>
                )}
              </div>
              <div>
                <span className="font-mono text-slate-500">augmentations →</span>
                {testResult.augmentations.length > 0 ? (
                  <ul className="mt-1 space-y-1 ml-4 list-disc">
                    {testResult.augmentations.map((a) => (
                      <li key={a.id}>
                        <span className="font-semibold">{a.label}:</span> {a.directive}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-slate-400"> (none)</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Synonyms */}
        <section>
          <h3 className="font-semibold mb-3">
            Synonyms{' '}
            <span className="text-xs font-normal text-slate-500">
              (collapse raw tags to canonical)
            </span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)_auto_auto] gap-2 mb-3">
            <input
              type="text"
              value={synDraft.canonical}
              onChange={(e) => setSynDraft((d) => ({ ...d, canonical: e.target.value }))}
              placeholder="Canonical (e.g., Database)"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
            />
            <input
              type="text"
              value={synDraft.patternsCsv}
              onChange={(e) => setSynDraft((d) => ({ ...d, patternsCsv: e.target.value }))}
              placeholder="patterns, comma-separated (aurora, mysql, postgres)"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
            />
            <Button
              onClick={handleSaveSyn}
              className="bg-green-600 hover:bg-green-700 text-white"
              size="sm"
            >
              {synDraft.id ? <Save className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            </Button>
            <Button
              onClick={() => setSynDraft(BLANK_SYN)}
              variant="outline"
              size="sm"
              disabled={!synDraft.id && !synDraft.canonical}
            >
              Clear
            </Button>
          </div>

          <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800/60 text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Canonical</th>
                  <th className="text-left p-2">Patterns</th>
                  <th className="text-right p-2 w-32">Actions</th>
                </tr>
              </thead>
              <tbody>
                {synonyms.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-3 text-center text-slate-500">
                      No synonym groups yet. Until you add one, no concepts are collapsed.
                    </td>
                  </tr>
                )}
                {synonyms.map((s) => (
                  <tr
                    key={s.id}
                    className="border-t border-slate-200 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800/30"
                  >
                    <td className="p-2 font-semibold">{s.canonical}</td>
                    <td className="p-2 text-xs text-slate-600 dark:text-slate-400">
                      {s.patterns.join(', ')}
                    </td>
                    <td className="p-2 text-right space-x-1">
                      <Button size="sm" variant="outline" onClick={() => handleEditSyn(s)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDeleteSyn(s)}
                        className="px-2"
                        aria-label={`Delete synonym group ${s.canonical}`}
                      >
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Augmentations */}
        <section>
          <h3 className="font-semibold mb-3">
            Scene Augmentations{' '}
            <span className="text-xs font-normal text-slate-500">
              (inject directive when keyword appears)
            </span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-[160px_minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-2 mb-3">
            <input
              type="text"
              value={augDraft.label}
              onChange={(e) => setAugDraft((d) => ({ ...d, label: e.target.value }))}
              placeholder="Label (e.g., kiro)"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
            />
            <input
              type="text"
              value={augDraft.patternsCsv}
              onChange={(e) => setAugDraft((d) => ({ ...d, patternsCsv: e.target.value }))}
              placeholder="patterns (kiro, aws kiro)"
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
            />
            <textarea
              value={augDraft.directive}
              onChange={(e) => setAugDraft((d) => ({ ...d, directive: e.target.value }))}
              placeholder="Directive: Include the Kiro icon prominently..."
              rows={2}
              className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
            />
            <div className="flex flex-col gap-1">
              <Button
                onClick={handleSaveAug}
                className="bg-green-600 hover:bg-green-700 text-white"
                size="sm"
              >
                {augDraft.id ? <Save className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              </Button>
              <Button
                onClick={() => setAugDraft(BLANK_AUG)}
                variant="outline"
                size="sm"
                disabled={!augDraft.id && !augDraft.label}
              >
                Clear
              </Button>
            </div>
          </div>

          <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800/60 text-xs uppercase">
                <tr>
                  <th className="text-left p-2 w-32">Label</th>
                  <th className="text-left p-2 w-1/4">Patterns</th>
                  <th className="text-left p-2">Directive</th>
                  <th className="text-right p-2 w-32">Actions</th>
                </tr>
              </thead>
              <tbody>
                {augmentations.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-3 text-center text-slate-500">
                      No augmentations yet. Until you add one, no directives are added.
                    </td>
                  </tr>
                )}
                {augmentations.map((a) => (
                  <tr
                    key={a.id}
                    className="border-t border-slate-200 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800/30"
                  >
                    <td className="p-2 font-semibold align-top">{a.label}</td>
                    <td className="p-2 text-xs text-slate-600 dark:text-slate-400 align-top">
                      {a.patterns.join(', ')}
                    </td>
                    <td className="p-2 text-xs align-top">{a.directive}</td>
                    <td className="p-2 text-right space-x-1 align-top">
                      <Button size="sm" variant="outline" onClick={() => handleEditAug(a)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDeleteAug(a)}
                        className="px-2"
                        aria-label={`Delete augmentation ${a.label}`}
                      >
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </CardContent>

      <ConfirmModal
        open={pendingDelete !== null}
        title={pendingDelete ? deleteCopy(pendingDelete).title : ''}
        description="This applies to the next generation; images already made keep the prompt they were made with."
        confirmLabel="Delete"
        busy={deleting}
        busyLabel="Deleting…"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </Card>
  );
}
