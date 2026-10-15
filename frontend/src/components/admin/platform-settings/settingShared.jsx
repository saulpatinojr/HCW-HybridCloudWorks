/**
 * What every Platform Settings Hub tab shares: the allowlists the server
 * enforces, the one route shape, and the load/save cycle of one setting.
 *
 * Each setting is one `admin_config` document behind
 * `cms/platform-settings/{setting}`, and the server normalizes every save to
 * exactly the shape its consumer reads (functions/src/lib/platform-settings.js).
 *
 * Race-safety, as hardened for the Newsletter Hub in #555:
 *
 *   - each load carries a generation number and only the latest may write
 *     state, so a slow first load cannot land over a retry, and an unmounted
 *     tab's load writes nothing;
 *   - a save is guarded by a ref as well as the disabled button, so a double
 *     submit sends one PUT;
 *   - a failed load clears what the card held and hides the form, so a
 *     stale or empty working copy can never be saved over the real document;
 *   - a save names the version it replaces (#946): the read's `etag` goes back
 *     as If-Match, and a save the server refuses because the setting was
 *     saved elsewhere since (412, or 428 from a page loaded before saves
 *     named a version) reloads the setting and says so, rather than
 *     overwriting what the other save stored.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { AlertTriangle, Loader2, RefreshCw, Save } from 'lucide-react';
import { getJSON, sendJSON } from '@/lib/api';

// The same lists the server allowlists (functions/src/lib/platform-settings.js).
export const HERO_PROVIDERS = Object.freeze([
  'Azure',
  'AWS',
  'GCP',
  'GitHub',
  'Terraform',
  'Ansible',
  'VMware',
  'Docker',
  'Multi',
]);
export const SOCIAL_PROVIDERS = Object.freeze([
  'linkedin',
  'twitter',
  'facebook',
  'instagram',
  'youtube',
]);
export const PODCAST_PROVIDERS = Object.freeze([
  'azure',
  'aws',
  'gcp',
  'github',
  'terraform',
  'finops',
  'vmware',
  'ansible',
  'docker',
]);

/**
 * Every setting a Change history row can name, as a person reads it. All but
 * the last are the server's platform-settings registry; `integrations` is
 * the Sessionize speaker id, saved on the Integrations page and written to
 * the same history (ADR 0033 Platform).
 */
export const SETTING_LABELS = Object.freeze({
  'default-heroes': 'Default covers',
  'social-autopost': 'Social autoposting',
  'podcast-feeds': 'Podcast feeds',
  'listen-and-learn-speech': 'Listen & Learn voice',
  'podcast-voices': 'Podcast voices',
  'newsletter-settings': 'Newsletter settings',
  'content-taxonomy': 'Content types & idea origins',
  reminders: 'Reminders',
  integrations: 'Sessionize speaker id (Integrations)',
});

/**
 * The names the history route's `?setting=` filter accepts: the server's
 * registry, which validates the value before querying. `integrations` is
 * listed by the unfiltered read but is not a registry setting, so it is not
 * offered as a filter — asking for it would be a 400.
 */
export const HISTORY_FILTERABLE = Object.freeze(
  Object.keys(SETTING_LABELS).filter((id) => id !== 'integrations')
);

export const settingRoute = (name) => `cms/platform-settings/${name}`;

/**
 * What the admin is told when a save is refused because the setting was saved
 * somewhere else since this page read it. The setting is reloaded with it.
 */
export const CHANGED_ELSEWHERE =
  'This was saved somewhere else since you opened it. Nothing was overwritten: what is stored now has been loaded, so make your change again.';

/**
 * Whether a save was refused because what it would replace is not what this
 * page read (#946): 412 when the version the save named is no longer stored,
 * 428 when the server will not replace a stored setting without one.
 *
 * @param {unknown} err the error sendJSON threw
 * @returns {boolean}
 */
export const isStaleSave = (err) =>
  err?.status === 412 || err?.status === 428 || err?.code === 'CONFLICT';

/**
 * PUT a setting, naming the version it replaces when the page has one: the
 * `etag` its last read or save returned, sent as If-Match. Without one (nothing
 * stored yet, the reminders sheet, or an API from before #946) the PUT carries
 * no If-Match, and the server creates the document or merges into it.
 *
 * @param {string} route the setting's route
 * @param {object} body the value to store
 * @param {string|null} etag the version the page read, or null
 * @returns {Promise<object>} the server's answer, with the new `etag`
 */
export const putSetting = (route, body, etag) =>
  etag
    ? sendJSON(route, 'PUT', body, { headers: { 'If-Match': etag } })
    : sendJSON(route, 'PUT', body);

export const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export const relativeTime = (iso) => {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
};

