/**
 * Docker's pages (owner request 2026-09-28). A page whose content is still to
 * be written is a placeholder: it says what it will cover and that it is
 * coming, reads nothing from the API, and points at something a visitor can
 * use now. The sandbox recipe is real content, on its own page (#774), as
 * are the two guides (#772, #773, tested in DockerGuides.test.jsx), the
 * blog and code pages list published Docker content like every other
 * provider's (#776), and the Learning page renders a checked, dated
 * catalogue (#778).
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderContext from '@/context/ProviderContext';
import { SANDBOX_COMMANDS } from '@/components/labs/SandboxSection';
import DockerLandingPage, { DOCKER_HERO_IMAGES, FOCUS_AREAS } from './LandingPage';
import DockerBlogPage from './BlogPage';
import DockerCodePage from './CodePage';
import DockerEducationPage from './EducationPage';
import DockerRssPage from './RssPage';
import DockerSandboxesPage, {
  CHECKED_ON,
  RECIPE_HEADING_ID,
  SANDBOXES_DOCS_URL,
  SANDBOXES_PATH,
} from './SandboxesPage';
import DockerToolsPage from './ToolsPage';
import {
  CREDENTIALS_NOTE,
  DATA_AS_OF,
  DATA_SOURCE,
  DOCKER_RUNS_OWN_EXAM,
  certifications as dockerCertifications,
  learningPaths as dockerLearningPaths,
  resources as dockerResources,
} from '@/data/docker/education';
import { pathMeta } from '@/components/shared/EducationTracks';

vi.mock('react-helmet-async', () => ({
  Helmet: ({ children }) => <>{children}</>,
}));

// The shared news page is tested with its data in its own suite, and rendered
// for real at /docker/news in App.routes.test.jsx; here it is enough to know
// which provider Docker's page hands it (#777).
vi.mock('@/pages/shared/NewsPage', () => ({
  default: ({ provider }) => <main data-testid="shared-news-page">{provider}</main>,
}));

// The blog and code pages read the published list through this one function.
// Everything else in the module stays real.
const fetchPublicContentList = vi.fn();
vi.mock('@/lib/publicApi', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchPublicContentList: (...args) => fetchPublicContentList(...args),
}));

function renderPage(page) {
  return render(
    <MemoryRouter>
      <ProviderContext.Provider value="docker">{page}</ProviderContext.Provider>
    </MemoryRouter>
  );
}

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('a Docker placeholder page called the network');
  });
  fetchPublicContentList.mockReset();
  fetchPublicContentList.mockResolvedValue([]);
});
afterEach(() => fetchSpy.mockRestore());

describe('the Docker landing page', () => {
  it('names Docker in its heading and its title, without calling itself "Docker Hub"', () => {
    renderPage(<DockerLandingPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Container intelligence with Docker' })
    ).toBeInTheDocument();
    // "Docker Hub" is the name of Docker's own image registry.
    expect(document.title).toBe('Docker Containers Hub | Hybrid Cloud Works');
  });

  it('has the three focus areas, in order, each available now and linking to its own page', () => {
    renderPage(<DockerLandingPage />);
    expect(FOCUS_AREAS.map((area) => area.title)).toEqual([
      'Building images',
      'The Docker Desktop app',
      'Running an agent in a sandbox',
    ]);
    for (const area of FOCUS_AREAS) {
      expect(screen.getByRole('heading', { level: 2, name: area.title })).toBeInTheDocument();
    }
    const area = (id) => within(screen.getByTestId(id));
    for (const [id, href] of [
      ['building-images', '/docker/building-images'],
      ['docker-desktop', '/docker/desktop'],
      ['agent-sandbox', '/docker/sandboxes'],
    ]) {
      expect(area(id).getByText('Available now')).toBeInTheDocument();
      expect(area(id).queryByText('Coming soon')).toBeNull();
      expect(area(id).getByRole('link')).toHaveAttribute('href', href);
    }
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('rotates its own hero art, the five generated Docker images (#775)', () => {
    renderPage(<DockerLandingPage />);
    const hero = screen.getByRole('img', { name: 'Docker container imagery' });
    expect([...hero.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(
      DOCKER_HERO_IMAGES
    );
    expect(DOCKER_HERO_IMAGES).toEqual([1, 2, 3, 4, 5].map((n) => `/images/docker-hero/${n}.png`));
  });

  it('uses the site’s own lab image as the worked example for building images', () => {
    renderPage(<DockerLandingPage />);
    const area = screen.getByTestId('building-images');
    expect(area).toHaveTextContent(/hcw-lab/);
    expect(area).toHaveTextContent(/multi-stage builds/i);
    expect(area).toHaveTextContent(/provenance attestations/i);
  });

  it('points the sandbox area at the Docker hub’s own sandboxes page', () => {
    renderPage(<DockerLandingPage />);
    const link = within(screen.getByTestId('agent-sandbox')).getByRole('link', {
      name: /run an agent in a sandbox/i,
    });
    expect(link).toHaveAttribute('href', '/docker/sandboxes');
    expect(SANDBOXES_PATH).toBe('/docker/sandboxes');
  });

  it('reads nothing from the content API', () => {
    renderPage(<DockerLandingPage />);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/Latest Published Content/i)).toBeNull();
  });
});

describe('the Docker sandboxes page', () => {
  it('names itself in its heading and title, and holds the whole recipe under its old heading', () => {
    renderPage(<DockerSandboxesPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Run an agent in a sandbox' })
    ).toBeInTheDocument();
    expect(document.title).toBe('Run an agent in a sandbox | Hybrid Cloud Works');

    const heading = screen.getByRole('heading', {
      level: 2,
      name: 'Run an agent against your landing zone',
    });
    // The id the section had on the labs page, so a copied fragment still means it.
    expect(heading).toHaveAttribute('id', RECIPE_HEADING_ID);
    expect(RECIPE_HEADING_ID).toBe('agent-heading');

    const recipe = screen.getByTestId('sandbox-section');
    expect(within(recipe).getAllByTestId('sandbox-step')).toHaveLength(3);
    const lines = [...recipe.querySelectorAll('pre code')];
    expect(lines.map((line) => line.dataset.shell)).toEqual(['PowerShell', 'bash']);
    expect(lines.map((line) => line.textContent)).toEqual(
      SANDBOX_COMMANDS.map((entry) => entry.command)
    );
    expect(within(recipe).getByTestId('sandbox-first-prompt')).toBeInTheDocument();
    expect(within(recipe).getByTestId('sandbox-cost')).toBeInTheDocument();
  });

  it('says when the commands were last checked, as a machine-readable date', () => {
    renderPage(<DockerSandboxesPage />);
    const checked = screen.getByTestId('sandboxes-checked');
    expect(checked).toHaveTextContent(`last checked on ${CHECKED_ON.label}`);
    expect(checked.querySelector('time')).toHaveAttribute('datetime', CHECKED_ON.iso);
    // A real calendar date, and the label says the same day.
    const day = new Date(`${CHECKED_ON.iso}T00:00:00Z`);
    expect(
      day.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    ).toBe(CHECKED_ON.label);
  });

  it('links to Docker’s documentation in a new tab, the labs, and the hub; and reads nothing', () => {
    renderPage(<DockerSandboxesPage />);
    const nav = screen.getByRole('navigation', { name: 'More on Docker' });
    const docs = within(nav).getByRole('link', { name: /docker sandboxes documentation/i });
    expect(docs).toHaveAttribute('href', SANDBOXES_DOCS_URL);
    expect(docs).toHaveAttribute('target', '_blank');
    expect(docs).toHaveAttribute('rel', 'noopener noreferrer');
    expect(docs).toHaveAccessibleName(/opens in a new tab/);
    expect(within(nav).getByRole('link', { name: /see the browser labs/i })).toHaveAttribute(
      'href',
      '/education/labs'
    );
    expect(within(nav).getByRole('link', { name: /back to the docker hub/i })).toHaveAttribute(
      'href',
      '/docker'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is not a placeholder', () => {
    renderPage(<DockerSandboxesPage />);
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('renders the mini landing frame and the 7-step Docker cloud sandbox (--cloud) walkthrough (#1080)', () => {
    renderPage(<DockerSandboxesPage />);
    expect(screen.getByTestId('mini-landing-frame')).toBeInTheDocument();
    const cloudSection = screen.getByTestId('cloud-sandbox-section');
    const cloudSteps = within(cloudSection).getAllByTestId('cloud-sandbox-step');
    expect(cloudSteps).toHaveLength(7);
    expect(cloudSection).toHaveTextContent('sbx login');
    expect(cloudSection).toHaveTextContent('sbx --cloud secret set anthropic');
    expect(cloudSection).toHaveTextContent(
      'sbx run --cloud claude --name hcw-lz --image-ref hybridcloudworks/hcw-lab:latest --cpus 2 --memory 4096'
    );
    expect(cloudSection).toHaveTextContent('terraform init -backend=false && terraform validate');
    expect(cloudSection).toHaveTextContent('sbx --cloud exec hcw-lz -- terraform -version');
    expect(cloudSection).toHaveTextContent('sbx --cloud rm hcw-lz');
    expect(cloudSection).toHaveTextContent(/Docker Agentic Platform subscription/i);
  });
});

describe('where the recipe used to be', () => {
  it('keeps the labs page’s `agent` slot, whose heading id is agent-heading, pointing here', () => {
    // Read as text: the labs page has its own rendered test. What matters here
    // is that an old `/education/labs#agent-heading` link still lands on a
    // heading, and that the heading's section sends the visitor on.
    const src = (...parts) => readFileSync(join(process.cwd(), 'src', ...parts), 'utf8');
    const labs = src('pages', 'shared', 'LabsLearnPage.jsx');
    expect(labs).toMatch(/<LabsSlot\s+id="agent"/);
    expect(labs).toContain("routes.sandboxes('docker')");
    expect(labs).not.toContain('<SandboxSection');
    expect(src('components', 'labs', 'LabsSlot.jsx')).toContain('id={`${id}-heading`}');
  });
});

describe('the Docker education catalogue (#778)', () => {
  it('says as data that Docker runs no exam, and names another issuer on every credential', () => {
    expect(DOCKER_RUNS_OWN_EXAM).toBe(false);
    expect(dockerCertifications.map((cert) => [cert.code, cert.issuer])).toEqual([
      ['Docker Foundations', 'LinkedIn Learning'],
      ['DCA', 'Mirantis'],
    ]);
    for (const cert of dockerCertifications) {
      expect(cert.issuer, cert.code).not.toMatch(/docker/i);
    }
  });

  it('is dated and sourced from Docker’s own training page', () => {
    expect(DATA_AS_OF).toBe('2026-09-29');
    expect(DATA_SOURCE).toEqual({
      label: 'Docker Training',
      url: 'https://www.docker.com/trainings/',
    });
  });

  it('links every path and resource somewhere real, over https, with nothing estimated', () => {
    for (const path of dockerLearningPaths) {
      expect(path.certUrl, path.title).toMatch(/^https:\/\//);
      expect(path.modules.length, path.title).toBeGreaterThan(0);
      // Docker's pages state minutes, not hours; nothing is rounded into `hours`.
      expect(path.hours, path.title).toBeUndefined();
    }
    for (const resource of dockerResources) {
      expect(resource.url, resource.title).toMatch(/^https:\/\//);
    }
  });
});

describe('the Docker Learning page (#778)', () => {
  it('names itself and says Docker runs no exam before any card', () => {
    renderPage(<DockerEducationPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Docker Learning' })).toBeInTheDocument();
    expect(document.title).toBe('Docker Learning | Hybrid Cloud Works');
    const note = screen.getByTestId('docker-credentials-note');
    expect(note).toHaveTextContent(CREDENTIALS_NOTE);
    expect(note).toHaveTextContent(/does not run a certification exam of its own/);
    // The note comes before the first certification card in reading order.
    const firstCard = screen.getByRole('link', {
      name: /Docker Foundations Professional Certificate/,
    });
    expect(note.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('Coming soon')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows who issues each credential, and opens each at its issuer in a new tab', () => {
    renderPage(<DockerEducationPage />);
    const tracks = screen.getByRole('region', { name: 'Certification tracks' });
    for (const cert of dockerCertifications) {
      const card = within(tracks).getByRole('link', { name: new RegExp(cert.title) });
      expect(card).toHaveAttribute('href', cert.learnUrl);
      expect(card).toHaveAttribute('target', '_blank');
      expect(card).toHaveAttribute('rel', 'noopener noreferrer');
      expect(card).toHaveTextContent(`Issued by ${cert.issuer}`);
    }
  });

  it('dates the catalogue and names its source', () => {
    const { container } = renderPage(<DockerEducationPage />);
    const freshness = container.querySelector('[data-catalogue-as-of]');
    expect(freshness).toHaveAttribute('data-catalogue-as-of', DATA_AS_OF);
    expect(freshness).toHaveTextContent('Docker Training');
  });

  it('lists every learning path with its own words for the link, level and length', () => {
    renderPage(<DockerEducationPage />);
    const paths = screen.getByRole('region', { name: 'Learning paths' });
    expect(
      within(paths)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent)
    ).toEqual(dockerLearningPaths.map((path) => path.title));
    const series = within(paths).getByRole('link', { name: /open the series/i });
    expect(series).toHaveAttribute(
      'href',
      'https://docs.docker.com/get-started/docker-concepts/building-images/'
    );
    expect(within(paths).getByText('Beginner · 25 minutes')).toBeInTheDocument();
    // No path reads as a certification's "View … details" link.
    expect(within(paths).queryByText(/View .* details/)).toBeNull();
  });
});

describe('pathMeta, the level-and-length line on a learning path card', () => {
  it('joins what the path has, and shows nothing for a path with neither', () => {
    expect(pathMeta({ level: 'Beginner', duration: '25 minutes' })).toBe('Beginner · 25 minutes');
    expect(pathMeta({ duration: '15 minutes' })).toBe('15 minutes');
    // The shape every other catalogue uses is unchanged.
    expect(pathMeta({ level: 'Intermediate', hours: 45 })).toBe('Intermediate · 45 h');
    expect(pathMeta({ level: 'Advanced' })).toBe('Advanced');
    expect(pathMeta({})).toBe('');
  });
});

describe('the Docker news page (#777)', () => {
  it('is the shared news page for Docker, which reads Docker’s blog feed', () => {
    renderPage(<DockerRssPage />);
    expect(screen.getByTestId('shared-news-page')).toHaveTextContent('docker');
    expect(screen.queryByText('Coming soon')).toBeNull();
  });
});

describe.each([['tools', DockerToolsPage, 'Docker Tools']])(
  'the Docker %s page',
  (section, Page, title) => {
    it('is an honest placeholder: its heading, "Coming soon", and what it will cover', () => {
      renderPage(<Page />);
      expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      expect(document.title).toBe(`${title} | Hybrid Cloud Works`);
      expect(screen.getByText('Coming soon')).toBeInTheDocument();
      const plans = screen.getByRole('heading', { level: 2, name: 'What this page will cover' });
      expect(within(plans.closest('section')).getAllByRole('listitem').length).toBeGreaterThan(0);
    });

    it('links back to the Docker hub, and reads nothing from the API', () => {
      renderPage(<Page />);
      const nav = screen.getByRole('navigation', { name: 'Docker pages you can use now' });
      expect(within(nav).getByRole('link', { name: /back to the docker hub/i })).toHaveAttribute(
        'href',
        '/docker'
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
);

/** A published document as the public list endpoint returns it. */
const doc = (overrides) => ({
  id: overrides.slug,
  title: 'Untitled',
  summary: 'A summary.',
  publishedDate: '2026-09-28T12:00:00Z',
  ...overrides,
});

