/**
 * The Landing Zone Builder page (#668, Phase 2 of #657). What must hold: a
 * bare URL renders the full default build with the management groups'
 * teaches text and one tab per emitted file; a `?lz=` URL reproduces a
 * build; ticking a component pulls its dependencies in and unticking one
 * takes its dependents out, with the URL saying so; counts and knobs write
 * their keys; an invalid range is refused in words and never reaches the
 * URL; a moved spoke range is explained in a sentence; the zip holds exactly
 * the files the tabs show; the diagram is a pure function of the build, so
 * two renders are identical and the pre-rendered page hydrates without a
 * mismatch; "Validate on the lab" sits under the files and is closed by
 * default (#672); and the route is wired into the prerender list and the
 * route table.
 */
import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, StaticRouter, useSearchParams } from 'react-router';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';

import LandingZonePage from './LandingZonePage';
import { LzSvg, componentForNode, describeLayout } from './landingZone/LzDiagram';
import { buildZip, languageFor } from './landingZone/LzFiles';
import { listNames, warningText } from './landingZone/LzControls';
import { explanationRequest } from './landingZone/LzExplainButton';
import { LINES as LAB_LINES } from './landingZone/labValidateRules';
import { DEFAULT_STATE, decodeLz, emitFiles, layoutDiagram } from '@/lib/landingZone';
import { staticRoutes } from '@/lib/routeFactory';
import { routes as prerenderRoutes } from '../../../scripts/prerender-entry.jsx';

vi.mock('react-helmet-async', () => ({
  Helmet: ({ children }) => <>{children}</>,
}));

// The explain button (#670) posts through publicApi; the base is only read on a click.
vi.mock('@/lib/functionsBase', () => ({
  requireFunctionsBase: () => 'https://api.test/api',
}));

// "Validate on the lab" (#672) asks whether the lab is open when it mounts.
// Answered here with the default, closed, so the explain tests' fetch counts
// stay about the explain route; LzLabValidate.test.jsx covers the real call.
const labDoor = vi.hoisted(() => ({
  closed: {
    configured: false,
    open: false,
    code: 'PUBLIC_SUBMISSION_CLOSED',
    reason: 'The lab is not taking public jobs yet: public submission is switched off.',
  },
}));
vi.mock('@/lib/publicApi', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchLabSubmissionStatus: vi.fn(async () => labDoor.closed),
}));

// The compressor is a lazy chunk; here it records what it was asked to zip.
const zip = vi.hoisted(() => ({
  zipSync: vi.fn(() => new Uint8Array([80, 75, 5, 6])),
}));
vi.mock('fflate', () => ({
  zipSync: (...args) => zip.zipSync(...args),
  strToU8: (text) => new TextEncoder().encode(text),
}));

const PATH = '/tools/landing-zone';

/** The query string as the router sees it, decoded so `lz=mg,hub` reads as written. */
function SearchProbe() {
  const [params] = useSearchParams();
  return <output data-testid="search">{params.toString()}</output>;
}
const search = () => decodeURIComponent(screen.getByTestId('search').textContent);

function renderPage(url = PATH) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <LandingZonePage />
      <SearchProbe />
    </MemoryRouter>
  );
}

const checkbox = (label) => screen.getByRole('checkbox', { name: label });
const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
const teaches = () => screen.getByTestId('lz-teaches').dataset.component;
const nodeIds = () =>
  Array.from(screen.getByTestId('lz-diagram').querySelectorAll('[data-node]')).map(
    (g) => g.dataset.node
  );

const paramsOf = (url) => new URLSearchParams(url.split('?')[1] ?? '');

beforeEach(() => {
  zip.zipSync.mockClear();
});

