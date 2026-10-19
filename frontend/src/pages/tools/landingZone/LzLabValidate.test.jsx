/**
 * "Validate on the lab" (#672). What must hold: the button is disabled with
 * one line, and no spinner, until the server says the lab is open, which by
 * default it does not (public submission switched off); a lab with no agent
 * or an unreadable status reads the same way, and a full queue says to try
 * again shortly; a build calling a module the lab does not have is refused
 * here with the module named; when open, one click sends the build's files
 * unchanged and polls the job to its output; a refusal naming the door shuts
 * the button; a changed build drops the output; and the pre-rendered markup
 * is the "checking" line, which hydration adopts.
 *
 * VISITOR WORDS ONLY (owner direction 2026-09-28). Every line is the page's
 * own, picked by the server's code. The fixtures below give the server's
 * `reason` and `error` the words the owner found on the live page — a
 * vendor, a setting, "not configured" — and the tests hold that none of it
 * is rendered, and that no code reaches the DOM either.
 *
 * Locked to this pane (ADR 0032 decision 6, revised 2026-09-28): the
 * Turnstile widget loads only once the lab is open and the build has a site
 * key, the button waits for its token, each submission carries one token and
 * asks for the next, and the lock's refusals read in the page's words.
 *
 * A REPORT, NOT THE JOB LOG (owner request 2026-09-28). A finished job shows
 * the visitor report, and the fixtures here are what the server's own
 * builder (functions/src/lib/labs/visitor-report.js) makes of the owner's
 * real job logs, which each job also carries as `output`, as a server from
 * before the report would. The tests hold that the verdict, Terraform's
 * errors, the modules and the providers are shown, and that nothing of the
 * log is: no image, registry, digest, runner path or host.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

import { LzLabValidate } from './LzLabValidate';
import {
  DOOR_CODES,
  LINES,
  LOCAL_CODES,
  REFUSAL_LINES,
  afterPoll,
  disabledReason,
  doorFromRefusal,
  doorFromStatus,
  doorTag,
  failureLine,
  localError,
  outcomeLine,
  preparePayload,
  statusLine,
  tooLargeLine,
  unresolvedLine,
  visitorReport,
} from './labValidateRules';
import {
  AVM_MODULES,
  DEFAULT_STATE,
  LAB_IMAGE_AVM,
  chooseVendored,
  decodeLz,
  emitFiles,
  parseVersion,
  vendoredModules,
} from '@/lib/landingZone';
import { decodeTarPayload, parseTar } from '../../../../../vps-agent/lib/docker-runner.js';
import { buildVisitorReport } from '../../../../../functions/src/lib/labs/visitor-report.js';
import { clearPublicGetCache } from '@/lib/publicApi';

vi.mock('@/lib/functionsBase', () => ({
  requireFunctionsBase: () => 'https://api.test/api',
}));

/** What a server message must never put on the page. */
const BACKEND_WORDS = /cloudflare|turnstile|not configured|agent|switched off|queue ceiling|owner/i;

const CLOSED = {
  configured: false,
  open: false,
  code: 'PUBLIC_SUBMISSION_CLOSED',
  reason: 'The lab is not taking public jobs yet: public submission is switched off.',
};
const OFFLINE = {
  configured: true,
  open: false,
  code: 'LAB_AGENT_OFFLINE',
  reason: 'The lab is not taking jobs yet: no lab agent is online to run them.',
};
const FULL = {
  configured: true,
  open: false,
  code: 'LAB_QUEUE_FULL',
  reason: "The lab's queue is full (queue ceiling 20).",
};
const OPEN = { configured: true, open: true, code: null, reason: null, queued: 0 };

/** A small build the lab can initialise: the platform with no landing zone. */
const NO_SPOKES = emitFiles(
  decodeLz(new URLSearchParams('lz=mg,policy,mgmt,hub,fw&corp=0&online=0'))
);
const DEFAULT_FILES = emitFiles(DEFAULT_STATE);

const refusal = (status, code, message) => Object.assign(new Error(message), { status, code });

function requestsFor({ door = OPEN, submit, jobs = [] } = {}) {
  const queue = [...jobs];
  return {
    status: vi.fn(async () => door),
    submit:
      submit ??
      vi.fn(async () => ({
        ok: true,
        jobId: 'job-1',
        type: 'terraform-validate',
        status: 'queued',
      })),
    job: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])),
  };
}

/**
 * Cloudflare's `turnstile` API, faked. A widget solves on render and again
 * on every reset, issuing turnstile-token-1, -2, … unless `solve` is false,
 * when the test drives the callbacks itself.
 */
