/**
 * The interview files themselves, as they are in the repository right now.
 *
 * Whatever is in this folder is what the site publishes, so this is the test
 * that stands between a typo in a hand-written file and a blank public page:
 * `./index.js` stops on the first bad file, and the checks here say what a
 * good folder looks like. With no interview yet, every check holds trivially,
 * which is the correct state for a folder that has none.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasInterviews } from './available';
import { interviews } from './index';
import { normalizeInterview, sortInterviews } from '@/lib/interviews';

const DIR = join(process.cwd(), 'src', 'data', 'interviews');
const published = readdirSync(DIR).filter(
  (name) => name.endsWith('.json') && !name.startsWith('_')
);

describe('src/data/interviews', () => {
  it('publishes exactly the JSON files whose names do not start with an underscore', () => {
    expect(interviews.map((interview) => `${interview.slug}.json`).sort()).toEqual(
      [...published].sort()
    );
  });

  it.each(published)('%s is a valid interview, as written', (name) => {
    const raw = JSON.parse(readFileSync(join(DIR, name), 'utf8'));
    expect(() => normalizeInterview(raw, name.replace(/\.json$/, ''))).not.toThrow();
  });

  it('has a unique slug for each interview', () => {
    const slugs = interviews.map((interview) => interview.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keeps them newest first', () => {
    expect(interviews.map((interview) => interview.slug)).toEqual(
      sortInterviews(interviews).map((interview) => interview.slug)
    );
  });

  it('tells the header there is something to link to exactly when there is', () => {
    expect(hasInterviews).toBe(interviews.length > 0);
  });

  it('is frozen, so no page can change what another page shows', () => {
    expect(Object.isFrozen(interviews)).toBe(true);
  });
});
