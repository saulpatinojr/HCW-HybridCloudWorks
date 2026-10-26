/**
 * /admin/doc-vault (owner request 2026-10-26): the private banner, the list
 * with its category filter and search, the viewer with its two Copy buttons,
 * pasting a document, uploading several files where one fails, editing,
 * restoring an earlier version, Trash (put back, delete for good), a conflict
 * from another tab, the state before the container exists, and the role.
 *
 * The API is a small fake that answers the way functions/src/lib/doc-vault/
 * handlers.js does (the routes, the statuses, the etag), so each test reads as
 * what the owner sees and the request each click sends.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocVaultPage from './DocVaultPage';
import { AdminRoleProvider } from '@/hooks/useAdminRole';

const getJSON = vi.fn();
const postJSON = vi.fn();
const sendJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));

// ── a fake API ─────────────────────────────────────────────────────────────

const refusal = (status, code, message, extra = {}) =>
  Object.assign(new Error(message), { status, code, ...extra });

function makeDoc(over = {}) {
  return {
    id: 'doc-1',
    title: 'Cover letter',
    category: 'Letter',
    tags: ['outreach', 'mvp'],
    source: 'pasted',
    relatedLink: 'https://example.com/role',
    version: 3,
    bodyBytes: 44,
    body: '# Dear team\n\nI am **very** keen.\n\nSee [the role](https://example.com/role).',
    createdAt: '2026-10-01T09:00:00.000Z',
    createdBy: 'admin-1',
    updatedAt: '2026-10-20T09:00:00.000Z',
    updatedBy: 'admin-1',
    deletedAt: null,
    purgeAt: null,
    restoredFromVersion: null,
    etag: '"e1"',
    ...over,
  };
}

const VERSIONS = [
  {
    version: 2,
    title: 'Cover letter',
    category: 'Letter',
    source: 'pasted',
    bodyBytes: 30,
    savedAt: '2026-10-10T09:00:00.000Z',
    restoredFromVersion: null,
  },
  {
    version: 1,
    title: 'Cover letter',
    category: 'Letter',
    source: 'uploaded',
    bodyBytes: 20,
    savedAt: '2026-10-01T09:00:00.000Z',
    restoredFromVersion: null,
  },
];

const PEOPLE = makeDoc({
  id: 'doc-2',
  title: 'MVP application',
  category: 'Application',
  tags: ['mvp'],
  relatedLink: null,
  version: 1,
  bodyBytes: 12,
  body: 'Why I should be an MVP.',
  updatedAt: '2026-10-22T09:00:00.000Z',
  etag: '"e2"',
});
const NOTES = makeDoc({
  id: 'doc-3',
  title: 'Azure notes',
  category: 'Notes',
  tags: [],
  relatedLink: null,
  version: 1,
  bodyBytes: 8,
  body: 'Notes.',
  updatedAt: '2026-10-05T09:00:00.000Z',
  etag: '"e3"',
});
const TRASHED = makeDoc({
  id: 'doc-4',
  title: 'Old draft',
  category: 'Other',
  tags: [],
  relatedLink: null,
  version: 2,
  bodyBytes: 5,
  body: 'Old.',
  deletedAt: '2026-10-24T09:00:00.000Z',
  purgeAt: '2026-11-23T09:00:00.000Z',
  etag: '"e4"',
});

const summary = (doc) => {
  const { body: _body, createdBy: _by, updatedBy: _upd, restoredFromVersion: _r, ...row } = doc;
  return row;
};

/** The vault the fake serves; a test changes it before rendering. */
let vault;
const resetVault = () => {
  vault = {
    documents: [makeDoc(), PEOPLE, NOTES],
    trash: [TRASHED],
    versions: { 'doc-1': VERSIONS },
    versionBodies: { 'doc-1:1': 'FIRST TEXT', 'doc-1:2': 'SECOND TEXT' },
    uploads: {},
  };
};

