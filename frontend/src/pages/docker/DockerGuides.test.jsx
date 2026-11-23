/**
 * The Docker hub's two guides: building images with the lab image as the
 * worked example (#772), and the Docker Desktop app (#773).
 *
 * Two kinds of check. The rendered ones hold the page's shape: its heading,
 * every command in its block under the shell it is written for, PowerShell
 * before bash, a dated "last checked" line, links that open where they say,
 * and no network. The source ones hold the building-images page to the files
 * it describes, read from the repository (as labImage.test.js does), so a
 * change to the Dockerfile or the publish workflow that falsifies a sentence
 * here fails a test instead of leaving the page wrong.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderContext from '@/context/ProviderContext';
import { LAB_IMAGE, RUN_LOCALLY_COMMANDS } from '@/data/labs/catalogue';
import DockerBuildingImagesPage, {
  BUILDING_IMAGES_PATH,
  CHECKED_ON as IMAGES_CHECKED_ON,
  COMMANDS as IMAGE_COMMANDS,
  PUBLISHED_IMAGE,
  LOCAL_TAG,
  SOURCE_LINKS,
} from './BuildingImagesPage';
import DockerDesktopPage, {
  CHECKED_ON as DESKTOP_CHECKED_ON,
  COMMANDS as DESKTOP_COMMANDS,
  CURRENT_RELEASE,
  DESKTOP_PATH,
  DOCS,
  DOWNLOADS,
  WSLCONFIG_EXAMPLE,
} from './DesktopPage';
import DockerToolsPage from './ToolsPage';

vi.mock('react-helmet-async', () => ({
  Helmet: ({ children }) => <>{children}</>,
}));

const REPO_ROOT = join(process.cwd(), '..');
const repoFile = (...parts) => readFileSync(join(REPO_ROOT, ...parts), 'utf8');

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
    throw new Error('a Docker guide called the network');
  });
});
afterEach(() => fetchSpy.mockRestore());

/** Every command block on the page, as `[shell, command]`, in document order. */
const commandBlocks = (container) =>
  [...container.querySelectorAll('pre code[data-shell]')].map((code) => [
    code.dataset.shell,
    code.textContent,
  ]);

/** A dated line: the `<time>` carries the ISO date and the label is the same day. */
function expectCheckedOn(checked) {
  const line = screen.getByTestId('guide-checked');
  expect(line).toHaveTextContent(checked.label);
  expect(line.querySelector('time')).toHaveAttribute('datetime', checked.iso);
  const day = new Date(`${checked.iso}T00:00:00Z`);
  expect(
    day.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })
  ).toBe(checked.label);
}

/** Each command list prints PowerShell before any bash line, and names a shell on every line. */
function expectShellOrder(commands) {
  for (const [section, list] of Object.entries(commands)) {
    expect(list.length, section).toBeGreaterThan(0);
    for (const entry of list) {
      expect(entry.shell, section).toMatch(/^(PowerShell|bash)\b/);
      expect(entry.command, section).not.toMatch(/undefined|<[a-z-]+>|THE_|YOUR_/i);
    }
    const firstBash = list.findIndex((entry) => entry.shell.startsWith('bash'));
    const lastPowerShell = list.map((entry) => entry.shell).lastIndexOf('PowerShell');
    if (firstBash !== -1 && lastPowerShell !== -1) {
      expect(lastPowerShell, section).toBeLessThan(firstBash);
    }
  }
}

