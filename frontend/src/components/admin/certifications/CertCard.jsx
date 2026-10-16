/**
 * One certification as a card — image, issuer, status badges and the row of
 * actions (edit, show/hide, feature, verify, Learn page, delete). Used by
 * every tab that lists certs, so a cert looks and acts the same wherever it
 * appears. `busy` disables the write buttons while that cert's write is out.
 */
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Award,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  ExternalLink,
  CheckSquare,
  Star,
  StarOff,
  GraduationCap,
} from 'lucide-react';
import { getLearnUrl, getIssuerColor } from '@/lib/certIssuers';
import { safeUrl } from '@/lib/safeUrl';
import { expiryFlags, issuerOf, resolveImages, toIso } from './certView';

/** Img with fallback chain. Renders Award placeholder when all URLs fail. */
export function CertImage({ urls, alt, className, placeholderClassName }) {
  const [idx, setIdx] = useState(0);
  if (!urls.length || idx >= urls.length) {
    return (
      <div
        className={`${className} flex items-center justify-center bg-slate-100 dark:bg-slate-800 ${placeholderClassName || ''}`}
      >
        <Award className="h-6 w-6 text-slate-400" />
      </div>
    );
  }
  return (
    <img
      src={urls[idx]}
      alt={alt}
      referrerPolicy="no-referrer"
      loading="lazy"
      className={className}
      onError={() => setIdx((i) => i + 1)}
    />
  );
}

function getCertCardClassName(cert) {
  return [
    'overflow-hidden transition-all',
    cert.display ? '' : 'opacity-60',
    cert.featured ? 'ring-2 ring-amber-400' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function certDateValue(cert) {
  return toIso(cert.expDate) || toIso(cert.issueDate) || '—';
}

function CertStatusBadges({ cert, isExpired, isExpiringSoon }) {
  return (
    <>
      {cert.featured && (
        <Badge variant="outline" className="border-amber-400 text-amber-600 text-xs">
          Featured
        </Badge>
      )}
      {!cert.display && (
        <Badge variant="outline" className="text-xs">
          Hidden
        </Badge>
      )}
      {isExpired && (
        <Badge variant="destructive" className="text-xs">
          Expired
        </Badge>
      )}
      {isExpiringSoon && (
        <Badge variant="outline" className="border-amber-400 text-amber-600 text-xs">
          Expiring
        </Badge>
      )}
    </>
  );
}

/**
 * Opens a URL that `safeUrl()` has already approved (http, https, mailto, or a
 * relative reference): CMS data could carry `javascript:` or `data:`.
 */
const openSafely = (url) => window.open(url, '_blank', 'noopener');

function VerifyButton({ cert }) {
  const verifyUrl = safeUrl(cert.verifyUrl);
  if (!verifyUrl) {
    return (
      <span
        className="inline-flex h-7 items-center justify-center rounded border border-slate-200 px-2 text-slate-400 dark:border-slate-700 dark:text-slate-400"
        title="Verification unavailable"
        aria-label="Verification unavailable"
      >
        <CheckSquare className="h-3 w-3" />
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2"
      onClick={() => openSafely(verifyUrl)}
      title="Verify"
    >
      <ExternalLink className="h-3 w-3" />
    </Button>
  );
}

function LearnButton({ cert, issuer }) {
  const url = safeUrl(cert.learnUrl || getLearnUrl(issuer, cert.code));
  if (!url) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2"
      onClick={() => openSafely(url)}
      title="Open provider Learn page"
    >
      <GraduationCap className="h-3 w-3" />
    </Button>
  );
}

export function CertActionButtons({ cert, issuer, busy, actions }) {
  const { onEdit, onToggleDisplay, onToggleFeatured, onDelete } = actions;
  return (
    <div className="flex gap-1 mt-2">
      <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => onEdit(cert)}>
        <Pencil className="h-3 w-3 mr-1" />
        Edit
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2"
        onClick={() => onToggleDisplay(cert)}
        disabled={busy}
        title={cert.display ? 'Hide from About page' : 'Show on About page'}
      >
        {cert.display ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2"
        onClick={() => onToggleFeatured(cert)}
        disabled={busy}
        title={cert.featured ? 'Unfeature' : 'Feature'}
      >
        {cert.featured ? <StarOff className="h-3 w-3" /> : <Star className="h-3 w-3" />}
      </Button>
      <VerifyButton cert={cert} />
      <LearnButton cert={cert} issuer={issuer} />
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-rose-600 hover:bg-rose-50"
        onClick={() => onDelete(cert)}
        disabled={busy}
        title="Delete"
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

export default function CertCard({ cert, nowMs, busy = false, actions, children }) {
  const issuer = issuerOf(cert);
  const { isExpired, isExpiringSoon } = expiryFlags(cert, nowMs);

  return (
    <Card className={getCertCardClassName(cert)} data-testid="cert-card">
      <CardContent className="p-4 flex gap-3">
        <CertImage
          key={cert._docId || cert.id}
          urls={resolveImages(cert)}
          alt={cert.name}
          className="h-16 w-16 rounded object-contain bg-slate-50 dark:bg-slate-800 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{cert.name || '(untitled)'}</p>
              <p className="text-xs text-slate-500 truncate flex items-center gap-1.5">
                <span
                  className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${getIssuerColor(issuer)}`}
                >
                  {issuer}
                </span>
              </p>
            </div>
            <div className="flex gap-1 shrink-0">
              <CertStatusBadges cert={cert} isExpired={isExpired} isExpiringSoon={isExpiringSoon} />
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {certDateValue(cert)}
            {cert.display_order !== null && cert.display_order !== undefined && (
              <> · order {cert.display_order}</>
            )}
          </p>
          {children}
          <CertActionButtons cert={cert} issuer={issuer} busy={busy} actions={actions} />
        </div>
      </CardContent>
    </Card>
  );
}

/** A grid of cards, or the empty line when there are none. */
export function CertGrid({ certs, nowMs, busyIds, actions, empty, renderExtra }) {
  if (certs.length === 0) {
    return <div className="text-center py-12 text-sm text-slate-400">{empty}</div>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {certs.map((cert) => (
        <CertCard
          key={cert._docId || cert.id}
          cert={cert}
          nowMs={nowMs}
          busy={busyIds?.has(cert._docId)}
          actions={actions}
        >
          {renderExtra?.(cert)}
        </CertCard>
      ))}
    </div>
  );
}
