import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PublishedPage, { getPrePublishFailures, slugRowOverride } from './PublishedPage';

const postJSON = vi.fn();
const getJSON = vi.fn();
const logAdminAction = vi.fn();
const unpublishToInspected = vi.fn();
const toast = vi.fn();

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: (...args) => toast(...args) }),
}));

vi.mock('@/hooks/useAuthReady', () => ({
  useAuthReady: () => ({ authReady: true }),
}));

vi.mock('@/lib/api', () => ({
  postJSON: (...args) => postJSON(...args),
  getJSON: (...args) => getJSON(...args),
}));

vi.mock('@/lib/auditLog', () => ({
  logAdminAction: (...args) => logAdminAction(...args),
}));

vi.mock('@/lib/contentWorkflow', () => ({
  unpublishToInspected: (...args) => unpublishToInspected(...args),
}));

vi.mock('@/components/admin/ImageOrderManager', () => ({
  ImageOrderManager: () => <div>Image Order Manager</div>,
}));

vi.mock('@/components/admin/ImageGalleryPicker', () => ({
  ImageGalleryPicker: () => <div>Image Gallery Picker</div>,
}));

const sampleSnapshot = {
  success: true,
  readyTotal: 1,
  publishedTotal: 1,
  readyCandidates: [
    {
      id: 'content-1',
      Title: 'Azure publish candidate',
      title: 'Azure publish candidate',
      contentStatus: 'approved_blog',
      type: 'blog',
      publishTarget: 'blog',
      cloudProvider: 'Azure',
      Summary: 'A summary that satisfies the pre-publish checklist.',
      altCoverImage: 'https://cdn.example/hero.png',
      slug: 'azure-publish-candidate',
      curatedSubpagePath: '/azure/blog/azure-publish-candidate',
      updatedAt: { toMillis: () => 200 },
      blogPublishedAt: { toDate: () => new Date('2026-04-20T12:00:00Z') },
      secondaryImageUrls: [],
      Live: false,
    },
  ],
  publishedItems: [
    {
      id: 'content-2',
      Title: 'Existing live article',
      contentStatus: 'published_blog',
      cloudProvider: 'AWS',
      slug: 'existing-live-article',
      curatedSubpagePath: '/aws/blog/existing-live-article',
      blogPublishedAt: { toDate: () => new Date('2026-04-19T12:00:00Z') },
      updatedAt: { toMillis: () => 100 },
      Live: true,
    },
  ],
};

/**
 * Drive the publish flow as an admin does since the pre-publish checklist
 * landed: the row button VALIDATES (fetching the full document for the body
 * check) and opens a modal; the modal's "Publish Now" is what publishes. A
 * test that clicked the row button and expected publishContent was asserting
 * a flow that no longer exists (T-320).
 */
async function publishFirstCandidate() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Publish' })[0]);
  expect(await screen.findByText('Ready to publish')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));
}

describe('getPrePublishFailures — the modal gate', () => {
  const passing = {
    Title: 'T',
    Summary: 'S',
    altCoverImage: 'https://cdn.example/hero.png',
    slug: 's',
    blogDraft: 'x'.repeat(201),
  };

  it('passes a complete item', () => {
    expect(getPrePublishFailures(passing)).toEqual([]);
  });

  it('names each missing prerequisite', () => {
    // The publish flow's only guard between the row button and publishContent
    // is this checklist; if a check silently disappears, the happy-path tests
    // above would still pass, so each check is pinned here.
    expect(getPrePublishFailures({ ...passing, altCoverImage: '' }).join()).toMatch(/hero image/i);
    expect(getPrePublishFailures({ ...passing, Title: ' ' }).join()).toMatch(/title/i);
    expect(getPrePublishFailures({ ...passing, Summary: '' }).join()).toMatch(/summary/i);
    expect(getPrePublishFailures({ ...passing, blogDraft: 'short' }).join()).toMatch(/too short/i);
    expect(getPrePublishFailures({ ...passing, slug: '' }).join()).toMatch(/slug/i);
  });
});

