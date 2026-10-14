# backups

Off-host backups for the lab host (estate review LAB-9,
[#955](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/955);
ADR 0032, amendment of 2026-10-14). The nightly Coder PostgreSQL dump the
`coder` role writes and a nightly HashiCorp Vault raft snapshot are uploaded
to the `host-backups` container of the storage account
`infra/lab-hybrid-backups.tf` creates, as the Arc machine's system-assigned
identity. The container is under a 35-day immutability policy, so the host
can add a copy and cannot remove or overwrite one; a host that is
compromised, and can therefore write backups, cannot destroy them.

Nothing for this is stored on the host but names: no storage key, no
connection string, no SAS. The one secret the role touches, the Vault
snapshot token, is created by the owner's seed and stored root-only, and the
role never reads its value.

## What it does

1. Installs four root-only helpers, whatever the switch:
   - `/usr/local/libexec/hcw-arc-token RESOURCE` asks the Azure Connected
     Machine agent on `127.0.0.1:40342` for the identity's token, by the
     challenge the agent documents for Linux and `roles/vault/tasks/seal.yml`
     performs for the seal key: a `GET` with `Metadata: true` answers 401
     naming a `.key` file in `/var/opt/azcmagent/tokens`, which only root and
     the `himds` group can read; a second `GET` with that file's contents as
     Basic authorization answers the token. The helper refuses a challenge
     that names anything but a `.key` file directly in that directory. The
     token goes to stdout only; the challenge answer reaches `curl` as a
     configuration line on stdin, never an argument.
   - `/usr/local/sbin/hcw-backup-upload KIND FILE` puts `FILE` in the
     container as `KIND/<basename>` (`KIND` is `coder` or `vault`, the two
     prefixes the Azure alerts count writes under) with one `Put Blob`,
     bearer token from `hcw-arc-token` for `https://storage.azure.com/`,
     `x-ms-blob-type: BlockBlob`. It reads the account, container and Blob
     REST version from `/etc/hcw/backups/upload.env`. `--check` instead lists
     the container once with the token and says whether the identity may. Every
     outcome is one line on stderr and one syslog line tagged
     `hcw-backup-upload`, at `daemon.info` or `daemon.err`, which the Arc data
     collection rule ships: `sudo journalctl -t hcw-backup-upload`.
   - `/usr/local/libexec/hcw-vault-backup` is the snapshot: it renews the
     token, saves `vault operator raft snapshot save` to
     `/var/backups/vault/vault-<UTC stamp>.snap` (a `.partial` name until the
     save completes), deletes local copies older than seven days and uploads
     the new one as `vault/<name>`. `VAULT_ADDR` and `VAULT_CACERT` come from
     the vault role's `/etc/profile.d/hcw-vault.sh`, the same two values a
     login shell gets.
   - `/usr/local/sbin/hcw-vault-backup-seed [--force]` is the owner's
     one-time step ("The snapshot token", below).
2. With `backups_enabled` true, writes `/etc/hcw/backups/upload.env`:
   three `KEY=value` lines naming the account, the container and the REST
   version. That file is also the switch the `coder` role's dump script reads:
   while it exists, `coder-postgres-backup` uploads the dump it has just
   written, by hand or from its timer, and a failed upload fails that run, so
   its `OnFailure=` says so; the dump stays on the host either way. With the
   switch false the file is removed and the dump stays local, as before this
   role.
3. Installs `hcw-vault-backup.service` and `.timer` (03:45 UTC, ten minutes of
   jitter, `Persistent=true`, after the 03:30 dump and before the 04:30
   reboot) and enables the timer while `backups_enabled` and
   `vault_enabled` are both true. The service carries
   `ConditionPathExists=/etc/hcw/backups/vault-token`: until the owner has
   seeded the token the run is skipped rather than failed, so the host does
   not raise `alert-lab-unit-failed` every night before then. The Azure
   alert `alert-lab-backup-missing-vault` still fires after two nights
   without a blob, which is the signal the copy is missing.
4. With the switch on, asks the Arc agent for a storage token and lists the
   container with it (`hcw-backup-upload --check`), as tonight's upload will,
   and refuses the run with the fix when the identity cannot: a grant that
   is missing, or too new to have taken effect, stops this run rather than
   the 03:30 dump.
5. Says how the backups stand: on or off, and whether the snapshot token is
   seeded.

`backups_enabled` is `arc_enabled` in `group_vars/all.yml`: the Arc
identity is the only principal granted on the container, so the uploads run
exactly when the host is Connected. A rebuilt host, before Arc is
re-onboarded, keeps its dumps locally and the two Azure alerts say the copies
are missing, which is correct.

## The snapshot token

`vault operator raft snapshot save` needs a token that may read
`sys/storage/raft/snapshot`, and the `vault` role never holds one: its root
token is typed at a hidden prompt and removed afterwards (`roles/vault/README.md`).
So the token is the owner's seed, the Coder rotation credential's pattern
(`roles/coder/README.md`, "Coder automation"; owner instruction 2026-10-09:
one seed, then automatic). The owner's line, from the workstation, is in
`docs/runbooks/labs-host.md`, "Off-host backups".

**What the seed does.** It reads the owner's Vault token from the first line
of stdin (a byte order mark, carriage return and blanks removed; a terminal,
an empty line or anything not shaped like a token refused with exit 2 before
Vault is asked anything), checks Vault accepts it, writes the policy
`hcw-raft-snapshot`:

```hcl
path "sys/storage/raft/snapshot" { capabilities = ["read"] }
path "auth/token/renew-self" { capabilities = ["update"] }
path "auth/token/lookup-self" { capabilities = ["read"] }
path "auth/token/revoke-self" { capabilities = ["update"] }
```

and creates a token under it and nothing else (`-no-default-policy`):
**periodic**, period 720 hours, so each renewal gives it the whole period
again and the nightly unit's `vault token renew` keeps it alive for as long
as the snapshots run; **orphan**, so revoking the owner's token afterwards
does not take it along. Creating an orphan periodic token needs the root
token or `sudo` on `auth/token/create-orphan`; the owner's root token has it.
The new token is written to `/etc/hcw/backups/vault-token`, `root:root`
`0600`, by rename, with its **accessor** beside it in `vault-token.accessor`:
the identifier Vault knows the token by, which revokes it without being
usable as it. A stored token that still works is left alone unless `--force`
is given. The owner's token is used for the policy, the token and the
revocations and kept nowhere; nothing the seed prints holds a token.

**The lifecycle is a reconciliation, not a hope.** One seed runs at a time
(a lock beside the token file), so two cannot mint two tokens and store one.
A token created but not stored (the directory unwritable, the rename
refused) is revoked again before the seed fails, so no token exists in Vault
that no file names. Replacing a token is three steps in a fixed order: the
old token's accessor is recorded in `/etc/hcw/backups/revoke-pending`
(written whole, by rename), then the new token is published, then
everything pending is revoked with the owner's token. An interruption
between the steps leaves the intent on disk, and every run, forced or not,
works the pending list before anything else; a run with a working token and
nothing pending is the only one that asks for no token on stdin. The token
still in the file is never revoked from that list: its accessor, asked of
Vault first and read from the copy beside it only when Vault no longer
answers for it, is protected, and a pending record that names it is a
replacement that did not complete, dropped with a note. A new token that
cannot be stored is revoked again and the retirement recorded for its
predecessor is withdrawn, so the predecessor stays the stored token. An
accessor leaves the list only when Vault revoked it or says it no longer
exists (`invalid accessor`); a revocation that fails for any other reason,
Vault unreachable included, stays, is said on stderr with the exact `vault
token revoke -accessor …` line, and is retried next run. Whether the stored
token works is judged after the list was worked, not before: a plain run
that finds it broken replaces it and says so, rather than reporting nothing
changed. The seed never calls a replacement complete while a predecessor
may still be valid.

**Where it is stored, and why a file.** A root-only file, for the reason the
Coder rotation credential is one: the unit runs as root at timer time with
nobody present, and anything root can read unattended is a root-only file
however it is wrapped. The helpers refuse the file's absence with the seed
line, and never print, log or pass its contents as an argument: the token
reaches the Vault CLI through its environment, and `vault token renew`,
which prints the token it renewed, has its output discarded.

**What it cannot do.** Read a secret, write anything, or make another token
with more than it has. A snapshot holds Vault's data encrypted under the
seal key in Key Vault, which only the Arc identity may unwrap, so the blob
alone opens nothing.

**If it stops being renewed.** A night the unit does not run (Vault sealed,
host off) is one night; the token has a month. `alert-lab-backup-missing-vault`
fires after two nights, and `sudo journalctl -t hcw-backup-upload -u
hcw-vault-backup` on the host says which step failed. A token that has
expired or been revoked is replaced with the seed line and `--force`.

## Restore

The restore and the rehearsed rebuild are the next pull request on
[#955](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/955):
a helper that lists the container as the Arc identity, downloads the newest
dump and snapshot, and restores them into a fresh `coder-postgres` and a
re-initialised Vault (`vault operator raft snapshot restore -force`; the seal
key in Key Vault is unchanged, so the restored data unseals). Until then the
local copies restore as `lab-host/README.md`, "Backups and restore", says,
and a blob downloads from the portal as any blob does.

## Check mode

Safe. `copy`, `template`, `file` and `systemd_service` report without
writing; the container listing is a command, which check mode skips, and
the `stat` runs.

## Variables

`meta/argument_specs.yml` is the contract. `backups_enabled`,
`backups_storage_account` and `backups_container` live in
`group_vars/all.yml`; the account and container are what
`infra/lab-hybrid-backups.tf` creates, and the role refuses names Azure could
not have issued. Everything else has a default in `defaults/main.yml`.
