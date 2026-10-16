/**
 * The larger fields of the certification editor, each with its own small
 * state: the issuer picker, the badge image drop zone, the display order with
 * the global ladder, and the visibility checkboxes. CertEditor owns the form;
 * these read `form` and call `set(key, value)`.
 */
import React, { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Award, Loader2, UploadCloud, X, ChevronDown } from 'lucide-react';
import {
  detectIssuer,
  getIssuerOptions,
  getVendorForIssuer,
  VENDOR_LABELS,
  getIssuerColor,
} from '@/lib/certIssuers';
import { resolveMediaUrl } from '@/lib/functionsBase';
import { issuerOf } from './certView';

/**
 * Image upload limits; the Settings tab shows the same numbers. Whatever is
 * picked is stored as one shape — the API decodes it and re-encodes a
 * 512 × 512 transparent PNG (functions/src/lib/badge-image.js) — so an SVG
 * and a 2,000 px export land on the page the same size.
 */
export const IMAGE_RULES = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxLabel: '5 MB',
  accept: 'image/*',
  formats: 'PNG / JPG / SVG',
  stored: 'stored as a 512 × 512 PNG',
});

/**
 * The issuer picker list: every real value in the certifications collection
 * PLUS the curated registry (lib/certIssuers.js), case-insensitive deduped
 * with the collection's spelling winning, sorted alphabetically. The
 * collection half keeps the list honest about what is on disk; the registry
 * half is how an issuer no cert carries yet (Anthropic, 2026-10-05) can be
 * picked rather than typed — a typed label still works.
 */
export function issuerOptionsFrom(allCerts, curated = getIssuerOptions()) {
  const map = new Map();
  const add = (v) => {
    if (!v || v === 'Unknown') return;
    const key = v.toLowerCase();
    if (!map.has(key)) map.set(key, v);
  };
  (allCerts || []).forEach((c) => add(issuerOf(c)));
  (curated || []).forEach(add);
  return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
}