function listAnswer(view) {
  const rows = view === 'trash' ? vault.trash : vault.documents;
  const counts = Object.fromEntries(
    ['Template', 'Application', 'Letter', 'Notes', 'Reference', 'Other'].map((c) => [
      c,
      rows.filter((d) => d.category === c).length,
    ])
  );
  const tagCounts = new Map();
  for (const doc of rows) for (const t of doc.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  return {
    ok: true,
    view,
    documents: rows.map(summary),
    total: rows.length,
    matching: rows.length,
    truncated: false,
    limit: 500,
    counts,
    tags: [...tagCounts].map(([tag, count]) => ({ tag, count })),
  };
}

const findDoc = (id) => [...vault.documents, ...vault.trash].find((d) => d.id === id);

beforeEach(() => {
  resetVault();
  getJSON.mockReset().mockImplementation(async (route) => {
    if (route === 'cms/doc-vault') return listAnswer('active');
    if (route === 'cms/doc-vault?view=trash') return listAnswer('trash');
    const version = /^cms\/doc-vault\/([^/]+)\/versions\/(\d+)$/.exec(route);
    if (version) {
      const body = vault.versionBodies[`${version[1]}:${version[2]}`];
      if (!body) throw refusal(404, 'VERSION_NOT_FOUND', 'No such version.');
      const entry = (vault.versions[version[1]] ?? []).find(
        (v) => v.version === Number(version[2])
      );
      return {
        ok: true,
        version: { ...entry, tags: ['old-tag'], relatedLink: null, body, current: false },
      };
    }
    const id = decodeURIComponent(route.split('/')[2]);
    const doc = findDoc(id);
    if (!doc) throw refusal(404, 'NOT_FOUND', 'No such document.');
    return { ok: true, document: doc, versions: vault.versions[id] ?? [] };
  });
  postJSON.mockReset();
  sendJSON.mockReset();
  toast.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete document.execCommand;
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

function renderPage({ role = null } = {}) {
  return render(
    <MemoryRouter initialEntries={['/admin/doc-vault']}>
      <Routes>
        <Route
          path="/admin/doc-vault"
          element={
            <AdminRoleProvider value={role}>
              <Link to="/admin/ambassador">Ambassador</Link>
              <DocVaultPage />
            </AdminRoleProvider>
          }
        />
        <Route path="/admin/ambassador" element={<h1>Ambassador page</h1>} />
      </Routes>
    </MemoryRouter>
  );
}

const list = () => screen.findByRole('list', { name: 'Documents' });
const viewer = () => screen.findByLabelText('Document text');

// ── the page ───────────────────────────────────────────────────────────────

describe('the page', () => {
  it('opens with the registry title and the private banner, word for word', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Doc Vault' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe(
      'Private. Only signed-in admins see this. Never shown on the public site.'
    );
    expect(getJSON).toHaveBeenCalledWith('cms/doc-vault');
  });

  it('lists the documents newest first with category, version and tags, and no text', async () => {
    renderPage();
    const items = within(await list()).getAllByRole('button');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('Cover letter')).toBeTruthy();
    expect(items[0].textContent).toMatch(/Letter/);
    expect(items[0].textContent).toMatch(/Version 3/);
    expect(items[0].textContent).toMatch(/outreach/);
    expect(screen.queryByText(/I am/)).toBeNull();
  });

  it('says what an empty vault is for', async () => {
    vault.documents = [];
    renderPage();
    expect(await screen.findByText(/The vault is empty/)).toBeTruthy();
  });

  it('keeps the Ambassador Evidence tab out of it, in words', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /How this works/ }));
    expect(screen.getByText(/belongs in Ambassador, on its Evidence tab/)).toBeTruthy();
  });
});

describe('filter and search', () => {
  it('narrows the list by category, with the counts beside each', async () => {
    renderPage();
    await list();
    const category = screen.getByLabelText('Filter by category');
    expect(within(category).getByRole('option', { name: 'Letter (1)' })).toBeTruthy();
    fireEvent.change(category, { target: { value: 'Application' } });
    const items = within(screen.getByRole('list', { name: 'Documents' })).getAllByRole('button');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toMatch(/MVP application/);
  });

  it('narrows the list by tag', async () => {
    renderPage();
    await list();
    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'mvp' } });
    expect(
      within(screen.getByRole('list', { name: 'Documents' })).getAllByRole('button')
    ).toHaveLength(2);
  });

  it('searches title, tag and category as you type, and offers a way back', async () => {
    renderPage();
    await list();
    fireEvent.change(screen.getByLabelText('Search the vault'), { target: { value: 'AZURE' } });
    const items = within(screen.getByRole('list', { name: 'Documents' })).getAllByRole('button');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toMatch(/Azure notes/);

    fireEvent.change(screen.getByLabelText('Search the vault'), { target: { value: 'zzz' } });
    expect(screen.getByText(/Nothing matches that search/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search and filters' }));
    expect(
      within(screen.getByRole('list', { name: 'Documents' })).getAllByRole('button')
    ).toHaveLength(3);
  });
});