describe('LandingZonePage', () => {
  it('renders the full default build from a bare URL', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Landing Zone Builder');

    for (const label of [
      'Management groups',
      'Policy baseline',
      'Management',
      'Connectivity hub',
      'Azure Firewall',
      'Identity',
      'Corp landing zone',
      'Online landing zone',
    ]) {
      expect(checkbox(label).checked, label).toBe(true);
    }

    // The teaches panel opens on the component every other one hangs from.
    expect(teaches()).toBe('management-groups');
    expect(screen.getByTestId('lz-teaches').textContent).toContain(
      'A management group is a container above subscriptions'
    );

    expect(tabNames()).toEqual(emitFiles(DEFAULT_STATE).map((f) => f.path));
    expect(nodeIds()).toEqual(layoutDiagram(DEFAULT_STATE).nodes.map((n) => n.id));
    expect(screen.queryByTestId('lz-warnings')).toBeNull();
    expect(screen.queryByTestId('lz-reset')).toBeNull();
    expect(search()).toBe('');
  });

  it('reproduces a build from its URL', () => {
    const url = `${PATH}?lz=mg,mgmt&corp=0&online=0&loc=westeurope`;
    renderPage(url);
    const state = decodeLz(paramsOf(url));

    expect(checkbox('Management groups').checked).toBe(true);
    expect(checkbox('Management').checked).toBe(true);
    expect(checkbox('Connectivity hub').checked).toBe(false);
    expect(checkbox('Corp landing zone').checked).toBe(false);

    // A knob whose components are all out of the build is disabled and says so.
    const hubCidr = document.getElementById('lz-option-hubCidr');
    expect(hubCidr.disabled).toBe(true);
    expect(hubCidr.closest('[data-option]').textContent).toContain(
      'none of which is in this build'
    );
    expect(document.getElementById('lz-option-location').value).toBe('westeurope');

    expect(tabNames()).toEqual(emitFiles(state).map((f) => f.path));
    expect(nodeIds()).toEqual(layoutDiagram(state).nodes.map((n) => n.id));
    expect(nodeIds()).not.toContain('hub');
    expect(screen.getByTestId('lz-reset')).toBeTruthy();
  });

  it('ticking a dependent component pulls its dependencies, and says so first', () => {
    renderPage(`${PATH}?lz=mg&corp=0&online=0`);
    const firewallRow = screen
      .getByRole('checkbox', { name: 'Azure Firewall' })
      .closest('[data-component]');
    expect(firewallRow.textContent).toContain(
      'Needs Connectivity hub. Ticking it also adds Connectivity hub.'
    );

    fireEvent.click(checkbox('Azure Firewall'));
    expect(checkbox('Azure Firewall').checked).toBe(true);
    expect(checkbox('Connectivity hub').checked).toBe(true);
    expect(search()).toBe('lz=mg,hub,fw&corp=0&online=0');
    // Ticking focuses the component in the teaches panel.
    expect(teaches()).toBe('firewall');
    expect(nodeIds()).toContain('firewall');

    const hubRow = checkbox('Connectivity hub').closest('[data-component]');
    expect(hubRow.textContent).toContain('Unticking it also removes Azure Firewall.');
  });

  it('unticking a component takes its dependents out with it', () => {
    renderPage();
    fireEvent.click(checkbox('Connectivity hub'));
    expect(checkbox('Connectivity hub').checked).toBe(false);
    expect(checkbox('Azure Firewall').checked).toBe(false);
    expect(checkbox('Identity').checked).toBe(false);
    expect(checkbox('Corp landing zone').checked).toBe(false);
    expect(checkbox('Online landing zone').checked).toBe(false);
    expect(search()).toBe('lz=mg,policy,mgmt&corp=0&online=0');
    expect(nodeIds()).not.toContain('hub');
  });

  it('writes counts and knobs to the URL under their keys', () => {
    renderPage();
    fireEvent.change(document.getElementById('lz-count-corp'), { target: { value: '3' } });
    expect(search()).toBe('corp=3');
    expect(nodeIds().filter((id) => id.startsWith('spoke:corp'))).toHaveLength(3);

    fireEvent.change(document.getElementById('lz-count-corp'), { target: { value: '0' } });
    expect(checkbox('Corp landing zone').checked).toBe(false);
    expect(search()).toBe('corp=0');

    fireEvent.change(document.getElementById('lz-option-firewallSku'), {
      target: { value: 'Premium' },
    });
    expect(search()).toBe('fw.sku=Premium&corp=0');

    fireEvent.click(document.getElementById('lz-option-privateDnsZones'));
    expect(search()).toBe('fw.sku=Premium&dns=0&corp=0');
    expect(nodeIds()).not.toContain('dns');

    fireEvent.click(screen.getByTestId('lz-reset'));
    expect(search()).toBe('');
  });

  it('refuses an invalid range in words and keeps it out of the URL', () => {
    renderPage();
    const hub = document.getElementById('lz-option-hubCidr');
    fireEvent.change(hub, { target: { value: '10.0.0' } });
    expect(hub.value).toBe('10.0.0');
    expect(hub.getAttribute('aria-invalid')).toBe('true');
    const knobMessage = () => hub.closest('[data-option]').querySelector('[role="status"]');
    expect(knobMessage().textContent).toContain(
      'Not applied. An address space is an IPv4 range in CIDR form'
    );
    expect(search()).toBe('');

    fireEvent.change(hub, { target: { value: '10.5.0.0/16' } });
    expect(search()).toBe('hub.cidr=10.5.0.0/16');
    expect(knobMessage()).toBeNull();
    expect(nodeIds()).toContain('hub');
    expect(screen.getByTestId('lz-diagram').textContent).toContain('Hub VNet 10.5.0.0/16');

    // Blur discards a half-typed draft and shows the committed value.
    fireEvent.change(hub, { target: { value: '10.5.0.0/' } });
    fireEvent.blur(hub);
    expect(hub.value).toBe('10.5.0.0/16');
  });

  it('explains a spoke range the build moved, whether it came from the URL or was typed', () => {
    renderPage(`${PATH}?hub.cidr=10.1.0.0/16`);
    expect(screen.getByTestId('lz-warnings').textContent).toContain(
      'The spoke range 10.1.0.0/16 overlaps the hub address space, so this build carves its spokes from 10.2.0.0/16 instead.'
    );
    expect(document.getElementById('lz-option-spokeCidr').value).toBe('10.2.0.0/16');
  });

  it('keeps the notice when the typed spoke range is the one that overlapped', () => {
    renderPage();
    const spoke = document.getElementById('lz-option-spokeCidr');
    fireEvent.change(spoke, { target: { value: '10.0.0.0/16' } });
    // The state moved it straight back to the default, so the URL is bare...
    expect(search()).toBe('');
    // ...and the page still says what happened.
    expect(screen.getByTestId('lz-warnings').textContent).toContain(
      'The spoke range 10.0.0.0/16 overlaps the hub address space, so this build carves its spokes from 10.1.0.0/16 instead.'
    );
    fireEvent.blur(spoke);
    expect(spoke.value).toBe('10.1.0.0/16');
  });

  it('shows one tab per emitted file and switches between them', () => {
    renderPage();
    const files = emitFiles(DEFAULT_STATE);
    const panel = screen.getByRole('tabpanel');
    expect(panel.dataset.path).toBe(files[0].path);
    expect(panel.textContent).toContain('hcl');

    const readme = files.find((f) => f.path.endsWith('.md'));
    fireEvent.click(screen.getByRole('tab', { name: readme.path }));
    expect(screen.getByRole('tabpanel').dataset.path).toBe(readme.path);
    expect(screen.getByRole('tabpanel').textContent).toContain('markdown');
    expect(screen.getByRole('tab', { name: readme.path }).getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('zips exactly the files the tabs show', async () => {
    const createObjectURL = vi.fn(() => 'blob:landing-zone');
    const revokeObjectURL = vi.fn();
    const hadCreate = 'createObjectURL' in URL;
    const previous = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      renderPage(`${PATH}?lz=mg,hub,fw&corp=2&online=0`);
      const expected = tabNames();
      fireEvent.click(screen.getByTestId('lz-download'));
      await waitFor(() => expect(zip.zipSync).toHaveBeenCalledTimes(1));

      const [[entries]] = zip.zipSync.mock.calls;
      expect(Object.keys(entries)).toEqual(expected);
      const files = emitFiles(decodeLz(paramsOf(`${PATH}?lz=mg,hub,fw&corp=2&online=0`)));
      for (const file of files) {
        expect(new TextDecoder().decode(entries[file.path])).toBe(file.content);
      }
      expect(click).toHaveBeenCalledTimes(1);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:landing-zone');
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      click.mockRestore();
      if (hadCreate) {
        URL.createObjectURL = previous.create;
        URL.revokeObjectURL = previous.revoke;
      } else {
        delete URL.createObjectURL;
        delete URL.revokeObjectURL;
      }
    }
  });

  it('says so when the zip cannot be built', async () => {
    zip.zipSync.mockImplementationOnce(() => {
      throw new Error('no memory');
    });
    renderPage();
    fireEvent.click(screen.getByTestId('lz-download'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('The zip could not be built');
  });

  it('focuses a component from its box in the diagram', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('lz-diagram').querySelector('[data-node="firewall"]'));
    expect(teaches()).toBe('firewall');
    expect(screen.getByTestId('lz-teaches').textContent).toContain(
      'A block of the connectivity hub’s module call'
    );
    fireEvent.keyDown(
      screen.getByTestId('lz-diagram').querySelector('[data-node="spoke:corp-1"]'),
      {
        key: 'Enter',
      }
    );
    expect(teaches()).toBe('corp');
    expect(screen.getByTestId('lz-teaches').textContent).toContain(
      'Azure/avm-res-network-virtualnetwork/azurerm'
    );
  });

  it('draws nothing and emits only the README for an empty build', () => {
    renderPage(`${PATH}?lz=&corp=0&online=0`);
    expect(screen.getByTestId('lz-diagram-empty')).toBeTruthy();
    expect(screen.queryByTestId('lz-diagram')).toBeNull();
    const files = emitFiles({ selected: [] });
    expect(files).toHaveLength(1);
    expect(tabNames()).toEqual(files.map((f) => f.path));
  });
});

describe('the diagram is deterministic', () => {
  it('renders the same SVG twice for the same build', () => {
    const layout = layoutDiagram(DEFAULT_STATE);
    const once = renderToString(<LzSvg layout={layout} focusedId="management-groups" />);
    const twice = renderToString(<LzSvg layout={layout} focusedId="management-groups" />);
    expect(once).toBe(twice);
    expect(once).toContain('<title id="lz-diagram-title">');
    expect(once).toContain('data-node="hub"');
  });

  it('renders the same page twice, and hydrates the server markup without a mismatch', async () => {
    const page = () => (
      <StaticRouter location={PATH}>
        <LandingZonePage />
      </StaticRouter>
    );
    const ssr = renderToString(page());
    expect(renderToString(page())).toBe(ssr);
    expect(ssr).toContain('A management group is a container above subscriptions');

    const container = document.createElement('div');
    container.innerHTML = ssr;
    document.body.appendChild(container);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let root;
    try {
      await act(async () => {
        root = hydrateRoot(
          container,
          <MemoryRouter initialEntries={[PATH]}>
            <LandingZonePage />
          </MemoryRouter>
        );
      });
      const complaints = errors.mock.calls.map((call) => String(call[0]));
      expect(complaints.filter((m) => /hydrat|did not match|server/i.test(m))).toEqual([]);
    } finally {
      errors.mockRestore();
      await act(async () => root?.unmount());
      container.remove();
    }
  });

  it('maps every node kind to the component it teaches', () => {
    const layout = layoutDiagram(DEFAULT_STATE);
    for (const node of layout.nodes) {
      expect(componentForNode(node.id), node.id).not.toBeNull();
    }
    expect(componentForNode('mg:corp')).toBe('management-groups');
    expect(componentForNode('spoke:online-2')).toBe('online');
    expect(componentForNode('something-else')).toBeNull();
    expect(describeLayout(layout)).toMatch(/^Landing zone diagram: \d+ management groups, /);
  });
});

describe('helpers', () => {
  it('lists names the way a sentence does', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A and B');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
  });

  it('has a sentence for every warning code, and a fallback for an unknown one', () => {
    expect(warningText({ code: 'spoke-cidr-overlap', from: 'a', to: 'b' })).toContain(
      'The spoke range a overlaps the hub address space'
    );
    expect(warningText({ code: 'later' })).toBe('The build was adjusted (later).');
  });

  it('highlights Markdown for the README and HCL for everything else', () => {
    expect(languageFor('README.md')).toBe('markdown');
    expect(languageFor('main.tf')).toBe('hcl');
    expect(languageFor('terraform.tfvars.example')).toBe('hcl');
  });

  it('builds the zip from the emitted files under their own paths', async () => {
    const files = emitFiles(DEFAULT_STATE);
    await buildZip(files);
    const [[entries, options]] = zip.zipSync.mock.calls;
    expect(Object.keys(entries)).toEqual(files.map((f) => f.path));
    expect(options).toEqual({ level: 6 });
  });
});

