import React from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ADMIN_ROUTES } from '@/config/admin';

export default function PrePublishModal({
  candidate,
  failures,
  autoPostSocial,
  onAutoPostSocialChange,
  onClose,
  onPublishNow,
}) {
  if (!candidate) return null;

  return (
    <Dialog
      open={Boolean(candidate)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-full max-w-md rounded-2xl border bg-background shadow-2xl p-6 space-y-4">
        <DialogHeader>
          <DialogTitle id="prepublish-modal-title" className="text-lg font-semibold text-left">
            {failures.length === 0 ? 'Ready to publish' : 'Publish blocked'}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground truncate text-left">
            {candidate.Title || candidate.title || 'Untitled'}
          </DialogDescription>
        </DialogHeader>

        {failures.length === 0 ? (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            All pre-publish checks passed: hero image, title, summary, body length, and slug.
          </p>
        ) : (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive mb-2">
              Fix these before publishing:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-destructive">
              {failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          </div>
        )}

        {failures.length === 0 && (
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoPostSocial}
              onChange={(e) => onAutoPostSocialChange(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            Auto-post to Social — open Social Hub compose after publish
          </label>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onClose()}>
            {failures.length === 0 ? 'Cancel' : 'Close'}
          </Button>
          {failures.length > 0 && (
            <Button size="sm" variant="outline" asChild>
              <Link to={ADMIN_ROUTES.EDITOR.replace(':id', candidate.id)}>Open Editor</Link>
            </Button>
          )}
          {failures.length === 0 && (
            <Button
              size="sm"
              onClick={() => {
                const item = candidate;
                onClose();
                onPublishNow(item);
              }}
            >
              Publish Now
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
