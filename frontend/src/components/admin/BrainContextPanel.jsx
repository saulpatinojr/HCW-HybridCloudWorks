import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { brainApi } from '@/lib/brainApi';
import { useBrainAccess } from '@/hooks/useBrainAccess';

export default function BrainContextPanel({ contentId }) {
  const { enabled } = useBrainAccess();
  const [state, setState] = useState({ items: [] });
  useEffect(() => {
    if (!enabled || !contentId) return undefined;
    let alive = true;
    brainApi
      .context(contentId)
      .then((data) => {
        if (alive) setState(data);
      })
      .catch(() => {
        if (alive) setState({ items: [], error: 'Linked research could not be loaded.' });
      });
    return () => {
      alive = false;
    };
  }, [enabled, contentId]);
  if (!enabled || !contentId) return null;
  return (
    <aside
      className="my-4 rounded-xl border bg-muted/30 p-4"
      aria-label="Linked Second Brain research"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <strong className="text-sm">Research behind this content</strong>
        <Link
          className="text-sm underline"
          to={`/admin/second-brain?capture=${encodeURIComponent(contentId)}`}
        >
          Capture a linked note
        </Link>
      </div>
      {state.error && (
        <p role="status" className="mt-2 text-sm">
          {state.error}
        </p>
      )}
      <ul className="mt-2 space-y-1">
        {state.items.map((item) => (
          <li key={item.id}>
            <Link
              className="text-sm underline"
              to={`/admin/second-brain?item=${encodeURIComponent(item.id)}`}
            >
              {item.title}
            </Link>
          </li>
        ))}
      </ul>
      {!state.items.length && !state.error && (
        <p className="mt-2 text-sm text-muted-foreground">
          Connect an idea or research note to build its context.
        </p>
      )}
    </aside>
  );
}
