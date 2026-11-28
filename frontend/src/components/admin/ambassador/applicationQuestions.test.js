/**
 * The guided application's rules (ADR 0033 §4): sections keep the form's
 * order, a structured answer round-trips through the one stored string,
 * each kind copies as readable text, and the packet lists every question
 * answered or not.
 */
import { describe, it, expect } from 'vitest';
import {
  answerText,
  answeredCount,
  packetText,
  parseAnswer,
  questionErrors,
  questionSections,
  serialiseAnswer,
} from './applicationQuestions';

const questions = [
  { id: 'name', section: 'Profile', prompt: 'First name', kind: 'profile' },
  { id: 'why', section: 'Questions', prompt: 'Why?', kind: 'text', maxChars: 10 },
  { id: 'site', section: 'Profile', prompt: 'Website', kind: 'url' },
  {
    id: 'links',
    section: 'Network',
    prompt: 'Networks',
    kind: 'links',
    options: ['LinkedIn', 'GitHub'],
  },
  {
    id: 'grid',
    section: 'Tools',
    prompt: 'How often?',
    kind: 'scale',
    rows: ['Teams', 'Forms'],
    options: ['Daily', 'Never'],
  },
  { id: 'acts', section: 'Expertise', prompt: 'Activities', kind: 'activities', maxItems: 2 },
];

describe('questionSections', () => {
  it('groups by section in first-seen order and names an unnamed section', () => {
    expect(questionSections(questions).map((s) => [s.section, s.questions.length])).toEqual([
      ['Profile', 2],
      ['Questions', 1],
      ['Network', 1],
      ['Tools', 1],
      ['Expertise', 1],
    ]);
    expect(questionSections([{ id: 'x', prompt: 'X', kind: 'text' }])[0].section).toBe('Questions');
  });
});

describe('structured answers', () => {
  it('round-trip through the stored string and empty out to the empty string', () => {
    const links = [{ network: 'GitHub', url: 'https://github.com/x' }];
    expect(parseAnswer('links', serialiseAnswer('links', links))).toEqual(links);
    // A blank row just added is kept (it is being filled in); no rows at all is empty.
    expect(parseAnswer('links', serialiseAnswer('links', [{ network: '', url: '' }]))).toEqual([
      { network: '', url: '' },
    ]);
    expect(serialiseAnswer('links', [])).toBe('');
    expect(answeredCount([{ id: 'l', kind: 'links' }], [{ questionId: 'l', text: '[{}]' }])).toBe(
      0
    );
    expect(parseAnswer('scale', serialiseAnswer('scale', { Teams: 'Daily', Forms: '' }))).toEqual({
      Teams: 'Daily',
    });
    expect(serialiseAnswer('scale', {})).toBe('');
    expect(parseAnswer('activities', serialiseAnswer('activities', ['e1', '', 'e2']))).toEqual([
      'e1',
      'e2',
    ]);
    expect(serialiseAnswer('text', 'hello')).toBe('hello');
  });

  it('read a malformed or foreign string as an empty answer rather than throwing', () => {
    expect(parseAnswer('links', 'not json')).toEqual([]);
    expect(parseAnswer('links', '[1, "x", {"url": 3}]')).toEqual([{ network: '', url: '3' }]);
    expect(parseAnswer('scale', '[1]')).toEqual({});
    expect(parseAnswer('activities', '{"a":1}')).toEqual([]);
    expect(parseAnswer('text', undefined)).toBe('');
  });
});

describe('answerText and packetText', () => {
  const evidenceById = new Map([
    ['e1', { id: 'e1', title: 'KCDC talk', date: '2026-08-14', url: 'https://kcdc.info' }],
  ]);
  const responses = [
    { questionId: 'name', text: 'Sam' },
    { questionId: 'links', text: JSON.stringify([{ network: 'GitHub', url: 'https://g/x' }]) },
    { questionId: 'grid', text: JSON.stringify({ Forms: 'Never', Teams: 'Daily' }) },
    { questionId: 'acts', text: JSON.stringify(['e1', 'gone']) },
  ];

  it('words each kind the way the form wants it pasted', () => {
    expect(answerText(questions[3], responses[1].text)).toBe('GitHub: https://g/x');
    // Scale rows keep the question's row order, not the stored one.
    expect(answerText(questions[4], responses[2].text)).toBe('Teams: Daily\nForms: Never');
    expect(answerText(questions[5], responses[3].text, { evidenceById })).toBe(
      'KCDC talk — 2026-08-14 · https://kcdc.info\ngone'
    );
    expect(answerText(questions[0], 'Sam')).toBe('Sam');
  });

  it('lists every section and question, answered or not, and counts the answered', () => {
    const text = packetText(questions, responses, { evidenceById, title: 'Example Program 2026' });
    expect(text.split('\n')).toEqual([
      'Example Program 2026',
      '',
      '## Profile',
      '',
      'First name',
      'Sam',
      '',
      'Website',
      '(not answered)',
      '',
      '## Questions',
      '',
      'Why?',
      '(not answered)',
      '',
      '## Network',
      '',
      'Networks',
      'GitHub: https://g/x',
      '',
      '## Tools',
      '',
      'How often?',
      'Teams: Daily',
      'Forms: Never',
      '',
      '## Expertise',
      '',
      'Activities',
      'KCDC talk — 2026-08-14 · https://kcdc.info',
      'gone',
      '',
    ]);
    expect(answeredCount(questions, responses)).toBe(4);
  });
});

describe('questionErrors', () => {
  it('names a bad URL, a bad link row and a text over its limit, and nothing for empties', () => {
    expect(questionErrors(questions, [])).toEqual({});
    expect(
      questionErrors(questions, [
        { questionId: 'site', text: 'ftp://x' },
        { questionId: 'why', text: 'twelve chars' },
        { questionId: 'links', text: JSON.stringify([{ network: 'X', url: 'x.com' }]) },
      ])
    ).toEqual({
      site: 'Must start with http:// or https://.',
      why: 'Over the limit by 2 characters.',
      links: '"x.com" must start with http:// or https://.',
    });
  });
});
