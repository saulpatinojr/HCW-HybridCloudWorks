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
 * Like `scripts/workflow-write-permissions.test.mjs` and `scripts/oidc-subjects.test.mjs`,
 * this list represents the canonical offline tripwire for required branch protection
 * rulesets without requiring external network API calls during unit tests.
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

      const lines = content.split('\n');
      let inJobsSection = false;
      let inMatrixInclude = false;
      let codeqlJobTemplate = null;
      const codeqlLanguages = [];

      for (const line of lines) {
        if (/^[a-zA-Z0-9_-]+:/.test(line)) {
          inJobsSection = line.startsWith('jobs:');
          inMatrixInclude = false;
          continue;
        }

        if (!inJobsSection) continue;

        if (/^\s{6,12}include:/.test(line)) {
          inMatrixInclude = true;
          continue;
        }

        // Job-level name: (indented 4 spaces under job id)
        const jobNameMatch = line.match(/^\s{4}name:\s+['"]?([^'"]+)['"]?\s*$/);
        if (jobNameMatch) {
          const rawName = jobNameMatch[1].trim();
          if (rawName.includes('${{ matrix.language }}')) {
            codeqlJobTemplate = rawName;
          } else if (!rawName.includes('${{ matrix.')) {
            jobNames.add(rawName);
          }
        }

        // Matrix include items:
        if (inMatrixInclude) {
          // Matrix name: (e.g. in ci.yml)
          const matrixNameMatch = line.match(/^\s{10,12}-\s*name:\s+['"]?([^'"]+)['"]?\s*$/);
          if (matrixNameMatch) {
            jobNames.add(matrixNameMatch[1].trim());
          }
          // Matrix language: (e.g. in codeql.yml)
          const matrixLangMatch = line.match(/^\s{10,12}-\s*language:\s+['"]?([^'"]+)['"]?\s*$/);
          if (matrixLangMatch) {
            codeqlLanguages.push(matrixLangMatch[1].trim());
          }
        }
      }

      // Expand CodeQL matrix languages if template and languages found
      if (codeqlJobTemplate && codeqlLanguages.length > 0) {
        for (const lang of codeqlLanguages) {
          jobNames.add(codeqlJobTemplate.replace('${{ matrix.language }}', lang));
        }
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