function fakeTurnstile({ siteKey = 'site-key-test', solve = true, loadFails = false } = {}) {
  let issued = 0;
  const widgets = new Map();
  const nextToken = () => `turnstile-token-${(issued += 1)}`;
  const api = {
    render: vi.fn((element, options) => {
      const id = `widget-${widgets.size + 1}`;
      widgets.set(id, options);
      if (solve) options.callback(nextToken());
      return id;
    }),
    reset: vi.fn((id) => {
      if (solve) widgets.get(id)?.callback(nextToken());
    }),
    remove: vi.fn((id) => widgets.delete(id)),
  };
  const load = vi.fn(async () => (loadFails ? Promise.reject(new Error('blocked')) : api));
  return { siteKey, load, api, options: () => [...widgets.values()][0] };
}

const renderControl = ({ turnstile = fakeTurnstile(), ...props } = {}) =>
  render(<LzLabValidate files={NO_SPOKES} pollDelay={() => 0} turnstile={turnstile} {...props} />);

const button = () => screen.getByTestId('lz-lab-validate');
const line = () => screen.getByTestId('lz-lab-line');
const control = () => screen.getByTestId('lz-lab');
const hasSpinner = () => Boolean(control().querySelector('.animate-spin'));

/** The control's whole DOM, text and attributes, holds no backend word and no server code. */
function expectNoBackendWords() {
  const html = control().outerHTML;
  expect(html).not.toMatch(BACKEND_WORDS);
  for (const code of DOOR_CODES) expect(html).not.toContain(code);
}

/** What the job log carries and a visitor must never read. */
const RUNNER_WORDS =
  /ghcr\.io|sha256:|docker|pulling|\/opt\/|\.\.\/\.\.\/\.\.\/|hcw-lab-runner|\bimage\b|registry|unauthenticated|hostinger|\bvps\b|Status: Downloaded|Digest:/i;

function expectNoRunnerWords() {
  expect(control().outerHTML).not.toMatch(RUNNER_WORDS);
}

/** The owner's real job logs (functions/src/lib/labs/fixtures). */
const LOGS = join(process.cwd(), '..', 'functions', 'src', 'lib', 'labs', 'fixtures');
const jobLog = (name) => readFileSync(join(LOGS, name), 'utf8');

/** A finished job as the server answers it: its report, and the raw log a server should not send. */
function finishedJob(status, exitCode, logName) {
  const output = jobLog(logName);
  return {
    id: 'job-1',
    status,
    exitCode,
    output,
    report: buildVisitorReport({ status, exitCode, output }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearPublicGetCache();
});

describe('closed until the server says open', () => {
  it('starts disabled on the checking line, with no spinner', () => {
    renderControl({ requests: { ...requestsFor(), status: vi.fn(() => new Promise(() => {})) } });
    expect(button()).toBeDisabled();
    expect(line().textContent).toBe(LINES.checking);
    expect(hasSpinner()).toBe(false);
  });

  it('says validation is unavailable when switched off, points at the download, and sends nothing', async () => {
    const requests = requestsFor({ door: CLOSED });
    renderControl({ requests });
    await waitFor(() => expect(line().textContent).toBe(LINES.unavailable));
    expect(line().textContent).toContain('download the files and validate locally');
    expect(line().dataset.door).toBe('closed');
    expect(button()).toBeDisabled();
    expect(hasSpinner()).toBe(false);
    expectNoBackendWords();
    fireEvent.click(button());
    expect(requests.submit).not.toHaveBeenCalled();
  });

  it('says the same, not the server’s words, when no runner is online', async () => {
    renderControl({ requests: requestsFor({ door: OFFLINE }) });
    await waitFor(() => expect(line().textContent).toBe(LINES.unavailable));
    expect(button()).toBeDisabled();
    expectNoBackendWords();
  });

  it('says the lab is busy, to try again shortly, when the queue is full', async () => {
    renderControl({ requests: requestsFor({ door: FULL }) });
    await waitFor(() => expect(line().textContent).toBe(LINES.busy));
    expect(line().dataset.door).toBe('busy');
    expect(button()).toBeDisabled();
    expectNoBackendWords();
  });

  it('stays closed, and says unavailable, when the status cannot be read', async () => {
    renderControl({
      requests: {
        ...requestsFor(),
        status: vi.fn(async () => Promise.reject(new Error('offline'))),
      },
    });
    await waitFor(() => expect(line().textContent).toBe(LINES.unavailable));
    expect(line().dataset.door).toBe('unreadable');
    expect(button()).toBeDisabled();
  });

  it('asks the real route on mount, and only asks', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => CLOSED }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LzLabValidate files={NO_SPOKES} />);
    await waitFor(() => expect(line().textContent).toBe(LINES.unavailable));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetchMock.mock.calls;
    expect(String(url)).toBe('https://api.test/api/public/labs/submit');
    expect(init.method).toBeUndefined();
  });

  it('is on the pre-rendered page as the checking line', () => {
    const html = renderToString(<LzLabValidate files={NO_SPOKES} requests={requestsFor()} />);
    expect(html).toContain(LINES.checking);
    expect(html).toContain('Validate on the lab');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('animate-spin');
    expect(html).not.toMatch(BACKEND_WORDS);
  });
});

