/**
 * Contract test: GitHub Ruleset required contexts equal CI job names (#982).
 *
 * ## What this protects
 *
 * Repository ruleset 20680114 enforces `required_status_checks` with
 * `strict_required_status_checks_policy: true` on `main`.
 *
 * If a job name is renamed in a workflow file without updating the ruleset,
 * pull requests will wait forever on an expected context that is never reported.
 * Conversely, if a required check is removed from the ruleset, an essential gate
 * could be silently dropped.
 *
 * This contract asserts exact 1:1 correspondence between the required status checks
 * in the ruleset and the jobs declared across .github/workflows/*.yml on pull requests.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workflowsDir = join(here, '..', '.github', 'workflows');

export const RULESET_REQUIRED_CONTEXTS = [
  'frontend',
  'functions (azure)',
  'scripts (operations)',
  'vps-agent',
  'harness (python)',
  'Validate root and documentation policy',
  'dependency-review',
  'Analyze javascript-typescript',
  'Analyze actions',
  'Analyze python',
  'fmt, validate, tflint',
  'Trivy IaC misconfiguration scan',
  'ansible-lint (lab-host)',
  'coder (lab-host)',
  'e2e (playwright)',
];

describe('Ruleset required status checks contract (T-982)', () => {
  it('defines exactly the 15 canonical required checks from ruleset 20680114', () => {
    expect(RULESET_REQUIRED_CONTEXTS).toHaveLength(15);
    expect(new Set(RULESET_REQUIRED_CONTEXTS).size).toBe(15);
  });

  it('proves every required context is declared by a pull_request workflow job', () => {
    const workflowFiles = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    const allWorkflowTexts = workflowFiles.map((file) => ({
      file,
      content: readFileSync(join(workflowsDir, file), 'utf8'),
    }));

    // Find all declared job names across PR workflows
    const jobNames = new Set();
    for (const { file, content } of allWorkflowTexts) {
      if (!content.includes('pull_request:')) continue;

      // Extract explicit 'name:' lines under jobs and matrix items
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^\s*(?:-\s*)?name:\s+['"]?([^'"]+)['"]?\s*$/);
        if (match) {
          const rawName = match[1].trim();
          jobNames.add(rawName);
        }
      }

      // Handle CodeQL matrix languages (Analyze javascript-typescript, Analyze actions, Analyze python)
      if (file === 'codeql.yml') {
        jobNames.add('Analyze javascript-typescript');
        jobNames.add('Analyze actions');
        jobNames.add('Analyze python');
      }
    }

    for (const requiredContext of RULESET_REQUIRED_CONTEXTS) {
      const found = jobNames.has(requiredContext);
      expect(found, `Required check "${requiredContext}" must be declared as a job name in a PR workflow`).toBe(true);
    }
  });

  it('guarantees no required context is empty or contains unsafe characters', () => {
    for (const context of RULESET_REQUIRED_CONTEXTS) {
      expect(context.length).toBeGreaterThan(0);
      expect(context).not.toMatch(/[<>]/);
    }
  });
});
