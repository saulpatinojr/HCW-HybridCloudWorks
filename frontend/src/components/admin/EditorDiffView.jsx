import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function buildLineDiffRows(baseText = '', editedText = '') {
  const baseLines = String(baseText).split('\n');
  const editedLines = String(editedText).split('\n');
  const maxLines = Math.max(baseLines.length, editedLines.length);

  return Array.from({ length: maxLines }, (_, index) => {
    const base = baseLines[index] ?? '';
    const edited = editedLines[index] ?? '';

    let status = 'same';
    if (base && !edited) status = 'removed';
    else if (!base && edited) status = 'added';
    else if (base !== edited) status = 'changed';

    return {
      id: index,
      lineNumber: index + 1,
      base,
      edited,
      status,
    };
  });
}

function lineClasses(status) {
  if (status === 'added') return 'bg-emerald-500/10 border-emerald-500/30';
  if (status === 'removed') return 'bg-red-500/10 border-red-500/30';
  if (status === 'changed') return 'bg-amber-500/10 border-amber-500/30';
  return 'bg-muted/10 border-transparent';
}

/** One side of the diff: every line of one draft, coloured by its status. */
function DiffColumn({ title, rows, field }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">{title}</p>
      <div className="border rounded-md overflow-hidden">
        {rows.map((row) => (
          <div
            key={`${field}-${row.id}`}
            className={`grid grid-cols-[48px_1fr] text-xs border-b last:border-b-0 ${lineClasses(row.status)}`}
          >
            <span className="px-2 py-1 text-muted-foreground border-r">{row.lineNumber}</span>
            <pre className="px-2 py-1 whitespace-pre-wrap break-words font-mono">
              {row[field] || ' '}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function EditorDiffView({ baseText = '', editedText = '' }) {
  const rows = useMemo(() => buildLineDiffRows(baseText, editedText), [baseText, editedText]);

  const changedCount = rows.filter((row) => row.status !== 'same').length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">AI vs Human Diff</CardTitle>
      </CardHeader>
      <CardContent>
        {changedCount === 0 ? (
          <p className="text-sm text-muted-foreground">No differences detected yet.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-3">
              {changedCount} line{changedCount === 1 ? '' : 's'} changed
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <DiffColumn title="Edited Draft" rows={rows} field="edited" />
              <DiffColumn title="AI Draft" rows={rows} field="base" />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
