/**
 * "Draft a piece" — start a draft in the Pipeline for a record on this Page
 * (#1886). Asks for a working title, creates the draft through the Drafts
 * route with the record attached, and opens it on the Drafts page, where the
 * usual Pipeline takes over: write, Send to In Review, approve, schedule,
 * publish.
 *
 * One draft per click: the button is disabled while the request is in flight,
 * so a double click cannot create two.
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import { FilePen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { draftPath, startDraftFor } from './pipelineHandoff';

/**
 * @param {{
 *   originRef: { page: string, id: string, part?: string|null },
 *   recordLabel: string,
 *   label?: string,
 *   ariaLabel?: string,
 *   tags?: string[],
 *   size?: string,
 *   variant?: string,
 *   onCreated?: (id: string) => void,
 * }} props
 */
export default function SendToPipelineButton({
  originRef,
  recordLabel,
  label = 'Draft a piece',
  ariaLabel,
  tags = [],
  size = 'sm',
  variant = 'outline',
  onCreated,
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const id = await startDraftFor({ originRef, title, tags });
      setOpen(false);
      setTitle('');
      onCreated?.(id);
      navigate(draftPath(id));
    } catch (err) {
      setError(err?.message || 'The draft was not created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)} aria-label={ariaLabel}>
        <FilePen className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent className="w-[calc(100%-2rem)] sm:max-w-md">
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Draft a piece for {recordLabel}</DialogTitle>
              <DialogDescription>
                Opens a new draft on the Drafts page, marked as started for {recordLabel}. From
                there it goes through the Pipeline as usual: review, schedule, publish.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <Label htmlFor="send-to-pipeline-title">Working title</Label>
              <Input
                id="send-to-pipeline-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                required
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !title.trim()}>
                {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Create draft
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
