/**
 * The guard #1927 asked for: the credential register, the DNS token runbook,
 * the standards pages and the audit settings cannot name a kind of Cloudflare
 * token, or a token, that the roll code (cloudflare-roll.js) does not hold
 * for that place.
 *
 * Why it exists: until #1927 every one of those places named the user token
 * `hcp-terraform-cloudflare-dns` as hcw-azure's, while the workspace really
 * held the account-owned token `hcw`, and the register said "renewed by
 * automation" for a token the script could not roll and nothing ran.
 * CLOUDFLARE_TARGETS is the one place that says which token each store holds
 * and which kind it is; everything below is held to it.
 */
import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { CLOUDFLARE_TARGETS, TOKEN_OWNERS, tokenOwnerRoutes } from './cloudflare-roll.js';
import { CREDENTIAL_REGISTER, findCredential } from './register.js';

const repoUrl = (path) => new URL(`../../../../${path}`, import.meta.url);
const repoFile = (path) => readFileSync(repoUrl(path), 'utf8');

/** How the register's `issuer` names each kind. A new kind fails the first test until it is added here. */
const ISSUER_BY_OWNER = Object.freeze({
  user: 'Cloudflare user API tokens',
  account: 'Cloudflare account API tokens',
});

/** How the documentation names each kind. */
const DOCS_WORD_BY_OWNER = Object.freeze({
  user: 'user',
  account: 'account-owned',
});

/** A phrase in a sentence that says which kind a token is. */
const KIND_PHRASE = Object.freeze({
  user: /\buser (API )?tokens?\b/i,
  account: /\baccount(-owned)?\*{0,2} (Cloudflare )?(API )?tokens?\b/i,
});

const OWNER_BY_ISSUER = Object.fromEntries(Object.entries(ISSUER_BY_OWNER).map(([owner, issuer]) => [issuer, owner]));

/** The pages that say which token a store holds. */
const DOCS = Object.freeze([
  'docs/runbooks/dns-token-stolen.md',
  'docs/runbooks/edge-dns-verification.md',
  'docs/runbooks/cold-rebuild.md',
  'docs/standards/required-inputs.md',
  'docs/standards/variables-and-secrets.md',
  'infra/variables.tf',
  'infra-lab/variables.tf',
]);

/** Words that mark a sentence as history ("this used to be named ..."), not a claim about today. */
const HISTORY_MARKER = /\buntil (#1927|then|2026-11-27)\b|\bearlier docs\b|\bwrongly\b|\bby mistake\b|\bused to name\b/i;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A token name as a word of its own: not part of `hcw-azure` or `hcw/hcw-lab`,
 * and not the HCP Terraform organization ("the organization hcw").
 */
const tokenNamePattern = (name) =>
  new RegExp(`(?<!\\b(?:organization|org)\\s+\`?)(?<![\\w/-])${escapeRegExp(name)}(?![\\w/-])`, 'i');

/**
 * The units a claim is made in: each table row whole, each heading, and each
 * sentence of the prose between them. In a Terraform file the prose is the
 * `#` comments, so their marker is dropped rather than read as a heading.
 */
function claimUnits(text, path) {
  const units = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length > 0) units.push(...paragraph.join(' ').split(/(?<=[.;!?])\s+/));
    paragraph = [];
  };
  const terraform = path.endsWith('.tf');
  for (const line of text.split('\n')) {
    const trimmed = terraform ? line.trim().replace(/^#+\s?/, '') : line.trim();
    if (trimmed === '') flush();
    else if (trimmed.startsWith('|') || trimmed.startsWith('#')) {
      flush();
      units.push(trimmed);
    } else paragraph.push(trimmed);
  }
  flush();
  return units;
}

