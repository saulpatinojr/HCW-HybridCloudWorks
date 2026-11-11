/**
 * Stage 4's card: edit the draft, check readiness, preview, save.
 *
 * Split into the pieces below rather than one 215-line body (#634). Each was
 * a block of JSX guarded by its own condition, which is where the card's
 * complexity came from — not from any one hard decision.
 *
 * The rendering is unchanged. The only interface change is `saveLabel`, which
 * the page now computes: `getPublishTargetLabel` is shared with two other
 * Stage cards, so it stays there rather than being dragged along.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, CheckCircle, Link2, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { getQueueReviewPath } from './persistStage';

/**
 * The draft's topics as badges, or nothing at all.
 *
 * Rendered twice in this card — in full above the editor, and capped at six
 * inside the preview, where the real page also caps them.
 */
function TopicBadges({ topics, limit }) {
  if (topics.length === 0) return null;
  const shown = limit ? topics.slice(0, limit) : topics;
  return (
    <div className="flex flex-wrap gap-2">
      {shown.map((topic) => (
        <Badge key={topic} variant="outline">
          {topic}
        </Badge>
      ))}
    </div>
  );
}

/**
 * One button per schema section.
 *
 * A section already present is shown filled and ticked rather than disabled,
 * because pressing it is how the operator finds out it is already there.
 */
function SectionBlockButtons({ sectionBlocks, draftContent, draftReady, insertSectionBlock }) {
  return (
    <div className="flex flex-wrap gap-2">
      {sectionBlocks.map((section) => {
        const exists = draftContent.includes(section.heading);
        return (
          <Button
            key={section.key}
            type="button"
            size="sm"
            variant={exists ? 'default' : 'outline'}
            onClick={() => insertSectionBlock(section)}
            disabled={!draftReady}
          >
            {exists ? '✓ ' : ''}
            {section.title}
          </Button>
        );
      })}
    </div>
  );
}