describe('the explain button (#670)', () => {
  it('sits in the teaches panel, follows the focus, and sends the build only on a click', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        explanation: {
          text: 'Two paragraphs.',
          model: 'claude-sonnet-4-5',
          generatedAt: '2026-09-25T10:30:00.000Z',
          cached: false,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const url = `${PATH}?lz=mg,hub,fw&corp=0&online=0`;
      renderPage(url);
      const button = () => screen.getByTestId('lz-explain-button');
      expect(screen.getByTestId('lz-teaches').contains(button())).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();

      // Focus the firewall from the diagram; the button now asks about it.
      fireEvent.click(screen.getByTestId('lz-diagram').querySelector('[data-node="firewall"]'));
      expect(teaches()).toBe('firewall');
      fireEvent.click(button());
      await screen.findByTestId('lz-explanation');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [[target, init]] = fetchMock.mock.calls;
      expect(String(target)).toBe('https://api.test/api/public/cloud-tools/explain');
      expect(JSON.parse(init.body)).toEqual(
        explanationRequest({ state: decodeLz(paramsOf(url)), componentId: 'firewall' })
      );
      expect(JSON.parse(init.body)).toMatchObject({
        kind: 'landing-zone',
        componentId: 'firewall',
        selected: ['management-groups', 'connectivity-hub', 'firewall'],
      });

      // Changing the build drops the answer and asks nothing new on its own.
      fireEvent.click(checkbox('Azure Firewall'));
      await waitFor(() => expect(screen.queryByTestId('lz-explanation')).toBeNull());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is on the pre-rendered page without an answer', () => {
    const ssr = renderToString(
      <StaticRouter location={PATH}>
        <LandingZonePage />
      </StaticRouter>
    );
    expect(ssr).toContain('Explain this component');
    expect(ssr).not.toContain('data-testid="lz-explanation"');
  });
});