describe('the building images guide (#772)', () => {
  it('lives at /docker/building-images and names itself in its heading and title', () => {
    expect(BUILDING_IMAGES_PATH).toBe('/docker/building-images');
    renderPage(<DockerBuildingImagesPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Building images' })).toBeInTheDocument();
    expect(document.title).toBe('Building images | Hybrid Cloud Works');
  });

  it('covers each topic the issue asks for, in order, under its own heading', () => {
    renderPage(<DockerBuildingImagesPage />);
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent.trim())
    ).toEqual([
      'Get the source',
      'One Dockerfile, two targets',
      'Base images pinned by digest',
      'Every direct download checked against a pinned sum',
      'Vendored for offline use',
      'Running as a non-root user',
      'Smoke tests',
      'Provenance attestations',
      'Publishing to Docker Hub',
    ]);
  });

  it('prints every command exactly, each under its shell, PowerShell first', () => {
    const { container } = renderPage(<DockerBuildingImagesPage />);
    expect(commandBlocks(container)).toEqual(
      Object.values(IMAGE_COMMANDS).flatMap((list) =>
        list.map((entry) => [entry.shell, entry.command])
      )
    );
    expectShellOrder(IMAGE_COMMANDS);
  });

  it('writes the PowerShell mount with ${PWD} literally, not interpolated at build time', () => {
    const [powershell, bash] = IMAGE_COMMANDS.smoke;
    expect(powershell.command).toBe(
      'docker run --rm --network none -v "${PWD}\\lab-image:/workspace:ro" hcw-lab:dev bash /workspace/smoke.sh full'
    );
    expect(bash.command).toBe(
      'MSYS_NO_PATHCONV=1 docker run --rm --network none -v "$(pwd -W 2>/dev/null || pwd)/lab-image:/workspace:ro" hcw-lab:dev bash /workspace/smoke.sh full'
    );
  });

  it('says when the commands were last checked', () => {
    renderPage(<DockerBuildingImagesPage />);
    expectCheckedOn(IMAGES_CHECKED_ON);
  });

  it('links to the source in new tabs and back to the hub, and reads nothing', () => {
    renderPage(<DockerBuildingImagesPage />);
    const nav = screen.getByRole('navigation', { name: 'More on Docker' });
    const dockerfile = within(nav).getByRole('link', { name: /the dockerfile on github/i });
    expect(dockerfile).toHaveAttribute('href', SOURCE_LINKS.dockerfile);
    expect(dockerfile).toHaveAttribute('target', '_blank');
    expect(dockerfile).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(nav).getByRole('link', { name: /docker desktop/i })).toHaveAttribute(
      'href',
      '/docker/desktop'
    );
    expect(within(nav).getByRole('link', { name: /back to the docker hub/i })).toHaveAttribute(
      'href',
      '/docker'
    );
    for (const link of screen.getAllByRole('link')) {
      if (link.getAttribute('target') === '_blank') {
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        expect(link).toHaveAccessibleName(/opens in a new tab/);
      }
    }
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the building images guide matches the files it describes', () => {
  const dockerfile = repoFile('lab-image', 'Dockerfile');
  const versions = repoFile('lab-image', 'versions.env');
  const workflow = repoFile('.github', 'workflows', 'publish-lab-image.yml');
  const smoke = repoFile('lab-image', 'smoke.sh');
  const envValue = (name) => versions.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];

  it('has the five stages the page names, with runner and full the two that ship', () => {
    const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)/gim)].map((m) => [
      m[2],
      m[1],
    ]);
    const base = `${envValue('BASE_IMAGE')}@${envValue('BASE_DIGEST')}`;
    expect(stages).toEqual([
      ['fetch', base],
      ['vendor', 'fetch'],
      ['mirror', 'fetch'],
      ['runner', base],
      ['full', 'runner'],
    ]);
    // The tag the page names and inspects is the one pinned, with its CPython
    // release, and the page names no other python tag. Read from versions.env,
    // never written here: the image-base bump moves the page with the pin.
    const page = repoFile('frontend', 'src', 'pages', 'docker', 'BuildingImagesPage.jsx');
    expect(envValue('BASE_IMAGE')).toMatch(/^python:\d+\.\d+\.\d+-slim-trixie$/);
    expect(page).toContain(envValue('BASE_IMAGE'));
    expect(page).toContain(`CPython ${envValue('BASE_PYTHON_VERSION')}`);
    expect([...new Set(page.match(/python:\d+\.\d+\.\d+-[a-z-]+/g))]).toEqual([
      envValue('BASE_IMAGE'),
    ]);
    expect(IMAGE_COMMANDS.inspectBase[0].command).toContain(envValue('BASE_IMAGE'));
    expect(dockerfile).toMatch(/Docker\s+(?:#\s+)?resolves the digest and ignores the tag/);
  });

  it('builds the target and tag the Dockerfile header documents', () => {
    expect(dockerfile).toContain(`docker build --target full   -t ${LOCAL_TAG}        lab-image`);
    // Every download is linux_amd64, which is why the page tells Apple silicon to pass --platform.
    expect(dockerfile).toMatch(/linux_amd64\.zip/);
    expect(dockerfile).not.toMatch(/arm64/);
  });

  it('has the mirror, the user, the working directory and the BuildKit features the page describes', () => {
    expect(dockerfile).toContain('path    = "/opt/terraform/mirror"');
    expect(dockerfile).toContain('terraform providers mirror');
    expect(dockerfile).toContain('HOME=/tmp/home');
    expect(dockerfile).toContain('TMPDIR=/tmp/run');
    expect(dockerfile).toContain('TF_DATA_DIR=/tmp/run/.terraform');
    expect(dockerfile).toContain('RUN --mount=type=bind');
    expect(dockerfile).toContain('COPY --chmod=');
    expect(dockerfile).toContain('--only-binary=:all:');
    expect(dockerfile).toContain('--require-hashes');
    expect(dockerfile).toContain('sha256sum -c');
    expect(dockerfile.match(/^USER 65534:65534$/gm)).toHaveLength(2);
    expect(dockerfile.match(/^WORKDIR \/workspace$/gm)).toHaveLength(2);
    expect(dockerfile).toMatch(/usermod -s \/bin\/bash -d \/tmp\/home nobody/);
    for (const provider of ['azurerm', 'azapi', 'alz', 'random', 'modtm', 'time']) {
      expect(dockerfile, provider).toContain(`terraform-provider-${provider}_`);
    }
  });

  it('has the smoke test’s refusals and the lines the page says it prints', () => {
    expect(smoke).toContain('runner|full');
    expect(smoke).toMatch(/smoke: passed/);
    expect(smoke).toContain("printf 'FAIL: %s\\n'");
  });

  it('publishes and attests the way the page says', () => {
    expect(workflow).toContain(`FULL_IMAGE: ${PUBLISHED_IMAGE}`);
    expect(workflow).toContain('actions/attest-build-provenance@');
    expect(workflow).toContain('push-to-registry: true');
    expect(workflow).toContain('provenance: false');
    // Signed in through Docker's OIDC connection, with nothing stored, and no
    // GitHub packages permission since the move to Docker Hub only.
    expect(workflow).toContain('DOCKERHUB_OIDC_CONNECTIONID: ${{ vars.DOCKERHUB_CONNECTION }}');
    expect(workflow).not.toContain('packages: write');
    // The commit's SHA, or the SHA and the date for a weekly rebuild (#949).
    expect(workflow).toContain('docker push "${FULL_IMAGE}:${TAG}"');
    expect(workflow).toContain('tag="${SHA}-rebuilt-$(date -u +%Y%m%d)"; else tag="${SHA}"; fi');
    expect(workflow).toContain('docker push "${FULL_IMAGE}:latest"');
    expect(workflow).toContain("- cron: '20 5 * * 2'");
    expect(workflow).toContain("no-cache: ${{ github.event_name == 'schedule' }}");
    expect(workflow).toContain(
      "(github.event_name == 'schedule' && needs.build.outputs.rebuild == 'true')"
    );
    expect(workflow).toContain('bash /workspace/smoke.sh full');
    // Exactly one job may sign in to the registry: publish.
    expect(workflow.match(/^\s+DOCKERHUB_OIDC_CONNECTIONID:/gm)).toHaveLength(1);
    expect(SOURCE_LINKS.workflow).toMatch(/\/\.github\/workflows\/publish-lab-image\.yml$/);
  });
});