// The spoke module's pin and what the lab carries of it are read from
// avmVersions.js and LAB_IMAGE_AVM, not written here, so the weekly bump
// moves these expectations with the pins (#1287).
const SPOKE = 'avm-res-network-virtualnetwork';
const SPOKE_PIN = AVM_MODULES[SPOKE].version;
const ALZ_PIN = AVM_MODULES['avm-ptn-alz'].version;
/** Every version of the spoke module the lab has, in the order the pane lists them. */
const SPOKE_CARRIED = vendoredModules(LAB_IMAGE_AVM)[SPOKE].map((c) => c.text);
/** A release the lab does not carry: one patch above the highest it has. */
const SPOKE_ABSENT = (() => {
  const [major, minor, patch] = parseVersion(
    chooseVendored(vendoredModules(LAB_IMAGE_AVM), SPOKE, '')
  );
  return `${major}.${minor}.${patch + 1}`;
})();

/** One spoke pinned to a release the lab does not carry. */
const UNVENDORED = [
  {
    path: 'main.tf',
    content: `module "spoke" {\n  source  = "Azure/${SPOKE}/azurerm"\n  version = "${SPOKE_ABSENT}"\n}\n`,
  },
];

describe('what the lab can resolve', () => {
  // The builder's full default build: every component, the identity, corp
  // and online spokes among them. Until the image vendored the spokes'
  // avm-res-network-virtualnetwork at the builder's pin (0.22.2 on
  // 2026-09-27), this was refused.
  it('accepts the full default build, spokes included, and sends it on a click', async () => {
    const requests = requestsFor({
      jobs: [{ id: 'job-1', status: 'succeeded', exitCode: 0, output: 'Success!' }],
    });
    renderControl({ files: DEFAULT_FILES, requests });
    await waitFor(() => expect(button()).toBeEnabled());
    expect(line().textContent).toBe(LINES.ready);

    fireEvent.click(button());
    await screen.findByTestId('lz-lab-output');
    // Sent, so under the 64 KB payload cap as well as fully vendored.
    expect(requests.submit).toHaveBeenCalledTimes(1);
    const [[sent]] = requests.submit.mock.calls;
    const unpacked = parseTar(decodeTarPayload(sent.payload)).map((e) => e.path);
    expect(unpacked).toEqual(DEFAULT_FILES.map((f) => f.path));
  });

  it('still refuses a build calling a version the lab does not have, naming it', async () => {
    const requests = requestsFor();
    renderControl({ files: UNVENDORED, requests });
    await waitFor(() => expect(line().textContent).toContain(`${SPOKE} ${SPOKE_ABSENT}`));
    expect(line().textContent).toBe(unresolvedLine([{ module: SPOKE, constraint: SPOKE_ABSENT }]));
    expect(button()).toBeDisabled();
    expect(requests.submit).not.toHaveBeenCalled();
  });

  it('lists what the lab does with each module', async () => {
    render(<LzLabValidate files={DEFAULT_FILES} requests={requestsFor()} />);
    const rows = screen.getByTestId('lz-lab-modules').querySelectorAll('li');
    const text = Array.from(rows).map((li) => [li.dataset.vendored, li.textContent]);
    expect(text).toContainEqual([
      'true',
      `module "alz" (Azure/avm-ptn-alz/azurerm ${ALZ_PIN}) → the lab's copy, avm-ptn-alz@${ALZ_PIN}`,
    ]);
    expect(text).toContainEqual([
      'true',
      `module "spoke_identity" (Azure/${SPOKE}/azurerm ${SPOKE_PIN}) → the lab's copy, ${SPOKE}@${SPOKE_PIN}`,
    ]);
    expect(text.every(([vendored]) => vendored === 'true')).toBe(true);
  });

  it('names what the lab has for a module it cannot resolve', async () => {
    render(<LzLabValidate files={UNVENDORED} requests={requestsFor()} />);
    const rows = screen.getByTestId('lz-lab-modules').querySelectorAll('li');
    expect(SPOKE_CARRIED).toContain(SPOKE_PIN);
    expect(Array.from(rows).map((li) => [li.dataset.vendored, li.textContent])).toEqual([
      [
        'false',
        `module "spoke" (Azure/${SPOKE}/azurerm ${SPOKE_ABSENT}) → not on the lab (it has ${SPOKE_CARRIED.join(', ')})`,
      ],
    ]);
  });

  it('refuses an empty build with its own line', async () => {
    renderControl({ files: emitFiles({ selected: [] }), requests: requestsFor() });
    await waitFor(() => expect(line().textContent).toBe(LINES.empty));
    expect(screen.queryByTestId('lz-lab-modules')).toBeNull();
  });
});