describe('validate on the lab (#672)', () => {
  it('sits under the files, closed by default in the visitor’s words, and sends nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderPage();
      const button = screen.getByTestId('lz-lab-validate');
      expect(screen.getByTestId('lz-files').contains(button)).toBe(true);
      await waitFor(() =>
        expect(screen.getByTestId('lz-lab-line').textContent).toBe(LAB_LINES.unavailable)
      );
      expect(screen.getByTestId('lz-lab-line').textContent).not.toContain('switched off');
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is on the pre-rendered page as the checking line, not a spinner', () => {
    const ssr = renderToString(
      <StaticRouter location={PATH}>
        <LandingZonePage />
      </StaticRouter>
    );
    expect(ssr).toContain('Validate on the lab');
    expect(ssr).toContain(LAB_LINES.checking);
  });
});

describe('wiring', () => {
  it('is a static route, pre-rendered, under the path the page names as canonical', () => {
    expect(staticRoutes.landingZone).toBe(PATH);
    expect(prerenderRoutes()).toContain(PATH);
    const ssr = renderToString(
      <StaticRouter location={PATH}>
        <LandingZonePage />
      </StaticRouter>
    );
    expect(ssr).toContain('href="https://hybridcloudworks.com/tools/landing-zone"');
    expect(ssr).toContain('<title>Landing Zone Builder | Hybrid Cloud Works</title>');
  });
});

