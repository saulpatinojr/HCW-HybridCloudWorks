/**
 * StageFourCard came apart into sub-components (#634), so these render it.
 *
 * A render test rather than unit tests on purpose: on #629 a rename left three
 * `<select>` blocks pointing at the old names, and lint, build and every unit
 * test passed because none of them rendered the thing that broke. Splitting a
 * 215-line component into seven is exactly that risk again.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import StageFourCard from './StageFourCard';

vi.mock('react-markdown', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => {} }));

const SECTIONS = [
  { key: 'tldr', heading: '## TL;DR', title: 'TL;DR', template: '## TL;DR' },
  { key: 'faq', heading: '## FAQ', title: 'FAQ', template: '## FAQ' },
];

function renderCard(overrides = {}) {
  const props = {
    draftTitle: 'A generated title',
    setDraftTitle: vi.fn(),
    title: '',
    draftSummary: 'A generated summary',
    setDraftSummary: vi.fn(),
    sectionBlocks: SECTIONS,
    draftContent: 'body with ## TL;DR in it',
    setDraftContent: vi.fn(),
    draftReady: true,
    insertSectionBlock: vi.fn(),
    draftTopics: [],
    resolveSlotImage: () => '',
    previewPath: '/azure/blog/a-title',
    readinessChecks: [],
    savedContentId: '',
    canPreview: true,
    readinessComplete: true,
    previewSaving: false,
    createAndOpenSaving: false,
    handleCreateAndOpenEditor: vi.fn(),
    saveLabel: 'Blog Draft',
    ...overrides,
  };
  return { props, ...render(<StageFourCard {...props} />) };
}

describe('StageFourCard', () => {
  it('renders the draft the operator is editing', () => {
    renderCard();
    expect(screen.getByDisplayValue('A generated title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A generated summary')).toBeInTheDocument();
    expect(screen.getByText('/azure/blog/a-title')).toBeInTheDocument();
  });

  it('ticks the section blocks already present in the draft', () => {
    renderCard();
    // TL;DR is in draftContent, FAQ is not.
    expect(screen.getByRole('button', { name: /✓ TL;DR/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^FAQ$/ })).toBeInTheDocument();
  });

  it('disables the section buttons until a draft exists', () => {
    renderCard({ draftReady: false });
    expect(screen.getByRole('button', { name: /TL;DR/ })).toBeDisabled();
  });

  it('caps the preview topics at six while listing them all above', () => {
    const topics = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    renderCard({ draftTopics: topics });
    // Seven above plus six in the preview.
    expect(screen.getAllByText('a')).toHaveLength(2);
    expect(screen.getAllByText('g')).toHaveLength(1);
  });

  it('renders no topic row at all when there are none', () => {
    renderCard({ draftTopics: [] });
    expect(screen.queryByText('a')).not.toBeInTheDocument();
  });

  it('shows the suggested address topic, and nothing when there is none (#1628)', () => {
    renderCard({ draftTopic: 'hybrid' });
    expect(screen.getByText(/Address topic: hybrid/)).toBeInTheDocument();
  });

  it('shows no address topic line when the server will pick one', () => {
    renderCard({ draftTopic: '' });
    expect(screen.queryByText(/Address topic/)).not.toBeInTheDocument();
  });

  it('shows the hero image only when a slot resolves one', () => {
    const { container } = renderCard({ resolveSlotImage: () => '/m/hero.png' });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/m/hero.png');
  });

  it('omits the image entirely when no slot resolves', () => {
    const { container } = renderCard();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows a hint only for the readiness checks that are unmet', () => {
    renderCard({
      readinessChecks: [
        { key: 'title', label: 'Has a title', done: true, hint: 'Add a title' },
        { key: 'summary', label: 'Has a summary', done: false, hint: 'Add a summary' },
      ],
    });
    expect(screen.getByText('Has a title')).toBeInTheDocument();
    expect(screen.queryByText('Add a title')).not.toBeInTheDocument();
    expect(screen.getByText('Add a summary')).toBeInTheDocument();
  });

  it('points the schema-sections hint at the buttons above it', () => {
    renderCard({
      readinessChecks: [
        { key: 'schema-sections', label: 'Sections', done: false, hint: 'Missing TL;DR' },
      ],
    });
    expect(
      screen.getByText(/Add them using the Schema Section Blocks buttons above/)
    ).toBeInTheDocument();
  });

  it('labels the save button for the content type', () => {
    renderCard({ saveLabel: 'Framework Draft' });
    expect(screen.getByRole('button', { name: /Save Framework Draft/ })).toBeInTheDocument();
  });

  it('blocks both saves until the gates are met', () => {
    renderCard({ readinessComplete: false });
    expect(screen.getByRole('button', { name: /Save Blog Draft/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Create \+ Open Editor/ })).toBeDisabled();
  });

  it('blocks both saves while either one is in flight', () => {
    // Otherwise pressing both writes the draft twice.
    renderCard({ previewSaving: true });
    expect(screen.getByRole('button', { name: /Create \+ Open Editor/ })).toBeDisabled();
  });

  it('links to what was last saved, once something has been', () => {
    renderCard({ savedContentId: 'abcdef123456' });
    // The link text is the id's first eight characters, not the whole id.
    const link = screen.getByRole('link', { name: 'abcdef12' });
    expect(link.getAttribute('href')).toContain('source=content');
  });

  it('shows no saved link before anything is saved', () => {
    renderCard();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
