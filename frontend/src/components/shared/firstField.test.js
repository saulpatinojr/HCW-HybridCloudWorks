import { describe, expect, it } from 'vitest';
import { firstField } from './firstField';

describe('firstField', () => {
  it('returns the first truthy field in key order', () => {
    expect(firstField({ a: '', b: 'second', c: 'third' }, ['a', 'b', 'c'], 'none')).toBe('second');
  });

  it('returns the fallback when no field is set', () => {
    expect(firstField({ a: '', b: 0, c: null }, ['a', 'b', 'c'], 'none')).toBe('none');
  });

  it('treats a missing record like an empty one', () => {
    expect(firstField(undefined, ['a'], 'none')).toBe('none');
    expect(firstField(null, ['a'], 'none')).toBe('none');
  });

  it('matches the || chain it replaces', () => {
    const record = { title: '', Title: 'Hello' };
    expect(firstField(record, ['title', 'Title'], '')).toBe(record.title || record.Title || '');
  });
});