describe('Cloudflare token kinds (#1927)', () => {
  it('has a register word and a docs word for exactly the kinds the roll code knows', () => {
    expect(Object.keys(ISSUER_BY_OWNER).sort()).toEqual(Object.keys(TOKEN_OWNERS).sort());
    expect(Object.keys(DOCS_WORD_BY_OWNER).sort()).toEqual(Object.keys(TOKEN_OWNERS).sort());
    expect(Object.keys(KIND_PHRASE).sort()).toEqual(Object.keys(TOKEN_OWNERS).sort());
  });

  it('gives every roll target a register row with its kind, its token and the roll script as the tool', () => {
    for (const [key, target] of Object.entries(CLOUDFLARE_TARGETS)) {
      expect(Object.hasOwn(target, 'owner'), key).toBe(true);
      const row = findCredential(target.id);
      expect(row, key).toBeTruthy();
      expect(row.issuer, key).toBe(ISSUER_BY_OWNER[target.owner]);
      expect(row.rotate, key).toContain(`scripts/roll-cloudflare-tokens.mjs --target ${key}`);
      if (target.tokenName) expect(row.consumer, key).toContain(`\`${target.tokenName}\``);
      // The code can build the roll route for it (an account id of the right shape stands in).
      expect(() =>
        tokenOwnerRoutes({ owner: target.owner, accountId: '00000000000000000000000000000001' })
      ).not.toThrow();
    }
  });

  it('names one of the two kinds for every Cloudflare API token row, and the roll script only for roll targets', () => {
    const targetIds = new Set(Object.values(CLOUDFLARE_TARGETS).map((target) => target.id));
    const tokenRows = CREDENTIAL_REGISTER.filter((row) => /cloudflare/i.test(row.issuer) && /token/i.test(row.issuer));
    expect(tokenRows.length).toBeGreaterThanOrEqual(targetIds.size);
    for (const row of tokenRows) {
      expect(Object.hasOwn(OWNER_BY_ISSUER, row.issuer), `${row.id}: "${row.issuer}"`).toBe(true);
    }
    for (const row of CREDENTIAL_REGISTER.filter((r) => String(r.rotate).includes('roll-cloudflare-tokens'))) {
      expect(targetIds.has(row.id), `${row.id} names the roll script but is not a roll target`).toBe(true);
    }
  });

  // Nothing schedules the roll script (#1927, decision on the issue), so no
  // Cloudflare token row may say a job renews it. A change that adds a
  // scheduled roll changes this test on purpose, in the same pull request.
  it('claims automatic renewal for no Cloudflare token: nothing schedules the roll script', () => {
    for (const row of CREDENTIAL_REGISTER.filter((r) => Object.hasOwn(OWNER_BY_ISSUER, r.issuer))) {
      expect(row.renewal, `${row.id}: nothing schedules the roll script`).not.toBe('automation');
    }
  });

  it('names the same token and kind for each workspace in the runbook tables', () => {
    const lines = repoFile('docs/runbooks/dns-token-stolen.md').split('\n');
    for (const [key, target] of Object.entries(CLOUDFLARE_TARGETS)) {
      if (target.type !== 'tfc') continue;
      const row = lines.find((line) => line.startsWith(`| \`${target.workspace}\``));
      expect(row, `${key}: no row for ${target.workspace}`).toBeTruthy();
      expect(row, key).toContain(`\`${target.tokenName}\``);
      const cells = row.split('|').map((cell) => cell.trim());
      expect(cells[3], key).toBe(DOCS_WORD_BY_OWNER[target.owner]);
      expect(row, key).toMatch(target.tokenNameConfirmed ? /\*\*Observed\*\*/ : /\*\*Not confirmed\.\*\*/);
    }
    // The renewal table: every target's row says the kind it is rolled as.
    for (const [key, target] of Object.entries(CLOUDFLARE_TARGETS)) {
      const row = lines.find((line) => line.startsWith('| ') && line.split('|')[1].includes(`\`${key}\``));
      expect(row, `${key}: no renewal row`).toBeTruthy();
      expect(row.split('|')[2].trim(), key).toBe(DOCS_WORD_BY_OWNER[target.owner]);
    }
  });

  it('says in each hcw-azure cloudflare_api_token row that the value is the hcw-azure token, of its kind', () => {
    const azure = CLOUDFLARE_TARGETS.azure;
    const claim = new RegExp(
      `${escapeRegExp(DOCS_WORD_BY_OWNER[azure.owner])}\\*{0,2} (Cloudflare )?token \`${escapeRegExp(azure.tokenName)}\``
    );
    const rows = [
      // required-inputs.md §4.1, the hcw-azure workspace table (the §4.7 row is the lab's).
      ['docs/standards/required-inputs.md', (line) => line.startsWith('| `cloudflare_api_token` | yes |')],
      ['docs/standards/variables-and-secrets.md', (line) => line.startsWith('| `cloudflare_api_token` |')],
      ['docs/runbooks/cold-rebuild.md', (line) => line.startsWith('- `cloudflare_api_token` =')],
    ];
    for (const [path, isRow] of rows) {
      const found = repoFile(path).split('\n').filter(isRow);
      expect(found, path).toHaveLength(1);
      expect(found[0], path).toMatch(claim);
    }
  });

  it('names the lab token only beside the lab, or as history (#1927)', () => {
    const lab = CLOUDFLARE_TARGETS.lab;
    const name = tokenNamePattern(lab.tokenName);
    const besideLab = new RegExp(`${escapeRegExp(lab.workspace)}|infra-lab`);
    const unpaired = [];
    // Everything in infra-lab/ is the lab's by where it is.
    for (const path of DOCS.filter((doc) => !doc.startsWith('infra-lab/'))) {
      for (const unit of claimUnits(repoFile(path), path)) {
        if (name.test(unit) && !besideLab.test(unit) && !HISTORY_MARKER.test(unit)) {
          unpaired.push(`${path}: "${unit.slice(0, 200)}"`);
        }
      }
    }
    expect(unpaired, `names ${lab.tokenName} without ${lab.workspace}, infra-lab or a history marker`).toEqual([]);
  });

  it('never pairs a named token with the other kind in any sentence of the docs', () => {
    const named = Object.values(CLOUDFLARE_TARGETS).filter((target) => target.tokenName);
    for (const path of DOCS) {
      for (const unit of claimUnits(repoFile(path), path)) {
        for (const target of named) {
          if (!tokenNamePattern(target.tokenName).test(unit)) continue;
          const kinds = Object.keys(KIND_PHRASE).filter((owner) => KIND_PHRASE[owner].test(unit));
          // A sentence naming both kinds is contrasting them; one naming none says nothing about the kind.
          if (kinds.length !== 1) continue;
          // A sentence naming two tokens of different kinds is ambiguous, and skipped.
          const others = named.filter((other) => other !== target && tokenNamePattern(other.tokenName).test(unit));
          if (others.some((other) => other.owner !== target.owner)) continue;
          expect(kinds[0], `${path}: "${unit.slice(0, 200)}"`).toBe(target.owner);
        }
      }
    }
  });

  it('reads `hcw` as the token name only when it stands alone', () => {
    const hcw = tokenNamePattern('hcw');
    expect(hcw.test('the account-owned token `hcw`')).toBe(true);
    expect(hcw.test('the HCP Terraform workspace hcw/hcw-azure')).toBe(false);
    expect(hcw.test('the workspace `hcw-azure`')).toBe(false);
    expect(hcw.test('the HCP Terraform organization hcw, a user token')).toBe(false);
    expect(hcw.test('org `hcw`')).toBe(false);
    expect(KIND_PHRASE.account.test('Manage account → Account API tokens')).toBe(true);
    expect(KIND_PHRASE.account.test('an **account-owned** Cloudflare token')).toBe(true);
    expect(KIND_PHRASE.user.test('a user API token')).toBe(true);
  });

  it('holds the DNS audit and the Terraform variable to the hcw-azure token name', () => {
    const azure = CLOUDFLARE_TARGETS.azure;
    expect(repoFile('scripts/lib/dns-audit-settings.mjs')).toMatch(
      new RegExp(`export const HCP_TERRAFORM_TOKEN_NAME = '${azure.tokenName}';`)
    );
    const variables = repoFile('infra/variables.tf');
    const block = variables.slice(variables.indexOf('variable "cloudflare_api_token"'));
    const description = block.match(/description\s*=\s*"([^"]*)"/)[1];
    expect(description).toContain(`${DOCS_WORD_BY_OWNER[azure.owner]} token ${azure.tokenName}`);
  });
});