describe('slugRowOverride — an absent field is not a new value (#400)', () => {
  const FULL = {
    changed: true,
    slug: 'new-slug',
    curatedSubpagePath: '/aws/blog/new-slug',
    publicUrl: 'https://hybridcloudworks.com/aws/blog/new-slug',
  };

  it('applies every field the response carried', () => {
    expect(slugRowOverride(FULL)).toEqual({
      slug: 'new-slug',
      Slug: 'new-slug',
      curatedSubpagePath: '/aws/blog/new-slug',
      slugPageUrl: FULL.publicUrl,
      publishedUrl: FULL.publicUrl,
      publicUrl: FULL.publicUrl,
    });
  });

  it('omits the fields the response did not carry, rather than blanking them', () => {
    // The bug: `|| ''` wrote empty strings over URLs the row already had, so
    // getPublicUrl fell through to the client-derived path and "View Live"
    // vanished or pointed somewhere the server never said.
    expect(slugRowOverride({ changed: true, slug: 'new-slug' })).toEqual({
      slug: 'new-slug',
      Slug: 'new-slug',
    });
    expect(slugRowOverride({ changed: true, slug: 'new-slug', publicUrl: null })).toEqual({
      slug: 'new-slug',
      Slug: 'new-slug',
    });
    expect(slugRowOverride({ changed: true, slug: 'new-slug', curatedSubpagePath: '' })).toEqual({
      slug: 'new-slug',
      Slug: 'new-slug',
    });
  });

  it('returns nothing at all for a response that carried nothing usable', () => {
    expect(slugRowOverride({})).toEqual({});
    expect(slugRowOverride()).toEqual({});
    expect(slugRowOverride({ changed: false, reason: 'Already on that slug' })).toEqual({});
  });
});

