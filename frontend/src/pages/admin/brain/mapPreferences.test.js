import { beforeEach, describe, expect, it } from 'vitest';
import { loadAppearance, saveAppearance, normalizeAppearance, nodeHeading } from './mapPreferences';
beforeEach(() => localStorage.clear());
describe('map presentation preferences', () => {
  it('retains a short heading independently of the complete title and body', () => {
    const item = {
      title: 'A longer complete idea title stays available for editing',
      body: 'The entire idea remains here.',
      properties: { heading: 'Recovery practice' },
    };
    expect(nodeHeading(item)).toBe('Recovery practice');
    expect(nodeHeading({ title: item.title }).split(/\s+/)).toHaveLength(4);
    expect(item.body).toBe('The entire idea remains here.');
  });
  it('saves only bounded style values and rejects invalid CSS colors', () => {
    saveAppearance({
      palette: 'warm',
      fontSize: 10,
      colors: { note: '#075985', reference: 'url(https://invalid.test)' },
      privateBody: 'Never persist this',
    });
    expect(loadAppearance()).toEqual({
      palette: 'warm',
      fontSize: 10,
      colors: { note: '#075985' },
    });
    expect(localStorage.getItem('hcw.brain.map.appearance.v1')).not.toContain('Never persist');
    expect(normalizeAppearance({ palette: 'unknown', fontSize: 100 })).toMatchObject({
      palette: 'cloud',
      fontSize: 14,
    });
    localStorage.setItem('hcw.brain.map.appearance.v1', 'invalid json');
    expect(loadAppearance()).toMatchObject({ palette: 'cloud', fontSize: 11 });
  });
});
