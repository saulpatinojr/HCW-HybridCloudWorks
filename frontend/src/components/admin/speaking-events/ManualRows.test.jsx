/**
 * The owner's own rows on Future Events: what Edit does with the hub's
 * editor. The rows themselves are drawn in ApplyTab.test.jsx.
 */
import { describe, it, expect, vi } from 'vitest';
import { manualEditAction } from './ManualRows';

describe('Edit on one of the owner’s rows', () => {
  const stored = { _docId: 'example-conf-2099', eventName: 'Example Conf 2099' };
  const row = { id: 'manual-example-conf-2099', docId: 'example-conf-2099' };

  it('opens the stored entry’s own form in the hub’s editor', () => {
    const editor = { openEditManual: vi.fn() };
    const onEdit = manualEditAction(editor, [stored])(row);
    onEdit();
    expect(editor.openEditManual).toHaveBeenCalledWith(stored);
  });

  it('gives no action without an editor, so the row links to the hub instead', () => {
    expect(manualEditAction(null, [stored])(row)).toBeNull();
  });

  it('opens nothing for an entry that has gone from the hub’s copy', () => {
    const editor = { openEditManual: vi.fn() };
    expect(manualEditAction(editor, [])(row)).toBeNull();
    expect(manualEditAction(editor, undefined)(row)).toBeNull();
    expect(editor.openEditManual).not.toHaveBeenCalled();
  });
});
