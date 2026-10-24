/**
 * A made-up interview for tests, written in the file format
 * (docs/runbooks/add-an-interview.md) and run through the real checks.
 *
 * It lives only here. No interview is shipped with the site until the owner
 * adds a real one, so none of these words can reach a public page.
 */
import { normalizeInterview } from '@/lib/interviews';

export const rawInterview = (overrides = {}) => ({
  title: 'A Test Interview',
  subtitle: 'A made-up conversation for the tests',
  date: '2026-10-01',
  guest: { name: 'Test Guest', role: 'Test Role' },
  bio: 'Test Guest exists only in the test suite.',
  image: { src: '/images/test-guest.jpg', alt: 'A grey square standing in for a portrait' },
  tags: ['landing-zones', 'governance'],
  qa: [
    {
      q: 'What is the first question?',
      a: 'The first answer, which is a plain sentence.',
      pullQuote: 'The first pull quote.',
    },
    { q: 'What is the second question?', a: 'The second answer.' },
    { q: 'What is the third question?', a: 'The third answer.' },
  ],
  related: {
    labs: [{ title: 'A lab', url: '/azure/education/labs/a-lab' }],
    learn: [{ title: 'A Learn page', url: 'https://learn.microsoft.com/training/' }],
  },
  ...overrides,
});

export const makeInterview = (slug = 'a-test-interview', overrides = {}) =>
  normalizeInterview(rawInterview(overrides), slug);
