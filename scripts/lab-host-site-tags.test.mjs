/**
 * lab-host/ansible/site.yml can be narrowed to the roles that changed
 * (bootstrap.sh --tags <role>; lab-host/README.md, "Running part of the
 * play"). What makes that safe is held here: every role carries its own name
 * as a tag, the pre-flight and the privilege checks run whatever the tags,
 * and the commit record — the host's claim that the whole playbook
 * converged — is written only by a full run, in the play and in bootstrap.sh
 * alike.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = readFileSync(join(REPO, 'lab-host/ansible/site.yml'), 'utf8');
const bootstrap = readFileSync(join(REPO, 'lab-host/bootstrap.sh'), 'utf8');
const readme = readFileSync(join(REPO, 'lab-host/README.md'), 'utf8');
const cfg = readFileSync(join(REPO, 'lab-host/ansible/ansible.cfg'), 'utf8');

describe('site.yml narrowed runs', () => {
  const roles = [...site.matchAll(/^ {4}- role: ([a-z_]+)\n((?: {6}.*\n)*)/gm)].map((m) => ({ name: m[1], body: m[2] }));

  it('every role carries its own name as a tag, and the README names every one of them', () => {
    expect(roles.length).toBeGreaterThanOrEqual(13);
    for (const { name, body } of roles) expect(body, name).toContain(`tags: [${name}]`);
    const listed = readme.slice(readme.indexOf('### Running part of the play'), readme.indexOf('### Which commit runs'));
    for (const { name } of roles) expect(listed, name).toContain(`\`${name}\``);
  });

  it('the pre-flight and the privilege checks run whatever the tags', () => {
    const pre = site.slice(site.indexOf('  pre_tasks:'), site.indexOf('  roles:'));
    const preTasks = [...pre.matchAll(/^ {4}- name: (.+)\n((?: {6}.*\n)*)/gm)];
    expect(preTasks.length).toBeGreaterThanOrEqual(4);
    for (const m of preTasks) expect(m[2], m[1]).toContain('tags: [always]');
    const post = site.slice(site.indexOf('  post_tasks:'));
    const check = post.slice(post.indexOf("- name: Check the container runtime's privilege separation"), post.indexOf('- name: Read the commit'));
    expect(check).toContain('tags: [always]');
  });

  it('the commit record is written only by a full run, in the play and in bootstrap.sh', () => {
    const post = site.slice(site.indexOf('  post_tasks:'));
    const record = post.slice(post.indexOf('- name: Record the commit this host converged from'));
    expect(record).toContain("when: ansible_run_tags == ['all'] and ansible_skip_tags | length == 0");
    expect(bootstrap).toContain('--tags | --tags=* | -t | --skip-tags | --skip-tags=*) hcw_partial=1 ;;');
    expect(bootstrap).toContain('if [ -z "${hcw_check_mode}" ] && [ -z "${hcw_partial}" ]; then');
  });

  it('prints the slowest tasks after the recap', () => {
    expect(cfg).toContain('callbacks_enabled = ansible.posix.profile_tasks');
    expect(cfg).toMatch(/\[callback_profile_tasks\]\ntask_output_limit = 20\nsort_order = descending/);
  });
});
