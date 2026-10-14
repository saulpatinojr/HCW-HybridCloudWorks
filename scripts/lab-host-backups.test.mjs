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
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const dumpGz = gzipSync('select 1;\n');
const dumpBytes = dumpGz.length;

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
      ['hcw-backup-restore', '/usr/local/sbin/hcw-backup-restore'],
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
    expect(seed).toContain('-format=json)');
    expect(seed).toContain('json_value client_token');
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
    -I) head=1 ;;
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
    conflict*) printf '<Error><Code>BlobImmutableDueToPolicy</Code></Error>' > "$out"; echo 409 ;;
    *) : > "$out"; echo 201 ;;
  esac
  exit 0
fi
if [ "\${head:-0}" = 1 ]; then
  case "$STUB_SCENARIO" in
    conflict) printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 15\\r\\nx-ms-blob-type: BlockBlob\\r\\n\\r\\n' > "$out"; echo 200 ;;
    conflict-mismatch) printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 99\\r\\n\\r\\n' > "$out"; echo 200 ;;
    *) : > "$out"; echo 404 ;;
  esac
  exit 0
fi
blob_xml() { printf '<Blob><Name>%s</Name><Properties><Last-Modified>%s</Last-Modified><Content-Length>%s</Content-Length></Properties></Blob>' "$1" "$2" "$3"; }
dump="$STUB_DIR/dump.gz"; dump_bytes="$(stat -c %s "$dump")"
case "$url" in
  *restype=container*comp=list*prefix=coder/*)
    { printf '<?xml version="1.0"?><EnumerationResults><Blobs>'; blob_xml coder/coder-20261013T033012Z.sql.gz 'Mon, 13 Oct 2026 03:30:14 GMT' "$dump_bytes"; blob_xml coder/coder-20261014T033009Z.sql.gz 'Tue, 14 Oct 2026 03:30:11 GMT' "$dump_bytes"; printf '</Blobs><NextMarker/></EnumerationResults>'; } > "$out"; echo 200 ;;
  *restype=container*comp=list*prefix=vault/*)
    { printf '<EnumerationResults><Blobs>'; blob_xml vault/vault-20261014T143509Z.snap 'Tue, 14 Oct 2026 14:35:10 GMT' 19; printf '</Blobs><NextMarker/></EnumerationResults>'; } > "$out"; echo 200 ;;
  *restype=container*comp=list*prefix='&'*)
    { printf '<EnumerationResults><Blobs>'; blob_xml coder/coder-20261014T033009Z.sql.gz 'Tue, 14 Oct 2026 03:30:11 GMT' "$dump_bytes"; blob_xml vault/vault-20261014T143509Z.snap 'Tue, 14 Oct 2026 14:35:10 GMT' 19; printf '</Blobs><NextMarker/></EnumerationResults>'; } > "$out"; echo 200 ;;
  *restype=container*comp=list*)
    case "$STUB_SCENARIO" in
      forbidden) printf '<Error><Code>AuthorizationPermissionMismatch</Code></Error>' > "$out"; echo 403 ;;
      *) printf '<EnumerationResults/>' > "$out"; echo 200 ;;
    esac ;;
  */host-backups/coder/coder-*.sql.gz)
    case "$STUB_SCENARIO" in
      short) printf 'short' > "$out" ;;
      *) cat "$dump" > "$out" ;;
    esac; echo 200 ;;
  */host-backups/vault/vault-*.snap) printf 'raft-snapshot-bytes' > "$out"; echo 200 ;;
  */host-backups/*) printf '<Error><Code>BlobNotFound</Code></Error>' > "$out"; echo 404 ;;
  *) echo 500 ;;
esac
`;

/** A stand-in docker: records every call; `compose … exec -T coder-postgres psql` keeps what it was fed. */
const DOCKER = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$STUB_DIR/docker.argv"
case "$*" in
  *"exec -T coder-postgres psql"*" -d coder "*) cat > "$STUB_DIR/loaded.sql"; [ "\${STUB_DOCKER_LOAD_FAIL:-0}" = 1 ] && { echo 'ERROR:  syntax error' >&2; exit 3; } ;;
  *"exec -T coder-postgres psql"*) : ;;
  *" stop coder") : ;;
  *" start coder") : ;;