describe('the viewer and Copy', () => {
  it('shows the document with its facts, its text as plain text and its history', async () => {
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    expect(await screen.findByRole('heading', { name: 'Cover letter' })).toBeTruthy();
    expect(getJSON).toHaveBeenCalledWith('cms/doc-vault/doc-1');
    expect((await viewer()).value).toContain('I am **very** keen.');
    expect(screen.getByText(/Version 3 \(newest\)/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Related link/ });
    expect(link.getAttribute('href')).toBe('https://example.com/role');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
    const versions = within(screen.getByRole('list', { name: 'Versions' })).getAllByRole(
      'listitem'
    );
    expect(versions).toHaveLength(3);
  });

  it('puts the text on the clipboard exactly as saved, and says so', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(makeDoc().body);
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(screen.getByText('Copy the text: done.')).toBeTruthy();
  });

  it('copies the plain-text form without the markdown marks', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    fireEvent.click(screen.getByRole('button', { name: 'Copy as plain text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith(
      'Dear team\n\nI am very keen.\n\nSee the role (https://example.com/role).'
    );
  });

  it('copies on a browser with no clipboard API, by the older copy command', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    let copied = null;
    document.execCommand = vi.fn(() => {
      copied = document.activeElement.value;
      return true;
    });
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the text' }));
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(copied).toBe(makeDoc().body);
  });

  it('says so, and leaves the text to select, when the browser refuses both ways', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = vi.fn(() => false);
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the text' }));
    expect(await screen.findByText(/did not allow copying/)).toBeTruthy();
    expect((await viewer()).value).toContain('I am **very** keen.');
  });

  it('shows text that looks like HTML as text, never as a page', async () => {
    vault.documents = [
      makeDoc({ body: 'Hi <img src=x onerror=alert(1)> <script>alert(2)</script>' }),
    ];
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    const text = await viewer();
    expect(text.value).toContain('<script>alert(2)</script>');
    expect(document.body.querySelector('script, img')).toBeNull();
  });

  it('shows a link that is not safe as nothing at all', async () => {
    vault.documents = [makeDoc({ relatedLink: 'javascript:alert(1)' })];
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    expect(screen.queryByRole('link', { name: /Related/ })).toBeNull();
  });

  it('shows a link into this admin as a link inside the app', async () => {
    vault.documents = [makeDoc({ relatedLink: '/admin/ambassador' })];
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    expect(
      screen.getByRole('link', { name: /Related page in this admin/ }).getAttribute('href')
    ).toBe('/admin/ambassador');
  });

  it('shows the text in a read-only box, which the Tab key reaches and Ctrl+A and Ctrl+C can take', async () => {
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    const box = await viewer();
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.readOnly).toBe(true);
    expect(box.disabled).toBe(false);
    box.focus();
    expect(document.activeElement).toBe(box);
  });

  it('says why it could not open a document', async () => {
    getJSON.mockImplementation(async (route) => {
      if (route === 'cms/doc-vault') return listAnswer('active');
      throw refusal(404, 'NOT_FOUND', 'No such document.');
    });
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/No such document/);
  });
});