function IssuerOptions({ options, current, onPick }) {
  return (
    <ul className="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg text-sm">
      {options.length === 0 && (
        <li className="px-3 py-1.5 text-slate-500 italic">No issuers yet — type to add one.</li>
      )}
      {options.map((n) => (
        <li key={n}>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(n);
            }}
            className={`w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 ${
              current === n ? 'bg-indigo-50 dark:bg-indigo-900/30 font-semibold' : ''
            }`}
          >
            {n}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function IssuerField({ form, set, allCerts }) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => issuerOptionsFrom(allCerts), [allCerts]);
  const issuerMatch = detectIssuer(form.issuer);
  const vendorMeta = VENDOR_LABELS[getVendorForIssuer(form.issuer)] || VENDOR_LABELS.other;

  return (
    <div>
      <Label className="text-xs flex items-center gap-2">
        Issuer
        {issuerMatch && (
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold ${getIssuerColor(form.issuer)}`}
          >
            {issuerMatch.name}
          </span>
        )}
      </Label>
      <div className="relative">
        <Input
          value={form.issuer}
          onChange={(e) => set('issuer', e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Pick or type…"
          className="pr-8"
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          aria-label="Show all issuers"
          tabIndex={-1}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
        {open && (
          <IssuerOptions
            options={options}
            current={form.issuer}
            onPick={(n) => {
              set('issuer', n);
              setOpen(false);
            }}
          />
        )}
      </div>
      {vendorMeta.path && (
        <p className="text-xs text-slate-500 mt-1">
          Will appear on <span className="font-mono">{vendorMeta.path}</span>
        </p>
      )}
    </div>
  );
}

function ImagePreview({ imageUrl }) {
  return (
    <>
      {imageUrl ? (
        <img
          src={resolveMediaUrl(imageUrl)}
          alt="Preview"
          referrerPolicy="no-referrer"
          className="h-16 w-16 rounded object-contain bg-white"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            e.currentTarget.nextElementSibling?.classList.remove('hidden');
          }}
        />
      ) : null}
      <div
        className={`h-16 w-16 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center ${
          imageUrl ? 'hidden' : ''
        }`}
      >
        <Award className="h-6 w-6 text-slate-400" />
      </div>
    </>
  );
}

function UploadStatus({ uploading }) {
  return (
    <div className="flex-1 min-w-0">
      <p className="text-xs font-medium flex items-center gap-1.5">
        {uploading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Uploading…
          </>
        ) : (
          <>
            <UploadCloud className="h-3.5 w-3.5" />
            Drag & drop or click to upload
          </>
        )}
      </p>
      <p className="text-xs text-slate-500 mt-0.5">
        {IMAGE_RULES.formats} · max {IMAGE_RULES.maxLabel}. Uploaded through the Azure API to Blob
        Storage and saved as the Image URL on save.
      </p>
    </div>
  );
}

export function BadgeImageField({ imageUrl, uploading, onFile, onClear }) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const openPicker = () => fileInputRef.current?.click();

  return (
    <div className="col-span-2">
      <Label className="text-xs">Badge image</Label>
      <div
        role="button"
        tabIndex={0}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPicker();
          }
        }}
        className={`mt-1 flex items-center gap-3 rounded-md border-2 border-dashed p-3 cursor-pointer transition-colors ${
          dragOver
            ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/30'
            : 'border-slate-300 dark:border-slate-700 hover:border-amber-300'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={IMAGE_RULES.accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        <ImagePreview imageUrl={imageUrl} />
        <UploadStatus uploading={uploading} />
        {imageUrl && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            title="Clear image"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Every other certification, in display order. ONE GLOBAL LADDER, not one per
 * issuer (ADR 0033, Spotlight slice): the About page and the Featured tab
 * both sort by `display_order` across every issuer, so a ladder scoped to the
 * issuer suggested numbers that collided with other issuers' certs the moment
 * the list was sorted. `issuer` is accepted and ignored so older callers
 * keep working.
 */
export function siblingsOf(allCerts, docId) {
  return (allCerts || [])
    .filter((c) => c._docId !== docId)
    .map((c) => ({
      _docId: c._docId,
      name: c.name,
      code: c.code,
      issuer: issuerOf(c),
      order: Number(c.display_order ?? 999),
    }))
    .sort((a, b) => a.order - b.order);
}

/** The lowest order number no other certification uses. */
export function nextFreeOrder(siblings) {
  const used = new Set(siblings.map((s) => s.order));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

/** The part of the ladder around `order`: the `span` rows before and after it. */
export function ladderWindow(siblings, order, span = 3) {
  const target = Number(order);
  if (!Number.isFinite(target)) return siblings.slice(0, span * 2);
  const at = siblings.findIndex((s) => s.order >= target);
  const centre = at === -1 ? siblings.length : at;
  return siblings.slice(Math.max(0, centre - span), centre + span + 1);
}

function SiblingLadder({ siblings, order }) {
  if (siblings.length === 0) return null;
  const rows = ladderWindow(siblings, order);
  return (
    <div className="mt-2 p-2 rounded-md bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/50">
      <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">
        Nearby on the About page ladder
      </p>
      <ul className="space-y-0.5 text-xs">
        {rows.map((s) => {
          const conflict = s.order === Number(order);
          return (
            <li
              key={s._docId}
              className={`flex items-center justify-between gap-2 ${
                conflict ? 'text-rose-600 font-semibold' : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <span className="truncate">
                <span className="font-mono text-xs mr-1">#{s.order}</span>
                {s.name}
                {s.code ? ` (${s.code})` : ''}
                <span className="text-slate-400"> · {s.issuer}</span>
              </span>
              {conflict && <span className="text-xs">same number</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DisplayOrderField({ form, set, allCerts, docId, error }) {
  const siblings = useMemo(() => siblingsOf(allCerts, docId), [allCerts, docId]);
  return (
    <div className="col-span-2">
      <Label className="text-xs flex items-center justify-between" htmlFor="cert-display-order">
        <span>
          Display order <span className="text-slate-500">across every issuer; 0 is first</span>
        </span>
        <button
          type="button"
          onClick={() => set('display_order', nextFreeOrder(siblings))}
          className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
        >
          Suggest next
        </button>
      </Label>
      <Input
        id="cert-display-order"
        type="number"
        min="0"
        step="1"
        value={form.display_order}
        onChange={(e) => set('display_order', e.target.value)}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? 'cert-display-order-error' : undefined}
      />
      {error && (
        <p id="cert-display-order-error" className="mt-1 text-xs text-rose-600" role="alert">
          {error}
        </p>
      )}
      <SiblingLadder siblings={siblings} order={form.display_order} />
    </div>
  );
}

function Flag({ checked, onChange, children }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function VisibilityFlags({ form, set }) {
  return (
    <div className="flex flex-col gap-2 justify-end pb-1">
      <Flag checked={form.display} onChange={(v) => set('display', v)}>
        Show on About page
      </Flag>
      <p className="text-xs text-slate-500 -mt-1">
        New certifications default to visible; hide only when you want them excluded from About.
      </p>
      <Flag checked={form.featured} onChange={(v) => set('featured', v)}>
        Feature in Spotlight
      </Flag>
      <Flag checked={form.certState} onChange={(v) => set('certState', v)}>
        Currently active
      </Flag>
    </div>
  );
}