describe('when the lab is open', () => {
  it('sends the files unchanged on a click, polls the job and shows the report', async () => {
    const done = finishedJob('succeeded', 0, 'validate-valid.log');
    const requests = requestsFor({
      jobs: [{ id: 'job-1', status: 'queued' }, { id: 'job-1', status: 'running' }, done],
    });
    renderControl({ requests });
    await waitFor(() => expect(button()).toBeEnabled());
    expect(line().textContent).toBe(LINES.ready);
    expect(requests.submit).not.toHaveBeenCalled();

    fireEvent.click(button());
    const output = await screen.findByTestId('lz-lab-output');
    expect(output.dataset.status).toBe('succeeded');
    expect(output.dataset.verdict).toBe('valid');
    expect(screen.getByTestId('lz-lab-verdict').textContent).toBe(done.report.headline);
    const modules = screen.getByTestId('lz-lab-report-modules');
    expect([...modules.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'avm-ptn-alz@0.21.0',
      'avm-res-network-virtualnetwork@0.22.2',
      'avm-ptn-alz-connectivity-hub-and-spoke-vnet@0.17.5',
      'avm-ptn-alz-management@0.9.0',
    ]);
    expect(modules.textContent).toContain(done.report.modulesNote);
    const providers = screen.getByTestId('lz-lab-report-providers');
    expect([...providers.querySelectorAll('li')].map((li) => li.textContent)).toContain(
      'hashicorp/azurerm v4.81.0'
    );
    expect(screen.queryByTestId('lz-lab-report-errors')).toBeNull();
    expectNoRunnerWords();

    expect(requests.submit).toHaveBeenCalledTimes(1);
    const [[sent]] = requests.submit.mock.calls;
    expect(sent.type).toBe('terraform-validate');
    expect(sent.payloadEncoding).toBe('tar');
    expect(sent.turnstileToken).toBe('turnstile-token-1');
    const unpacked = parseTar(decodeTarPayload(sent.payload)).map((e) => ({
      path: e.path,
      content: new TextDecoder().decode(e.data),
    }));
    expect(unpacked).toEqual(NO_SPOKES.map(({ path, content }) => ({ path, content })));
    expect(requests.job).toHaveBeenCalledWith('job-1');
    expect(requests.job).toHaveBeenCalledTimes(3);
    expect(button()).toBeEnabled();
  });

  it('shows Terraform’s errors with the learner’s file and line, and none of the log', async () => {
    const done = finishedJob('failed', 1, 'validate-invalid.log');
    renderControl({ requests: requestsFor({ jobs: [done] }) });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    const output = await screen.findByTestId('lz-lab-output');
    expect(output.dataset.status).toBe('failed');
    expect(output.dataset.verdict).toBe('invalid');
    expect(screen.getByTestId('lz-lab-verdict').textContent).toBe(done.report.headline);
    const errors = [...screen.getByTestId('lz-lab-report-errors').querySelectorAll('pre')];
    expect(errors.map((pre) => pre.textContent)).toEqual(done.report.errors);
    expect(errors[0].textContent).toContain('on alz.tf line 14, in module "alz":');
    expect(errors[2].textContent).toContain('on avm-ptn-alz-management@0.9.0/main.tf line 40');
    expectNoRunnerWords();
  });

  it('says the lab could not run the check when it failed before Terraform, showing nothing of the log', async () => {
    const done = finishedJob('failed', 125, 'validate-not-run.log');
    renderControl({ requests: requestsFor({ jobs: [done] }) });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    const output = await screen.findByTestId('lz-lab-output');
    expect(output.dataset.verdict).toBe('error');
    expect(output.textContent).toBe(done.report.headline);
    expectNoRunnerWords();
  });

  it('never renders a raw output field, even when a job carries one and no report', async () => {
    const logOnly = {
      id: 'job-1',
      status: 'succeeded',
      exitCode: 0,
      output: jobLog('validate-valid.log'),
    };
    renderControl({ requests: requestsFor({ jobs: [logOnly] }) });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    const output = await screen.findByTestId('lz-lab-output');
    expect(output.dataset.verdict).toBe('none');
    expect(output.textContent).toBe(outcomeLine(logOnly));
    expect(output.textContent).not.toContain('Success!');
    expectNoRunnerWords();
  });

  it('shows the per-visitor limit in the page’s words and sends no second request', async () => {
    const requests = requestsFor({
      submit: vi.fn(async () =>
        Promise.reject(
          refusal(429, 'LAB_RATE_LIMITED', 'per-client counter lab-caller:abc exhausted')
        )
      ),
    });
    renderControl({ requests });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    const alert = await screen.findByTestId('lz-lab-error');
    expect(alert.textContent).toBe(REFUSAL_LINES.LAB_RATE_LIMITED);
    expect(alert.textContent).toContain('Try again in about an hour');
    expect(alert.dataset.status).toBe('429');
    expect(requests.job).not.toHaveBeenCalled();
  });

  it('shuts the button when a refusal names the door', async () => {
    const requests = requestsFor({
      submit: vi.fn(async () => Promise.reject(refusal(503, 'LAB_AGENT_OFFLINE', OFFLINE.reason))),
    });
    renderControl({ requests });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    const alert = await screen.findByTestId('lz-lab-error');
    expect(alert.textContent).toBe(LINES.unavailable);
    expect(line().textContent).toBe(LINES.unavailable);
    expect(button()).toBeDisabled();
    expectNoBackendWords();
  });

  it('stops asking at the deadline and says the job may still run', async () => {
    let clock = 0;
    const requests = requestsFor({ jobs: [{ id: 'job-1', status: 'queued' }] });
    requests.job.mockImplementation(async () => {
      clock += 60_000;
      return { id: 'job-1', status: 'queued' };
    });
    renderControl({ requests, now: () => clock, deadlineMs: 120_000 });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    const stalled = await screen.findByTestId('lz-lab-stalled');
    expect(stalled.textContent).toBe(LINES.stalled);
    expect(requests.job).toHaveBeenCalledTimes(2);
  });

  it('drops the report when the build changes', async () => {
    const requests = requestsFor({ jobs: [finishedJob('succeeded', 0, 'validate-valid.log')] });
    const turnstile = fakeTurnstile();
    const { rerender } = renderControl({ requests, turnstile });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    await screen.findByTestId('lz-lab-output');
    const fewer = emitFiles(decodeLz(new URLSearchParams('lz=mg&corp=0&online=0')));
    rerender(
      <LzLabValidate files={fewer} requests={requests} pollDelay={() => 0} turnstile={turnstile} />
    );
    expect(screen.queryByTestId('lz-lab-output')).toBeNull();
  });
});