/** The live-style preview of the page this draft will become. */
function LivePreview({
  resolveSlotImage,
  previewPath,
  draftTitle,
  title,
  draftSummary,
  draftTopics,
  draftContent,
}) {
  const heroUrl = resolveSlotImage('hero');
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {heroUrl && <img src={heroUrl} alt="" className="w-full h-48 object-cover" />}
        <div className="p-4 space-y-3">
          <div className="text-xs text-muted-foreground">{previewPath}</div>
          <h3 className="text-xl font-bold">{draftTitle || title || 'Untitled content draft'}</h3>
          <p className="text-sm text-muted-foreground">{draftSummary || 'No summary yet.'}</p>
          <TopicBadges topics={draftTopics} limit={6} />
          <div className="prose prose-sm dark:prose-invert max-w-none border-t border-border pt-3 max-h-105 overflow-y-auto">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {draftContent || '_Draft content preview appears here._'}
            </ReactMarkdown>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** One readiness row: a tick or a warning, the label, and the hint if unmet. */
function ReadinessRow({ check }) {
  const hint =
    check.key === 'schema-sections'
      ? `${check.hint}. Add them using the Schema Section Blocks buttons above.`
      : check.hint;
  return (
    <div className="flex items-start gap-2 text-sm">
      {check.done ? (
        <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" />
      ) : (
        <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />
      )}
      <div>
        <p className={check.done ? 'text-foreground' : 'text-muted-foreground'}>{check.label}</p>
        {!check.done && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

function ReadinessChecklist({ readinessChecks }) {
  return (
    <Card className="border-border/60">
      <CardHeader>
        <CardTitle className="text-sm">Publish Readiness Checklist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {readinessChecks.map((check) => (
          <ReadinessRow key={check.key} check={check} />
        ))}
      </CardContent>
    </Card>
  );
}

/** The three gate readouts, plus a link to whatever was last saved. */
function SaveStatusLines({ draftReady, canPreview, readinessComplete, savedContentId }) {
  return (
    <div className="text-xs text-muted-foreground space-y-1">
      <p>Draft ready: {draftReady ? 'Yes' : 'No'}</p>
      <p>Images selected/uploaded: {canPreview ? 'Yes' : 'No'}</p>
      <p>Readiness complete: {readinessComplete ? 'Yes' : 'No'}</p>
      {savedContentId && (
        <p>
          Saved content:{' '}
          <a href={getQueueReviewPath(savedContentId)} className="text-blue-600 hover:underline">
            {savedContentId.slice(0, 8)}
          </a>
        </p>
      )}
    </div>
  );
}

/**
 * Both save buttons.
 *
 * Each is disabled while EITHER save is in flight, so the draft cannot be
 * written twice by pressing both.
 */
function SaveActions({
  previewSaving,
  createAndOpenSaving,
  canPreview,
  readinessComplete,
  handleCreateAndOpenEditor,
  saveLabel,
}) {
  const busy = previewSaving || createAndOpenSaving;
  const blocked = busy || !canPreview || !readinessComplete;
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        onClick={handleCreateAndOpenEditor}
        disabled={blocked}
        className="gap-1"
      >
        {createAndOpenSaving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Link2 className="h-4 w-4" />
        )}
        Create + Open Editor
      </Button>
      <Button type="submit" disabled={blocked} className="gap-1">
        {previewSaving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle className="h-4 w-4" />
        )}
        Save {saveLabel}
      </Button>
    </div>
  );
}

export default function StageFourCard({
  draftTitle,
  setDraftTitle,
  title,
  draftSummary,
  setDraftSummary,
  sectionBlocks,
  draftContent,
  setDraftContent,
  draftReady,
  insertSectionBlock,
  draftTopics,
  draftTopic = '',
  resolveSlotImage,
  previewPath,
  readinessChecks,
  savedContentId,
  canPreview,
  readinessComplete,
  previewSaving,
  createAndOpenSaving,
  handleCreateAndOpenEditor,
  saveLabel,
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Stage 4: Content Draft</CardTitle>
        <CardDescription>
          Edit content with schema blocks, validate readiness, and preview using live-style layout.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs">Generated Title</Label>
          <Input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="Title will be generated after Stage 2 Submit"
            disabled={!draftReady}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-xs">Generated Summary</Label>
          <Textarea
            value={draftSummary}
            onChange={(e) => setDraftSummary(e.target.value)}
            rows={4}
            placeholder="Summary will be generated after Stage 2 Submit"
            disabled={!draftReady}
          />
        </div>

        <div className="space-y-2">
          <Label className="text-xs">Schema Section Blocks</Label>
          <p className="text-xs text-muted-foreground">
            Use these buttons to insert the required sections named in the readiness checklist.
          </p>
          <SectionBlockButtons
            sectionBlocks={sectionBlocks}
            draftContent={draftContent}
            draftReady={draftReady}
            insertSectionBlock={insertSectionBlock}
          />
        </div>

        <TopicBadges topics={draftTopics} />
        {draftTopic && (
          <p className="text-xs text-muted-foreground">
            Address topic: {draftTopic}. It can be changed on the review board before publishing.
          </p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 border-t border-border pt-4">
          <div className="space-y-2">
            <Label className="text-xs">Editor (Markdown)</Label>
            <Textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              rows={20}
              placeholder="Article content will be generated after Stage 2 Submit"
              disabled={!draftReady}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Final Page Preview (Live-style)</Label>
            <LivePreview
              resolveSlotImage={resolveSlotImage}
              previewPath={previewPath}
              draftTitle={draftTitle}
              title={title}
              draftSummary={draftSummary}
              draftTopics={draftTopics}
              draftContent={draftContent}
            />
          </div>
        </div>

        <ReadinessChecklist readinessChecks={readinessChecks} />

        <div className="border-t border-border pt-4 flex items-center justify-between gap-3">
          <SaveStatusLines
            draftReady={draftReady}
            canPreview={canPreview}
            readinessComplete={readinessComplete}
            savedContentId={savedContentId}
          />
          <SaveActions
            previewSaving={previewSaving}
            createAndOpenSaving={createAndOpenSaving}
            canPreview={canPreview}
            readinessComplete={readinessComplete}
            handleCreateAndOpenEditor={handleCreateAndOpenEditor}
            saveLabel={saveLabel}
          />
        </div>
      </CardContent>
    </Card>
  );
}