describe('Engineering Workbench presets and FinOps features', () => {
  it('renders telemetry strip with standing floor, emitted file count, and peered spokes', () => {
    renderPage();
    const strip = screen.getByTestId('lz-telemetry-strip');
    expect(strip.textContent).toContain('$1151/mo');
    expect(strip.textContent).toContain('files');
    expect(strip.textContent).toContain('3');
  });

  it('renders 1-click architecture preset bar with all 5 presets', () => {
    renderPage();
    const presetBar = screen.getByTestId('lz-preset-bar');
    expect(presetBar.querySelectorAll('button')).toHaveLength(5);
    expect(presetBar.textContent).toContain('Full Enterprise ALZ');
    expect(presetBar.textContent).toContain('Cost-Aware Secure Hub (Basic FW)');
    expect(presetBar.textContent).toContain('FinOps Lean Governance');
  });

  it('displays Blueprint Context Banner when build matches canonical preset', () => {
    renderPage();
    const banner = screen.getByTestId('lz-preset-banner');
    expect(banner.textContent).toContain('Validated Pattern');
    expect(banner.textContent).toContain('Enterprise Hub-and-Spoke Landing Zone');
    expect(banner.querySelector('a').getAttribute('href')).toBe(
      '/azure/architecture-designs/enterprise-hub-spoke-landing-zone'
    );
  });

  it('switches preset on button click and updates URL and FinOps BOM', () => {
    renderPage();
    const secureBasicBtn = screen.getByRole('button', { name: /Cost-Aware Secure Hub/i });
    fireEvent.click(secureBasicBtn);

    expect(checkbox('Azure Firewall').checked).toBe(true);
    expect(document.getElementById('lz-option-firewallSku').value).toBe('Basic');
    const bom = screen.getByTestId('lz-finops-bom');
    expect(bom.textContent).toContain('Azure Firewall (Basic SKU)');
  });
});

