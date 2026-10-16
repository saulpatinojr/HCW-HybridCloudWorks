/**
 * Add or edit one certification, in the shared dialog (ADR 0033 §2:
 * `ui/dialog`, so role="dialog", Escape, the focus trap and the overlay come
 * from Radix rather than a hand-built overlay). Saving POSTs a new cert or
 * PATCHes an existing one through `cms/certifications` and hands the saved
 * row back with `onSaved`; the badge image uploads through
 * `cms/uploads/certifications`, which stores it as a 512 × 512 PNG whatever
 * was picked (SVG included) and answers the stored `url`, which is what is
 * kept here — never the path this side guessed from the file name.
 *
 * The form validates before it sends — the same rules the API enforces —
 * and says which field is wrong beside it. Save and upload each have an
 * in-flight guard held in a ref, so a double click sends one request.
 *
 * ABANDONED UPLOADS ARE DELETED. A badge uploaded and then cancelled used to
 * sit in the container until the nightly cleanup's seven-day rule; on Cancel
 * every blob this editor uploaded and did not save is deleted through
 * `DELETE cms/certifications/images`, best-effort. Cancel is disabled while
 * an upload is in flight so there is never a blob the editor does not know
 * about.
 */
import React, { useRef, useState } from 'react';
import { postJSON, sendJSON } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { Award, Loader2, GraduationCap, Plus, Trash2, Wand2 } from 'lucide-react';
import { detectIssuer, getVendorForIssuer, getLearnUrl } from '@/lib/certIssuers';
import {
  COLLECTION,
  emptyForm,
  fromIso,
  issuerOf,
  resolveImage,
  toIso,
  validateCertForm,
} from './certView';
import {
  BadgeImageField,
  DisplayOrderField,
  IMAGE_RULES,
  IssuerField,
  VisibilityFlags,
} from './editorFields';

const linkRows = (value) =>
  Array.isArray(value)
    ? value.map((row) =>
        typeof row === 'string'
          ? { label: row, url: row }
          : { label: row?.label || '', url: row?.url || '' }
      )
    : [];

export function initialForm(cert) {
  return {
    ...emptyForm,
    ...cert,
    name: cert.name || '',
    code: cert.code || '',
    verifyUrl: cert.verifyUrl || '',
    issuer: issuerOf(cert) === 'Unknown' && !cert._docId ? '' : issuerOf(cert),
    issueDate: toIso(cert.issueDate),
    expDate: toIso(cert.expDate),
    renewalDate: toIso(cert.renewalDate),
    renewalRequirements: cert.renewalRequirements || '',
    description: cert.description || '',
    imageUrl: cert.imageUrl || resolveImage(cert) || '',
    learnUrl: cert.learnUrl || '',
    evidence: linkRows(cert.evidence),
    relatedLearning: linkRows(cert.relatedLearning),
  };
}

const cleanLinks = (rows) =>
  (rows || [])
    .map((row) => ({ label: String(row.label || '').trim(), url: String(row.url || '').trim() }))
    .filter((row) => row.url)
    .map((row) => ({ label: row.label || row.url, url: row.url }));

/** The document a save writes. Dates are plain calendar days; order 0 is kept. */
export function buildPayload(form) {
  const s = (v) => String(v ?? '').trim();
  const canonicalIssuer = detectIssuer(form.issuer)?.name || s(form.issuer) || 'Unknown';
  // Blank means unordered (999); an explicit 0 is a real first place.
  const blankOrder =
    form.display_order === '' || form.display_order === null || form.display_order === undefined;
  const order = blankOrder ? 999 : Number(form.display_order);
  return {
    name: s(form.name),
    code: s(form.code) || null,
    issuer: canonicalIssuer,
    vendor: getVendorForIssuer(canonicalIssuer),
    issueDate: fromIso(form.issueDate),
    expDate: fromIso(form.expDate),
    renewalDate: fromIso(form.renewalDate),
    renewalRequirements: s(form.renewalRequirements) || null,
    verifyUrl: s(form.verifyUrl) || null,
    learnUrl: s(form.learnUrl) || null,
    imageUrl: s(form.imageUrl) || null,
    description: s(form.description) || null,
    evidence: cleanLinks(form.evidence),
    relatedLearning: cleanLinks(form.relatedLearning),
    display: Boolean(form.display),
    certState: Boolean(form.certState),
    featured: Boolean(form.featured),
    display_order: Number.isInteger(order) && order >= 0 ? order : 999,
  };
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function imageProblem(file) {
  if (!file.type.startsWith('image/')) return { title: 'Not an image', description: file.type };
  if (file.size > IMAGE_RULES.maxBytes) {
    return { title: 'Image too large', description: `Max ${IMAGE_RULES.maxLabel}` };
  }
  return null;
}

/** The blob path of an upload this editor made, from the URL the API answered. */
export function uploadedPathFromUrl(url) {
  const match = /\/api\/public\/media\/certifications\/(.+)$/.exec(String(url || ''));
  return match ? decodeURIComponent(match[1]) : null;
}

function useImageUpload(cert, set, toast, uploaded) {
  const [uploading, setUploading] = useState(false);
  const inFlight = useRef(false);

  const upload = async (file) => {
    if (!file || inFlight.current) return;
    const problem = imageProblem(file);
    if (problem) {
      toast({ ...problem, variant: 'destructive' });
      return;
    }
    inFlight.current = true;
    setUploading(true);
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      const id = cert._docId || `new-${Date.now()}`;
      const path = `${id}/images/badge-${Date.now()}.${ext}`;
      const result = await postJSON('cms/uploads/certifications', {
        path,
        contentType: file.type || 'image/png',
        dataBase64: await readAsBase64(file),
      });
      uploaded.current.push({ path: uploadedPathFromUrl(result.url) || path, url: result.url });
      set('imageUrl', result.url);
      toast({ title: 'Image uploaded' });
    } catch (err) {
      console.error('[Certifications] upload failed', err);
      toast({ title: 'Upload failed', description: err.message, variant: 'destructive' });
    } finally {
      inFlight.current = false;
      setUploading(false);
    }
  };
  return { uploading, upload };
}