describe('locked to this pane: the browser check', () => {
  const TURNSTILE_UNCONFIGURED = {
    configured: false,
    open: false,
    code: 'TURNSTILE_NOT_CONFIGURED',
    reason:
      'The lab is not taking public jobs yet: its browser check (Cloudflare Turnstile) is not configured.',
  };

  it('loads nothing from Cloudflare while the lab is closed', async () => {
    const turnstile = fakeTurnstile();
    renderControl({ requests: requestsFor({ door: CLOSED }), turnstile });
    await waitFor(() => expect(line().textContent).toBe(LINES.unavailable));
    expect(turnstile.load).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lz-lab-check')).toBeNull();
  });

  it('with no browser-check secret on the server, says only that validation is unavailable, and loads nothing', async () => {
    const turnstile = fakeTurnstile();
    renderControl({ requests: requestsFor({ door: TURNSTILE_UNCONFIGURED }), turnstile });
    await waitFor(() => expect(line().textContent).toBe(LINES.unavailable));
    expect(line().dataset.door).toBe('closed');
    expect(button()).toBeDisabled();
    expect(turnstile.load).not.toHaveBeenCalled();
    expectNoBackendWords();
  });

  it('keeps the button disabled on a build with no site key, and says validation is unavailable', async () => {
    const turnstile = fakeTurnstile({ siteKey: '' });
    const requests = requestsFor();
    renderControl({ requests, turnstile });
    await waitFor(() => expect(line().textContent).toBe(LINES.unavailable));
    expect(button()).toBeDisabled();
    expect(turnstile.load).not.toHaveBeenCalled();
    expectNoBackendWords();
    fireEvent.click(button());
    expect(requests.submit).not.toHaveBeenCalled();
  });

  it('renders the widget once the lab is open, for the lab-validate action, seen only when needed', async () => {
    const turnstile = fakeTurnstile();
    renderControl({ requests: requestsFor(), turnstile });
    await waitFor(() => expect(button()).toBeEnabled());
    expect(turnstile.load).toHaveBeenCalledTimes(1);
    expect(turnstile.api.render).toHaveBeenCalledTimes(1);
    const [[element, options]] = turnstile.api.render.mock.calls;
    expect(element).toBe(screen.getByTestId('lz-lab-check'));
    expect(options).toMatchObject({
      sitekey: 'site-key-test',
      action: 'lab-validate',
      appearance: 'interaction-only',
    });
  });

  it('waits for the token before the button can be pressed', async () => {
    const turnstile = fakeTurnstile({ solve: false });
    renderControl({ requests: requestsFor(), turnstile });
    // The line reads "checking" from the moment the door opens, before the
    // script has loaded, so wait for the widget itself before solving it.
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalledTimes(1));
    expect(line().textContent).toBe(LINES.browserCheck);
    expect(button()).toBeDisabled();
    expect(hasSpinner()).toBe(false);
    act(() => turnstile.options().callback('token-late'));
    await waitFor(() => expect(button()).toBeEnabled());
    expect(line().textContent).toBe(LINES.ready);
  });

  it('says when the check wants the visitor, and when it failed, without naming its vendor', async () => {
    const turnstile = fakeTurnstile({ solve: false });
    renderControl({ requests: requestsFor(), turnstile });
    await waitFor(() => expect(turnstile.api.render).toHaveBeenCalled());
    act(() => turnstile.options()['before-interactive-callback']());
    expect(line().textContent).toBe(LINES.browserInteractive);
    act(() => turnstile.options()['error-callback']('300010'));
    expect(line().textContent).toBe(LINES.browserError);
    expect(button()).toBeDisabled();
    expectNoBackendWords();
  });

  it('says the check could not run when its script does not load', async () => {
    renderControl({ requests: requestsFor(), turnstile: fakeTurnstile({ loadFails: true }) });
    await waitFor(() => expect(line().textContent).toBe(LINES.browserError));
    expect(button()).toBeDisabled();
  });

  it('spends one token per submission and asks for the next', async () => {
    const turnstile = fakeTurnstile();
    const requests = requestsFor({
      jobs: [{ id: 'job-1', status: 'succeeded', exitCode: 0, output: 'ok' }],
    });
    renderControl({ requests, turnstile });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    await screen.findByTestId('lz-lab-output');
    expect(turnstile.api.reset).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    await waitFor(() => expect(requests.submit).toHaveBeenCalledTimes(2));
    const tokens = requests.submit.mock.calls.map(([sent]) => sent.turnstileToken);
    expect(tokens).toEqual(['turnstile-token-1', 'turnstile-token-2']);
  });

  it('shows the lock’s refusal in the page’s words and renews the check', async () => {
    const message =
      "Cloudflare's browser check did not pass, or its token had expired or was already used, so the lab did not take the job. Try again.";
    const turnstile = fakeTurnstile();
    const requests = requestsFor({
      submit: vi.fn(async () => Promise.reject(refusal(403, 'TURNSTILE_FAILED', message))),
    });
    renderControl({ requests, turnstile });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    const alert = await screen.findByTestId('lz-lab-error');
    expect(alert.textContent).toBe(REFUSAL_LINES.TURNSTILE_FAILED);
    expect(alert.dataset.status).toBe('403');
    expect(turnstile.api.reset).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button()).toBeEnabled());
    expectNoBackendWords();
  });

  it('shuts the door and removes the widget when the server has no browser-check secret', async () => {
    const turnstile = fakeTurnstile();
    const requests = requestsFor({
      submit: vi.fn(async () =>
        Promise.reject(refusal(503, 'TURNSTILE_NOT_CONFIGURED', TURNSTILE_UNCONFIGURED.reason))
      ),
    });
    renderControl({ requests, turnstile });
    await waitFor(() => expect(button()).toBeEnabled());
    fireEvent.click(button());
    await screen.findByTestId('lz-lab-error');
    expect(line().textContent).toBe(LINES.unavailable);
    expect(button()).toBeDisabled();
    // The widget goes in the effect's cleanup, which runs after the commit
    // that shows the error, so it is waited for rather than assumed.
    await waitFor(() => expect(turnstile.api.remove).toHaveBeenCalledWith('widget-1'));
    expect(screen.queryByTestId('lz-lab-check')).toBeNull();
    expectNoBackendWords();
  });

  it('removes the widget when the control goes away', async () => {
    const turnstile = fakeTurnstile();
    const { unmount } = renderControl({ requests: requestsFor(), turnstile });
    await waitFor(() => expect(button()).toBeEnabled());
    unmount();
    expect(turnstile.api.remove).toHaveBeenCalledWith('widget-1');
  });
});