describe('the Docker Desktop guide (#773)', () => {
  it('lives at /docker/desktop and names itself in its heading and title', () => {
    expect(DESKTOP_PATH).toBe('/docker/desktop');
    renderPage(<DockerDesktopPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'The Docker Desktop app' })
    ).toBeInTheDocument();
    expect(document.title).toBe('The Docker Desktop app | Hybrid Cloud Works');
  });

  it('covers each topic the issue asks for, in order, under its own heading', () => {
    renderPage(<DockerDesktopPage />);
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent.trim())
    ).toEqual([
      'Before you install',
      'Install on Windows',
      'Install on macOS',
      'The dashboard: containers, images and volumes',
      'The settings that matter for the labs',
      'Run the lab image',
      'Desktop and Docker Engine on the lab host',
    ]);
  });

  it('runs the lab image with the labs’ own “Run it locally” lines, not a copy of them', () => {
    renderPage(<DockerDesktopPage />);
    const block = screen.getByTestId('commands-run-locally');
    expect(
      [...block.querySelectorAll('pre code')].map((code) => [code.dataset.shell, code.textContent])
    ).toEqual(RUN_LOCALLY_COMMANDS.map((entry) => [entry.shell, entry.command]));
    expect(DESKTOP_COMMANDS.pull.map((entry) => entry.command)).toEqual([
      `docker pull ${LAB_IMAGE}`,
      `docker pull ${LAB_IMAGE}`,
    ]);
  });

  it('prints every other command exactly, each under its shell, PowerShell first', () => {
    const { container } = renderPage(<DockerDesktopPage />);
    const blocks = commandBlocks(container);
    for (const entry of Object.values(DESKTOP_COMMANDS).flat()) {
      expect(blocks).toContainEqual([entry.shell, entry.command]);
    }
    expectShellOrder(DESKTOP_COMMANDS);
    expect(DESKTOP_COMMANDS.windowsInstall[1].command).toBe(
      "Start-Process \"$HOME\\Downloads\\Docker Desktop Installer.exe\" -Wait -ArgumentList 'install','--user'"
    );
  });

  it('downloads from Docker’s own links, over https', () => {
    for (const url of Object.values(DOWNLOADS)) {
      expect(url).toMatch(/^https:\/\/desktop\.docker\.com\//);
    }
    expect(DESKTOP_COMMANDS.windowsInstall[0].command).toContain(DOWNLOADS.windows);
    expect(DESKTOP_COMMANDS.macDownload.map((entry) => entry.command)).toEqual([
      `curl -fLo Docker.dmg ${DOWNLOADS.macAppleSilicon}`,
      `curl -fLo Docker.dmg ${DOWNLOADS.macIntel}`,
    ]);
  });

  it('states the release and the licence terms it checked, and when', () => {
    renderPage(<DockerDesktopPage />);
    expectCheckedOn(DESKTOP_CHECKED_ON);
    const release = screen.getByTestId('desktop-release');
    expect(release).toHaveTextContent(`Docker Desktop ${CURRENT_RELEASE.version}`);
    expect(release).toHaveTextContent(`Docker Engine ${CURRENT_RELEASE.engine}`);
    expect(release.querySelector('time')).toHaveAttribute('datetime', CURRENT_RELEASE.date.iso);
    // The release cannot postdate the day it was checked.
    expect(CURRENT_RELEASE.date.iso <= DESKTOP_CHECKED_ON.iso).toBe(true);
    const licence = screen.getByTestId('desktop-licence');
    expect(licence).toHaveTextContent(/fewer than 250 employees/);
    expect(licence).toHaveTextContent(/less than \$10 million in annual revenue/);
    expect(licence).toHaveTextContent(/government entity/);
    expect(within(licence).getByRole('link')).toHaveAttribute('href', DOCS.licence);
  });

  it('gives the .wslconfig example in Microsoft’s own form', () => {
    renderPage(<DockerDesktopPage />);
    expect(screen.getByTestId('wslconfig-example').textContent).toBe(WSLCONFIG_EXAMPLE);
    expect(WSLCONFIG_EXAMPLE.split('\n')).toEqual(['[wsl2]', 'memory=4GB', 'processors=2']);
  });

  it('links out in new tabs and back to the hub, and reads nothing', () => {
    renderPage(<DockerDesktopPage />);
    const nav = screen.getByRole('navigation', { name: 'More on Docker' });
    expect(within(nav).getByRole('link', { name: /building the lab image/i })).toHaveAttribute(
      'href',
      '/docker/building-images'
    );
    expect(within(nav).getByRole('link', { name: /back to the docker hub/i })).toHaveAttribute(
      'href',
      '/docker'
    );
    for (const link of screen.getAllByRole('link')) {
      if (link.getAttribute('target') === '_blank') {
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        expect(link).toHaveAccessibleName(/opens in a new tab/);
        expect(link.getAttribute('href')).toMatch(/^https:\/\//);
      }
    }
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the Docker tools page points at both guides', () => {
  it('links to the Desktop guide and the images guide, in the same tab', () => {
    renderPage(<DockerToolsPage />);
    const nav = screen.getByRole('navigation', { name: 'Docker pages you can use now' });
    expect(within(nav).getByRole('link', { name: 'The Docker Desktop app' })).toHaveAttribute(
      'href',
      '/docker/desktop'
    );
    expect(within(nav).getByRole('link', { name: 'Building images' })).toHaveAttribute(
      'href',
      '/docker/building-images'
    );
  });
});
