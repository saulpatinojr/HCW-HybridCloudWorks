/**
 * SenderCard — the From address newsletters send from (ADR 0033 Amplify
 * slice). The code's default is shown as such; a change is validated on the
 * server against a Resend sending domain, and the server's reason comes back
 * when it refuses. Empty returns to the default.
 *
 *   GET cms/newsletter-sender
 *   PUT cms/newsletter-sender { from }   publisher
 */
import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Loader2, Save } from 'lucide-react';
import { getJSON, sendJSON } from '@/lib/api';

export const SENDER_ROUTE = 'cms/newsletter-sender';

/** The From address: the stored sender or the code's default, and the server's word on a change. */
export default function SenderCard() {
  const [stored, setStored] = useState(null);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let current = true;
    getJSON(SENDER_ROUTE)
      .then((res) => {
        if (!current) return;
        setStored(res);
        setValue(res.isDefault ? '' : res.from);
      })
      .catch((err) => current && setLoadError(err.message))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, []);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const res = await sendJSON(SENDER_ROUTE, 'PUT', { from: value.trim() });
      setStored(res);
      setValue(res.isDefault ? '' : res.from);
      setNotice({
        ok: true,
        message: res.isDefault
          ? `Back to the default: ${res.from}`
          : `Newsletters now send from ${res.from}.`,
      });
    } catch (err) {
      setNotice({ ok: false, message: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sender</CardTitle>
        <CardDescription>
          The From address on every newsletter, test send and confirmation email. It must be on a
          domain Resend sends from; the default is always allowed, another domain must be verified
          in Resend first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && <Spinner size="sm" label="Loading sender" className="justify-start" />}
        {!loading && loadError && (
          <p role="alert" className="text-sm text-destructive">
            The sender could not be read: {loadError}
          </p>
        )}
        {!loading && !loadError && stored && (
          <form onSubmit={save} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="nl-sender">From address</Label>
              <Input
                id="nl-sender"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={stored.defaultFrom}
                aria-describedby="nl-sender-help"
              />
              <p id="nl-sender-help" className="text-xs text-muted-foreground">
                {stored.isDefault ? 'Using the default. ' : `Currently ${stored.from}. `}
                Write it as <code>Name &lt;address@{stored.sendingDomain}&gt;</code>, or leave empty
                for the default.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="sm" className="gap-2" disabled={saving}>
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}{' '}
                Save sender
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