describe('the words', () => {
  it('puts the door first, then the site key, then the build, then the browser check', () => {
    const resolution = { ok: false, unresolved: [{ module: 'm', constraint: '1.0.0' }] };
    const resolved = { ok: true, unresolved: [] };
    const open = doorFromStatus(OPEN);
    const ready = { siteKey: 'k', check: 'ready' };
    expect(
      disabledReason({
        door: doorFromStatus(CLOSED),
        hasTerraform: false,
        resolution,
        ...ready,
      })
    ).toBe(LINES.unavailable);
    expect(
      disabledReason({ door: doorFromStatus(FULL), hasTerraform: false, resolution, ...ready })
    ).toBe(LINES.busy);
    expect(
      disabledReason({ door: open, hasTerraform: false, resolution, siteKey: '', check: 'idle' })
    ).toBe(LINES.unavailable);
    expect(
      disabledReason({ door: open, hasTerraform: true, resolution, siteKey: 'k', check: 'loading' })
    ).toBe(unresolvedLine(resolution.unresolved));
    expect(
      disabledReason({
        door: { phase: 'known', open: false },
        hasTerraform: true,
        resolution,
        ...ready,
      })
    ).toBe(LINES.unavailable);
    expect(
      disabledReason({ door: open, hasTerraform: true, resolution: resolved, ...ready })
    ).toBeNull();
    expect(
      disabledReason({
        door: open,
        hasTerraform: true,
        resolution: resolved,
        siteKey: 'k',
        check: 'spent',
      })
    ).toBeNull();
    for (const [check, expected] of [
      ['idle', LINES.browserCheck],
      ['loading', LINES.browserCheck],
      ['interactive', LINES.browserInteractive],
      ['error', LINES.browserError],
    ]) {
      expect(
        disabledReason({
          door: open,
          hasTerraform: true,
          resolution: resolved,
          siteKey: 'k',
          check,
        })
      ).toBe(expected);
    }
  });

  it('keeps the open flag and the code from the status read, and drops the server’s sentence', () => {
    expect(doorFromStatus(CLOSED)).toEqual({
      phase: 'known',
      open: false,
      code: 'PUBLIC_SUBMISSION_CLOSED',
    });
    expect(doorFromStatus(OPEN)).toEqual({ phase: 'known', open: true, code: null });
    expect(doorFromStatus(null)).toEqual({ phase: 'unreadable' });
  });

  it('tags the door without its code', () => {
    expect(doorTag({ phase: 'checking' })).toBe('checking');
    expect(doorTag({ phase: 'unreadable' })).toBe('unreadable');
    expect(doorTag(doorFromStatus(OPEN))).toBe('open');
    expect(doorTag(doorFromStatus(FULL))).toBe('busy');
    for (const code of DOOR_CODES.filter((c) => c !== 'LAB_QUEUE_FULL')) {
      expect(doorTag({ phase: 'known', open: false, code }), code).toBe('closed');
    }
  });

  it('reads a poll: a 404 or 503 ends the run, a transport failure backs off, the deadline stalls', () => {
    const clock = { errors: 2, elapsed: 0, deadlineMs: 1000 };
    const gone = refusal(404, 'JOB_NOT_FOUND', 'Job not found');
    expect(afterPoll({ error: gone }, clock)).toEqual({
      update: { phase: 'error', error: gone },
      stop: true,
      errors: 2,
    });
    expect(afterPoll({ error: new Error('reset') }, clock)).toEqual({
      update: null,
      stop: false,
      errors: 3,
    });
    expect(afterPoll({ job: { status: 'running' } }, clock)).toEqual({
      update: { job: { status: 'running' } },
      stop: false,
      errors: 0,
    });
    expect(afterPoll({ job: { status: 'queued' } }, { ...clock, elapsed: 1000 })).toEqual({
      update: { phase: 'stalled', job: { status: 'queued' } },
      stop: true,
      errors: 2,
    });
    expect(afterPoll({ error: new Error('reset') }, { ...clock, elapsed: 1000 }).update).toEqual({
      phase: 'stalled',
    });
  });

  it('shuts the door only for a 503 that names it, keeping no sentence', () => {
    expect(doorFromRefusal(refusal(503, 'LAB_QUEUE_FULL', 'full'))).toEqual({
      phase: 'known',
      open: false,
      code: 'LAB_QUEUE_FULL',
    });
    expect(doorFromRefusal(refusal(503, 'LAB_PAUSED_FOR_TODAY', 'paused'))).toBeNull();
    expect(doorFromRefusal(refusal(429, 'LAB_RATE_LIMITED', 'slow down'))).toBeNull();
    expect(doorFromRefusal(new Error('network'))).toBeNull();
  });

  it('refuses, before sending, a payload over the 64 KB the lab takes', async () => {
    // Random bytes as base64 barely compress, so 120 KB of it stays over the
    // cap. getRandomValues fills at most 64 KiB a call, so two calls.
    const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(45_000)));
    const noise = Buffer.concat([random(), random()]).toString('base64');
    const { error, body } = await preparePayload([{ path: 'main.tf', content: noise }]);
    expect(body).toBeUndefined();
    expect(error.status).toBe(413);
    expect(error.code).toBe(LOCAL_CODES.tooLarge);
    expect(failureLine(error)).toBe(tooLargeLine(error.bytes));
    expect(failureLine(error)).toMatch(
      /^This build is too large for the lab \([\d,]+ bytes; the limit is 65,536\)\. /
    );
    const small = await preparePayload(NO_SPOKES);
    expect(small.body.payloadEncoding).toBe('tar');
  });

  it('says where a run is while it is in flight', () => {
    expect(statusLine(null, { phase: 'submitting' })).toBe(LINES.submitting);
    expect(statusLine(null, { phase: 'polling', job: { status: 'queued' } })).toBe(LINES.queued);
    expect(statusLine(null, { phase: 'polling', job: { status: 'running' } })).toBe(LINES.running);
    expect(statusLine('closed', { phase: 'done' })).toBe('closed');
    expect(statusLine(null, null)).toBe(LINES.ready);
  });

  it('has a sentence for every terminal status', () => {
    expect(outcomeLine({ status: 'succeeded' })).toContain('valid');
    expect(outcomeLine({ status: 'failed' })).toContain('terraform validate');
    expect(outcomeLine({ status: 'timeout' })).toContain('ran out of time');
    expect(outcomeLine({ status: 'cancelled' })).toContain('cancelled');
    expect(outcomeLine({ status: 'odd' })).toBe('The job ended as odd.');
  });

  it('reads the report defensively: a known verdict, entries shaped as such, no runner text', () => {
    const leaky = {
      status: 'failed',
      output: 'Pulling from hybridcloudworks/hcw-lab-runner',
      report: {
        verdict: 'invalid',
        headline: 'Pulled ghcr.io/hybridcloudworks/hcw-lab-runner@sha256:abc',
        errors: [
          'Error: Unsupported argument\n\n  on main.tf line 2:',
          'Error: x\n\n  on ../../../opt/avm/avm-ptn-alz@0.21.0/main.tf line 1:',
          7,
        ],
        modules: ['avm-ptn-alz@0.21.0', '../../../opt/avm/avm-ptn-alz@0.21.0', null],
        modulesNote: 'Copied from the image registry.',
        providers: ['hashicorp/azurerm v4.81.0', 'hashicorp/azurerm v4.81.0 (unauthenticated)'],
      },
    };
    expect(visitorReport(leaky)).toEqual({
      verdict: 'invalid',
      headline: outcomeLine(leaky),
      errors: ['Error: Unsupported argument\n\n  on main.tf line 2:'],
      modules: ['avm-ptn-alz@0.21.0'],
      modulesNote: null,
      providers: ['hashicorp/azurerm v4.81.0'],
    });
    expect(visitorReport({ status: 'succeeded', report: { verdict: 'odd' } })).toBeNull();
    expect(visitorReport({ status: 'succeeded', report: 'valid' })).toBeNull();
    expect(visitorReport({ status: 'succeeded', output: 'Success!' })).toBeNull();
    expect(visitorReport({ status: 'succeeded', report: { verdict: 'valid' } })).toEqual({
      verdict: 'valid',
      headline: outcomeLine({ status: 'succeeded' }),
      errors: [],
      modules: [],
      modulesNote: null,
      providers: [],
    });
  });

  it('words every refusal itself, from the code, and never repeats the server', () => {
    const leaky = 'Cloudflare Turnstile is not configured; ask the owner to seed the secret';
    for (const code of Object.keys(REFUSAL_LINES)) {
      const text = failureLine(refusal(503, code, leaky));
      expect(text, code).toBe(REFUSAL_LINES[code]);
      expect(text, code).not.toMatch(BACKEND_WORDS);
    }
    expect(failureLine(refusal(413, 'PAYLOAD_TOO_LARGE', leaky))).toBe(tooLargeLine(undefined));
    expect(failureLine(refusal(403, 'FORBIDDEN', leaky))).toBe(LINES.failed);
    expect(failureLine(refusal(400, 'INVALID_BODY', leaky))).toBe(LINES.failed);
    expect(failureLine(refusal(404, undefined, leaky))).toBe(LINES.jobGone);
    expect(failureLine(refusal(429, undefined, leaky))).toBe(REFUSAL_LINES.LAB_RATE_LIMITED);
    expect(failureLine(refusal(503, undefined, leaky))).toBe(LINES.unavailable);
    expect(failureLine(new Error('socket hang up'))).toBe(LINES.failed);
    expect(failureLine(localError(LOCAL_CODES.notBuilt))).toBe(LINES.notBuilt);
    expect(failureLine(localError(LOCAL_CODES.checkPending))).toBe(LINES.browserMissing);
  });

  it('has a line for every door code, and every closed door but a full queue reads the same', () => {
    for (const code of DOOR_CODES) {
      expect(REFUSAL_LINES[code], code).toBe(
        code === 'LAB_QUEUE_FULL' ? LINES.busy : LINES.unavailable
      );
    }
  });
});