describe('PublishedPage', () => {
  beforeEach(() => {
    postJSON.mockReset();
    logAdminAction.mockReset();
    unpublishToInspected.mockReset();
    getJSON.mockReset();
    toast.mockReset();
    // The validation step's full-document fetch: the body-length check reads
    // blogDraft, which the snapshot row deliberately omits.
    getJSON.mockResolvedValue({
      item: {
        id: 'content-1',
        blogDraft: 'A body well past the two-hundred character floor. '.repeat(8),
      },
    });
  });

  it('publishes a staged item and surfaces publish diagnostics', async () => {
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getPublishSnapshot') {
        return sampleSnapshot;
      }

      if (endpoint === 'publishContent') {
        return {
          success: true,
          mappings: [
            {
              contentId: 'content-1',
              blogId: 'blog-1',
              reused: false,
              landingProvider: 'Azure',
              slug: 'azure-publish-candidate',
              curatedSubpagePath: '/azure/blog/azure-publish-candidate',
              expectedPublicUrl: 'https://hybridcloudworks.com/azure/blog/azure-publish-candidate',
              sourceUrl: 'https://source.example.com/article',
            },
          ],
          warnings: [],
        };
      }

      throw new Error(`Unexpected endpoint ${endpoint}`);
    });

    render(
      <MemoryRouter initialEntries={['/admin/publish']}>
        <PublishedPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Publish' })).toBeInTheDocument();
    expect(screen.getByText('Azure publish candidate')).toBeInTheDocument();

    await publishFirstCandidate();

    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('publishContent', {
        contentIds: ['content-1'],
        publishTarget: 'blog',
        cloudProvider: 'Azure',
        markLive: true,
        createSlugPageTrigger: true,
        addToCurated: true,
      })
    );

    await waitFor(() =>
      expect(logAdminAction).toHaveBeenCalledWith('content_published_live', {
        contentId: 'content-1',
        title: 'Azure publish candidate',
        publishTarget: 'blog',
        publishMapping: {
          contentId: 'content-1',
          blogId: 'blog-1',
          reused: false,
          landingProvider: 'Azure',
          slug: 'azure-publish-candidate',
          curatedSubpagePath: '/azure/blog/azure-publish-candidate',
          expectedPublicUrl: 'https://hybridcloudworks.com/azure/blog/azure-publish-candidate',
          sourceUrl: 'https://source.example.com/article',
        },
      })
    );

    expect(screen.getByText('Latest Publish Diagnostics')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Expected URL: https://hybridcloudworks.com/azure/blog/azure-publish-candidate'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('No items are currently staged for publishing.')).toBeInTheDocument();
  });

  it('surfaces a mapping error when publish succeeds without an expected public URL', async () => {
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getPublishSnapshot') {
        return sampleSnapshot;
      }

      if (endpoint === 'publishContent') {
        return {
          success: true,
          mappings: [
            {
              contentId: 'content-1',
              blogId: 'blog-1',
              reused: false,
              landingProvider: 'Azure',
              slug: 'azure-publish-candidate',
              curatedSubpagePath: '/azure/blog/azure-publish-candidate',
              expectedPublicUrl: null,
              sourceUrl: 'https://source.example.com/article',
            },
          ],
          warnings: [],
        };
      }

      throw new Error(`Unexpected endpoint ${endpoint}`);
    });

    render(
      <MemoryRouter initialEntries={['/admin/publish']}>
        <PublishedPage />
      </MemoryRouter>
    );

    expect(await screen.findByText('Azure publish candidate')).toBeInTheDocument();

    await publishFirstCandidate();

    expect(
      await screen.findByText(
        'Publish completed but published URL is missing. Check landingProvider/slug mapping in publish response.'
      )
    ).toBeInTheDocument();
  });

  it('carries the "Images: re-host hotlinked" action, which reads its candidates only when opened (#374)', async () => {
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getPublishSnapshot') return sampleSnapshot;
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });
    getJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'cms/content/rehost-images') {
        return {
          success: true,
          scanned: 22,
          candidates: [
            {
              id: 'content-2',
              title: 'Existing live article',
              live: true,
              fields: ['content'],
              urlCount: 8,
              hosts: ['techcommunity.microsoft.com'],
              lastRun: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });

    render(
      <MemoryRouter initialEntries={['/admin/publish']}>
        <PublishedPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Publish' })).toBeInTheDocument();
    expect(getJSON).not.toHaveBeenCalledWith('cms/content/rehost-images');

    fireEvent.click(screen.getByRole('button', { name: 'Images: re-host hotlinked' }));
    expect(
      await screen.findByText('1 of 22 published articles hotlink third-party images.')
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Existing live article' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Re-host selected (1)' })).toBeEnabled();
  });

  it("sets a published article's slug from its own row, and the row's live link follows (#400)", async () => {
    // The placement decision, pinned: the control is in the ALREADY-LIVE list,
    // beside the "View Live" link it changes — not in the editor, and not in
    // the staged list where the article is not yet on a URL at all.
    postJSON.mockImplementation(async (endpoint, body) => {
      if (endpoint === 'getPublishSnapshot') return sampleSnapshot;
      if (endpoint === 'cms/content/slug') {
        expect(body).toEqual({ contentId: 'content-2', slug: 'existing-live-article' });
        return {
          contentId: 'content-2',
          requested: 'existing-live-article',
          changed: true,
          moved: true,
          fields: ['slug', 'Slug', 'curatedSubpagePath'],
          previousSlug: 'stale-slug',
          slug: 'existing-live-article',
          curatedSubpagePath: '/aws/blog/existing-live-article',
          publicUrl: 'https://hybridcloudworks.com/aws/blog/existing-live-article',
        };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });

    render(
      <MemoryRouter initialEntries={['/admin/publish']}>
        <PublishedPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Publish' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Slug' }));
    fireEvent.click(screen.getByRole('button', { name: /Set slug/ }));

    expect(await screen.findByText(/Moved from "stale-slug"/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('link', { name: 'View Live' })
          .some(
            (link) =>
              link.getAttribute('href') ===
              'https://hybridcloudworks.com/aws/blog/existing-live-article'
          )
      ).toBe(true)
    );
  });

  /** Every "View Live" href on the page, for the row-repaint assertions. */
  const liveHrefs = () =>
    screen.getAllByRole('link', { name: 'View Live' }).map((link) => link.getAttribute('href'));

  it("a response with no URL fields leaves the row's existing ones intact (#400)", async () => {
    // A Functions app that predates the no-path refusal can still answer
    // `changed: true` with no URL fields. Before this, the row took that as
    // "the URLs are now empty", lost its curatedSubpagePath, and fell through
    // to the client-derived path — so the live link moved somewhere the server
    // never said. An absent field is no information, not a new value.
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getPublishSnapshot') return sampleSnapshot;
      if (endpoint === 'cms/content/slug') {
        // Deliberately the OLDER shape: no `moved`, no `fields`, no URLs —
        // what a Functions app predating this PR's later commits still sends.
        return {
          contentId: 'content-2',
          requested: 'existing-live-article',
          changed: true,
          previousSlug: 'existing-live-article',
          slug: 'existing-live-article',
        };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });

    render(
      <MemoryRouter initialEntries={['/admin/publish']}>
        <PublishedPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Publish' })).toBeInTheDocument();
    const before = liveHrefs();
    expect(before).toContain('https://hybridcloudworks.com/aws/blog/existing-live-article');

    fireEvent.click(screen.getByRole('button', { name: 'Slug' }));
    fireEvent.click(screen.getByRole('button', { name: /Set slug/ }));

    // The panel reported something, so the click was handled…
    expect(await screen.findByText(/Slug unchanged/)).toBeInTheDocument();
    // …and the row kept the URL it already had.
    expect(liveHrefs()).toEqual(before);
  });

  it('a later, thinner response does not drop what an earlier one applied (#400)', async () => {
    // The override is merged onto the row's existing one, not substituted for
    // it: the first set-slug supplies the URL, the second reports only the
    // slug, and the URL from the first has to survive.
    let call = 0;
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getPublishSnapshot') return sampleSnapshot;
      if (endpoint === 'cms/content/slug') {
        call += 1;
        return call === 1
          ? {
              contentId: 'content-2',
              changed: true,
              moved: true,
              previousSlug: 'existing-live-article',
              slug: 'renamed-once',
              curatedSubpagePath: '/aws/blog/renamed-once',
              publicUrl: 'https://hybridcloudworks.com/aws/blog/renamed-once',
            }
          : {
              contentId: 'content-2',
              changed: true,
              moved: true,
              previousSlug: 'renamed-once',
              slug: 'renamed-twice',
            };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });

    render(
      <MemoryRouter initialEntries={['/admin/publish']}>
        <PublishedPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Publish' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Slug' }));
    fireEvent.click(screen.getByRole('button', { name: /Set slug/ }));
    await waitFor(() =>
      expect(liveHrefs()).toContain('https://hybridcloudworks.com/aws/blog/renamed-once')
    );

    fireEvent.click(screen.getByRole('button', { name: /Set slug/ }));
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(3));
    // Replacing rather than merging would blank the URL the first call set.
    expect(liveHrefs()).toContain('https://hybridcloudworks.com/aws/blog/renamed-once');
  });

  it('queues a podcast transcript from a live row, after confirming, and says where it will appear (#435)', async () => {
    // The placement decision, pinned: the action is on the ALREADY-LIVE list
    // and nowhere on the staged one — "published" is what makes an article
    // final enough to read aloud. The row confirms, then enqueues; the
    // transcript lands later as a draft, so the toast says where to look.
    postJSON.mockImplementation(async (endpoint, body) => {
      if (endpoint === 'getPublishSnapshot') return sampleSnapshot;
      if (endpoint === 'cms/podcast/transcripts/generate') {
        expect(body).toEqual({ articleId: 'content-2' });
        return {
          ok: true,
          jobId: 'job-1',
          type: 'generate-podcast-transcript',
          status: 'queued',
          transcriptId: 'article_existing-live-article',
        };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });

    render(
      <MemoryRouter initialEntries={['/admin/publish']}>
        <PublishedPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Publish' })).toBeInTheDocument();

    // One live row, one staged row: exactly one trigger.
    const triggers = screen.getAllByRole('button', { name: 'Podcast transcript' });
    expect(triggers).toHaveLength(1);

    fireEvent.click(triggers[0]);
    expect(
      await screen.findByText(
        'Generates a two-host script and audio from this article; lands as a draft.'
      )
    ).toBeInTheDocument();
    expect(postJSON).not.toHaveBeenCalledWith(
      'cms/podcast/transcripts/generate',
      expect.anything()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/podcast/transcripts/generate', {
        articleId: 'content-2',
      })
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: 'Podcast transcript queued',
        description: 'Listed under Recording Hub → Podcast when generated.',
      })
    );
    expect(logAdminAction).toHaveBeenCalledWith('podcast_transcript_queued', {
      contentId: 'content-2',
      title: 'Existing live article',
      jobId: 'job-1',
      transcriptId: 'article_existing-live-article',
    });
  });

  it('still reports a queued transcript when the audit write fails (#448 review)', async () => {
    // The enqueue succeeded, so the job IS queued; an audit failure after it
    // must not be reported as "not queued". The audit is its own try and at
    // most warns.
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getPublishSnapshot') return sampleSnapshot;
      if (endpoint === 'cms/podcast/transcripts/generate') {
        return { ok: true, jobId: 'job-1', transcriptId: 'article_existing-live-article' };
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });
    logAdminAction.mockRejectedValueOnce(new Error('identity lookup failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <MemoryRouter initialEntries={['/admin/publish']}>
        <PublishedPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Publish' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Podcast transcript' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(logAdminAction).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: 'Podcast transcript queued',
      description: 'Listed under Recording Hub → Podcast when generated.',
    });
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    warn.mockRestore();
  });

  it('shows the API refusal verbatim when a transcript is not queued (#435)', async () => {
    // The API's sentence names the fix — not published, or the container not
    // provisioned yet — so it is the message, not a paraphrase of it.
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getPublishSnapshot') return sampleSnapshot;
      if (endpoint === 'cms/podcast/transcripts/generate') {
        throw new Error(
          'Article content-2 is not published; only published articles produce a podcast transcript'
        );
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });

    render(
      <MemoryRouter initialEntries={['/admin/publish']}>
        <PublishedPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Publish' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Podcast transcript' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Generate' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: 'Podcast transcript not queued',
        description:
          'Article content-2 is not published; only published articles produce a podcast transcript',
        variant: 'destructive',
      })
    );
    expect(logAdminAction).not.toHaveBeenCalledWith('podcast_transcript_queued', expect.anything());
  });

  it('a refusal repaints nothing in the row (#400)', async () => {
    // The client half of the server's no-path refusal: the two must agree that
    // a refusal changed nothing, or the page would show a move the CMS never
    // made. authedFetch turns a non-2xx into a throw carrying the API's error.
    postJSON.mockImplementation(async (endpoint) => {
      if (endpoint === 'getPublishSnapshot') return sampleSnapshot;
      if (endpoint === 'cms/content/slug') {
        throw new Error(
          'Cannot determine the published path for this article, so nothing was changed. ' +
            'Give it a cloud provider (Aws, Azure, Gcp, Github, Terraform or Finops) or an ' +
            'existing curatedSubpagePath, then set the slug again.'
        );
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });

    render(
      <MemoryRouter initialEntries={['/admin/publish']}>
        <PublishedPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Publish' })).toBeInTheDocument();
    const before = liveHrefs();

    fireEvent.click(screen.getByRole('button', { name: 'Slug' }));
    fireEvent.click(screen.getByRole('button', { name: /Set slug/ }));

    // The refusal is shown, verbatim and actionable…
    expect(await screen.findByText(/Cannot determine the published path/)).toBeInTheDocument();
    expect(screen.getByText(/cloud provider/)).toBeInTheDocument();
    // …and nothing about the row moved.
    expect(liveHrefs()).toEqual(before);
    expect(screen.queryByText(/Moved from/)).not.toBeInTheDocument();
  });
});
