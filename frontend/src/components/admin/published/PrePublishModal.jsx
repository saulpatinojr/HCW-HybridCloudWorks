import React from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={() => onClose()} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prepublish-modal-title"
        className="relative w-full max-w-md rounded-2xl border bg-background shadow-2xl p-6 space-y-4"
      >
        <h2 id="prepublish-modal-title" className="text-lg font-semibold">
          {failures.length === 0 ? 'Ready to publish' : 'Publish blocked'}
        </h2>
        <p className="text-sm text-muted-foreground truncate">
          {candidate.Title || candidate.title || 'Untitled'}
        </p>

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
      </div>
    </div>
  );
}
