# vault

HashiCorp Vault on the lab host, host-native under systemd, for **lab-host
secrets only** (owner decision 2026-09-26; ADR 0032, amendment of that
date). Integrated storage (raft) in `/var/lib/vault`, the API on
`127.0.0.1:8200` and raft's cluster port on `127.0.0.1:8201`, TLS with a
certificate generated on the host. Off until `vault_enabled` is true.

Not the Ansible Vault in `lab-host/README.md`, "The vault". The `vault_`
prefix on this role's variables is its name, as ansible-lint's naming rule
asks; none of them is a key in the Ansible Vault file, which holds nothing
for this role because nothing it needs is a secret.

## The boundary

This host runs untrusted learner workloads, and an escape from a workspace
or a job container is root on the host, which can read an unsealed Vault's
memory. So this Vault holds secrets **for the lab host only**, and never a
production HybridCloudWorks secret: those stay in Azure Key Vault
`kv-site-prod-cus-01`, which nothing on this host can read. Nothing may be
stored here that exists nowhere else either (ADR 0032: the host holds no
data of record), so every value in it must be one its issuer can re-issue.

## What it does

With `vault_enabled` true:

1. Installs `gpg`, `gpgv`, `openssl` and `unzip`, and creates the `vault`
   system user (no login shell).
2. Verifies the download in three links, each before the next is used:
   - HashiCorp's release signing key from
     `https://www.hashicorp.com/.well-known/pgp-key.txt`, refused unless its
     SHA256 is `vault_pgp_key_checksum`. Its primary fingerprint is
     `C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F`, the one
     <https://www.hashicorp.com/en/trust/security> publishes. It is
     converted with `gpg --dearmor` into the binary keyring `gpgv` reads,
     under a file name carrying the key's checksum.
   - `gpgv` checks HashiCorp's signature on `vault_<version>_SHA256SUMS`, and
     the role refuses a `vault_checksum` that the signed file does not list
     for `vault_<version>_linux_amd64.zip`.
   - The archive is downloaded and refused unless it hashes to
     `vault_checksum`. HashiCorp signs only SHA256SUMS: "The archives
     themselves are not signed, but rather hashed."
3. Installs the binary as `/usr/local/bin/vault` and checks `vault version`
   names the pin.
4. Generates an RSA-4096 key and a self-signed certificate for `127.0.0.1`
   and `localhost` on the host if there is none (`/etc/vault.d/tls/`, key
   `root:vault 0640`, certificate `0644`, 730 days), as the `labs_agent`
   role does for the agent's, and warns on every run within 60 days of
   expiry.
5. Checks the auto-unseal seal before it writes anything that uses it or
   drops it ("Auto-unseal", below).
6. Writes `/etc/vault.d/vault.hcl` (`root:vault 0640`),
   `/etc/profile.d/hcw-vault.sh` (`VAULT_ADDR` and `VAULT_CACERT` for login
   shells) and `vault.service`, HashiCorp's own unit minus the lines that
   exist for mlock; starts it, and restarts it when the binary, the
   configuration, the certificate or the unit changed.
7. Reads `vault status` and says which state Vault is in and whose step is
   next. `status` exits 2 when sealed; only an error (1) fails the play.

With it false, the role installs nothing, and stops and disables a Vault an
earlier run installed. `/var/lib/vault` stays, so turning it back on brings
the same, sealed, Vault back.

It never runs `vault operator init` or `unseal`, and never holds an unseal
key or a token. Those are owner steps, in `lab-host/README.md`, "HashiCorp
Vault", and the keys go to the owner's password manager and nowhere else.

**A restart seals Vault**, unless the auto-unseal seal is on. A changed
binary, configuration, certificate or unit restarts it, and so does every
reboot, including the nightly idle reboot at 04:30
(`hcw-reboot-when-idle.timer`). Under Shamir keys
it then answers `Sealed true` and serves nothing until the owner unseals it.
With the seal on it unseals itself ("Auto-unseal", below; ADR 0032,
amendment of 2026-09-29).

## TLS on the loopback

A certificate rather than `tls_disable`. Every request carries a token and
every answer from an unsealed Vault is a secret, and plaintext would stay
plaintext wherever the port is later carried. Self-signed, because nothing
off the host connects to 8200, so there is no CA to chain to; the CLI trusts
the one certificate through `VAULT_CACERT`. The listener requires TLS 1.3.

## mlock

`disable_mlock = true`. Vault's configuration reference (read 2026-09-26):
"You must set an explicit value for `disable_mlock` if you use integrated
storage", and "Disabling mlock is strongly recommended if using integrated
storage", because mlock pulls raft's memory-mapped BoltDB file into resident
memory. The same paragraph asks for swap to be off or encrypted in that
case, so the role prints a warning on a host with swap. It does not turn
swap off: that is a host-wide change with its own effect on the Coder
workspaces.

