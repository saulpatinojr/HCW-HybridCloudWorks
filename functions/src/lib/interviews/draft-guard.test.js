/**
 * The honesty guard (ADR 0040 D4): a pull quote not verbatim in the
 * transcript is dropped; an answer with words the guest did not say is
 * kept and flagged; nothing the guest said is thrown away.
 */
import { describe, it, expect } from 'vitest';
import { answerShare, guardDraft, longWords, normalizeForMatch } from './draft-guard.js';

const guest = [
  'We moved the estate to landing zones because the subscriptions were growing faster than the policies.',
  'Honestly the hardest part was convincing people that “management groups” were not just folders.',
].join('\n');
const interviewer = 'What was the hardest part? And why landing zones?';
const transcript = `${interviewer}\n${guest}`;

describe('normalizeForMatch and longWords', () => {
  it('folds case, straightens quotes and dashes, collapses whitespace', () => {
    expect(normalizeForMatch('  “Management   Groups” — not\nfolders ')).toBe('"management groups" - not folders');
    expect(normalizeForMatch('It’s')).toBe("it's");
  });

  it('keeps distinct words of five letters or more, without quotes and dashes', () => {
    expect([...longWords('The estate, the Estate — “policies” and zone.')].sort()).toEqual(['estate', 'policies']);
    expect(longWords('').size).toBe(0);
  });
});

describe('answerShare', () => {
  it('is the share of long words the guest said, and 1 for an answer with none', () => {
    const words = longWords(guest);
    expect(answerShare('The subscriptions were growing faster than the policies.', words)).toBe(1);
    expect(answerShare('We bought Kubernetes clusters instead.', words)).toBeLessThan(0.5);
    expect(answerShare('Yes.', words)).toBe(1);
  });
});

describe('guardDraft', () => {
  it('keeps a verbatim pull quote, whatever its spacing, case or quote marks', () => {
    const { qa, droppedQuotes, flagged } = guardDraft(
      [{ q: 'Why?', a: 'The subscriptions were growing faster than the policies.', pullQuote: 'the subscriptions were growing   faster than the policies' }],
      { transcriptText: transcript, guestText: guest }
    );
    expect(qa[0].pullQuote).toBe('the subscriptions were growing   faster than the policies');
    expect(qa[0].needsReview).toBeUndefined();
    expect(droppedQuotes).toBe(0);
    expect(flagged).toBe(0);
  });

  it('drops a pull quote the guest did not say, and keeps the item', () => {
    const { qa, droppedQuotes } = guardDraft(
      [{ q: 'Why?', a: 'The subscriptions were growing faster than the policies.', pullQuote: 'Landing zones changed everything for us.' }],
      { transcriptText: transcript, guestText: guest }
    );
    expect(qa).toEqual([{ q: 'Why?', a: 'The subscriptions were growing faster than the policies.', pullQuote: '' }]);
    expect(droppedQuotes).toBe(1);
  });

  it('flags an answer with invented words rather than dropping it, and does not flag a paraphrase of the guest', () => {
    const { qa, flagged } = guardDraft(
      [
        { q: 'What next?', a: 'We will migrate every workload to Kubernetes clusters across three regions next quarter.' },
        { q: 'Hardest part?', a: 'Convincing people that management groups were not just folders.' },
      ],
      { transcriptText: transcript, guestText: guest }
    );
    expect(qa[0]).toMatchObject({ needsReview: true, a: expect.stringMatching(/Kubernetes/) });
    expect(qa[1].needsReview).toBeUndefined();
    expect(flagged).toBe(1);
  });

  it('drops a pull quote the interviewer said, unless the speakers could not be told apart', () => {
    const qa = [{ q: 'Why?', a: 'The subscriptions were growing faster than the policies.', pullQuote: 'What was the hardest part?' }];
    expect(guardDraft(qa, { transcriptText: transcript, guestText: guest }).droppedQuotes).toBe(1);
    expect(guardDraft(qa, { transcriptText: transcript, guestText: guest, speakersUnsure: true }).droppedQuotes).toBe(0);
  });

  it('holds the 80% line exactly: eight of ten long words is kept, seven is flagged', () => {
    const said = 'alpha1 bravo2 charlie3 delta4 echo5 foxtrot6 golf7 hotel8';
    const eight = `${said} india9 juliet10`;
    const seven = 'alpha1 bravo2 charlie3 delta4 echo5 foxtrot6 golf7 india9 juliet10 kilo11';
    expect(answerShare(eight, longWords(said))).toBe(0.8);
    expect(guardDraft([{ q: 'q', a: eight }], { transcriptText: said, guestText: said }).flagged).toBe(0);
    expect(guardDraft([{ q: 'q', a: seven }], { transcriptText: said, guestText: said }).flagged).toBe(1);
  });

  it('judges answers against the guest’s turns only: the interviewer’s words do not vouch for an answer', () => {
    const { qa } = guardDraft(
      [{ q: 'Why?', a: 'Hardest question answered, landing zones chosen.' }],
      { transcriptText: transcript, guestText: '' }
    );
    expect(qa[0].needsReview).toBe(true);
  });

  it('answers an empty list and a missing pull quote without complaint', () => {
    expect(guardDraft([], { transcriptText: '', guestText: '' })).toEqual({ qa: [], droppedQuotes: 0, flagged: 0 });
    expect(guardDraft(undefined, { transcriptText: '', guestText: '' }).qa).toEqual([]);
    expect(guardDraft([{ q: 'q', a: 'Yes.' }], { transcriptText: 'Yes.', guestText: 'Yes.' }).qa[0].pullQuote).toBe('');
  });
});
