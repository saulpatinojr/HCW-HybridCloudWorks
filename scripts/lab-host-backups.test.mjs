/**
 * The lab host's off-host backups (LAB-9, #955): lab-host/ansible/roles/backups.
 *
 * Two layers, as in lab-host-bootstrap-lock.test.mjs. The shape, read from
 * the files on every platform: the role runs last with its tag, the Coder
 * dump uploads only while the role's env file exists, the units skip rather
 * than fail before the seed, the syslog tag and the blob prefixes are the
 * ones the Azure alerts and the alerting runbook read. And the four helpers
 * themselves, run with bash against a stand-in curl and a stand-in vault
 * that record what they were asked, wherever a bash is usable (CI's Linux
 * runner and Git Bash alike): the Arc challenge is answered from the key
 * file the agent names and from nowhere else, no secret ever reaches an
 * argument, the blob lands under KIND/<name>, and the seed stores a
 * root-only token without printing one.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROLE = join(REPO, 'lab-host', 'ansible', 'roles', 'backups');
const read = (...parts) => readFileSync(join(REPO, ...parts), 'utf8');
const helper = (name) => join(ROLE, 'files', name).replaceAll('\\', '/');

const site = read('lab-host', 'ansible', 'site.yml');
const groupVars = read('lab-host', 'ansible', 'group_vars', 'all.yml');
const tasks = read('lab-host', 'ansible', 'roles', 'backups', 'tasks', 'main.yml');
const service = read('lab-host', 'ansible', 'roles', 'backups', 'templates', 'hcw-vault-backup.service.j2');
const timer = read('lab-host', 'ansible', 'roles', 'backups', 'templates', 'hcw-vault-backup.timer.j2');
const dump = read('lab-host', 'ansible', 'roles', 'coder', 'templates', 'coder-postgres-backup.sh.j2');
const upload = readFileSync(helper('hcw-backup-upload'), 'utf8');
const arcToken = readFileSync(helper('hcw-arc-token'), 'utf8');
const vaultBackup = readFileSync(helper('hcw-vault-backup'), 'utf8');
const seed = readFileSync(helper('hcw-vault-backup-seed'), 'utf8');
const alerting = read('docs', 'runbooks', 'alerting-and-support.md');
const infra = read('infra', 'lab-hybrid-backups.tf');
const readme = read('lab-host', 'README.md');

describe('the backups role in the play', () => {
  it('runs last, tagged, after vault', () => {
    const roles = [...site.matchAll(/^ {4}- role: ([a-z_]+)\n/gm)].map((m) => m[1]);
    expect(roles.at(-1)).toBe('backups');
    expect(roles.at(-2)).toBe('vault');
    expect(site).toMatch(/- role: backups\n {6}tags: \[backups\]/);
    expect(readme.slice(readme.indexOf('### Running part of the play'))).toContain('`backups`');
  });

  it('is switched by the Arc fact and points at the account infra creates', () => {
    expect(groupVars).toMatch(/^backups_enabled: "\{\{ arc_enabled \}\}"$/m);
    expect(groupVars).toMatch(/^backups_storage_account: stlabhybridprodcus01$/m);
    expect(groupVars).toMatch(/^backups_container: host-backups$/m);
    expect(infra).toContain('"stlabhybrid${var.environment}${var.region_abbreviation}01"');
    expect(infra).toMatch(/name\s*=\s*"host-backups"/);
  });

  it('installs the helpers whatever the switch and gates the env file and the timer on it', () => {
    for (const [src, dest] of [
      ['hcw-arc-token', '/usr/local/libexec/hcw-arc-token'],
      ['hcw-backup-upload', '/usr/local/sbin/hcw-backup-upload'],
      ['hcw-vault-backup', '/usr/local/libexec/hcw-vault-backup'],
      ['hcw-vault-backup-seed', '/usr/local/sbin/hcw-vault-backup-seed'],
    ]) {
      const block = tasks.slice(tasks.indexOf(`src: ${src}\n`), tasks.indexOf(`src: ${src}\n`) + 200);
      expect(block, src).toContain(`dest: ${dest}`);
      expect(block, src).toContain('mode: "0750"');
      expect(block, src).not.toContain('when:');
    }
    expect(tasks).toMatch(/src: upload\.env\.j2[\s\S]*?when: backups_enabled \| bool/);
    expect(tasks).toMatch(/Remove the upload destination[\s\S]*?when: not backups_enabled \| bool/);
    expect(tasks).toMatch(/Enable the nightly Vault snapshot timer[\s\S]*?when: backups_enabled \| bool and vault_enabled \| bool/);
    expect(tasks).toMatch(/argv:\n {6}- \/usr\/local\/sbin\/hcw-backup-upload\n {6}- --check/);
  });

  it('skips the snapshot before the seed instead of failing it, and reports a failure to the notifier', () => {
    expect(service).toContain('ConditionPathExists={{ backups_vault_token_file }}');
    expect(service).toContain('OnFailure=hcw-unit-failed@%n.service');
    expect(service).toContain('ExecStart=/usr/local/libexec/hcw-vault-backup');
    expect(service).toContain('ProtectSystem=strict');
    expect(service).toContain('ReadWritePaths={{ backups_vault_dir }}');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('OnCalendar={{ backups_vault_on_calendar }}');
  });

  it('uploads the Coder dump only while the env file exists, after the dump is in place', () => {
    const hook = dump.indexOf('if [ -r /etc/hcw/backups/upload.env ]; then');
    expect(hook).toBeGreaterThan(dump.indexOf('mv "${target}.partial" "$target"'));
    expect(dump.slice(hook)).toContain('/usr/local/sbin/hcw-backup-upload coder "$target"');
    expect(dump).not.toContain('never leaves the host');
  });

  it('logs under the tag and prefixes the alerts and the runbook read', () => {
    expect(upload).toContain('logger -t hcw-backup-upload');
    expect(alerting).toContain('journalctl -t hcw-backup-upload');
    expect(alerting).toContain('hcw-vault-backup.timer');
    expect(upload).toContain('"${base}/${kind}/${name}"');
    expect(upload).toMatch(/coder\|vault\)/);
    expect(infra).toContain('/host-backups/coder/');
    expect(infra).toContain('/host-backups/vault/');
  });

  it('keeps every secret out of argv', () => {
    // The challenge answer and the bearer token go to curl as configuration on stdin.
    expect(arcToken).toContain('-K -');
    expect(arcToken).not.toMatch(/-H "Authorization/);
    expect(upload).toContain('-K -');
    expect(upload).not.toMatch(/-H "Authorization/);
    // The Vault token goes to the CLI through its environment, and `token renew` prints it.
    expect(vaultBackup).toContain('export VAULT_TOKEN');
    expect(vaultBackup).toMatch(/token renew >\/dev\/null/);
    expect(seed).toContain('export VAULT_TOKEN="$line"');
    expect(seed).toContain('-field=token');
  });
});

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });
// On Windows only a Git Bash (MSYSTEM set) is the bash these helpers are
// written for; System32's bash is WSL, which cannot see these paths.
const bashUsable =
  (process.platform !== 'win32' || Boolean(process.env.MSYSTEM)) && run('bash', ['-c', 'true']).status === 0;

/** A stand-in curl: records argv, the configuration on stdin and the URL; answers by scenario. */
const CURL = `#!/usr/bin/env bash
set -u
args=("$@"); url="\${args[\${#args[@]}-1]}"
config=''; out=''; upload=''; headers=0; code=0
i=0
while [ "$i" -lt "\${#args[@]}" ]; do
  case "\${args[$i]}" in
    -D) headers=1; i=$((i+1)) ;;
    -K) config="$(cat)"; i=$((i+1)) ;;
    -o) out="\${args[$((i+1))]}"; i=$((i+1)) ;;
    -T) upload="\${args[$((i+1))]}"; i=$((i+1)) ;;
    -w) code=1; i=$((i+1)) ;;
  esac
  i=$((i+1))
done
printf '%s\\n' "$*" >> "$STUB_DIR/curl.argv"
printf '%s\\n---\\n' "$config" >> "$STUB_DIR/curl.config"
printf '%s\\n' "$url" >> "$STUB_DIR/curl.urls"
secret="$(tr -d '\\r\\n' < "$STUB_DIR/tokens/one.key")"
if [ "$headers" = 1 ]; then
  case "$STUB_SCENARIO" in
    no-challenge) printf 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n' ;;
    realm-outside) printf 'HTTP/1.1 401 Unauthorized\\r\\nWWW-Authenticate: Basic realm=/tmp/elsewhere/one.key\\r\\n\\r\\n' ;;
    *) printf 'HTTP/1.1 401 Unauthorized\\r\\nWww-Authenticate: Basic realm=%s/one.key\\r\\n\\r\\n' "$STUB_DIR/tokens" ;;
  esac
  exit 0
fi
if printf '%s' "$config" | grep -q "Authorization: Basic $secret\\"\$"; then
  printf '{"access_token":"arc-token-123","expires_on":"1760500000","resource":"https://storage.azure.com/","token_type":"Bearer"}'
  exit 0
fi
if printf '%s' "$config" | grep -q 'Authorization: Basic'; then exit 22; fi
bearer='Authorization: Bearer'
if ! printf '%s' "$config" | grep -q "$bearer arc-token-123\\""; then printf '<Error><Code>NoBearer</Code></Error>' > "$out"; echo 401; exit 0; fi
if [ -n "$upload" ]; then
  cp "$upload" "$STUB_DIR/uploaded.bin"
  case "$STUB_SCENARIO" in
    forbidden) printf '<Error><Code>AuthorizationPermissionMismatch</Code></Error>' > "$out"; echo 403 ;;
    *) : > "$out"; echo 201 ;;
  esac
  exit 0
fi
case "$url" in
  *restype=container*comp=list*)
    case "$STUB_SCENARIO" in
      forbidden) printf '<Error><Code>AuthorizationPermissionMismatch</Code></Error>' > "$out"; echo 403 ;;
      *) printf '<EnumerationResults/>' > "$out"; echo 200 ;;
    esac ;;
  *) echo 500 ;;
esac
`;

