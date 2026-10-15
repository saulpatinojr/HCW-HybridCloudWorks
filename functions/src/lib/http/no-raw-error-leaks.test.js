/**
 * no-raw-error-leaks.test.js — repository guard enforcing AP-B10 error sanitization.
 *
 * Verifies that admin HTTP handler modules do not leak internal exception details
 * (such as Cosmos errors, DB connection strings, or provider errors) via
 * `error: error?.message` or `message: error?.message` in response bodies.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('no-raw-error-leaks repository guard (AP-B10)', () => {
  const TARGET_FILES = [
    'cms/content-create.js',
    'cms/content-update.js',
    'cms/drafts-handlers.js',
    'cms/publish.js',
    'cms/set-slug.js',
    'cms/rehost-images.js',
    'cms/image-prompts/handlers.js',
    'content-workflow/shared.js',
    'manual-images/shared.js',
    'gallery-images.js',
    'labs.js',
    'snapshots-publish.js',
    'social-caption.js',
    'ai/proxy.js',
    'timers/reviewer-digest.js',
  ];

  it.each(TARGET_FILES)('enforces %s does not leak raw error.message in HTTP responses', (relPath) => {
    const fullPath = path.resolve(__dirname, '..', relPath);
    const content = fs.readFileSync(fullPath, 'utf8');

    // Reject patterns like: message: error?.message, error: error?.message, message: err?.message, error: err?.message
    const rawErrorRegex = /(message|error):\s*(error|err)\?\.message/g;
    const matches = [...content.matchAll(rawErrorRegex)];

    expect(
      matches,
      `Found raw error leaks in ${relPath}: ${matches.map((m) => m[0]).join(', ')}`
    ).toHaveLength(0);
  });
});