const EMPTY_META = Object.freeze({ exists: false, stored: null, updatedAt: null, problem: null });

const metaOf = (response) => ({
  exists: Boolean(response?.exists),
  stored: response?.stored ?? null,
  updatedAt: response?.updatedAt ?? null,
  problem: response?.problem ?? null,
});

/**
 * One setting's load/save cycle. `value` is the working copy the card edits;
 * `saved` is the value as last stored (null when nothing is), which edits do
 * not change until they are saved; `meta` is what the server said about the
 * stored document; `options` is what the server offers to choose from, where
 * a setting is a choice. The version the page read is held privately and
 * named by the next save (#946).
 *
 * @param {string} name the setting, as its route names it
 * @param {boolean} authReady whether a token can be had yet; nothing loads before
 */
export function useSetting(name, authReady) {
  const [value, setValue] = useState(null);
  const [saved, setSaved] = useState(null);
  const [meta, setMeta] = useState(EMPTY_META);
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const savingRef = useRef(false);
  // The ETag of the document this page last read or wrote: what a save names.
  const etagRef = useRef(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!authReady) return undefined;
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    getJSON(settingRoute(name))
      .then((response) => {
        if (!current()) return;
        setValue(response?.value ?? null);
        setSaved(response?.exists ? (response?.value ?? null) : null);
        setMeta(metaOf(response));
        setOptions(Array.isArray(response?.options) ? response.options : []);
        etagRef.current = response?.etag ?? null;
        setError(null);
      })
      .catch((err) => {
        if (!current()) return;
        // Nothing from a previous load survives a failed one.
        setValue(null);
        setSaved(null);
        setMeta(EMPTY_META);
        setOptions([]);
        etagRef.current = null;
        setError(err?.message ?? 'Could not load this setting.');
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      // Unmounting or a newer attempt: this load may no longer write state.
      if (current()) generation.current += 1;
    };
  }, [name, authReady, attempt]);

  const reload = useCallback(() => {
    // Supersede any load still in flight at once, not on the next effect run:
    // until the effect re-runs, an older answer would still count as current.
    generation.current += 1;
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  /**
   * Store `next` under the version this page read; true when it was stored.
   * A refusal because the setting changed elsewhere reloads it instead.
   */
  const save = useCallback(
    async (next) => {
      if (savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      try {
        const response = await putSetting(settingRoute(name), next, etagRef.current);
        etagRef.current = response?.etag ?? null;
        setValue(response.value);
        setSaved(response.value ?? null);
        setMeta({ ...metaOf(response), exists: true, stored: 'valid', problem: null });
        if (Array.isArray(response.options)) setOptions(response.options);
        toast({ title: 'Saved', description: `${name} is stored.` });
        return true;
      } catch (err) {
        if (isStaleSave(err)) {
          // Saved elsewhere since this page read it: show what is stored now
          // rather than keep offering a working copy that would replace it.
          toast({
            title: 'Changed elsewhere',
            description: CHANGED_ELSEWHERE,
            variant: 'destructive',
          });
          reload();
          return false;
        }
        toast({
          title: 'Not saved',
          description: err?.message ?? 'The write was refused.',
          variant: 'destructive',
        });
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [name, toast, reload]
  );

  return { value, setValue, saved, meta, options, loading, saving, error, save, reload };
}

export function StoredState({ meta }) {
  if (meta.stored === 'invalid') {
    return (
      <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span>
          The stored document does not match the shape the code reads
          {meta.problem ? ` (${meta.problem})` : ''}. What is shown is empty; saving replaces it.
        </span>
      </p>
    );
  }
  if (!meta.exists) {
    return <p className="text-xs text-muted-foreground">Not stored yet — the feature is off.</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      Stored{meta.updatedAt ? ` · updated ${relativeTime(meta.updatedAt)}` : ''}
    </p>
  );
}

/**
 * Sits inside each card's form: the submit is the form's, so one click is one
 * save. `disabled` holds it back while the form cannot be saved as it stands.
 */
export function SaveRow({ saving, disabled = false, children }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <Button type="submit" size="sm" disabled={saving || disabled}>
        {saving ? (
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Save className="mr-2 h-3.5 w-3.5" />
        )}
        Save
      </Button>
    </div>
  );
}

/**
 * A setting's loading, failed or loaded state. A failure names the setting,
 * says what the server said and offers a retry; the card is not rendered, so
 * nothing can be saved from a form that never received the stored document.
 */
export function SettingSection({ setting, label, render }) {
  if (setting.loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading {label ?? 'setting'}…
      </div>
    );
  }
  if (setting.error) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
      >
        <span>
          {label ? `${label}: ` : ''}
          {setting.error}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={setting.reload}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }
  return render(setting);
}
