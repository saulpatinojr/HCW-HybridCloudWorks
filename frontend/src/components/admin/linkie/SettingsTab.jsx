/**
 * Settings — whether the Linkie key works, and where the rest is set (#577).
 *
 * This was the Connection tab. It is last now because that is where the
 * Newsletter Hub standard puts a provider's connection test: an operator comes
 * here when something is wrong, not while composing.
 *
 * A successful test re-resolves the profile, so a key fixed here takes effect
 * without a page reload — `onStatusChange` is what carries that back up.
 */
import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertCircle, CheckCircle, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { extractProfiles, readLinkieBody } from '@/lib/linkie';
import { ltGetProfiles } from './linkieApi';

export default function SettingsTab({ onStatusChange }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null); // { ok, message, profile? }

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const response = await ltGetProfiles();
      // `/pages` (`/profiles` until October 2026) was already the right
      // endpoint, so this test has always worked — but it read a resolved
      // not-ok envelope as success. A refused key now says so, and a key
      // without the pages scopes answers 403 "Insufficient scope" here.
      const profile = readLinkieBody(response);
      const profiles = extractProfiles(response);
      setResult({
        ok: true,
        message: `Connected to the Linkie API — ${profiles.length} page${profiles.length === 1 ? '' : 's'}.`,
        profile,
      });
      onStatusChange?.(true);
    } catch (err) {
      setResult({ ok: false, message: err.message });
      onStatusChange?.(false);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Linkie API Connection</CardTitle>
          <CardDescription>
            The LINKIE_API_KEY is stored in Azure Key Vault and used server-side by the linkieProxy
            Azure Function - it is never sent to the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            The button and the link share a flex row. `space-y-4` sets
            margin-top on a following sibling, and both render as `inline-flex`
            — so with no result panel between them they land on the same line
            with no separation at all. The result panel stays outside the row,
            as its own block child, because it is a full-width message.
          */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button onClick={handleTest} disabled={testing} className="gap-2">
              {testing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Test Connection
            </Button>
            <a
              href="https://linkie.bio/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              Manage your Linkie <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          {result && (
            <div
              className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
                result.ok
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400'
                  : 'border-destructive/40 bg-destructive/10 text-destructive'
              }`}
            >
              {result.ok ? (
                <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0">
                <p>{result.message}</p>
                {result.ok && result.profile && (
                  <pre className="mt-2 text-xs text-muted-foreground overflow-auto max-h-40">
                    {JSON.stringify(result.profile, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
