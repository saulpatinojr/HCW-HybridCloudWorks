/**
 * Finish — where the piece goes next (ADR 0033 §7 slice 2). Every output
 * has a visible destination: a write this page performs (save, send to
 * review) or a deep link into the hub that takes it from here, carrying the
 * document id so the hub can pick it up.
 */
import React from 'react';
import { Link } from 'react-router';
import {
  CalendarClock,
  Edit3,
  Headphones,
  ImageIcon,
  Loader2,
  Plus,
  Save,
  Send,
  Share2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import EmptyState from '@/components/admin/shared/EmptyState';
import StatusBadge from '@/components/admin/shared/StatusBadge';

function Action({ icon: Icon, title, description, children }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="h-4 w-4 text-primary" aria-hidden="true" /> {title}
        </CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * @param {{
 *   session: ReturnType<typeof import('./useForgeSession').useForgeSession>,
 *   onDraft: () => void, onStart: () => void,
 * }} props
 */
export default function FinishTab({ session, onDraft, onStart }) {
  const { doc, contentId, busy, dirty } = session;

  if (!doc) {
    return (
      <EmptyState
        title="Nothing to finish yet"
        description="Create the draft on the Draft tab first; the next steps for it appear here."
        action={<Button onClick={onDraft}>Go to the draft</Button>}
      />
    );
  }

  const id = encodeURIComponent(contentId);
  const status = String(doc.contentStatus || '');
  const inDrafts = status === 'drafting';
  const queueHref = `/admin/review-queue/${id}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{doc.Title || doc.title || 'Untitled'}</span>
        <StatusBadge content={doc} />
        {dirty && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            Unsaved edits on the Draft tab
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Action
          icon={Save}
          title="Save as draft"
          description="It already is one: the document lives on the Drafts page. Save writes your latest edits under the current version."
        >
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy === 'save' || !dirty}
              onClick={() => session.save()}
              className="gap-1"
            >
              {busy === 'save' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {dirty ? 'Save edits' : 'Saved'}
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/admin/drafts">Open Drafts</Link>
            </Button>
          </div>
        </Action>

        <Action
          icon={Send}
          title="Send to review"
          description={
            inDrafts
              ? 'Moves it from Drafting to In Review on the Review Queue. Nothing is published.'
              : `It is already in the pipeline as “${status.replace(/_/g, ' ')}”: the forge staged it, so review happens on the Review Queue.`
          }
        >
          {inDrafts ? (
            <Button
              size="sm"
              disabled={Boolean(busy) || dirty}
              onClick={() => session.sendToReview()}
              className="gap-1"
            >
              {busy === 'send' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Send to In Review
            </Button>
          ) : (
            <Button size="sm" asChild>
              <Link to={queueHref}>Open on the Review Queue</Link>
            </Button>
          )}
          {inDrafts && dirty && (
            <p className="mt-1 text-xs text-muted-foreground">Save your edits first.</p>
          )}
        </Action>

        <Action
          icon={Edit3}
          title="Open in Editor"
          description="The full editor: body, cover, SEO fields, publish controls."
        >
          <Button size="sm" variant="outline" asChild>
            <Link to={`/admin/editor/${id}`}>Open in Editor</Link>
          </Button>
        </Action>

        <Action
          icon={CalendarClock}
          title="Schedule"
          description="Publishing and scheduling happen on the Publish page once the piece is approved or forge-ready."
        >
          <Button size="sm" variant="outline" asChild>
            <Link to="/admin/publish">Open Publish</Link>
          </Button>
        </Action>

        <Action
          icon={Share2}
          title="Create derivative"
          description="Social posts for this piece. Extract them with the AI action on the Draft tab, then compose in the Social Hub."
        >
          <Button size="sm" variant="outline" asChild>
            <Link to={`/admin/social-hub?tab=compose&contentId=${id}`}>Open the Social Hub</Link>
          </Button>
        </Action>

        <Action
          icon={ImageIcon}
          title="Generate images"
          description="Cover and inline images from the prompt library, linked to this piece."
        >
          <Button size="sm" variant="outline" asChild>
            <Link to={`/admin/image-prompts?contentId=${id}`}>Open Image Prompts</Link>
          </Button>
        </Action>

        <Action
          icon={Headphones}
          title="Generate audio"
          description="A spoken version through Listen & Learn, from this document."
        >
          <Button size="sm" variant="outline" asChild>
            <Link to={`/admin/listen-and-learn?contentId=${id}`}>Open Listen & Learn</Link>
          </Button>
        </Action>

        <Action
          icon={Plus}
          title="Start another piece"
          description="Clears this session. The document stays where it is."
        >
          <Button size="sm" variant="ghost" onClick={onStart} className="gap-1">
            <Plus className="h-3.5 w-3.5" /> Start another
          </Button>
        </Action>
      </div>
    </div>
  );
}