describe('the Docker blog (#776)', () => {
  it('lists the articles filed under Docker, each linking to its /docker/blog page', async () => {
    fetchPublicContentList.mockResolvedValue([
      doc({
        slug: 'multi-stage-builds',
        title: 'Multi-stage builds, line by line',
        cloudProvider: 'Docker',
      }),
      // Containers come up in writing about every provider; an article filed
      // under another one stays there even when its title says Docker.
      doc({
        slug: 'docker-on-container-apps',
        title: 'Docker images on Azure Container Apps',
        cloudProvider: 'Azure',
      }),
      doc({
        slug: 'a-framework',
        title: 'A framework',
        cloudProvider: 'Docker',
        type: 'framework',
      }),
    ]);
    renderPage(<DockerBlogPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Docker Containers Blog' })
    ).toBeInTheDocument();
    expect(document.title).toBe('Docker Containers Blog | HCW');

    // The card: its title, and its "Read" link to the article's own page.
    const title = await screen.findByRole('heading', {
      level: 3,
      name: 'Multi-stage builds, line by line',
    });
    const card = title.closest('article');
    expect(within(card).getByRole('link', { name: /read/i })).toHaveAttribute(
      'href',
      '/docker/blog/multi-stage-builds'
    );
    // Every article link on the page goes to that one article.
    const articleLinks = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href) => href?.startsWith('/docker/blog/'));
    expect(articleLinks.length).toBeGreaterThan(0);
    expect(new Set(articleLinks)).toEqual(new Set(['/docker/blog/multi-stage-builds']));
    expect(screen.queryByText('Docker images on Azure Container Apps')).toBeNull();
    expect(screen.queryByText('A framework')).toBeNull();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('says so plainly when nothing is published yet', async () => {
    renderPage(<DockerBlogPage />);
    expect(await screen.findByText('No articles in this category yet.')).toBeInTheDocument();
  });
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

describe('the Docker code page (#776)', () => {
  it('asks for Docker’s code patterns and opens each at /docker/code/<slug>', async () => {
    fetchPublicContentList.mockResolvedValue([
      doc({ slug: 'compose-stack', title: 'A small stack with Docker Compose' }),
    ]);
    render(
      <MemoryRouter initialEntries={['/docker/code']}>
        <ProviderContext.Provider value="docker">
          <Routes>
            <Route path="/docker/code" element={<DockerCodePage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </ProviderContext.Provider>
      </MemoryRouter>
    );

    expect(
      screen.getByRole('heading', { level: 1, name: 'Docker Code Patterns' })
    ).toBeInTheDocument();
    expect(fetchPublicContentList).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'coder_corner', provider: 'docker' })
    );

    fireEvent.click(await screen.findByText('A small stack with Docker Compose'));
    expect(screen.getByTestId('where')).toHaveTextContent('/docker/code/compose-stack');
  });

  it('says so plainly when nothing is published yet', async () => {
    renderPage(<DockerCodePage />);
    expect(await screen.findByText('No guides published yet.')).toBeInTheDocument();
  });
});

describe('links out of the placeholders', () => {
  it('sends the tools page to the sandboxes page, in the same tab', () => {
    renderPage(<DockerToolsPage />);
    const link = screen.getByRole('link', { name: /run an agent in a sandbox/i });
    expect(link).toHaveAttribute('href', SANDBOXES_PATH);
    expect(link).not.toHaveAttribute('target');
  });
});