/** Delete every upload this editor made except the one `keepUrl` names. Best-effort. */
async function discardUploads(uploaded, keepUrl) {
  const stale = uploaded.current.filter((entry) => entry.url !== keepUrl);
  uploaded.current = uploaded.current.filter((entry) => entry.url === keepUrl);
  await Promise.all(
    stale.map((entry) =>
      sendJSON('cms/certifications/images', 'DELETE', { path: entry.path }).catch((err) =>
        console.warn('[Certifications] could not delete abandoned upload', entry.path, err?.message)
      )
    )
  );
}

function useSave({ cert, form, setErrors, onSaved, onClose, toast, uploaded }) {
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const isNew = !cert._docId;

  const save = async () => {
    if (inFlight.current) return;
    const errors = validateCertForm(form);
    setErrors(errors);
    if (Object.keys(errors).length) {
      toast({ title: 'Fix the highlighted fields', variant: 'destructive' });
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const payload = buildPayload(form);
      // The server stamps _createdAt/_updatedAt.
      if (isNew) {
        const created = await postJSON(`cms/${COLLECTION}`, payload);
        onSaved({ _docId: created.id, ...payload });
      } else {
        await sendJSON(`cms/${COLLECTION}/${cert._docId}`, 'PATCH', payload);
        onSaved({ ...cert, ...payload });
      }
      // Uploads replaced by a later upload or a typed URL are not referenced by the saved row.
      await discardUploads(uploaded, payload.imageUrl);
      toast({ title: isNew ? 'Certification added' : 'Saved' });
      onClose();
    } catch (err) {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return { saving, save, isNew };
}

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-xs text-rose-600" role="alert">
      {message}
    </p>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  className = 'col-span-2',
  type,
  error,
  min,
}) {
  return (
    <div className={className}>
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function LearnUrlField({ form, set, toast, error }) {
  const autoSuggest = () => {
    const url = getLearnUrl(form.issuer, form.code);
    if (!url) {
      toast({
        title: 'No mapping yet',
        description: `Pick a known issuer or add ${form.issuer || 'this issuer'} to certIssuers.js.`,
        variant: 'destructive',
      });
      return;
    }
    set('learnUrl', url);
    toast({ title: 'Learn URL filled', description: url });
  };
  return (
    <div className="col-span-2">
      <Label className="text-xs flex items-center justify-between" htmlFor="cert-learn-url">
        <span className="flex items-center gap-1.5">
          <GraduationCap className="h-3.5 w-3.5" />
          Provider Learn page
        </span>
        <button
          type="button"
          onClick={autoSuggest}
          className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700"
        >
          <Wand2 className="h-3 w-3" /> Auto-suggest
        </button>
      </Label>
      <Input
        id="cert-learn-url"
        value={form.learnUrl}
        onChange={(e) => set('learnUrl', e.target.value)}
        placeholder="https://learn.microsoft.com/en-us/credentials/certifications/…"
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? 'cert-learn-url-error' : undefined}
      />
      <FieldError id="cert-learn-url-error" message={error} />
      <p className="text-xs text-slate-500 mt-1">
        Used to link this cert to the official learning path on the provider site.
      </p>
    </div>
  );
}

/** Label + URL rows: evidence of the cert, or related learning. */
function LinkListField({ idPrefix, title, hint, rows, onChange, errors }) {
  const update = (index, key, value) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  return (
    <fieldset className="col-span-2 space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-medium">{title}</legend>
      <p className="text-xs text-slate-500">{hint}</p>
      {rows.length === 0 && <p className="text-xs text-slate-500">None yet.</p>}
      {rows.map((row, index) => {
        const error = errors[`${idPrefix}.${index}`];
        return (
          <div key={index} className="grid grid-cols-[1fr_2fr_auto] gap-2 items-start">
            <div>
              <Label className="text-xs" htmlFor={`cert-${idPrefix}-${index}-label`}>
                Label
              </Label>
              <Input
                id={`cert-${idPrefix}-${index}-label`}
                value={row.label}
                onChange={(e) => update(index, 'label', e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs" htmlFor={`cert-${idPrefix}-${index}-url`}>
                URL
              </Label>
              <Input
                id={`cert-${idPrefix}-${index}-url`}
                type="url"
                placeholder="https://..."
                value={row.url}
                onChange={(e) => update(index, 'url', e.target.value)}
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={error ? `cert-${idPrefix}-${index}-error` : undefined}
              />
              <FieldError id={`cert-${idPrefix}-${index}-error`} message={error} />
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mt-5 h-8 px-2 text-rose-600"
              aria-label={`Remove ${title.toLowerCase()} ${index + 1}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...rows, { label: '', url: '' }])}
      >
        <Plus className="h-3.5 w-3.5 mr-1" /> Add {title.toLowerCase()}
      </Button>
    </fieldset>
  );
}

export default function CertEditor({ cert, allCerts, onClose, onSaved }) {
  const { toast } = useToast();
  const [form, setForm] = useState(() => initialForm(cert));
  const [errors, setErrors] = useState({});
  const uploaded = useRef([]);
  const set = (k, v) => {
    setForm((p) => ({ ...p, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const { uploading, upload } = useImageUpload(cert, set, toast, uploaded);
  const { saving, save, isNew } = useSave({
    cert,
    form,
    setErrors,
    onSaved,
    onClose,
    toast,
    uploaded,
  });
  const busy = saving || uploading;

  const cancel = () => {
    if (busy) return;
    // Nothing saved, so nothing this editor uploaded is referenced.
    discardUploads(uploaded, null);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Award className="h-5 w-5 text-amber-500" />
              {isNew ? 'Add Certification' : 'Edit Certification'}
            </DialogTitle>
            <DialogDescription>
              Dates are calendar days. Only certifications with Show on About page ticked are
              published, at the next Update Cert Catalog.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              id="cert-name"
              label="Name *"
              value={form.name}
              onChange={(v) => set('name', v)}
              placeholder="Google Cloud Professional Cloud Architect"
              error={errors.name}
            />
            <TextField
              id="cert-code"
              label="Code"
              className=""
              value={form.code}
              onChange={(v) => set('code', v)}
              placeholder="PCA"
            />
            <IssuerField form={form} set={set} allCerts={allCerts} />
            <TextField
              id="cert-issue-date"
              label="Issue date"
              className=""
              type="date"
              value={form.issueDate}
              onChange={(v) => set('issueDate', v)}
              error={errors.issueDate}
            />
            <TextField
              id="cert-exp-date"
              label="Expiration date"
              className=""
              type="date"
              value={form.expDate}
              onChange={(v) => set('expDate', v)}
              error={errors.expDate}
            />
            <TextField
              id="cert-renewal-date"
              label="Renewal date"
              className=""
              type="date"
              value={form.renewalDate}
              onChange={(v) => set('renewalDate', v)}
              error={errors.renewalDate}
            />
            <div>
              <Label className="text-xs" htmlFor="cert-renewal-requirements">
                Renewal requirements
              </Label>
              <Input
                id="cert-renewal-requirements"
                value={form.renewalRequirements}
                onChange={(e) => set('renewalRequirements', e.target.value)}
                placeholder="Free renewal assessment on Learn; opens 180 days before expiry"
              />
            </div>
            <TextField
              id="cert-verify-url"
              label="Verify URL"
              value={form.verifyUrl}
              onChange={(v) => set('verifyUrl', v)}
              placeholder="https://www.credly.com/badges/…"
              error={errors.verifyUrl}
            />
            <LearnUrlField form={form} set={set} toast={toast} error={errors.learnUrl} />
            <BadgeImageField
              imageUrl={form.imageUrl}
              uploading={uploading}
              onFile={upload}
              onClear={() => set('imageUrl', '')}
            />
            <TextField
              id="cert-image-url"
              label="Image URL"
              value={form.imageUrl}
              onChange={(v) => set('imageUrl', v)}
              placeholder="https://images.credly.com/size/340x340/…"
              error={errors.imageUrl}
            />
            <div className="col-span-2">
              <Label className="text-xs" htmlFor="cert-description">
                Description / story (optional)
              </Label>
              <Textarea
                id="cert-description"
                rows={3}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="Why this matters, what I learned, where I used it…"
              />
            </div>
            <LinkListField
              idPrefix="evidence"
              title="Evidence"
              hint="Transcript, badge page, exam result — the Ambassador hub imports these."
              rows={form.evidence}
              onChange={(rows) => set('evidence', rows)}
              errors={errors}
            />
            <LinkListField
              idPrefix="relatedLearning"
              title="Related learning"
              hint="Courses, labs or Listen & Learn chapters that prepare for this certification."
              rows={form.relatedLearning}
              onChange={(rows) => set('relatedLearning', rows)}
              errors={errors}
            />
            <DisplayOrderField
              form={form}
              set={set}
              allCerts={allCerts}
              docId={cert._docId}
              error={errors.display_order}
            />
            <VisibilityFlags form={form} set={set} />
          </div>
          <DialogFooter className="gap-2 border-t pt-4 sm:gap-0">
            <Button type="button" variant="outline" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isNew ? 'Add' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