/** A stand-in vault CLI: records argv and VAULT_TOKEN, answers the five commands the helpers use. */
const VAULT = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$STUB_DIR/vault.argv"
printf '%s\\n' "\${VAULT_TOKEN:-<unset>}" >> "$STUB_DIR/vault.tokens"
printf '%s %s\\n' "\${VAULT_ADDR:-<unset>}" "\${VAULT_CACERT:-<unset>}" >> "$STUB_DIR/vault.env"
valid=" \${STUB_VAULT_VALID_TOKENS:-} "
case "$1 $2" in
  "token renew")
    [ "\${STUB_VAULT_RENEW_FAIL:-0}" = 1 ] && { echo 'Error renewing token: permission denied' >&2; exit 2; }
    printf 'Key    Value\\n---    -----\\ntoken  %s\\n' "$VAULT_TOKEN"; exit 0 ;;
  "token lookup")
    case "$valid" in *" \${VAULT_TOKEN:-} "*) ;; *) echo 'Error looking up token: permission denied' >&2; exit 2 ;; esac
    if [ "\${3:-}" = -format=json ]; then printf '{\\n  "data": {\\n    "expire_time": "2026-11-13T03:45:00Z"\\n  }\\n}\\n'; else printf 'Key   Value\\n'; fi; exit 0 ;;
  "policy write") cat > "$STUB_DIR/policy.$3"; exit 0 ;;
  "token create") echo 'stand-in-fresh-snapshot-token-00001'; exit 0 ;;
  "token revoke") echo "$VAULT_TOKEN" >> "$STUB_DIR/vault.revoked"; exit 0 ;;
  "operator raft") printf 'raft-snapshot-bytes' > "$5"; exit 0 ;;
