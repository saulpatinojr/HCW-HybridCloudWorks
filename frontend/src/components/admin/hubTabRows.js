/**
 * How HubTabs splits its tabs into rows when they do not fit on one line.
 *
 * Left to itself, a wrapping row of tabs puts as many as fit on the first
 * line and leaves the rest, sometimes a single tab, alone on the second. With
 * every tab stretched to fill its line, that last tab became a bar the full
 * width of the page (seen on Platform Settings). So the bar works out the
 * fewest lines it needs and then shares the tabs out as evenly as it can
 * across them: eight tabs on two lines become four and four, not seven and
 * one.
 */
import { useLayoutEffect, useState } from 'react';

/**
 * Pack tabs left to right into lines no wider than `limit` and return the
 * index of the first tab of each line after the first.
 */
function lineStarts(widths, limit, gap) {
  const starts = [];
  let used = 0;
  widths.forEach((width, index) => {
    if (index > 0 && used + gap + width > limit) {
      starts.push(index);
      used = width;
    } else {
      used = index === 0 ? width : used + gap + width;
    }
  });
  return starts;
}

/**
 * Where each line after the first begins, so the tabs use the fewest lines
 * that fit `available` and those lines are as close in width as possible.
 * An empty list means everything fits on one line.
 *
 * @param {number[]} widths each tab's natural width, in pixels
 * @param {number} available the width the tabs can use
 * @param {number} gap the space between two tabs
 * @returns {number[]}
 */
export function balancedRowStarts(widths, available, gap) {
  if (widths.length === 0 || !(available > 0)) return [];
  const fewest = lineStarts(widths, available, gap).length;
  if (fewest === 0) return [];
  // The narrowest line width that still needs no more lines than that: the
  // tightest limit spreads the tabs most evenly. Binary search on whole pixels.
  let low = Math.max(...widths);
  let high = Math.max(low, Math.ceil(available));
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts(widths, middle, gap).length <= fewest) high = middle;
    else low = middle + 1;
  }
  return lineStarts(widths, low, gap);
}

/** Split `items` into lines that begin at the given indexes. */
export function splitIntoRows(items, starts) {
  const bounds = [0, ...starts, items.length];
  return bounds.slice(0, -1).map((start, row) => items.slice(start, bounds[row + 1]));
}

/** The horizontal padding of an element, in pixels. */
function paddingX(element) {
  const style = window.getComputedStyle(element);
  return (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
}

/** Measure the bar and its tabs, and return where the lines should break. */
function measureRowStarts(list, labels) {
  const tabs = labels.filter(Boolean);
  if (!list || tabs.length === 0) return [];
  // A tab's natural width is its label plus its own padding; the button
  // itself may already be stretched, so it is not measured directly.
  const widths = tabs.map(
    (label) => label.getBoundingClientRect().width + paddingX(label.parentElement)
  );
  const gap = parseFloat(window.getComputedStyle(list).rowGap) || 0;
  return balancedRowStarts(widths, list.clientWidth - paddingX(list), gap);
}

/**
 * Keep the line breaks right as the bar is resized or a label changes (the
 * decisions list shows a count beside each label, for example).
 *
 * @param {React.RefObject<HTMLElement>} listRef the tab list
 * @param {React.RefObject<HTMLElement[]>} labelRefs each tab's label
 * @param {string} signature changes whenever the set of labels does
 * @returns {number[]} index of the first tab of each line after the first
 */
export function useBalancedRows(listRef, labelRefs, signature) {
  const [starts, setStarts] = useState([]);
  useLayoutEffect(() => {
    const list = listRef.current;
    const update = () => {
      const next = measureRowStarts(list, labelRefs.current);
      setStarts((current) => (current.join() === next.join() ? current : next));
    };
    update();
    if (typeof ResizeObserver === 'undefined' || !list) return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(list);
    labelRefs.current.forEach((label) => label && observer.observe(label));
    return () => observer.disconnect();
    // `starts` too: a new split moves tabs between lines, which replaces the
    // label elements, so the observer has to be pointed at the new ones.
  }, [listRef, labelRefs, signature, starts]);
  return starts;
}
