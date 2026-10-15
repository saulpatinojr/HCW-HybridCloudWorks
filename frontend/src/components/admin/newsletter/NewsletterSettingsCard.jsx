/**
 * NewsletterSettingsCard — the settings a newsletter send needs (ADR 0030 §2a).
 *
 * Reads and writes `cms/platform-settings/newsletter-settings`. A partial save
 * is allowed. The issue view lists which of the postal address and reply-to a
 * send still needs; the approval step, a later change, will refuse to send
 * without them.
 *
 * The Content, Signup form and Template blocks (#557) are part of the same form
 * and the same save: the settings are one document written whole, so one form holds
 * all of it.
 *
 * Race-safety: each load carries a generation number and only the latest may
 * write state, so a slow first load cannot land over a retry; a save is
 * guarded by a ref as well as the disabled button, so a double click sends
 * one PUT; and a failed load hides the form and clears what it held.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import IntegrationBadge from '@/components/admin/shared/IntegrationBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { Loader2, Save } from 'lucide-react';
import { getJSON, sendJSON } from '@/lib/api';
import NewsletterContentFields, { contentProblem } from './NewsletterContentFields';
import NewsletterSignupFields, { signupProblem } from './NewsletterSignupFields';
import NewsletterTemplateFields from './NewsletterTemplateFields';
import { DEFAULT_SIGNUP_CONFIG } from '@/lib/newsletterSignup';

export const NEWSLETTER_SETTINGS_ROUTE = 'cms/platform-settings/newsletter-settings';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const EMPTY = {
  postalAddress: '',
  replyTo: '',
  sendDay: 'tuesday',
  sendTime: '09:00',
  timeZone: 'America/Chicago',
  sections: [],
  windowDays: 7,
  introEnabled: true,
  introTone: 'professional',
  signupPlacement: DEFAULT_SIGNUP_CONFIG.placement,
  signupHeading: DEFAULT_SIGNUP_CONFIG.heading,
  signupBlurb: DEFAULT_SIGNUP_CONFIG.blurb,
  // The built-in design; otherwise a Resend template id.
  templateId: '',
};

/** The newsletter settings as one form over one document, saved whole so no field is dropped. */
export default function NewsletterSettingsCard({ onSaved }) {
  const [value, setValue] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  // Set only when the stored settings could not be read. The form is NOT shown
  // then: its fields would hold defaults, and saving them would overwrite the
  // real settings after nothing worse than a transient load error.
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [options, setOptions] = useState(null);
  const loadGeneration = useRef(0);
  const savingRef = useRef(false);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const current = () => generation === loadGeneration.current;
    getJSON(NEWSLETTER_SETTINGS_ROUTE)
      .then((res) => {
        if (!current()) return;
        setValue({ ...EMPTY, ...(res?.value || {}) });
        setOptions(res?.options || null);
        setLoadError('');
      })
      .catch((err) => {
        if (!current()) return;
        setValue(EMPTY);
        setLoadError(err.message || 'Could not load the newsletter settings.');
      })
      .finally(() => current() && setLoading(false));
    return () => {
      // Unmounting or a newer attempt: this load may no longer write state.
      if (current()) loadGeneration.current += 1;
    };
  }, [attempt]);

  const handleRetry = () => {
    setLoading(true);
    setLoadError('');
    setAttempt((n) => n + 1);
  };

  const set = (key) => (event) =>
    setValue((current) => ({ ...current, [key]: event.target.value }));

  const setContent = (patch) => setValue((current) => ({ ...current, ...patch }));

  const handleSave = async (event) => {
    event.preventDefault();
    if (savingRef.current) return;
    const problem = contentProblem(value) || signupProblem(value);
    if (problem) {
      setNotice({ ok: false, message: problem });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    try {
      const res = await sendJSON(NEWSLETTER_SETTINGS_ROUTE, 'PUT', value);
      // What the server stored, after its own clamping, is what the form shows.
      setValue({ ...EMPTY, ...res.value });
      if (res.options) setOptions(res.options);
      setNotice({ ok: true, message: 'Newsletter settings saved.' });
      onSaved?.();
    } catch (err) {
      setNotice({ ok: false, message: err.message });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Newsletter settings <IntegrationBadge id="resend" size="xs" />
        </CardTitle>
        <CardDescription>
          Every issue carries your postal address (required by law for commercial email) and sends
          replies to the inbox below. Nothing can be approved until both are filled in. Content sets
          what each issue is built from, Signup form sets the box visitors subscribe with, and
          Template sets the design the email is laid out in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && <Spinner size="sm" label="Loading settings" className="justify-start" />}
        {!loading && loadError && (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              The saved settings could not be loaded, so they are not shown for editing: {loadError}
            </p>
            <Button variant="outline" size="sm" onClick={handleRetry}>
              Retry
            </Button>
          </div>
        )}
        {!loading && !loadError && (
          <form onSubmit={handleSave} className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2 space-y-1.5">
              <Label htmlFor="nl-postal">Postal address</Label>
              <Textarea
                id="nl-postal"
                rows={3}
                maxLength={300}
                value={value.postalAddress}
                onChange={set('postalAddress')}
                placeholder="PO Box or business address"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nl-reply">Reply-to address</Label>
              <Input
                id="nl-reply"
                type="email"
                value={value.replyTo}
                onChange={set('replyTo')}
                placeholder="an inbox you read"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nl-zone">Time zone</Label>
              <Input id="nl-zone" value={value.timeZone} onChange={set('timeZone')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nl-day">Send day</Label>
              <select
                id="nl-day"
                value={value.sendDay}
                onChange={set('sendDay')}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm capitalize"
              >
                {DAYS.map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nl-time">Send time</Label>
              <Input id="nl-time" type="time" value={value.sendTime} onChange={set('sendTime')} />
            </div>
            <div className="md:col-span-2">
              <NewsletterContentFields value={value} options={options} onChange={setContent} />
            </div>
            <div className="md:col-span-2">
              <NewsletterSignupFields value={value} onChange={setContent} />
            </div>
            <div className="md:col-span-2">
              <NewsletterTemplateFields value={value} onChange={setContent} />
            </div>
            <div className="md:col-span-2 flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={saving} className="gap-2">
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save settings
              </Button>
              {notice && (
                <p
                  role={notice.ok ? 'status' : 'alert'}
                  className={`text-sm ${notice.ok ? 'text-emerald-600' : 'text-destructive'}`}
                >
                  {notice.message}
                </p>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
