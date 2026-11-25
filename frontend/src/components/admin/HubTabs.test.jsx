/**
 * The shared hub tab bar: the ARIA tabs contract every hub relies on.
 */
import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import HubTabs, { nextTabIndex } from './HubTabs';
import { balancedRowStarts, splitIntoRows } from './hubTabRows';

const TABS = [
  { id: 'one', label: 'One' },
  { id: 'two', label: 'Two' },
  { id: 'three', label: 'Three' },
];

function Harness({ active = 'one', onSelect = vi.fn() }) {
  return (
    <HubTabs tabs={TABS} active={active} onSelect={onSelect} idPrefix="demo" label="Demo hub">
      <p>content of {active}</p>
    </HubTabs>
  );
}

describe('nextTabIndex', () => {
  it('wraps arrows and jumps with Home and End', () => {
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('Home', 1, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
    expect(nextTabIndex('Enter', 0, 3)).toBeNull();
  });
});

describe('HubTabs', () => {
  it('links each tab to the one panel, which is labelled by the selected tab', () => {
    render(<Harness active="two" />);
    const tablist = screen.getByRole('tablist', { name: 'Demo hub' });
    expect(tablist).toBeTruthy();
    const selected = screen.getByRole('tab', { selected: true });
    expect(selected.textContent).toBe('Two');
    expect(selected.id).toBe('demo-tab-two');
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.getAttribute('aria-controls')).toBe('demo-tabpanel');
    }
    const panel = screen.getByRole('tabpanel');
    expect(panel.id).toBe('demo-tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('demo-tab-two');
    expect(panel.textContent).toBe('content of two');
  });

  it('puts only the selected tab in the Tab order, and moves with the keyboard', () => {
    const onSelect = vi.fn();
    render(<Harness active="one" onSelect={onSelect} />);
    const [one, two, three] = screen.getAllByRole('tab');
    expect(one.getAttribute('tabindex')).toBe('0');
    expect(two.getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(one, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('two');
    expect(document.activeElement).toBe(two);
    // A held key repeats before `active` changes: it must keep moving from focus.
    fireEvent.keyDown(two, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('three');
    expect(document.activeElement).toBe(three);
    fireEvent.keyDown(one, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('three');
    expect(document.activeElement).toBe(three);
    fireEvent.click(two);
    expect(onSelect).toHaveBeenLastCalledWith('two');
  });

  it('wraps rather than scrolls, and marks the selected tab by its fill', () => {
    render(<Harness active="two" />);
    const tablist = screen.getByRole('tablist');
    // No sideways scroll strip: every tab stays on screen.
    expect(tablist.className).not.toContain('overflow-x-auto');
    const [one, two] = screen.getAllByRole('tab');
    expect(two.className).toContain('bg-primary');
    expect(one.className).not.toContain('bg-primary');
    // Every tab has a visible keyboard focus ring.
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).toContain('focus-visible:outline-2');
    }
  });

  it('follows the selection it is given, as a ?tab= link changes it', () => {
    const { rerender } = render(<Harness active="one" />);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('One');
    rerender(<Harness active="three" />);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Three');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('demo-tab-three');
  });

  it('wraps ArrowLeft from the first tab to the last, and Home goes back', () => {
    const onSelect = vi.fn();
    render(<Harness active="one" onSelect={onSelect} />);
    const [one, , three] = screen.getAllByRole('tab');
    fireEvent.keyDown(one, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith('three');
    expect(document.activeElement).toBe(three);
    fireEvent.keyDown(three, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('one');
    expect(document.activeElement).toBe(one);
  });
});

describe('HubTabs on a narrow bar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('measures its tabs and breaks them onto lines, keeping every tab', () => {
    // jsdom lays nothing out, so give each label 100px and the bar 250px.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100 });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(250);
    const { container } = render(<Harness active="one" />);
    const lines = container.querySelectorAll('[role="tablist"] > [role="presentation"]');
    expect(lines).toHaveLength(2);
    expect(lines[0].querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(lines[1].querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });
});

describe('balancedRowStarts', () => {
  it('keeps one line when everything fits', () => {
    expect(balancedRowStarts([100, 100, 100], 400, 4)).toEqual([]);
  });

  it('shares the tabs out evenly instead of leaving one alone on the last line', () => {
    // Seven fit on the first line at 800px; the eighth would sit alone.
    const widths = Array(8).fill(100);
    expect(balancedRowStarts(widths, 800, 4)).toEqual([4]);
  });

  it('uses no more lines than a plain wrap would', () => {
    const widths = [80, 60, 120, 170, 130, 50, 90, 110];
    const lines = balancedRowStarts(widths, 340, 4).length + 1;
    expect(lines).toBe(3);
  });

  it('gives a tab wider than the bar a line of its own rather than failing', () => {
    expect(balancedRowStarts([500, 100], 300, 4)).toEqual([1]);
    expect(balancedRowStarts([], 300, 4)).toEqual([]);
    expect(balancedRowStarts([100], 0, 4)).toEqual([]);
  });
});

describe('splitIntoRows', () => {
  it('cuts the list at each line start', () => {
    expect(splitIntoRows(['a', 'b', 'c', 'd'], [2])).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(splitIntoRows(['a', 'b'], [])).toEqual([['a', 'b']]);
  });
});