describe('Multi-Cloud Target Cloud Selector and Architecture Previews (#Phase4)', () => {
  it('renders target cloud switcher with Azure active and AWS/GCP preview pills', () => {
    renderPage();
    const switcher = screen.getByTestId('lz-cloud-switcher');
    expect(switcher).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Azure \(Active\)/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /AWS \(Preview\)/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: /Google Cloud \(Preview\)/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('switches to AWS preview on click and displays 8-component mapping and pinned modules', () => {
    renderPage();
    const awsBtn = screen.getByRole('button', { name: /AWS \(Preview\)/i });
    fireEvent.click(awsBtn);

    const preview = screen.getByTestId('lz-cloud-preview');
    expect(preview).toBeInTheDocument();
    expect(preview.textContent).toContain('Amazon Web Services Landing Zone Architecture');
    expect(preview.textContent).toContain('Universal 8-Component Architecture (AWS)');
    expect(preview.textContent).toContain('AWS Organizations Root + OUs');
    expect(preview.textContent).toContain('Service Control Policies (SCPs)');
    expect(preview.textContent).toContain('terraform-aws-modules/transit-gateway/aws');

    const blueprintLink = preview.querySelector('a');
    expect(blueprintLink.getAttribute('href')).toBe(
      '/aws/architecture-designs/global-load-balancing'
    );

    // Return to Azure workbench
    const [returnBtn] = screen.getAllByRole('button', { name: /Return to Azure Workbench/i });
    fireEvent.click(returnBtn);
    expect(screen.queryByTestId('lz-cloud-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('lz-preset-bar')).toBeInTheDocument();
  });

  it('switches to Google Cloud preview on click and displays Shared VPC architecture mapping', () => {
    renderPage();
    const gcpBtn = screen.getByRole('button', { name: /Google Cloud \(Preview\)/i });
    fireEvent.click(gcpBtn);

    const preview = screen.getByTestId('lz-cloud-preview');
    expect(preview).toBeInTheDocument();
    expect(preview.textContent).toContain('Google Cloud Platform Landing Zone Architecture');
    expect(preview.textContent).toContain('Universal 8-Component Architecture (Google Cloud)');
    expect(preview.textContent).toContain('Cloud Resource Manager Folders');
    expect(preview.textContent).toContain('Shared VPC Host Project');
    expect(preview.textContent).toContain('terraform-google-modules/network/google');

    const blueprintLink = preview.querySelector('a');
    expect(blueprintLink.getAttribute('href')).toBe(
      '/gcp/architecture-designs/global-load-balancing'
    );
  });
});
