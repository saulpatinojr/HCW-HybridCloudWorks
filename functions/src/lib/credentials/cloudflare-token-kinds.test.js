/**
 * The guard #1927 asked for: the credential register, the DNS token runbook,
 * the standards pages and the audit settings cannot name a kind of Cloudflare
 * token, or a token, that the roll code (cloudflare-roll.js) does not hold
 * for that place.
 *
 * Why it exists: until #1927 every one of those places named the user token
 * `hcp-terraform-cloudflare-dns` as hcw-azure's, while the workspace really
 * held the account-owned token `hcw`, and the register said "renewed by
 * automation" for a token the script could not roll. CLOUDFLARE_TARGETS is
 * the one place that says which token each store holds and which kind it is;
 * everything below is held to it.
 */
import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { CLOUDFLARE_TARGETS, TOKEN_OWNERS, tokenOwnerRoutes } from './cloudflare-roll.js';
import { CREDENTIAL_REGISTER, findCredential } from './register.js';

const repoFile = (path) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

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

describe('Cloudflare token kinds (#1927)', () => {
  it('has a register word and a docs word for exactly the kinds the roll code knows', () => {
    expect(Object.keys(ISSUER_BY_OWNER).sort()).toEqual(Object.keys(TOKEN_OWNERS).sort());
    expect(Object.keys(DOCS_WORD_BY_OWNER).sort()).toEqual(Object.keys(TOKEN_OWNERS).sort());
  });

  it('gives every roll target a register row whose issuer is the kind the code rolls it as', () => {
    for (const [key, target] of Object.entries(CLOUDFLARE_TARGETS)) {
      const row = findCredential(target.id);
      expect(row, key).toBeTruthy();
      expect(row.renewal, key).toBe('automation');
      expect(row.issuer, key).toBe(ISSUER_BY_OWNER[target.owner]);
      if (target.tokenName) expect(row.consumer, key).toContain(`\`${target.tokenName}\``);
      // The code can build the roll route for it (an account id of the right shape stands in).
      expect(() =>
        tokenOwnerRoutes({ owner: target.owner, accountId: '00000000000000000000000000000001' })
      ).not.toThrow();
    }
  });

  it('claims automatic renewal only for Cloudflare tokens the roll code can renew', () => {
    const targetIds = new Set(Object.values(CLOUDFLARE_TARGETS).map((target) => target.id));
    const automatedCloudflare = CREDENTIAL_REGISTER.filter(
      (row) => row.renewal === 'automation' && /cloudflare/i.test(row.issuer)
    );
    expect(automatedCloudflare.length).toBeGreaterThan(0);
    for (const row of automatedCloudflare) {
      expect(targetIds.has(row.id), `${row.id} says automation but is not a roll target`).toBe(true);
      expect(Object.hasOwn(OWNER_BY_ISSUER, row.issuer), `${row.id} names a kind the code cannot roll`).toBe(true);
    }
  });

  it('names the same token and kind for each workspace in the runbook table', () => {
    const runbook = repoFile('docs/runbooks/dns-token-stolen.md');
    for (const [key, target] of Object.entries(CLOUDFLARE_TARGETS)) {
      if (target.type !== 'tfc') continue;
      const row = runbook.split('\n').find((line) => line.startsWith(`| \`${target.workspace}\``));
      expect(row, `${key}: no row for ${target.workspace}`).toBeTruthy();
      expect(row, key).toContain(`\`${target.tokenName}\``);
      const cells = row.split('|').map((cell) => cell.trim());
      expect(cells[3], key).toBe(DOCS_WORD_BY_OWNER[target.owner]);
      expect(row, key).toMatch(target.tokenNameConfirmed ? /\*\*Observed\*\*/ : /\*\*Not confirmed\.\*\*/);
    }
    // The renewal table: every target's row says the kind it is rolled as.
    for (const [key, target] of Object.entries(CLOUDFLARE_TARGETS)) {
      const row = runbook.split('\n').find((line) => line.startsWith('| ') && line.split('|')[1].includes(`\`${key}\``));
      expect(row, `${key}: no renewal row`).toBeTruthy();
      expect(row.split('|')[2].trim(), key).toBe(DOCS_WORD_BY_OWNER[target.owner]);
    }
  });

  it('never pairs a named token with the other kind in any sentence of the docs', () => {
    const named = Object.values(CLOUDFLARE_TARGETS).filter((target) => target.tokenName);
    const kindPhrase = {
      user: /\buser token\b/i,
      account: /\baccount-owned\b/i,
    };
    for (const path of DOCS) {
      const sentences = repoFile(path).split(/(?<=[.;])\s+|\n\s*\n|\|/);
      for (const sentence of sentences) {
        for (const target of named) {
          if (!sentence.includes(`\`${target.tokenName}\``) && !sentence.includes(` ${target.tokenName} `)) continue;
          const kinds = Object.keys(kindPhrase).filter((owner) => kindPhrase[owner].test(sentence));
          // A sentence naming both kinds is contrasting them; one naming none says nothing about the kind.
          if (kinds.length !== 1) continue;
          // A sentence naming two tokens is checked only when both are of that kind.
          const others = named.filter((other) => other !== target && sentence.includes(other.tokenName));
          if (others.some((other) => other.owner !== target.owner)) continue;
          expect(kinds[0], `${path}: "${sentence.trim().slice(0, 160)}"`).toBe(target.owner);
        }
      }
    }
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