esac
echo "stand-in vault: unexpected $*" >&2; exit 9
`;

describe.skipIf(!bashUsable)('the helpers, run', () => {
  let dir, env;
  const bash = (script, args = [], extra = {}, input) =>
    run('bash', [script, ...args], { env: { ...env, ...extra }, input, timeout: 20000 });
  const lines = (name) => readFileSync(join(dir, name), 'utf8').trim().split('\n');

  beforeEach(() => {
    // Forward slashes throughout: the helpers compare the path the agent names
    // with the directory they were given, and Git Bash takes C:/... paths.
    dir = mkdtempSync(join(tmpdir(), 'hcw-backups-')).replaceAll('\\', '/');
    mkdirSync(join(dir, 'tokens'));
    writeFileSync(join(dir, 'tokens', 'one.key'), 'Y2hhbGxlbmdlLXNlY3JldA==\n');
    writeFileSync(join(dir, 'curl'), CURL);
    writeFileSync(join(dir, 'vault'), VAULT);
    chmodSync(join(dir, 'curl'), 0o755);
    chmodSync(join(dir, 'vault'), 0o755);
    writeFileSync(join(dir, 'upload.env'), 'HCW_BACKUPS_ACCOUNT=stlabhybridprodcus01\nHCW_BACKUPS_CONTAINER=host-backups\nHCW_BACKUPS_API_VERSION=2024-11-04\n');
    writeFileSync(join(dir, 'hcw-vault.sh'), 'export VAULT_ADDR=https://127.0.0.1:8200\nexport VAULT_CACERT=/etc/vault.d/tls/vault.crt\n');
    writeFileSync(join(dir, 'coder-20261014T033000Z.sql.gz'), 'not really gzip');
    env = {
      PATH: process.env.PATH,
      STUB_DIR: dir,
      STUB_SCENARIO: 'ok',
      HCW_CURL: `${dir}/curl`,
      HCW_ARC_TOKENS_DIR: `${dir}/tokens`,
      HCW_ARC_TOKEN_URL: 'http://127.0.0.1:40342/metadata/identity/oauth2/token?api-version=2020-06-01',
      HCW_ARC_TOKEN: helper('hcw-arc-token'),
      HCW_BACKUPS_ENV: `${dir}/upload.env`,
      HCW_BACKUP_UPLOAD: helper('hcw-backup-upload'),
      HCW_VAULT_BIN: `${dir}/vault`,
      HCW_VAULT_ENV: `${dir}/hcw-vault.sh`,
      HCW_VAULT_BACKUP_TOKEN_FILE: `${dir}/etc/vault-token`,
      HCW_VAULT_BACKUP_DIR: `${dir}/snapshots`,
      HCW_VAULT_BACKUP_KEEP_DAYS: '7',
    };
  });
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  describe('hcw-arc-token', () => {
    it('answers the challenge from the key file the agent names and prints the token alone', () => {
      const { status, stdout, stderr } = bash(helper('hcw-arc-token'), ['https://storage.azure.com/']);
      expect(stderr).toBe('');
      expect(status).toBe(0);
      expect(stdout).toBe('arc-token-123\n');
      const urls = lines('curl.urls');
      expect(urls).toHaveLength(2);
      expect(urls[0]).toBe(`${env.HCW_ARC_TOKEN_URL}&resource=https%3A%2F%2Fstorage.azure.com%2F`);
      // The secret reached curl on stdin, not in argv.
      expect(readFileSync(join(dir, 'curl.argv'), 'utf8')).not.toContain('Y2hhbGxlbmdlLXNlY3JldA==');
      expect(readFileSync(join(dir, 'curl.config'), 'utf8')).toContain('header = "Authorization: Basic Y2hhbGxlbmdlLXNlY3JldA=="');
    });

    it('refuses a challenge naming a file outside the token directory, before reading anything', () => {
      const { status, stdout, stderr } = bash(helper('hcw-arc-token'), ['https://storage.azure.com/'], { STUB_SCENARIO: 'realm-outside' });
      expect(status).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('which is not a .key file in');
      expect(lines('curl.urls')).toHaveLength(1);
    });

    it('refuses an endpoint that does not challenge', () => {
      const { status, stderr } = bash(helper('hcw-arc-token'), ['https://storage.azure.com/'], { STUB_SCENARIO: 'no-challenge' });
      expect(status).toBe(1);
      expect(stderr).toContain('answered 200 rather than a 401 challenge');
    });

    it('takes exactly one resource', () => {
      expect(bash(helper('hcw-arc-token')).status).toBe(2);
    });
  });

  describe('hcw-backup-upload', () => {
    it('puts the file under KIND/<name> with the bearer token on stdin and says so', () => {
      const file = join(dir, 'coder-20261014T033000Z.sql.gz');
      const { status, stderr } = bash(helper('hcw-backup-upload'), ['coder', file]);
      expect(stderr.trim()).toBe('hcw-backup-upload: uploaded coder/coder-20261014T033000Z.sql.gz (15 bytes) to stlabhybridprodcus01/host-backups');
      expect(status).toBe(0);
      expect(lines('curl.urls').at(-1)).toBe('https://stlabhybridprodcus01.blob.core.windows.net/host-backups/coder/coder-20261014T033000Z.sql.gz');
      expect(readFileSync(join(dir, 'uploaded.bin'), 'utf8')).toBe('not really gzip');
      const config = readFileSync(join(dir, 'curl.config'), 'utf8');
      // Joined here so a secret scanner does not read the stand-in as a credential.
      expect(config).toContain(['header = "Authorization:', 'Bearer arc-token-123"'].join(' '));
      expect(config).toContain('header = "x-ms-version: 2024-11-04"');
      expect(config).toContain('header = "x-ms-blob-type: BlockBlob"');
      expect(readFileSync(join(dir, 'curl.argv'), 'utf8')).not.toContain('arc-token-123');
    });

    it('names the refusal Azure gave and keeps the dump', () => {
      const file = join(dir, 'coder-20261014T033000Z.sql.gz');
      const { status, stderr } = bash(helper('hcw-backup-upload'), ['coder', file], { STUB_SCENARIO: 'forbidden' });
      expect(status).toBe(1);
      expect(stderr).toContain('answered HTTP 403 (AuthorizationPermissionMismatch)');
      expect(stderr).toContain(`the dump stays at ${file}`);
      expect(statSync(file).size).toBe(15);
    });

    it('--check lists the container once and says the identity may', () => {
      const { status, stderr } = bash(helper('hcw-backup-upload'), ['--check']);
      expect(stderr.trim()).toBe('hcw-backup-upload: the Arc identity can list stlabhybridprodcus01/host-backups');
      expect(status).toBe(0);
      expect(lines('curl.urls').at(-1)).toBe('https://stlabhybridprodcus01.blob.core.windows.net/host-backups?restype=container&comp=list&maxresults=1');
    });

    it('--check names the missing grant on a 403', () => {
      const { status, stderr } = bash(helper('hcw-backup-upload'), ['--check'], { STUB_SCENARIO: 'forbidden' });
      expect(status).toBe(1);
      expect(stderr).toContain('Storage Blob Data Contributor grant on the container is missing');
    });

    it('refuses an unknown kind, a missing file and a missing env file without asking for a token', () => {
      expect(bash(helper('hcw-backup-upload'), ['portainer', join(dir, 'upload.env')]).status).toBe(2);
      const missing = bash(helper('hcw-backup-upload'), ['coder', join(dir, 'absent.sql.gz')]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('is not a regular file; nothing was uploaded');
      const off = bash(helper('hcw-backup-upload'), ['coder', join(dir, 'coder-20261014T033000Z.sql.gz')], { HCW_BACKUPS_ENV: join(dir, 'no.env') });
      expect(off.status).toBe(1);
      expect(off.stderr).toContain('off-host backups are off on this host');
      expect(() => lines('curl.urls')).toThrow();
    });
  });

  describe('hcw-vault-backup', () => {
    beforeEach(() => {
      mkdirSync(join(dir, 'etc'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-seeded-snapshot-token-001\n');
    });

    it('renews the token, snapshots, prunes and uploads under vault/', () => {
      const { status, stdout, stderr } = bash(helper('hcw-vault-backup'));
      expect(stderr).toMatch(/^hcw-backup-upload: uploaded vault\/vault-\d{8}T\d{6}Z\.snap \(19 bytes\) to stlabhybridprodcus01\/host-backups\n$/);
      expect(status).toBe(0);
      expect(stdout).toMatch(/^hcw-vault-backup: wrote .*vault-\d{8}T\d{6}Z\.snap \(19 bytes\) and uploaded it\n$/);
      const calls = lines('vault.argv');
      expect(calls[0]).toBe('token renew');
      expect(calls[1]).toMatch(/^operator raft snapshot save .*\.snap\.partial$/);
      expect(new Set(lines('vault.tokens'))).toEqual(new Set(['stand-in-seeded-snapshot-token-001']));
      expect(lines('vault.env')[0]).toBe('https://127.0.0.1:8200 /etc/vault.d/tls/vault.crt');
      expect(lines('curl.urls').at(-1)).toMatch(/\/host-backups\/vault\/vault-\d{8}T\d{6}Z\.snap$/);
      // The renewal's output, which names the token, went nowhere.
      expect(stdout + stderr).not.toMatch(/stand-in-[a-z-]+-token/);
    });

    it('stops at a token that will not renew, naming the seed, before taking a snapshot', () => {
      const { status, stderr } = bash(helper('hcw-vault-backup'), [], { STUB_VAULT_RENEW_FAIL: '1' });
      expect(status).toBe(1);
      expect(stderr).toContain('could not be renewed');
      expect(stderr).toContain('hcw-vault-backup-seed --force');
      expect(lines('vault.argv')).toEqual(['token renew']);
    });

    it('refuses to run without the token file, naming the seed', () => {
      rmSync(join(dir, 'etc', 'vault-token'));
      const { status, stderr } = bash(helper('hcw-vault-backup'));
      expect(status).toBe(1);
      expect(stderr).toContain('seed the snapshot token with hcw-vault-backup-seed');
    });
  });

  describe('hcw-vault-backup-seed', () => {
    const owner = 'stand-in-owner-root-token-00000001';

    it('writes the policy, creates a periodic orphan token and stores it root-only without printing one', () => {
      const { status, stdout, stderr } = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-fresh-snapshot-token-00001` }, `﻿${owner}\r\n`);
      expect(stderr).toBe('');
      expect(status).toBe(0);
      expect(stdout).toContain('stored the snapshot token for policy hcw-raft-snapshot');
      expect(stdout).toContain('expires on 2026-11-13T03:45:00Z');
      expect(stdout).toContain('sudo systemctl start hcw-vault-backup.service');
      expect(stdout).not.toMatch(/stand-in-[a-z-]+-token/);
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-fresh-snapshot-token-00001\n');
      if (process.platform !== 'win32') expect(statSync(join(dir, 'etc', 'vault-token')).mode & 0o777).toBe(0o600);
      const policy = readFileSync(join(dir, 'policy.hcw-raft-snapshot'), 'utf8');
      expect(policy).toContain('path "sys/storage/raft/snapshot" { capabilities = ["read"] }');
      expect(policy).toContain('path "auth/token/renew-self" { capabilities = ["update"] }');
      expect(policy).not.toMatch(/secret|sys\/raw|\*/);
      const calls = lines('vault.argv');
      expect(calls).toContain('policy write hcw-raft-snapshot -');
      expect(calls).toContain('token create -policy=hcw-raft-snapshot -no-default-policy -orphan -period=720h -display-name=hcw-vault-backup -field=token');
      // The owner's token was used for the lookup, the policy and the create, and appears nowhere else.
      expect(readFileSync(join(dir, 'vault.argv'), 'utf8')).not.toContain(owner);
    });

    it('leaves a working token alone, and replaces and revokes it with --force', () => {
      mkdirSync(join(dir, 'etc'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-old-working-token-0000001\n');
      const valid = { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-old-working-token-0000001 stand-in-fresh-snapshot-token-00001` };
      const kept = bash(helper('hcw-vault-backup-seed'), [], valid, `${owner}\n`);
      expect(kept.status).toBe(0);
      expect(kept.stdout).toContain('already stored');
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-old-working-token-0000001\n');
      const forced = bash(helper('hcw-vault-backup-seed'), ['--force'], valid, `${owner}\n`);
      expect(forced.status).toBe(0);
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-fresh-snapshot-token-00001\n');
      expect(lines('vault.revoked')).toEqual(['stand-in-old-working-token-0000001']);
    });

    it('refuses an empty line, a non-token and a token Vault rejects, before writing anything', () => {
      const empty = bash(helper('hcw-vault-backup-seed'), [], {}, '\n');
      expect(empty.status).toBe(2);
      expect(empty.stderr).toContain('the token on stdin was empty; nothing was changed');
      const shape = bash(helper('hcw-vault-backup-seed'), [], {}, 'not a token\n');
      expect(shape.status).toBe(2);
      expect(shape.stderr).toContain('is not a Vault token');
      const rejected = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: '' }, `${owner}\n`);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('Vault did not accept the token on stdin');
      expect(() => statSync(join(dir, 'etc', 'vault-token'))).toThrow();
      expect(() => lines('policy.hcw-raft-snapshot')).toThrow();
    });
  });
});