## Auto-unseal

With `vault_seal_azurekeyvault_enabled` the configuration gains a
`seal "azurekeyvault"` stanza (#726; ADR 0032, amendment of 2026-09-29).
Vault's root key is then wrapped by the RSA key `vault-seal` in the lab-only
Key Vault `kv-labhybrid-prod-cus-01` (`infra/lab-hybrid.tf`), and at every
start Vault asks that key to unwrap it. The Shamir keys become **recovery
keys**: they still authorise `generate-root`, a rekey or a migration, and
they **cannot unseal Vault**. HashiCorp's seal page: "Recovery keys cannot
decrypt the root key and therefore are not sufficient to unseal Vault if the
auto unseal mechanism isn't working", and a Vault whose seal key is
permanently deleted "cannot be recovered, even from backups". That is why the
vault has purge protection and both the vault and the key carry
`prevent_destroy`.

`group_vars/all.yml` reads the switch from the host, as `arc_enabled` does:
it is true exactly when `/etc/ansible/facts.d/hcw_vault_seal.fact` is JSON
whose `enabled` is `true`. The seal describes the Vault data on this
installation, so a rebuilt host starts without it whatever the repository
says. Moving an initialised Vault onto the seal is an owner step,
`vault operator unseal -migrate`, in
[docs/runbooks/labs-host.md](../../../../docs/runbooks/labs-host.md),
"HashiCorp Vault: moving to auto-unseal".

### How it authenticates

As the Arc machine's system-assigned identity, with nothing stored on the
host for it. Read against the source of the pinned release, Vault 2.1.1,
whose binary `go version -m` shows built with exactly these modules:

- The seal (`go-kms-wrapping/wrappers/azurekeyvault` v2.0.14) signs in with a
  client secret only when `tenant_id`, `client_id` and `client_secret` are all
  set; with no `client_id` it calls `azidentity.NewDefaultAzureCredential`.
- That chain (`azidentity` v1.13.1) reaches `ManagedIdentityCredential`,
  which hands managed identity to MSAL for Go v1.6.0. MSAL recognises an
  Azure Arc machine by `IDENTITY_ENDPOINT` and `IMDS_ENDPOINT`, or by
  `/opt/azcmagent/bin/himds` existing, and runs the agent's challenge flow:
  a 401 naming a `.key` file in `/var/opt/azcmagent/tokens`, which only root
  and the `himds` group can read, then the same request carrying its
  contents. Microsoft: "On Linux, you must be a member of the `himds` group."
- MSAL refuses a user-assigned identity on Arc ("Azure Arc doesn't support
  user-assigned managed identities"), and the seal turns a `client_id` into
  exactly that request. So the stanza has neither `client_id` nor
  `client_secret`, and `tenant_id` only when
  `vault_seal_azurekeyvault_tenant_id` is set: nothing reads it without a
  secret.

With the seal on, the unit changes in four ways, and with it off it renders
byte for byte as before #726:

- `SupplementaryGroups=himds`, for the Vault process only; the `vault` user
  itself is not in the group.
- `Environment=AZURE_TOKEN_CREDENTIALS=ManagedIdentityCredential`, which pins
  the chain to managed identity (azidentity's documented selector), so
  nothing else on the host, such as an Azure CLI login, is ever tried.
- `Wants=` and `After=himdsd.service`, the agent's daemon.
- `StartLimitIntervalSec=0` and `RestartSec=30`. An initialised Vault whose
  key cannot be read exits ("Vault is initialized but no Seal key could be
  loaded"), and HashiCorp's limit of three starts a minute would leave it
  failed after a short Key Vault or network outage. It keeps trying instead,
  and comes up unsealed when the key answers.

The agent's own systemd drop-in, `/lib/systemd/system.conf.d/azcmagent.conf`,
already gives every unit `IDENTITY_ENDPOINT` and `IMDS_ENDPOINT`.

### What the role checks

Before it writes the configuration:

- **With the seal on**, it reads the key the way Vault will, and writes no
  stanza until that works: `azcmagent show` must report Connected, the
  `himds` group must exist, the agent must answer the challenge and issue a
  token, and Key Vault must return the key as an RSA key allowing `wrapKey`
  and `unwrapKey`. A 403 (no grant yet), a 404 (no key yet) or an
  unreachable vault stops the run with the reason and changes nothing, so
  the Vault running now keeps its seal. The tasks that see the challenge
  file or the token are `no_log`.
- **With the seal off**, it refuses to write a configuration without the
  stanza while Vault reports the `azurekeyvault` seal or a migration in
  progress: Vault would not start, and the recovery keys could not help.

### Migrating from Shamir

The owner's lines, with what each prints, are in the runbook section named
above. In short: stop Vault and copy `/var/lib/vault` cold, write the fact,
run `bootstrap.sh`, enter three of the existing keys at
`vault operator unseal -migrate`, wait for `vault status` to drop the
`Seal Migration in Progress` line, then restart. Restarting before that line
goes leaves Vault in migration mode again; entering the three keys again
finishes it (rehearsed).

### A rebuilt host

A rebuilt host is a new Arc machine with a new identity. The next
`hcw-azure` apply moves the grant to it (`infra/lab-hybrid.tf` reads the
machine's principal at plan time). Then write the fact before initialising,
and `vault operator init -recovery-shares=5 -recovery-threshold=3` gives
recovery keys and a Vault that is already unsealed.

### Back to Shamir

Set `"disabled": true` beside `"enabled": true` in the fact and run
`bootstrap.sh`: the stanza gains `disabled = "true"`, Vault restarts into a
migration, and three recovery keys at `vault operator unseal -migrate` make
them unseal keys again. Once `vault status` shows `Seal Type shamir` with no
migration line, delete the fact and run `bootstrap.sh` again, which drops
the stanza; that restart seals Vault, so unseal it as before. The key must
still exist for all of this: the migration unwraps with it. Rehearsed on
2026-09-29, as was restoring the cold copy taken before the migration.

## Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `vault_enabled` | required (`false` in `group_vars`) | Run or stop Vault |
| `vault_version`, `vault_checksum` | required | Release, and the SHA256 of its linux amd64 zip from the signed SHA256SUMS |
| `vault_pgp_key_checksum` | required | SHA256 of HashiCorp's armored signing key |
| `vault_api_port`, `vault_cluster_port` | `8200`, `8201` | Ports on `127.0.0.1`; the address is fixed in `vars/main.yml` |
| `vault_ui` | `false` | The web UI, on the same loopback listener |
| `vault_raft_node_id` | `lab-host-01` | Fixed at first start |
| `vault_data_dir` | `/var/lib/vault` | Raft storage, `vault:vault 0700` |
| `vault_certificate_days`, `vault_certificate_warn_days` | `730`, `60` | The generated certificate |
| `vault_seal_azurekeyvault_enabled` | `false` (`group_vars` reads the host's fact) | Auto-unseal through Azure Key Vault |
| `vault_seal_azurekeyvault_vault_name`, `vault_seal_azurekeyvault_key_name` | `kv-labhybrid-prod-cus-01`, `vault-seal` | What `infra/lab-hybrid.tf` creates; `scripts/lab-host-vault-seal.test.mjs` holds them equal |
| `vault_seal_azurekeyvault_tenant_id` | `""` | Written as `tenant_id` when set; unused without a client secret |
| `vault_seal_azurekeyvault_disabled` | `false` (`group_vars` reads the fact's `disabled`) | Migrate back to Shamir keys |
| `vault_seal_restart_seconds` | `30` | With the seal on, the wait between starts when the key cannot be read |

Paths are in `defaults/main.yml`; `meta/argument_specs.yml` is the contract.

## Bumping the pin

`scripts/version-floors.json` holds `vault_version` to the newest line,
N-2 patches, from endoflife.date's `hashicorp-vault` product, and the weekly
updater moves the floor. The newest community release, bash, anywhere with
`curl` and `node`:

```bash
curl -fsS 'https://api.releases.hashicorp.com/v1/releases/vault?limit=5&license_class=oss' | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{for(const r of JSON.parse(s))console.log(r.version,r.timestamp_created,r.is_prerelease)})"
```

The checksum is that release's `linux_amd64.zip` line in its SHA256SUMS;
2.1.1 below, change both numbers for another release:

```bash
curl -fsS https://releases.hashicorp.com/vault/2.1.1/vault_2.1.1_SHA256SUMS | grep linux_amd64.zip
```

The role verifies the file's signature on the host, so a value read from
anywhere else fails the run. A new pin restarts Vault, sealed. Read
HashiCorp's upgrade notes for every release between the old pin and the new
(<https://developer.hashicorp.com/vault/docs/updates/important-changes>),
and take a raft snapshot first once Vault holds anything: the `backups`
role takes one nightly, and `sudo systemctl start hcw-vault-backup.service`
takes one now, once its token is seeded (`roles/backups/README.md`).

## Rotating the certificate

Remove the pair and re-run `bootstrap.sh`, which generates a new one and
restarts Vault. Bash, on the host:

```bash
sudo rm /etc/vault.d/tls/vault.key /etc/vault.d/tls/vault.crt && sudo /opt/hcw-src/lab-host/bootstrap.sh
```

Vault is then sealed; unseal it (`lab-host/README.md`, "HashiCorp Vault").

## Check mode

Safe. `get_url` with a checksum, `unarchive` and `shell` with `creates`, and
`template` report without writing; the signature check, the version and
certificate checks and the status read are commands, which check mode skips.
The seal's two reads, `vault status` and `azcmagent show`, run in check mode
because they change nothing; the token and key reads do not run.
