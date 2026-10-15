import { test, expect, STATUS_ANSWERS, STUB_USER } from './fixtures/entra.js';

/**
 * The admin portal, signed in (estate review 2026-10-06: QA-1, AP-F1, AP-F2).
 *
 * Every test here signs in the way a person does — open a route, press "Sign
 * in with Microsoft", come back — through the credential-free identity in
 * fixtures/entra.js. The bundle is the production code path built with the
 * placeholder configuration in fixtures/stub-build-env.js; the stub answers the
 * identity host and the API at the network boundary, and nothing in the
 * application knows it is under test.
 *
 * Each test names, in a comment, the change to the product that makes it fail.
 * A test that cannot fail is the defect QA-1 recorded. On 2026-10-07 each named
 * change was made to the source, the bundle rebuilt and the test run against
 * it: eleven made their test fail, and the one that did not is recorded where
 * it applies rather than claimed.
 */

/** The routes the phone shell is checked on (AP-F1 acceptance, QA-1). */
const PHONE_ROUTES = ['/admin', '/admin/review-queue', '/admin/platform-settings', '/admin/health'];

/** Main-frame URLs, in order, so a test can see the journey and not only its end. */
function recordNavigations(page) {
  const urls = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(new URL(frame.url()));
  });
  return urls;
}

/**
 * Let the page settle, then return how many admin checks it made. A bound on
 * this is the regression check for the renewal loop fixed in entraAuth.js: an
 * `unknown` answer made the page re-check about 160 times a second.
 */
async function settledStatusCalls(page, identity) {
  await page.waitForTimeout(1500);
  return identity.statusRequests.length;
}

test.describe('signing in', () => {
  test('the callback lands on the route the person asked for, not the portal root', async ({
    page,
    identity,
  }) => {
    // Fails if: MSAL's return-to-start is turned off (`handleRedirectPromise`
    // with `navigateToLoginRequestUrl: false`; the callback page then sends
    // everyone to `/admin`), or the redirect URI stops being the callback
    // route. NOT if AuthCallbackPage's `/admin` fallback loses its pathname
    // check: run against that change on 2026-10-07 it still passed, because
    // MSAL 5 returns to the start page with a full navigation, so the page is
    // gone before the fallback line runs.
    const navigations = recordNavigations(page);
    await identity.signIn('/admin/platform-settings');

    await expect(
      page.locator('#admin-main').getByRole('heading', { level: 1, name: 'Platform Settings' })
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/admin/platform-settings');
    // The authorization response is gone from the address bar and history.
    expect(page.url()).not.toContain('code=');

    // It really went through the callback, carrying the code.
    expect(
      navigations.some((url) => url.pathname === '/auth/callback' && url.hash.includes('code='))
    ).toBe(true);
    const [authorize] = identity.authorizeRequests;
    expect(new URL(authorize.redirect_uri).pathname).toBe('/auth/callback');
    expect(authorize.prompt).toBe('select_account');
    expect(authorize.scope.split(' ')).toContain('api://e2e-hcw-api/access_as_admin');

    // The token the identity host issued is the one the API was shown.
    expect(identity.statusRequests[0].authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(identity.authorizeRequests).toHaveLength(1);
  });

  test('a registry refusal shows the denial and nothing of the admin', async ({
    page,
    identity,
  }) => {
    // Fails if: the guard renders its children for a signed-in non-admin, the
    // denial card changes its copy, or a refusal is treated as an expired
    // session (a second trip to /authorize).
    identity.answerAdminStatus(STATUS_ANSWERS.notAdmin);
    await identity.signIn('/admin/review-queue');

    await expect(page.getByText('Access Denied')).toBeVisible();
    await expect(
      page.getByText(`${STUB_USER.email} is not authorized. Contact the site admin.`)
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bootstrap My Admin Access' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'ContentForge' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Review Queue' })).toHaveCount(0);
    expect(identity.authorizeRequests).toHaveLength(1);
  });

  test('a token without the admin scope shows the configuration card and does not retry', async ({
    page,
    identity,
  }) => {
    // The API's `WWW-Authenticate: Bearer error="insufficient_scope"`
    // (require-role.js). Fails if: useAdminAuth classifies it as a session
    // problem (it would redirect to /authorize, and come back refused again),
    // the card stops showing the API's description, or the renewal loop
    // returns (the status-call bound).
    identity.answerAdminStatus(STATUS_ANSWERS.insufficientScope);
    await identity.signIn('/admin/review-queue');

    await expect(page.getByText('Admin access is misconfigured')).toBeVisible();
    await expect(
      page.getByText('The access token is missing the access_as_admin scope.')
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'ContentForge' })).toHaveCount(0);

    expect(await settledStatusCalls(page, identity)).toBeLessThanOrEqual(4);
    expect(identity.authorizeRequests).toHaveLength(1);
  });

  test('an expired token leads to one re-authentication, once per tab, then an honest card', async ({
    page,
    identity,
  }) => {
    // The API's `WWW-Authenticate: Bearer error="invalid_token"`. Fails if:
    // the automatic re-authentication is removed (one trip to /authorize, not
    // two), the once-per-tab guard is removed (a redirect loop: more trips
    // and no card), or the renewal loop returns (the status-call bound). The
    // reload step also holds the guard to sessionStorage: a module variable
    // would forget across it (reasoned, not run as a mutation).
    identity.answerAdminStatus(STATUS_ANSWERS.invalidToken);
    await page.goto('/admin/review-queue');
    await page.getByRole('button', { name: /sign in with microsoft/i }).click();

    await expect(page.getByText('Could not verify your access')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText('Your sign-in needs renewing before we can check your admin access.')
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/admin/review-queue');

    // One sign-in, then exactly one re-authentication: no account picker on
    // the second, because it renews the session it has rather than starting
    // a new one.
    expect(identity.authorizeRequests).toHaveLength(2);
    expect(identity.authorizeRequests[0].prompt).toBe('select_account');
    expect(identity.authorizeRequests[1].prompt).toBeUndefined();
    expect(identity.authorizeRequests[1].scope.split(' ')).toContain(
      'api://e2e-hcw-api/access_as_admin'
    );
    expect(await settledStatusCalls(page, identity)).toBeLessThanOrEqual(6);

    // Once per TAB: a reload is exactly when a module variable would reset.
    await page.reload();
    await expect(page.getByText('Could not verify your access')).toBeVisible();
    expect(identity.authorizeRequests).toHaveLength(2);
  });
});

