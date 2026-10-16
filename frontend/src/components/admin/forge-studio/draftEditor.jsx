/**
 * The Draft tab's editing surface (ADR 0033 §7 slice 2): the three text
 * fields, the activity list under them, and the AI actions beside them.
 */
import React, { useState } from 'react';
import { Activity, ChevronDown, ChevronRight, Loader2, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { TONES } from './brief';
import { ASSIST_ACTIONS } from './draftModel';

/** The title, summary and body, each written straight onto the session. */
export function DraftFields({ text, setText, bodyRef }) {
  return (
    <>
      <div>
        <Label htmlFor="draft-title">Title</Label>
        <Input
          id="draft-title"
          value={text.title}
          onChange={(event) => setText('title', event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="draft-summary">Summary</Label>
        <Textarea
          id="draft-summary"
          rows={2}
          value={text.summary}
          onChange={(event) => setText('summary', event.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="draft-body">Body (markdown)</Label>
        <Textarea
          id="draft-body"
          ref={bodyRef}
          rows={24}
          value={text.body}
          onChange={(event) => setText('body', event.target.value)}
          className="font-mono text-xs"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Select a passage before Expand, Condense, Rewrite or Change tone to work on it alone;
          otherwise the whole body is used.
        </p>
      </div>
    </>
  );
}

function ActivityRow({ row }) {
  const route = [row.provider, row.model].filter(Boolean).join(' / ');
  return (
    <li className="flex flex-wrap gap-x-3 gap-y-1 px-4 py-2">
      <span className="font-mono text-muted-foreground">
        {row.at ? new Date(row.at).toLocaleString() : ''}
      </span>
      <span className="font-medium">
        {row.action}
        {row.details?.assist ? `: ${row.details.assist}` : ''}
      </span>
      <span className="text-muted-foreground">{row.actor}</span>
      {route && (
        <Badge variant="outline" className="font-mono text-xs">
          {route}
        </Badge>
      )}
    </li>
  );
}

function ActivityRows({ rows }) {
  if (rows.length === 0) {
    return (
      <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
        Nothing recorded yet. Every AI action and every save lands here.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border/60 border-t border-border/60 text-xs">
      {rows.map((row, index) => (
        <ActivityRow key={`${row.at}-${index}`} row={row} />
      ))}
    </ul>
  );
}

/** Who did what, through which model: the document's activity, newest first, folded. */
export function ActivityList({ activity = [] }) {
  const [open, setOpen] = useState(false);
  const rows = [...activity].reverse();
  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Activity className="h-3.5 w-3.5" aria-hidden="true" />
        Activity ({rows.length}) — who did what, through which model
      </button>
      {open && <ActivityRows rows={rows} />}
    </div>
  );
}

export function AssistPanel({
  busy,
  pendingAction,
  canRun,
  instruction,
  tone,
  onInstruction,
  onTone,
  onRun,
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> AI actions
        </CardTitle>
        <CardDescription>
          One call each, through the AI Engine&apos;s route for “Forge Studio assist”. Every result
          is editable and nothing is applied until you say so.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label htmlFor="assist-instruction">Direction (optional)</Label>
          <Input
            id="assist-instruction"
            value={instruction}
            onChange={(event) => onInstruction(event.target.value)}
            placeholder="e.g. add a cost comparison; keep the code blocks"
          />
        </div>
        <div>
          <Label htmlFor="assist-tone">Tone (for Change tone)</Label>
          <select
            id="assist-tone"
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={tone}
            onChange={(event) => onTone(event.target.value)}
          >
            {TONES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          {ASSIST_ACTIONS.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant="outline"
              disabled={Boolean(busy) || !canRun}
              onClick={() => onRun(action.id)}
            >
              {pendingAction === action.id ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {action.label}
            </Button>
          ))}
        </div>
        {busy === 'assist' && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Asking the model…
          </p>
        )}
      </CardContent>
    </Card>
  );
}
