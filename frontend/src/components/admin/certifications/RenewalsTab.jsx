/**
 * Renewals — every certification that has expired or expires within the
 * renewal window, soonest first, with its due date and days left.
 *
 * The weekly re-verify timer (`reVerifyCertifications`, Sundays 00:00 UTC,
 * functions/src/lib/timers/cert-reverify.js) marks expired and Credly-revoked
 * certs inactive, re-activates a renewed one whose expiry moved ahead, and
 * republishes the snapshot. It records no run history that the API can read,
 * so this tab says what the timer does and shows its effect (the "Marked
 * inactive" badge) rather than inventing a last-run time.
 */
import React, { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { CertGrid } from './CertCard';
import { CertListNotice, TabIntro } from './shared';
import { RENEWAL_WINDOW_DAYS, renewalRows } from './certView';

function dueLine({ due, daysLeft, expired }) {
  if (expired) {
    const ago = Math.abs(daysLeft);
    return `Expired ${due} · ${ago} day${ago === 1 ? '' : 's'} ago`;
  }
  return `Due ${due} · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
}

function RenewalDetail({ row }) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      <span className={row.expired ? 'text-rose-600' : 'text-amber-600'}>{dueLine(row)}</span>
      {row.renewalDate && <span className="text-muted-foreground">Renew by {row.renewalDate}</span>}
      {row.cert.renewalRequirements && (
        <span className="text-muted-foreground">{row.cert.renewalRequirements}</span>
      )}
      {row.cert.certState === false && (
        <Badge variant="outline" className="text-xs">
          Marked inactive
        </Badge>
      )}
    </p>
  );
}

export default function RenewalsTab({ certs, nowMs, actions }) {
  const rows = useMemo(() => renewalRows(certs.items, nowMs), [certs.items, nowMs]);
  const byId = useMemo(() => new Map(rows.map((row) => [row.cert._docId, row])), [rows]);
  const expired = rows.filter((row) => row.expired).length;

  return (
    <div className="space-y-4">
      <TabIntro>
        Expired certifications and those expiring in the next {RENEWAL_WINDOW_DAYS} days, soonest
        first. Every Sunday at 00:00 UTC the re-verify timer marks expired certs, and Credly badges
        that no longer verify, as inactive; brings back a renewed cert whose expiry is ahead again;
        and republishes the public snapshot.
      </TabIntro>
      {certs.loaded ? (
        <>
          <p className="text-sm" role="status">
            {expired} expired · {rows.length - expired} expiring
          </p>
          <CertGrid
            certs={rows.map((row) => row.cert)}
            nowMs={nowMs}
            busyIds={certs.busyIds}
            actions={actions}
            empty={`Nothing has expired or expires in the next ${RENEWAL_WINDOW_DAYS} days.`}
            renderExtra={(cert) => <RenewalDetail row={byId.get(cert._docId)} />}
          />
        </>
      ) : (
        <CertListNotice certs={certs} />
      )}
    </div>
  );
}