test.describe('the collapsed rail on a desktop (AP-F2)', () => {
  test.skip(({ isMobile }) => isMobile, 'the rail is the desktop shell; a phone gets the drawer');

  test('shows each item its label on hover and on focus, unclipped, under its name', async ({
    page,
    identity,
  }) => {
    // Fails if: the label goes back to a title attribute (nothing is
    // rendered), it is positioned inside the nav's scroll container (the
    // point beside the rail is not the label), or it stops matching the name.
    await identity.signIn('/admin');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const rail = page.getByRole('navigation', { name: 'ContentForge' });
    const queue = rail.getByRole('link', { name: /^Review Queue/ });
    const label = queue.getByText('Review Queue', { exact: true });
    await expect(label).toHaveCount(0);

    await queue.hover();
    await expect(label).toBeVisible();
    await expect(queue).toHaveAccessibleName(/^Review Queue/);
    // The label is outside the 64 px rail, and it is what the browser paints
    // there: a label clipped by the scroll container would not be hit.
    const box = await label.boundingBox();
    const railBox = await rail.boundingBox();
    expect(box.x + box.width / 2).toBeGreaterThan(railBox.x + railBox.width);
    const painted = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.textContent ?? '',
      { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    );
    expect(painted).toBe('Review Queue');

    await page.mouse.move(600, 600);
    await expect(label).toHaveCount(0);

    await queue.focus();
    await expect(label).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(label).toHaveCount(0);
  });
});