describe('paste a document', () => {
  const fill = async (title, body) => {
    renderPage();
    await list();
    fireEvent.click(screen.getByRole('button', { name: /Paste a document/ }));
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: title } });
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: body } });
  };

  it('opens a blank form, keeps Add switched off until there is a title and text, and says what a repeat does', async () => {
    renderPage();
    await list();
    fireEvent.click(screen.getByRole('button', { name: /Paste a document/ }));
    expect(
      await screen.findByText(/becomes its newest version instead of a second copy/)
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to the vault' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New letter' } });
    expect(screen.getByRole('button', { name: 'Add to the vault' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Body' } });
    expect(screen.getByRole('button', { name: 'Add to the vault' }).disabled).toBe(false);
  });

  it('sends exactly the five fields, then shows the new document and refreshes the list', async () => {
    const created = makeDoc({
      id: 'doc-9',
      title: 'New letter',
      category: 'Template',
      tags: ['a', 'b'],
      version: 1,
      body: 'Body',
      relatedLink: null,
    });
    postJSON.mockResolvedValue({ ok: true, outcome: 'created', document: created });
    getJSON.mockImplementation(async (route) => {
      if (route === 'cms/doc-vault') return listAnswer('active');
      return { ok: true, document: created, versions: [] };
    });
    await fill('  New letter ', 'Body');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Template' } });
    fireEvent.change(screen.getByLabelText('Tags (optional)'), { target: { value: 'a, #b, A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to the vault' }));
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
    expect(postJSON).toHaveBeenCalledWith('cms/doc-vault', {
      fields: {
        title: 'New letter',
        category: 'Template',
        tags: ['a', 'b'],
        body: 'Body',
        relatedLink: null,
      },
    });
    expect(await screen.findByRole('heading', { name: 'New letter' })).toBeTruthy();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Added to the vault' }));
    expect(
      getJSON.mock.calls.filter(([route]) => route === 'cms/doc-vault').length
    ).toBeGreaterThan(1);
  });

  it('says a repeat of a title became a new version', async () => {
    const versioned = makeDoc({ version: 4, body: 'Body' });
    postJSON.mockResolvedValue({ ok: true, outcome: 'versioned', document: versioned });
    await fill('Cover letter', 'Body');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Letter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to the vault' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Saved as a new version' })
      )
    );
  });

  it('shows what the API refused, keeps the typed text, and sends nothing twice', async () => {
    postJSON.mockRejectedValue(
      refusal(
        400,
        'INVALID',
        'The link must be an https address, or a page of this admin that starts with /admin/ (at most 500 characters).'
      )
    );
    await fill('New letter', 'Body');
    fireEvent.click(screen.getByRole('button', { name: 'Add to the vault' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/https address/);
    expect(screen.getByLabelText('Text').value).toBe('Body');
    expect(postJSON).toHaveBeenCalledTimes(1);
  });

  it('holds the Add button back, in words, for a link that is not safe', async () => {
    await fill('New letter', 'Body');
    fireEvent.change(screen.getByLabelText('Related link (optional)'), {
      target: { value: 'javascript:alert(1)' },
    });
    expect(screen.getByRole('button', { name: 'Add to the vault' }).disabled).toBe(true);
    expect(screen.getByText(/must be an https address/)).toBeTruthy();
  });

  it('asks before throwing away typed text, whether the way out is a list row or a link', async () => {
    await fill('Half written', 'Some text');
    fireEvent.click(within(await list()).getByRole('button', { name: /Azure notes/ }));
    expect(await screen.findByText('Discard what you typed?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Text').value).toBe('Some text');

    fireEvent.click(screen.getByRole('link', { name: 'Ambassador' }));
    expect(await screen.findByText('Leave this page?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave without saving' }));
    expect(await screen.findByRole('heading', { name: 'Ambassador page' })).toBeTruthy();
  });

  it('discards on request and opens the row asked for', async () => {
    await fill('Half written', 'Some text');
    fireEvent.click(within(await list()).getByRole('button', { name: /Azure notes/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('heading', { name: 'Azure notes' })).toBeTruthy();
    expect(screen.queryByLabelText('Title')).toBeNull();
  });
});

describe('upload files', () => {
  const file = (name, text = `text of ${name}`, size) => {
    const f = new File([text], name, { type: 'text/markdown' });
    if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
    return f;
  };

  async function choose(files) {
    renderPage();
    await list();
    fireEvent.click(screen.getByRole('button', { name: /Upload files/ }));
    const picker = await screen.findByLabelText('Files (one or many)');
    fireEvent.change(picker, { target: { files } });
    return picker;
  }

  it('sends a mixed batch one file at a time, keeps going past the one that fails, and says what became of each', async () => {
    const order = [];
    postJSON.mockImplementation(async (route, body) => {
      order.push(body.filename);
      if (body.filename === 'broken.md')
        throw refusal(
          422,
          'EMPTY_BODY',
          'The file has no text to keep (only front matter, or nothing).'
        );
      if (body.filename === 'again.md')
        return {
          ok: true,
          outcome: 'versioned',
          document: { category: 'Letter', version: 4 },
          warnings: [],
        };
      if (body.filename === 'same.md')
        return {
          ok: true,
          outcome: 'unchanged',
          document: { category: 'Notes', version: 1 },
          warnings: [],
        };
      return {
        ok: true,
        outcome: 'created',
        document: { category: 'Notes', version: 1 },
        warnings: ['Front matter not kept: aliases.'],
      };
    });
    await choose([
      file('first.md'),
      file('broken.md'),
      file('again.md'),
      file('same.md'),
      file('last.txt'),
    ]);
    fireEvent.change(screen.getByLabelText('Category for files that do not name one'), {
      target: { value: 'Notes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload 5 files' }));

    const results = await screen.findByRole('list', { name: 'Upload results' });
    await waitFor(() => expect(within(results).getAllByRole('listitem')).toHaveLength(5));
    expect(order).toEqual(['first.md', 'broken.md', 'again.md', 'same.md', 'last.txt']);
    const lines = within(results)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(lines[0]).toMatch(/first\.md.*Added as a new document in Notes/);
    expect(lines[0]).toMatch(/Front matter not kept: aliases\./);
    expect(lines[1]).toMatch(/broken\.md.*Not added: The file has no text to keep/);
    expect(lines[2]).toMatch(/again\.md.*Saved as version 4 of a document already here in Letter/);
    expect(lines[3]).toMatch(/same\.md.*Already here with exactly this text/);
    expect(lines[4]).toMatch(/last\.txt.*Added as a new document/);
    expect(
      await screen.findByText('5 files: 2 added, 1 new version, 1 already here, 1 not added.')
    ).toBeTruthy();
    expect(postJSON.mock.calls[0]).toEqual([
      'cms/doc-vault/upload',
      { filename: 'first.md', text: 'text of first.md', defaultCategory: 'Notes' },
    ]);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Files added to the vault' })
    );
  });

  it('reloads the list once at the end, not after every file', async () => {
    postJSON.mockResolvedValue({
      ok: true,
      outcome: 'created',
      document: { category: 'Other', version: 1 },
      warnings: [],
    });
    await choose([file('a.md'), file('b.md'), file('c.md')]);
    const before = getJSON.mock.calls.filter(([route]) => route === 'cms/doc-vault').length;
    fireEvent.click(screen.getByRole('button', { name: 'Upload 3 files' }));
    await screen.findByText('3 files: 3 added, 0 new versions, 0 already here, 0 not added.');
    expect(getJSON.mock.calls.filter(([route]) => route === 'cms/doc-vault').length).toBe(
      before + 1
    );
  });

  it('does not send a file that is over the size, and does not stop for it', async () => {
    postJSON.mockResolvedValue({
      ok: true,
      outcome: 'created',
      document: { category: 'Other', version: 1 },
      warnings: [],
    });
    await choose([file('huge.md', 'x', 300 * 1024), file('small.md')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 2 files' }));
    const results = await screen.findByRole('list', { name: 'Upload results' });
    await waitFor(() => expect(within(results).getAllByRole('listitem')).toHaveLength(2));
    expect(within(results).getAllByRole('listitem')[0].textContent).toMatch(
      /huge\.md.*over 272 KB.*Nothing was sent/
    );
    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(postJSON.mock.calls[0][1].filename).toBe('small.md');
  });

  it("reports a file the browser cannot read as that file's line", async () => {
    postJSON.mockResolvedValue({
      ok: true,
      outcome: 'created',
      document: { category: 'Other', version: 1 },
      warnings: [],
    });
    const unreadable = file('locked.md');
    unreadable.text = async () => {
      throw new Error('The file could not be read.');
    };
    await choose([unreadable, file('fine.md')]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 2 files' }));
    const results = await screen.findByRole('list', { name: 'Upload results' });
    await waitFor(() => expect(within(results).getAllByRole('listitem')).toHaveLength(2));
    expect(within(results).getAllByRole('listitem')[0].textContent).toMatch(
      /locked\.md.*could not be read/
    );
    expect(postJSON).toHaveBeenCalledTimes(1);
  });

  it('offers only text files in the picker, and can be dismissed and closed', async () => {
    postJSON.mockResolvedValue({
      ok: true,
      outcome: 'unchanged',
      document: { category: 'Other', version: 1 },
      warnings: [],
    });
    const picker = await choose([file('a.md')]);
    expect(picker.getAttribute('accept')).toBe('.md,.markdown,.txt,.text,text/markdown,text/plain');
    expect(picker.multiple).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    await screen.findByText('1 file: 0 added, 0 new versions, 1 already here, 0 not added.');
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nothing new added' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('list', { name: 'Upload results' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByLabelText('Files (one or many)')).toBeNull();
  });
});

describe('edit', () => {
  it('sends the five fields with the etag of the version on screen, then shows the new version', async () => {
    const saved = makeDoc({ version: 4, body: 'Edited text', etag: '"e9"' });
    sendJSON.mockResolvedValue({ ok: true, outcome: 'versioned', document: saved });
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.change(await screen.findByLabelText('Text'), { target: { value: 'Edited text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
    expect(sendJSON).toHaveBeenCalledWith('cms/doc-vault/doc-1', 'PUT', {
      etag: '"e1"',
      fields: {
        title: 'Cover letter',
        category: 'Letter',
        tags: ['outreach', 'mvp'],
        body: 'Edited text',
        relatedLink: 'https://example.com/role',
      },
    });
    await waitFor(() => expect(screen.queryByLabelText('Title')).toBeNull());
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Saved as a new version' })
    );
  });

  it('keeps Save switched off until something changes', async () => {
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect((await screen.findByRole('button', { name: 'Save changes' })).disabled).toBe(true);
  });

  it('keeps the typed text and offers the latest when another tab saved first', async () => {
    sendJSON.mockRejectedValue(
      refusal(
        412,
        'CONFLICT',
        'This document changed in another tab or on another device since you opened it. Nothing was saved; reload it to see the latest version.'
      )
    );
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.change(await screen.findByLabelText('Text'), { target: { value: 'My edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/changed in another tab/);
    expect(alert.textContent).toMatch(/copy anything you want to keep/);
    expect(screen.getByLabelText('Text').value).toBe('My edit');
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(screen.queryByLabelText('Text')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Cover letter' })).toBeTruthy();
  });
});

describe('history and restoring a version', () => {
  async function openWithHistory() {
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
  }

  it('lets an earlier version be read first, and says that it is not the newest', async () => {
    await openWithHistory();
    fireEvent.click(screen.getByRole('button', { name: 'View version 1' }));
    expect(
      await screen.findByText(/You are reading version 1, not the newest \(version 3\)/)
    ).toBeTruthy();
    expect(getJSON).toHaveBeenCalledWith('cms/doc-vault/doc-1/versions/1');
    expect((await viewer()).value).toBe('FIRST TEXT');
    expect(screen.getByText(/Version 1 \(an earlier one\)/)).toBeTruthy();
    // Copy copies the version on screen.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copy the text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('FIRST TEXT'));
    // And Edit and Move to Trash are not offered on an old version.
    expect(screen.queryByRole('button', { name: /^Edit$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the newest' }));
    expect((await viewer()).value).toContain('I am **very** keen.');
  });

  it('asks, then makes the version the newest with the etag of the version on screen', async () => {
    const restored = makeDoc({
      version: 4,
      body: 'FIRST TEXT',
      etag: '"e7"',
      restoredFromVersion: 1,
    });
    postJSON.mockResolvedValue({ ok: true, outcome: 'versioned', document: restored });
    await openWithHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
    expect(await screen.findByText('Make this version the newest?')).toBeTruthy();
    expect(postJSON).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
    expect(postJSON).toHaveBeenCalledWith('cms/doc-vault/doc-1/restore-version', {
      version: 1,
      etag: '"e1"',
    });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Version 1 is the newest again' })
    );
  });

  it('restores from the version being read, too', async () => {
    postJSON.mockResolvedValue({
      ok: true,
      outcome: 'versioned',
      document: makeDoc({ version: 4 }),
    });
    await openWithHistory();
    fireEvent.click(screen.getByRole('button', { name: 'View version 2' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore this version' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(postJSON).toHaveBeenCalled());
    expect(postJSON.mock.calls[0][1]).toEqual({ version: 2, etag: '"e1"' });
  });

  it('leaves the version alone when the owner says no', async () => {
    await openWithHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 2' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('says what a document with no history yet will do', async () => {
    vault.versions = {};
    await openWithHistory();
    expect(screen.getByText(/No earlier versions yet/)).toBeTruthy();
  });
});

describe('delete, Trash, put back and delete for good', () => {
  it('moves to Trash only after asking, with the etag, and drops the document from the list', async () => {
    sendJSON.mockResolvedValue({ ok: true, outcome: 'trashed', document: { id: 'doc-1' } });
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(await screen.findByText('Move this document to Trash?')).toBeTruthy();
    expect(sendJSON).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Move to Trash' }).at(-1));
    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
    expect(sendJSON).toHaveBeenCalledWith('cms/doc-vault/doc-1', 'DELETE', { etag: '"e1"' });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Moved to Trash' }));
    await waitFor(() => expect(screen.queryByLabelText('Document text')).toBeNull());
  });

  async function openTrashed() {
    renderPage();
    await list();
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
    const trash = await screen.findByRole('list', { name: 'Documents in Trash' });
    fireEvent.click(within(trash).getByRole('button', { name: /Old draft/ }));
    await viewer();
  }

  it('shows Trash with when each document goes for good, and offers no edit on one', async () => {
    await openTrashed();
    expect(getJSON).toHaveBeenCalledWith('cms/doc-vault?view=trash');
    expect(
      screen.getByText(/This document is in Trash\. It will be removed for good on/)
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Edit$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move to Trash' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Restore version/ })).toBeNull();
    // It can still be copied from.
    expect(screen.getByRole('button', { name: 'Copy the text' })).toBeTruthy();
  });

  it('puts a document back with the etag', async () => {
    postJSON.mockResolvedValue({ ok: true, outcome: 'restored', document: { id: 'doc-4' } });
    await openTrashed();
    fireEvent.click(screen.getByRole('button', { name: 'Put back' }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/doc-vault/doc-4/untrash', { etag: '"e4"' })
    );
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Put back' }));
  });

  it('deletes for good only after asking, naming what cannot be undone', async () => {
    sendJSON.mockResolvedValue({ ok: true, deleted: 'doc-4', permanent: true });
    await openTrashed();
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    expect(await screen.findByText('Delete this document for good?')).toBeTruthy();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    expect(sendJSON).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete forever' }).at(-1));
    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
    expect(sendJSON).toHaveBeenCalledWith('cms/doc-vault/doc-4', 'DELETE', {
      etag: '"e4"',
      permanent: true,
    });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deleted for good' }));
  });

  it('shows an empty Trash in plain words', async () => {
    vault.trash = [];
    renderPage();
    await list();
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
    expect(await screen.findByText(/Trash is empty/)).toBeTruthy();
  });
});

describe('before the container exists, and the role', () => {
  it('tells the owner the one step that fixes it, and tries again on request', async () => {
    getJSON.mockRejectedValueOnce(
      refusal(503, 'NOT_PROVISIONED', 'The Doc Vault has no storage yet.')
    );
    renderPage();
    expect(await screen.findByText('The Doc Vault has no storage yet')).toBeTruthy();
    expect(screen.getByText(/docs\/runbooks\/doc-vault\.md/)).toBeTruthy();
    // The private line stays up in every state.
    expect(
      screen.getByText('Private. Only signed-in admins see this. Never shown on the public site.')
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await list()).toBeTruthy();
    expect(screen.queryByText('The Doc Vault has no storage yet')).toBeNull();
  });

  it('shows a failed list in words, with the way to try again', async () => {
    getJSON.mockRejectedValueOnce(refusal(500, 'X', 'Failed to list documents (reference inv-1)'));
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Failed to list documents/);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await list()).toBeTruthy();
  });

  it.each(['viewer', 'editor'])(
    'tells a %s it is for publishers, and asks the API for nothing',
    async (role) => {
      renderPage({ role });
      expect(await screen.findByText('The Doc Vault is for publishers and above')).toBeTruthy();
      expect(getJSON).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /Paste a document/ })).toBeNull();
    }
  );

  it.each(['publisher', 'super_admin'])('opens for a %s', async (role) => {
    renderPage({ role });
    expect(await list()).toBeTruthy();
    expect(getJSON).toHaveBeenCalledWith('cms/doc-vault');
  });
});

describe("reading the text never reaches the browser's storage", () => {
  it('writes nothing to localStorage or sessionStorage while documents are opened, copied and edited', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    fireEvent.click(within(await list()).getByRole('button', { name: /Cover letter/ }));
    await viewer();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the text' }));
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.change(await screen.findByLabelText('Text'), {
      target: { value: 'typed SECRET text' },
    });
    await act(async () => {});
    for (const [, value] of local.mock.calls) {
      expect(String(value)).not.toContain('SECRET');
      expect(String(value)).not.toContain('Dear team');
    }
  });
});
