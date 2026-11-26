/**
 * The Cloudflare page's Cache tab (#1905). Cloudflare keeps copies of the
 * site's pages and files close to visitors (the cache). Purging throws
 * copies away, so the next visitor gets a fresh one from the site.
 *
 * Two ways: everything (asks first, because every visitor's next request
 * then goes to the site, which is slower for a while), or up to 30
 * addresses, one per line, each https and on the zone's own names. Both need
 * the super admin role (RoleGate), and each button is disabled while its
 * request is out. Purging deletes nothing on the site itself.
 */
import React, { useState } from 'react';
import { Eraser, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import RoleGate from '@/components/admin/RoleGate';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { MAX_PURGE_FILES, purgeCloudflareCache } from '@/lib/cloudflare';
import { NotConfigured, WRITE_REASON, useCloudflareWrite } from './CloudflareParts';
import useCanWrite from './useCanWrite';
import { parsePurgeList } from './cloudflareView';

export default function CloudflareCache({ status = null }) {
  const { busyIds, run } = useCloudflareWrite();
  const canWrite = useCanWrite();
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState('');
  const zoneName = status?.zone?.name || '';
  const { files, problems } = parsePurgeList(text, { zoneName, max: MAX_PURGE_FILES });
  const typed = text.trim().length > 0;

  if (status?.configured === false) {
    return <NotConfigured missing={status.missing} message={status.message} />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Empty the whole cache</CardTitle>
          <CardDescription>
            Every copy Cloudflare keeps of the site is thrown away. Use it after a change that
            touches many pages. For a while every visitor’s request goes to the site itself, so
            pages load a little slower. Nothing on the site is deleted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RoleGate minRole="super_admin" reason={WRITE_REASON}>
            <Button
              size="sm"
              variant="destructive"
              disabled={busyIds.has('everything')}
              onClick={() => setConfirming(true)}
            >
              {busyIds.has('everything') ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" aria-hidden="true" />
              ) : (
                <Eraser className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              )}
              Purge everything
            </Button>
          </RoleGate>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Empty the cache for some addresses</CardTitle>
          <CardDescription>
            One full address per line, up to {MAX_PURGE_FILES}, each starting https://
            {zoneName ? ` and on ${zoneName}` : ''}. Only those copies are thrown away.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            aria-label="Addresses to purge"
            className="font-mono text-xs min-h-[8rem]"
            placeholder={`https://${zoneName || 'www.example.com'}/a-page`}
            value={text}
            disabled={busyIds.has('files') || !canWrite}
            onChange={(event) => setText(event.target.value)}
          />
          {typed && problems.length > 0 && (
            <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <RoleGate minRole="super_admin" reason={WRITE_REASON}>
            <Button
              size="sm"
              disabled={busyIds.has('files') || !typed || problems.length > 0}
              onClick={async () => {
                const done = await run(
                  'files',
                  () => purgeCloudflareCache({ files }),
                  `${files.length} address${files.length === 1 ? '' : 'es'} purged.`
                );
                if (done) setText('');
              }}
            >
              {busyIds.has('files') && (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" aria-hidden="true" />
              )}
              Purge {files.length || ''} address{files.length === 1 ? '' : 'es'}
            </Button>
          </RoleGate>
        </CardContent>
      </Card>

      <ConfirmModal
        open={confirming}
        title="Purge everything?"
        description="Every cached copy of the site is thrown away at once. Pages load a little slower until Cloudflare has fresh copies. Nothing on the site is deleted."
        confirmLabel="Purge everything"
        busy={busyIds.has('everything')}
        onConfirm={async () => {
          await run(
            'everything',
            () => purgeCloudflareCache({ everything: true }),
            'The whole cache is purged.'
          );
          setConfirming(false);
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