esac
exit 0
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
    if [ "\${3:-}" = -accessor ]; then
      case "\${STUB_VAULT_UNREACHABLE:-0}" in 1|accessor) echo 'Error looking up token: dial tcp 127.0.0.1:8200: connect: connection refused' >&2; exit 2 ;; esac
      case " \${STUB_VAULT_VALID_ACCESSORS:-} " in *" $4 "*) printf 'Key   Value\\n'; exit 0 ;; *) echo 'Error looking up token: * invalid accessor' >&2; exit 2 ;; esac
    fi
    [ "\${STUB_VAULT_UNREACHABLE:-0}" = 1 ] && { echo 'Error looking up token: dial tcp 127.0.0.1:8200: connect: connection refused' >&2; exit 2; }
    # A valid token whose policy denies lookup-self answers exactly as an expired one does.
    case " \${STUB_VAULT_ACL_DENIED:-} " in *" \${VAULT_TOKEN:-} "*) echo 'Error looking up token: permission denied' >&2; exit 2 ;; esac
    case "$valid" in *" \${VAULT_TOKEN:-} "*) ;; *) echo 'Error looking up token: permission denied' >&2; exit 2 ;; esac
    # Each stand-in token has a stand-in accessor that does not contain it.
    case "$VAULT_TOKEN" in
      stand-in-fresh-snapshot-token-00001) acc=accessor-fresh-00001 ;;
      stand-in-old-working-token-0000001) acc=accessor-old-0000001 ;;
      stand-in-seeded-snapshot-token-001) acc=accessor-seeded-001 ;;
      *) acc=accessor-owner ;;
    esac
    [ "\${STUB_VAULT_NO_ACCESSOR:-0}" = 1 ] && acc=''
    if [ "\${3:-}" = -format=json ]; then printf '{\\n  "data": {\\n    "accessor": "%s",\\n    "expire_time": "2026-11-13T03:45:00Z"\\n  }\\n}\\n' "$acc"; else printf 'Key   Value\\n'; fi; exit 0 ;;
  "policy write") cat > "$STUB_DIR/policy.$3"; exit 0 ;;
  "token create") printf '{\\n  "auth": {\\n    "client_token": "stand-in-fresh-snapshot-token-00001",\\n    "accessor": "accessor-fresh-00001"\\n  }\\n}\\n'; exit 0 ;;
  "token revoke")
    [ "\${STUB_VAULT_REVOKE_FAIL:-0}" = 1 ] && { echo 'Error revoking token: permission denied' >&2; exit 2; }
    if [ "\${3:-}" = -accessor ]; then echo "accessor:$4" >> "$STUB_DIR/vault.revoked"; else echo "$VAULT_TOKEN" >> "$STUB_DIR/vault.revoked"; fi; exit 0 ;;
  "status -format=json") printf '{\\n  "type": "%s",\\n  "initialized": true,\\n  "sealed": %s\\n}\\n' "\${STUB_VAULT_SEAL_TYPE:-azurekeyvault}" "\${STUB_VAULT_SEALED:-false}"; exit 0 ;;
  "operator raft")
    case "$4" in
      save) printf 'raft-snapshot-bytes' > "$5"; exit 0 ;;
      restore) [ "\${STUB_VAULT_RESTORE_FAIL:-0}" = 1 ] && { echo 'Error installing the snapshot: permission denied' >&2; exit 2; }; printf '%s\\n' "$*" >> "$STUB_DIR/vault.restored"; exit 0 ;;
    esac ;;
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
    writeFileSync(join(dir, 'docker'), DOCKER);
    chmodSync(join(dir, 'curl'), 0o755);
    chmodSync(join(dir, 'vault'), 0o755);
    chmodSync(join(dir, 'docker'), 0o755);
    writeFileSync(join(dir, 'upload.env'), 'HCW_BACKUPS_ACCOUNT=stlabhybridprodcus01\nHCW_BACKUPS_CONTAINER=host-backups\nHCW_BACKUPS_API_VERSION=2024-11-04\n');
    writeFileSync(join(dir, 'hcw-vault.sh'), 'export VAULT_ADDR=https://127.0.0.1:8200\nexport VAULT_CACERT=/etc/vault.d/tls/vault.crt\n');
    writeFileSync(join(dir, 'coder-20261014T033000Z.sql.gz'), 'not really gzip');
    // What the stand-in container serves as a Coder dump: a real gzip, so the restore's gunzip reads it.
    writeFileSync(join(dir, 'dump.gz'), dumpGz);
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
      HCW_DOCKER: `${dir}/docker`,
      HCW_RESTORE_DIR: `${dir}/restore`,
      HCW_CODER_PROJECT_DIR: '/etc/hcw/coder',
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

    it('takes a 409 as done when the blob already there has this file\'s length (a retried PUT), and as a conflict otherwise', () => {
      const file = join(dir, 'coder-20261014T033000Z.sql.gz');
      const done = bash(helper('hcw-backup-upload'), ['coder', file], { STUB_SCENARIO: 'conflict' });
      expect(done.stderr).toContain('uploaded coder/coder-20261014T033000Z.sql.gz (15 bytes) to stlabhybridprodcus01/host-backups; an earlier attempt had stored it');
      expect(done.status).toBe(0);
      expect(lines('curl.argv').at(-1)).toContain('-I');
      const clash = bash(helper('hcw-backup-upload'), ['coder', file], { STUB_SCENARIO: 'conflict-mismatch' });
      expect(clash.status).toBe(1);
      expect(clash.stderr).toContain('answered HTTP 409 (a blob of that name exists with 99 bytes, this file has 15)');
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
      expect(stderr).toContain('run hcw-vault-backup-seed again');
      expect(stderr).not.toContain('--force');
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
      expect(calls).toContain('token create -policy=hcw-raft-snapshot -no-default-policy -orphan -period=720h -display-name=hcw-vault-backup -format=json');
      // The accessor identifies the token in Vault without being usable as one.
      expect(readFileSync(join(dir, 'etc', 'vault-token.accessor'), 'utf8')).toBe('accessor-fresh-00001\n');
      expect(stdout).toContain('(accessor accessor-fresh-00001)');
      // The owner's token was used for the lookup, the policy and the create, and appears nowhere else.
      expect(readFileSync(join(dir, 'vault.argv'), 'utf8')).not.toContain(owner);
    });

    it('leaves a working token alone, and replaces and revokes it by accessor with --force', () => {
      mkdirSync(join(dir, 'etc'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-old-working-token-0000001\n');
      writeFileSync(join(dir, 'etc', 'vault-token.accessor'), 'accessor-old-0000001\n');
      const valid = { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-old-working-token-0000001 stand-in-fresh-snapshot-token-00001` };
      const kept = bash(helper('hcw-vault-backup-seed'), [], valid, `${owner}\n`);
      expect(kept.status).toBe(0);
      expect(kept.stdout).toContain('already stored');
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-old-working-token-0000001\n');
      const forced = bash(helper('hcw-vault-backup-seed'), ['--force'], valid, `${owner}\n`);
      expect(forced.stderr).toBe('');
      expect(forced.status).toBe(0);
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-fresh-snapshot-token-00001\n');
      expect(readFileSync(join(dir, 'etc', 'vault-token.accessor'), 'utf8')).toBe('accessor-fresh-00001\n');
      // Revoked by the accessor kept beside it, with the owner's token, never by the old token's own value.
      expect(lines('vault.revoked')).toEqual(['accessor:accessor-old-0000001']);
      expect(() => statSync(join(dir, 'etc', 'revoke-pending'))).toThrow();
    });

    it('says so when the replaced token could not be revoked, keeps its accessor, and retries it on the next run, forced or not', () => {
      mkdirSync(join(dir, 'etc'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-old-working-token-0000001\n');
      writeFileSync(join(dir, 'etc', 'vault-token.accessor'), 'accessor-old-0000001\n');
      const valid = `${owner} stand-in-old-working-token-0000001 stand-in-fresh-snapshot-token-00001`;
      const forced = bash(helper('hcw-vault-backup-seed'), ['--force'], { STUB_VAULT_VALID_TOKENS: valid, STUB_VAULT_VALID_ACCESSORS: 'accessor-old-0000001', STUB_VAULT_REVOKE_FAIL: '1' }, `${owner}\n`);
      expect(forced.status).toBe(0);
      expect(forced.stdout).toContain('stored the snapshot token');
      expect(forced.stderr).toContain('WARNING: a superseded snapshot token (accessor accessor-old-0000001) could not be revoked and may still be valid');
      expect(forced.stderr).toContain('vault token revoke -accessor accessor-old-0000001');
      expect(readFileSync(join(dir, 'etc', 'revoke-pending'), 'utf8')).toBe('accessor-old-0000001\n');
      // The intent was recorded before the new token was published: pending_add precedes the token write in the script.
      expect(seed.indexOf('pending_add "$old_accessor"')).toBeLessThan(seed.indexOf('write_atomically "$token_file"'));
      // A plain run with a working token does not take the early exit while something is pending:
      // it asks for the owner's token, retries, clears the list and then says nothing else changed.
      const next = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: valid, STUB_VAULT_VALID_ACCESSORS: 'accessor-old-0000001' }, `${owner}\n`);
      expect(next.status).toBe(0);
      expect(next.stdout).toContain('revoked the superseded snapshot token with accessor accessor-old-0000001');
      expect(next.stdout).toContain('already stored');
      expect(() => statSync(join(dir, 'etc', 'revoke-pending'))).toThrow();
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-fresh-snapshot-token-00001\n');
    });

    it('never revokes the token still in the file from the pending list, and judges "unchanged" after working it', () => {
      mkdirSync(join(dir, 'etc'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-old-working-token-0000001\n');
      // A stale copy beside the token: Vault's own answer for the stored token is what protects it.
      writeFileSync(join(dir, 'etc', 'vault-token.accessor'), 'accessor-stale-copy\n');
      // A replacement interrupted after recording its intent: the stored token's own accessor is pending.
      writeFileSync(join(dir, 'etc', 'revoke-pending'), 'accessor-old-0000001\n');
      const valid = `${owner} stand-in-old-working-token-0000001 stand-in-fresh-snapshot-token-00001`;
      const plain = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: valid }, `${owner}\n`);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain('the record for accessor accessor-old-0000001 was a replacement that did not complete');
      expect(plain.stdout).toContain('already stored');
      expect(() => lines('vault.revoked')).toThrow();
      expect(() => statSync(join(dir, 'etc', 'revoke-pending'))).toThrow();
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-old-working-token-0000001\n');
      // A stored token that no longer works is replaced by a plain run, and said so, rather than reported unchanged.
      writeFileSync(join(dir, 'etc', 'revoke-pending'), 'accessor-long-gone\n');
      const replaced = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-fresh-snapshot-token-00001` }, `${owner}\n`);
      expect(replaced.status).toBe(0);
      expect(replaced.stdout).toContain('the stored snapshot token no longer works; replacing it');
      expect(replaced.stdout).toContain('stored the snapshot token');
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-fresh-snapshot-token-00001\n');
      expect(readFileSync(join(dir, 'etc', 'vault-token.accessor'), 'utf8')).toBe('accessor-fresh-00001\n');
    });

    it('withdraws the recorded retirement when the new token cannot be stored, so the predecessor stays current', () => {
      mkdirSync(join(dir, 'etc'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-old-working-token-0000001\n');
      writeFileSync(join(dir, 'etc', 'vault-token.accessor'), 'accessor-old-0000001\n');
      // A mktemp that fails on its second call: the intent is recorded (first call), the token write fails (second).
      mkdirSync(join(dir, 'nobin'));
      writeFileSync(
        join(dir, 'nobin', 'mktemp'),
        '#!/usr/bin/env bash\nn=$(cat "$STUB_DIR/mktemp.calls" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STUB_DIR/mktemp.calls"\n[ "$n" -ge "${STUB_MKTEMP_FAIL_AT:-999}" ] && exit 1\nexec /usr/bin/mktemp "$@"\n'
      );
      chmodSync(join(dir, 'nobin', 'mktemp'), 0o755);
      const valid = `${owner} stand-in-old-working-token-0000001 stand-in-fresh-snapshot-token-00001`;
      const forced = bash(helper('hcw-vault-backup-seed'), ['--force'], { STUB_VAULT_VALID_TOKENS: valid, STUB_MKTEMP_FAIL_AT: '2', PATH: `${dir}/nobin${delimiter}${process.env.PATH}` }, `${owner}\n`);
      expect(forced.status).toBe(1);
      expect(forced.stderr).toContain('the token just created was revoked again');
      expect(lines('vault.revoked')).toEqual(['stand-in-fresh-snapshot-token-00001']);
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-old-working-token-0000001\n');
      expect(() => statSync(join(dir, 'etc', 'revoke-pending'))).toThrow();
    });

    it('spares a pending record only on Vault\'s word: an empty token file or a token Vault no longer answers for protects nothing', () => {
      mkdirSync(join(dir, 'etc'));
      // Empty token file, stale sidecar naming a pending accessor: the record is worked, not dropped.
      writeFileSync(join(dir, 'etc', 'vault-token'), '');
      writeFileSync(join(dir, 'etc', 'vault-token.accessor'), 'accessor-old-0000001\n');
      writeFileSync(join(dir, 'etc', 'revoke-pending'), 'accessor-old-0000001\n');
      const empty = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-fresh-snapshot-token-00001` }, `${owner}\n`);
      expect(empty.status).toBe(0);
      expect(empty.stdout).toContain('revoked the superseded snapshot token with accessor accessor-old-0000001');
      expect(empty.stdout).not.toContain('did not complete');
      expect(lines('vault.revoked')).toEqual(['accessor:accessor-old-0000001']);
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-fresh-snapshot-token-00001\n');
      // A stored token Vault no longer answers for, its sidecar naming a pending accessor: worked too, and the
      // broken token's retirement is recorded from the sidecar before the replacement is published.
      rmSync(join(dir, 'vault.revoked'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-old-working-token-0000001\n');
      writeFileSync(join(dir, 'etc', 'vault-token.accessor'), 'accessor-old-0000001\n');
      writeFileSync(join(dir, 'etc', 'revoke-pending'), 'accessor-long-gone\n');
      const broken = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-fresh-snapshot-token-00001` }, `${owner}\n`);
      expect(broken.status).toBe(0);
      expect(broken.stdout).toContain('the stored snapshot token no longer works; replacing it');
      expect(lines('vault.revoked')).toEqual(['accessor:accessor-long-gone', 'accessor:accessor-old-0000001']);
    });

    it('revokes a working predecessor Vault reports no accessor for only after the new token is in place', () => {
      mkdirSync(join(dir, 'etc'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-old-working-token-0000001\n');
      mkdirSync(join(dir, 'nobin'));
      writeFileSync(
        join(dir, 'nobin', 'mktemp'),
        '#!/usr/bin/env bash\nn=$(cat "$STUB_DIR/mktemp.calls" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STUB_DIR/mktemp.calls"\n[ "$n" -ge "${STUB_MKTEMP_FAIL_AT:-999}" ] && exit 1\nexec /usr/bin/mktemp "$@"\n'
      );
      chmodSync(join(dir, 'nobin', 'mktemp'), 0o755);
      const valid = { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-old-working-token-0000001 stand-in-fresh-snapshot-token-00001`, STUB_VAULT_NO_ACCESSOR: '1' };
      // The token write (the first mktemp, since nothing was enqueued) fails: the predecessor must still be untouched.
      const failed = bash(helper('hcw-vault-backup-seed'), ['--force'], { ...valid, STUB_MKTEMP_FAIL_AT: '1', PATH: `${dir}/nobin${delimiter}${process.env.PATH}` }, `${owner}\n`);
      expect(failed.status).toBe(1);
      expect(lines('vault.revoked')).toEqual(['stand-in-fresh-snapshot-token-00001']);
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-old-working-token-0000001\n');
      // With the write working, the predecessor is revoked by itself, after the new token is stored.
      rmSync(join(dir, 'vault.revoked'));
      const ok = bash(helper('hcw-vault-backup-seed'), ['--force'], valid, `${owner}\n`);
      expect(ok.status).toBe(0);
      expect(lines('vault.revoked')).toEqual(['stand-in-old-working-token-0000001']);
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-fresh-snapshot-token-00001\n');
    });

    it('stops before the pending list when Vault gives no verdict on the stored token, so an indeterminate lookup revokes nothing', () => {
      mkdirSync(join(dir, 'etc'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-old-working-token-0000001\n');
      writeFileSync(join(dir, 'etc', 'vault-token.accessor'), 'accessor-old-0000001\n');
      // An interrupted replacement left the working token's own accessor pending, and Vault is not answering.
      writeFileSync(join(dir, 'etc', 'revoke-pending'), 'accessor-old-0000001\n');
      const valid = `${owner} stand-in-old-working-token-0000001 stand-in-fresh-snapshot-token-00001`;
      const down = bash(helper('hcw-vault-backup-seed'), ['--force'], { STUB_VAULT_VALID_TOKENS: valid, STUB_VAULT_UNREACHABLE: '1' }, `${owner}\n`);
      expect(down.status).toBe(1);
      expect(down.stderr).toContain('Vault gave no answer: it is sealed or not reachable');
      expect(() => lines('vault.revoked')).toThrow();
      expect(readFileSync(join(dir, 'etc', 'revoke-pending'), 'utf8')).toBe('accessor-old-0000001\n');
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-old-working-token-0000001\n');
      // Vault back: the record is recognised as the working token's own and dropped, nothing revoked.
      const up = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: valid }, `${owner}\n`);
      expect(up.status).toBe(0);
      expect(up.stdout).toContain('was a replacement that did not complete');
      expect(() => lines('vault.revoked')).toThrow();
      expect(() => statSync(join(dir, 'etc', 'revoke-pending'))).toThrow();
      // The three verdicts are kept apart in the script: an accessor, a refusal, and no answer.
      expect(seed).toContain("grep -qiE 'permission denied|invalid token|bad token'");
      expect(seed).toContain('[ "$stored_verdict" -ne 2 ] || fail');
    });

    it('settles a "permission denied" on the stored token with the owner\'s token by accessor, so a valid token denied lookup-self is still protected', () => {
      mkdirSync(join(dir, 'etc'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-old-working-token-0000001\n');
      writeFileSync(join(dir, 'etc', 'vault-token.accessor'), 'accessor-old-0000001\n');
      writeFileSync(join(dir, 'etc', 'revoke-pending'), 'accessor-old-0000001\n');
      // The stored token answers "permission denied" to lookup-self although Vault still knows its accessor.
      const denied = { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-fresh-snapshot-token-00001`, STUB_VAULT_ACL_DENIED: 'stand-in-old-working-token-0000001', STUB_VAULT_VALID_ACCESSORS: 'accessor-old-0000001' };
      const plain = bash(helper('hcw-vault-backup-seed'), [], denied, `${owner}\n`);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain('the record for accessor accessor-old-0000001 was a replacement that did not complete');
      // Its self-lookup still fails, so a plain run replaces it, and only then retires it, by that accessor.
      expect(plain.stdout).toContain('the stored snapshot token no longer works; replacing it');
      expect(lines('vault.revoked')).toEqual(['accessor:accessor-old-0000001']);
      expect(readFileSync(join(dir, 'etc', 'vault-token'), 'utf8')).toBe('stand-in-fresh-snapshot-token-00001\n');
      // Without an accessor beside it the two cases cannot be told apart, and the seed stops rather than guess.
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-old-working-token-0000001\n');
      rmSync(join(dir, 'etc', 'vault-token.accessor'));
      rmSync(join(dir, 'vault.revoked'));
      writeFileSync(join(dir, 'etc', 'revoke-pending'), 'accessor-old-0000001\n');
      const blind = bash(helper('hcw-vault-backup-seed'), [], denied, `${owner}\n`);
      expect(blind.status).toBe(1);
      expect(blind.stderr).toContain('cannot be told from a valid one denied lookup-self');
      expect(() => lines('vault.revoked')).toThrow();
      expect(readFileSync(join(dir, 'etc', 'revoke-pending'), 'utf8')).toBe('accessor-old-0000001\n');
    });

    it('drops a pending accessor Vault no longer knows, and keeps one it cannot ask about', () => {
      mkdirSync(join(dir, 'etc'));
      writeFileSync(join(dir, 'etc', 'vault-token'), 'stand-in-fresh-snapshot-token-00001\n');
      writeFileSync(join(dir, 'etc', 'vault-token.accessor'), 'accessor-fresh-00001\n');
      writeFileSync(join(dir, 'etc', 'revoke-pending'), 'accessor-long-gone\naccessor-unknowable\n');
      const valid = { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-fresh-snapshot-token-00001`, STUB_VAULT_REVOKE_FAIL: '1' };
      // Revocation refused, lookup says the accessor is invalid: the token is gone, so the entry goes.
      const gone = bash(helper('hcw-vault-backup-seed'), [], { ...valid, STUB_VAULT_VALID_ACCESSORS: 'accessor-unknowable' }, `${owner}\n`);
      expect(gone.status).toBe(0);
      expect(gone.stdout).toContain('accessor accessor-long-gone no longer exists in Vault');
      expect(gone.stderr).toContain('(accessor accessor-unknowable) could not be revoked and may still be valid');
      expect(readFileSync(join(dir, 'etc', 'revoke-pending'), 'utf8')).toBe('accessor-unknowable\n');
      // Vault refuses the revocation and cannot be asked about the accessor: ambiguous, so the entry stays.
      const unreachable = bash(helper('hcw-vault-backup-seed'), [], { ...valid, STUB_VAULT_UNREACHABLE: 'accessor' }, `${owner}\n`);
      expect(unreachable.status).toBe(0);
      expect(readFileSync(join(dir, 'etc', 'revoke-pending'), 'utf8')).toBe('accessor-unknowable\n');
      // A working token with nothing pending needs no token on stdin at all.
      rmSync(join(dir, 'etc', 'revoke-pending'));
      const quiet = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: 'stand-in-fresh-snapshot-token-00001' }, '');
      expect(quiet.status).toBe(0);
      expect(quiet.stdout).toContain('nothing was changed (--force replaces it)');
    });

    it('fails before asking Vault when the token directory cannot be made, and revokes the token it created when it cannot be stored', () => {
      // A token file whose directory is a regular file: refused before any Vault call.
      const early = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-fresh-snapshot-token-00001`, HCW_VAULT_BACKUP_TOKEN_FILE: `${dir}/upload.env/vault-token` }, `${owner}\n`);
      expect(early.status).toBe(1);
      expect(early.stderr).toContain('nothing was asked of Vault');
      expect(() => lines('vault.argv')).toThrow();
      // A mktemp that fails after the token exists: the token is revoked again.
      mkdirSync(join(dir, 'nobin'));
      writeFileSync(join(dir, 'nobin', 'mktemp'), '#!/usr/bin/env bash\nexit 1\n');
      chmodSync(join(dir, 'nobin', 'mktemp'), 0o755);
      const late = bash(helper('hcw-vault-backup-seed'), [], { STUB_VAULT_VALID_TOKENS: `${owner} stand-in-fresh-snapshot-token-00001`, PATH: `${dir}/nobin${delimiter}${process.env.PATH}` }, `${owner}\n`);
      expect(late.status).toBe(1);
      expect(late.stderr).toContain('the token just created was revoked again');
      expect(lines('vault.revoked')).toEqual(['stand-in-fresh-snapshot-token-00001']);
      expect(() => statSync(join(dir, 'etc', 'vault-token'))).toThrow();
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

  // Each test here runs the helper several times, and each run spawns bash, the stand-in curl
  // and the stand-in docker or vault: well past vitest's five-second default on a slow runner.
  describe('hcw-backup-restore', { timeout: 60000 }, () => {
    const restore = helper('hcw-backup-restore');

    it('lists the container as the identity, newest last, with bytes and dates', () => {
      const all = bash(restore, ['list']);
      expect(all.stderr).toBe('');
      expect(all.status).toBe(0);
      expect(all.stdout).toMatch(/^NAME\s+BYTES\s+LAST MODIFIED\n/);
      expect(all.stdout).toContain('coder/coder-20261014T033009Z.sql.gz');
      expect(all.stdout).toContain('vault/vault-20261014T143509Z.snap');
      expect(lines('curl.urls').at(-1)).toContain('restype=container&comp=list&prefix=&maxresults=5000');
      const coder = bash(restore, ['list', 'coder']);
      expect(coder.status).toBe(0);
      const names = coder.stdout.split('\n').slice(1).filter(Boolean).map((l) => l.split(/\s+/)[0]);
      expect(names).toEqual(['coder/coder-20261013T033012Z.sql.gz', 'coder/coder-20261014T033009Z.sql.gz']);
      expect(bash(restore, ['list', 'portainer']).status).toBe(2);
    });

    it('fetches the newest blob by default, or a named one, checking the length Azure listed', () => {
      const newest = bash(restore, ['fetch', 'coder']);
      expect(newest.stderr).toBe('');
      expect(newest.status).toBe(0);
      expect(newest.stdout).toContain(`fetched coder/coder-20261014T033009Z.sql.gz (${dumpBytes} bytes) to ${dir}/restore/coder/coder-20261014T033009Z.sql.gz`);
      expect(readFileSync(join(dir, 'restore', 'coder', 'coder-20261014T033009Z.sql.gz')).equals(dumpGz)).toBe(true);
      if (process.platform !== 'win32') expect(statSync(join(dir, 'restore')).mode & 0o777).toBe(0o700);
      const named = bash(restore, ['fetch', 'coder', 'coder-20261013T033012Z.sql.gz']);
      expect(named.status).toBe(0);
      expect(lines('curl.urls').at(-1)).toBe('https://stlabhybridprodcus01.blob.core.windows.net/host-backups/coder/coder-20261013T033012Z.sql.gz');
      const absent = bash(restore, ['fetch', 'coder', 'coder-19990101T000000Z.sql.gz']);
      expect(absent.status).toBe(1);
      expect(absent.stderr).toContain('no blob coder/coder-19990101T000000Z.sql.gz');
      const short = bash(restore, ['fetch', 'vault', 'vault-20261014T143509Z.snap'], { STUB_SCENARIO: 'short' });
      expect(short.status).toBe(0);
      const cut = bash(restore, ['fetch', 'coder'], { STUB_SCENARIO: 'short' });
      expect(cut.status).toBe(1);
      expect(cut.stderr).toContain(`downloaded 5 bytes of coder/coder-20261014T033009Z.sql.gz, Azure listed ${dumpBytes}; nothing was kept`);
      expect(() => statSync(join(dir, 'restore', 'coder', 'coder-20261014T033009Z.sql.gz.partial'))).toThrow();
    });

    it('restores a dump into coder-postgres only with --yes: stop, drop and recreate, load, start', () => {
      const refused = bash(restore, ['coder']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('add --yes to go ahead');
      expect(() => lines('docker.argv')).toThrow();
      const done = bash(restore, ['coder', '--yes']);
      expect(done.stderr).toBe('');
      expect(done.status).toBe(0);
      expect(done.stdout).toContain('restored coder/coder-20261014T033009Z.sql.gz into coder-postgres');
      const calls = lines('docker.argv');
      expect(calls[0]).toBe('compose --project-directory /etc/hcw/coder stop coder');
      expect(calls[1]).toBe('compose --project-directory /etc/hcw/coder exec -T coder-postgres psql -U coder -d postgres -v ON_ERROR_STOP=1 -q -c DROP DATABASE coder -c CREATE DATABASE coder OWNER coder');
      expect(calls[2]).toBe('compose --project-directory /etc/hcw/coder exec -T coder-postgres psql -U coder -d coder -v ON_ERROR_STOP=1 -q');
      expect(calls[3]).toBe('compose --project-directory /etc/hcw/coder start coder');
      expect(readFileSync(join(dir, 'loaded.sql'), 'utf8')).toBe('select 1;\n');
      const failed = bash(restore, ['coder', '--yes'], { STUB_DOCKER_LOAD_FAIL: '1' });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('loading the dump failed partway; coder is stopped');
      expect(lines('docker.argv').at(-1)).not.toContain('start coder');
    });

    it('restores a snapshot into Vault with -force and a token from stdin, never from an argument', () => {
      const refused = bash(restore, ['vault'], {}, 'stand-in-owner-root-token-00000001\n');
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('add --yes');
      const empty = bash(restore, ['vault', '--yes'], {}, '\n');
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain('the token on stdin was empty; nothing was restored');
      expect(() => lines('vault.restored')).toThrow();
      const done = bash(restore, ['vault', '--yes'], {}, 'stand-in-owner-root-token-00000001\r\n');
      expect(done.stderr).toBe('');
      expect(done.status).toBe(0);
      // Acceptance, not completion: the helper says what Vault reports and what to confirm.
      expect(done.stdout).toContain('Vault accepted vault/vault-20261014T143509Z.snap for restore and now reports Initialized true, Sealed false');
      expect(done.stdout).toContain('journalctl -u vault');
      expect(done.stdout).not.toMatch(/\brestored vault\//);
      expect(lines('vault.argv')).toContain('status -format=json');
      expect(lines('vault.restored')).toEqual([`operator raft snapshot restore -force ${dir}/restore/vault/vault-20261014T143509Z.snap`]);
      // The seal check and the restore run with the token; the status poll after it runs with none.
      expect(new Set(lines('vault.tokens'))).toEqual(new Set(['stand-in-owner-root-token-00000001', '<unset>']));
      expect(readFileSync(join(dir, 'vault.argv'), 'utf8')).not.toContain('stand-in-owner-root-token');
      const denied = bash(restore, ['vault', '--yes'], { STUB_VAULT_RESTORE_FAIL: '1' }, 'stand-in-owner-root-token-00000001\n');
      expect(denied.status).toBe(1);
      expect(denied.stderr).toContain('vault operator raft snapshot restore refused');
      // A Vault under Shamir keys could not open the snapshot's data: refused before -force, with the fix.
      rmSync(join(dir, 'vault.restored'));
      const shamir = bash(restore, ['vault', '--yes'], { STUB_VAULT_SEAL_TYPE: 'shamir' }, 'stand-in-owner-root-token-00000001\n');
      expect(shamir.status).toBe(1);
      expect(shamir.stderr).toContain('Vault reports seal type shamir, and the snapshots were taken under azurekeyvault');
      expect(shamir.stderr).toContain('moving to auto-unseal');
      expect(() => lines('vault.restored')).toThrow();
    });
  });
});
