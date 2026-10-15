/**
 * One chapter row in an open book (ADR 0033 §4): the status and the guide
 * badge read without colour, the keyboard reorder path is real, every action
 * reaches the hub, and a failed regeneration offers Retry and Keep current
 * while the published take keeps its player.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ChapterRow from './ChapterRow';

vi.mock('@/lib/functionsBase', () => ({ resolveMediaUrl: (u) => u }));

const chapter = (over = {}) => ({
  id: 'area-1',
  setId: 'azure_az-104',
  areaSlug: 'area-1',
  areaName: 'Manage identities',
  title: 'Manage identities',
  kind: 'guide',
  status: 'published',
  order: 0,
  audioUrl: '/api/public/media/listenandlearn/azure/az-104/area-1-20261003140509.mp3',
  durationSeconds: 552,
  audioBytes: 4613734,
  activeVersionId: '20261003140509',
  versionCount: 2,
  versions: [
    { id: 'legacy', active: false, durationSeconds: 500 },
    {
      id: '20261003140509',
      active: true,
      speechModel: 'gemini-2.5-flash-preview-tts',
      durationSeconds: 552,
      audioBytes: 4613734,
    },
  ],
  droppedFromGuide: false,
  transcript: [{ speaker: 'Maya', text: 'Hello' }],
  ...over,
});

const actions = () => ({
  review: vi.fn(),
  regenerate: vi.fn(),
  rename: vi.fn(),
  move: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  versions: vi.fn(),
  keepCurrent: vi.fn(),
});

const drag = { dragging: false, onDragStart: vi.fn(), onDragOver: vi.fn(), onDrop: vi.fn() };

function renderRow(props = {}) {
  const a = actions();
  render(
    <ol>
      <ChapterRow
        chapter={chapter(props.chapter)}
        book={{ kind: 'course' }}
        index={props.index ?? 1}
        count={props.count ?? 3}
        busy={false}
        progress={props.progress ?? null}
        actions={a}
        drag={drag}
      />
    </ol>
  );
  return a;
}

describe('ChapterRow', () => {
  it('shows the status, the kind, the take summary and the player for the active take', () => {
    renderRow();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('Study guide')).toBeInTheDocument();
    expect(
      screen.getByText(/Take 2 of 2 · gemini-2.5-flash-preview-tts · 9:12 · 4.4 MB/)
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Play: Manage identities')).toHaveAttribute(
      'src',
      expect.stringContaining('area-1-20261003140509.mp3')
    );
    expect(screen.getByRole('link', { name: /Download MP3/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Versions \(2\)/ })).toBeInTheDocument();
  });

  it('flags a lesson the current guide no longer lists', () => {
    renderRow({ chapter: { droppedFromGuide: true } });
    expect(screen.getByText('Not in current guide')).toBeInTheDocument();
  });

  it('moves with the keyboard buttons, disabled at the ends, and offers a drag handle', () => {
    const a = renderRow({ index: 0, count: 2 });
    expect(screen.getByRole('button', { name: 'Move Manage identities up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move Manage identities down' }));
    expect(a.move).toHaveBeenCalledWith(0, 1);
    expect(
      screen.getByRole('button', { name: 'Drag to reorder Manage identities' })
    ).toHaveAttribute('draggable');
  });

  it('wires every action to the hub', () => {
    const a = renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw to draft' }));
    expect(a.review).toHaveBeenCalledWith(expect.objectContaining({ id: 'area-1' }), 'draft');
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(a.regenerate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }));
    expect(a.archive).toHaveBeenCalledWith(expect.objectContaining({ id: 'area-1' }), true);
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    expect(a.remove).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Versions/ }));
    expect(a.versions).toHaveBeenCalled();
  });

  it('renames in place and sends the new title', () => {
    const a = renderRow();
    fireEvent.click(screen.getByRole('button', { name: /Rename/ }));
    const input = screen.getByLabelText('New title for Manage identities');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'Identity and access' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(a.rename).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'area-1' }),
      'Identity and access'
    );
  });

  it('after a failed regeneration keeps the player and offers Retry and Keep current', () => {
    // The shape the job stores since #945: a sentence with the error's code
    // and the log line's reference, never the provider's words.
    const a = renderRow({
      chapter: {
        lastError: {
          message: 'The chapter could not be voiced (HTTP_500; reference inv-41).',
          at: '2026-10-03T14:00:00.000Z',
        },
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The chapter could not be voiced (HTTP_500; reference inv-41).'
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/published take is still playing/);
    expect(screen.getByLabelText('Play: Manage identities')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(a.regenerate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep current' }));
    expect(a.keepCurrent).toHaveBeenCalled();
  });

  it('shows the running job’s line and an archived chapter’s Restore', () => {
    renderRow({ progress: 'Queued — speech by Gemini', chapter: { status: 'archived' } });
    expect(screen.getByText('Queued — speech by Gemini')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve and publish|Withdraw/ })).toBeNull();
  });
});
