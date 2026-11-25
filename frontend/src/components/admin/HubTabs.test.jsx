/**
 * The shared hub tab bar: the ARIA tabs contract every hub relies on.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import HubTabs, { nextTabIndex } from './HubTabs';

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

  it('lays the tabs out as a grid, and marks the selected tab by its fill', () => {
    render(<Harness active="two" />);
    const tablist = screen.getByRole('tablist');
    // No sideways scroll strip: a grid of equal cells keeps every tab on screen.
    expect(tablist.className).not.toContain('overflow-x-auto');
    expect(tablist.className).toContain('grid-cols-[repeat(auto-fit,');
    // The tabs are the grid's own cells, so the columns line up on every row.
    expect([...tablist.children].every((child) => child.getAttribute('role') === 'tab')).toBe(true);
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