test.describe('the Health Hub status slot (#1010)', () => {
  test.skip(({ isMobile }) => isMobile, 'measured at both widths from the desktop project');

  /** Five stored results, one per word, so the badges differ in width. */
  const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();
  const STORED = {
    success: true,
    results: {
      publer: { status: 'healthy', summary: 'Connected.', checkedAt: minutesAgo(3) },
      'batch-inspect': { status: 'degraded', summary: 'Slow.', checkedAt: minutesAgo(4) },
      resend: { status: 'critical', summary: 'Refused.', checkedAt: minutesAgo(5) },
      'lab-agents': {
        status: 'offline',
        summary: 'All 1 agents are offline.',
        checkedAt: minutesAgo(2),
        checkedBy: 'pulse',
      },
    },
    pulse: { lastBeatAt: minutesAgo(2), intervalMs: 300000, lateAfterMs: 900000 },
  };

  /** Each probe card's badge, as its distance from the card's top-right corner. */
  const badgeOffsets = (page) =>
    page.locator('[data-probe]').evaluateAll((cards) =>
      cards.map((card) => {
        const box = card.getBoundingClientRect();
        const badge = card.querySelector('[data-slot="status"] [data-status]');
        const mark = badge.getBoundingClientRect();
        return {
          id: card.dataset.probe,
          status: badge.dataset.status,
          right: Math.round(box.right - mark.right),
          top: Math.round(mark.top - box.top),
        };
      })
    );

  test('every probe card’s badge sits the same distance from its top-right corner, at 1280 and 390', async ({
    page,
    identity,
  }, testInfo) => {
    // Fails if: the header row wraps again (flex-wrap), the text block loses
    // flex-1, or the slot can shrink — a long description then drops the
    // badge under the text, which moves it down and left on every card but
    // the one with the shortest sentence (the bug in #1010).
    identity.answerApi('cms/health/probe-results', STORED);
    await page.setViewportSize({ width: 1280, height: 900 });
    await identity.signIn('/admin/health');
    await page.getByRole('tab', { name: 'Checks' }).click();
    await expect(
      page.locator('[data-probe="batch-inspect"] [data-status="degraded"]')
    ).toBeVisible();
    await expect(page.locator('[data-probe="lab-agents"] [data-status="offline"]')).toBeVisible();

    for (const width of [1280, 390]) {
      // The same page reflowed: one column at 390, three at 1280.
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('[data-probe="publer"]')).toBeVisible();

      const offsets = await badgeOffsets(page);
      expect(offsets.length).toBeGreaterThanOrEqual(38);
      expect(new Set(offsets.map((o) => o.status))).toEqual(
        new Set(['healthy', 'degraded', 'critical', 'offline', 'unknown'])
      );
      const [first] = offsets;
      for (const offset of offsets) {
        expect({ right: offset.right, top: offset.top }, `${offset.id} at ${width}px`).toEqual({
          right: first.right,
          top: first.top,
        });
      }
      // The admin column scrolls inside the shell, so a full-page capture
      // stops at the viewport: grow the viewport to the column's height for
      // the picture, then measure again at that size.
      const height = await page.evaluate(
        () => document.getElementById('admin-main')?.scrollHeight ?? 900
      );
      await page.setViewportSize({ width, height: Math.min(height + 120, 16000) });
      const tall = await badgeOffsets(page);
      expect(tall.every((o) => o.right === first.right && o.top === first.top)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`health-checks-${width}.png`) });
    }
  });
});

test.describe('the phone shell on a Pixel 5 (AP-F1)', () => {
  test.skip(({ isMobile }) => !isMobile, 'the drawer is the phone shell; mobile-chrome runs it');

  for (const route of PHONE_ROUTES) {
    test(`${route}: a full-width column, a drawer that opens and closes, no sideways scroll`, async ({
      page,
      identity,
    }) => {
      // Fails if: the rail comes back below md (the column drops to about
      // 263 px), the menu button goes, the drawer stops closing on Escape, or
      // anything on the page is wider than the phone.
      await identity.signIn(route);
      const column = page.locator('#admin-main');
      await expect(column.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'ContentForge' })).toBeHidden();

      const width = await column.evaluate((element) => element.getBoundingClientRect().width);
      expect(width).toBeGreaterThanOrEqual(340);

      const menuButton = page.getByRole('button', { name: 'Open menu' });
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      const drawer = page.getByRole('dialog', { name: 'ContentForge' });
      await expect(drawer).toBeVisible();
      const menu = drawer.getByRole('navigation', { name: 'ContentForge menu' });
      await expect(menu.getByRole('link', { name: /^Review Queue/ })).toBeVisible();
      await expect(menu.getByText('Platform Settings', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(menuButton).toBeFocused();

      const overflow = await page.evaluate(() => {
        const main = document.getElementById('admin-main');
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          column: main.scrollWidth - main.clientWidth,
        };
      });
      expect(overflow).toEqual({ page: 0, column: 0 });
    });
  }
});

/**
 * A dashboard snapshot with a count on every stage that has one, so the
 * badges take their room in the stage boxes the way they do in production.
 */
const DASHBOARD_SNAPSHOT = Object.freeze({
  success: true,
  stats: {
    blog: { needsReview: 4, inProgress: 3, published: 41, total: 48 },
    news: { needsReview: 2, inProgress: 0, published: 6, total: 8 },
    architecture: { needsReview: 1, inProgress: 2, published: 12, total: 15 },
    framework: { needsReview: 0, inProgress: 1, published: 9, total: 10 },
    coder_corner: { needsReview: 1, inProgress: 2, published: 5, total: 8 },
    rejected: 3,
  },
  readyToPublish: 2,
  recentNeedsReview: [],
});

/** Geometry of the pipeline and its card, read in the page. */
async function pipelineLayout(page) {
  await page.getByTestId('pipeline').waitFor();
  return page.evaluate(() => {
    const main = document.getElementById('admin-main');
    const card = document.querySelector('[data-testid="pipeline-card"]').getBoundingClientRect();
    const row = document.querySelector('[data-testid="pipeline"]').getBoundingClientRect();
    const stages = [...document.querySelectorAll('[data-testid="pipeline-stage"]')].map((stage) =>
      stage.getBoundingClientRect()
    );
    const descriptions = [
      ...document.querySelectorAll('[data-testid="pipeline-stage-description"]'),
    ];
    return {
      columnOverflow: main.scrollWidth - main.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      card: { left: card.left, right: card.right },
      row: { left: row.left, right: row.right },
      stageCount: stages.length,
      widths: stages.map((s) => s.width),
      heights: stages.map((s) => s.height),
      columns: new Set(stages.map((s) => Math.round(s.left))).size,
      leftmost: Math.min(...stages.map((s) => s.left)),
      rightmost: Math.max(...stages.map((s) => s.right)),
      cut: descriptions
        .filter((d) => d.scrollWidth > d.clientWidth || d.scrollHeight > d.clientHeight)
        .map(
          (d) =>
            `${d.textContent} (${d.scrollWidth}x${d.scrollHeight} in ${d.clientWidth}x${d.clientHeight})`
        ),
    };
  });
}

/** The assertions every width shares. */
function expectPipelineFits(layout, columns) {
  expect(layout.stageCount).toBe(6);
  expect(layout.columns).toBe(columns);
  expect({ column: layout.columnOverflow, page: layout.pageOverflow }).toEqual({
    column: 0,
    page: 0,
  });
  // Inside the card, and as far from its left edge as from its right.
  expect(layout.row.right).toBeLessThanOrEqual(layout.card.right);
  expect(layout.rightmost).toBeLessThanOrEqual(layout.card.right);
  expect(
    Math.abs(layout.leftmost - layout.card.left - (layout.card.right - layout.rightmost))
  ).toBeLessThanOrEqual(1);
  // Six boxes of one size.
  expect(Math.max(...layout.widths) - Math.min(...layout.widths)).toBeLessThanOrEqual(1);
  expect(Math.max(...layout.heights) - Math.min(...layout.heights)).toBeLessThanOrEqual(1);
  // Every description whole: not cut across, not cut below its two lines.
  expect(layout.cut).toEqual([]);
}

/**
 * The stat tiles: one height across every row, the expected column count,
 * and no label or note cut short.
 */
async function expectStatTilesEven(page, columns) {
  const tiles = await page.getByTestId('stat-tile').evaluateAll((nodes) =>
    nodes.map((tile) => {
      const box = tile.getBoundingClientRect();
      const cut = [...tile.querySelectorAll('span[title]')]
        .filter((line) => line.scrollWidth > line.clientWidth)
        .map((line) => line.textContent);
      return { left: Math.round(box.left), height: box.height, cut };
    })
  );
  expect(tiles).toHaveLength(5);
  expect(new Set(tiles.map((tile) => tile.left)).size).toBe(columns);
  const heights = tiles.map((tile) => tile.height);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  expect(tiles.flatMap((tile) => tile.cut)).toEqual([]);
}

test.describe('the dashboard pipeline fits its card on a desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the phone layout is checked on mobile-chrome below');

  for (const width of [1280, 1440]) {
    test.describe(`${width} px`, () => {
      test.use({ viewport: { width, height: 900 } });

      test('six equal stages in one row inside the card, nothing cut, five even stat tiles', async ({
        page,
        identity,
      }) => {
        // Fails if: the row goes back to `flex` with a `min-w-38` box (the six
        // boxes and chevrons needed ~1072 px of the 926 px card, so Live
        // Pages ran past the card's right edge), a description goes back to
        // one-line `truncate` ("Still being writ…", "Deci…"), the count badge
        // returns to the label's line, or the grid stops giving six columns
        // here. Measured on the old row on 2026-10-08: #admin-main scrolled
        // 97 px sideways at 1280 and 17 px at 1440, and five of the six
        // descriptions were cut. The stat tiles: fails if a tile with a note
        // stretches its row again, or the row stops giving five columns here
        // (`@2xl` would: index.css redefines it as 1400 px).
        identity.answerApi('getAdminDashboardSnapshot', DASHBOARD_SNAPSHOT);
        await identity.signIn('/admin');
        expectPipelineFits(await pipelineLayout(page), 6);
        await expect(page.getByRole('link', { name: /^Publish: .*2 items$/ })).toBeVisible();
        await expectStatTilesEven(page, 5);
      });
    });
  }
});

test.describe('the dashboard pipeline fits its card on a Pixel 5', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile-chrome runs the phone layout');

  test('two equal columns inside the card, nothing cut, stat tiles two to a row', async ({
    page,
    identity,
  }) => {
    // Fails if: the grid drops to one column or overflows the phone, or a
    // description is cut. Same measurements as the desktop widths, and the
    // stat tiles two to a row, even, with nothing cut.
    identity.answerApi('getAdminDashboardSnapshot', DASHBOARD_SNAPSHOT);
    await identity.signIn('/admin');
    expectPipelineFits(await pipelineLayout(page), 2);
    await expectStatTilesEven(page, 2);
  });
});
