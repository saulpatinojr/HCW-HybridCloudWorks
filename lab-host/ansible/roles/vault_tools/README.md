# vault_tools

The host side of the Ansible vault: the directory `bootstrap.sh` reads it
from, and `hcw-vault-set`, which sets one key in it. This is the vault the
playbook reads, `/etc/hcw/ansible/vault.yml`. HashiCorp Vault, which the
host also runs, is the `vault` role.

`hcw-vault-set` was first installed on the host by hand. This role puts the
same helper there from the repository, with two fixes (below), so the host
carries no hand-made tooling.

## What it does

1. Makes `/etc/hcw/ansible` a directory, `root:root` `0700`. That is what the
   `install -d` line in `lab-host/README.md` ("The vault") makes, so on a
   host where the owner ran it this task is `ok`. The role creates neither
   `vault.yml` nor `vault-password`.
2. Copies `files/hcw-vault-set` to `/usr/local/sbin/hcw-vault-set`,
   `root:root` `0750`.

It runs straight after `hardening` in `site.yml`, so the helper is in place
even when a later role stops on a missing vault key, which is when it is
needed.

## hcw-vault-set

```text
hcw-vault-set KEY   (the value is read from stdin)
```

The owner's line, from the workstation, is in `lab-host/README.md`, "The
vault". On the host, as root:

1. It refuses a key that is not `vault_` followed by `[a-z0-9_]`, with exit
   code 2, before reading anything.
2. It refuses, with exit code 2 and before reading the value, a key the
   playbook itself defines as a variable. `bootstrap.sh` passes `vault.yml`
   with `-e`, and an extra var outranks every other variable, so such a key
   would silently replace it: `vault_enabled` or `vault_api_port`, say,
   which belong to the `vault` role that runs HashiCorp Vault. The names
   are read at run time from the checkout the host runs, `/opt/hcw-src`
   (`HCW_SRC_DIR` overrides it, which is how the test runs it), in
   `lab-host/ansible/`, `.yml` or `.yaml`:
   - every top-level key of the files under `group_vars/`, `host_vars/`
     and each role's `defaults/` and `vars/`, `main/` directories included;
   - every name the playbooks at the top, the inventory, and each role's
     `tasks/` and `handlers/` (subdirectories included) set as they run: a
     play's, block's or task's `vars`, a `register`, a `set_fact` in any of
     its spellings (`set_fact`, `ansible.builtin.`, `ansible.legacy.`, and
     the free-form `name=value`), and an inventory host's own variables.

   The error names the file. With no checkout there, with no role in it, or
   with a file in it that does not parse, it refuses every key rather than
   guess. A variable loaded from a file named only at run time
   (`include_vars`, `vars_files`) is not seen; the playbook uses neither.
   None of the keys the playbook reads from the vault today is refused.
3. It refuses with exit code 2 when `vault-password` is missing or empty.
4. It reads the value from stdin into a root-only temporary directory,
   dropping carriage returns. A leading byte order mark and surrounding
   whitespace are removed too, and an empty value is refused.
5. It decrypts `vault.yml` when it exists, sets the key in the parsed
   mapping and writes it back as YAML (sorted keys; comments are not kept).
   Every value it writes is a string, so `true` or `0123` stays the text it
   was.
6. It encrypts the result with the existing password, then decrypts it
   again to check the key is there.
7. It installs the result beside `vault.yml` as `root:root` `0600` and
   renames it over `vault.yml`.
8. It prints `hcw-vault-set: set KEY (value not shown). Keys in the vault:`
   followed by the key names. The temporary files are shredded on every
   exit.

Nothing it prints contains a value, and the value is never an argument, so
it is not in `ps`, a shell history or a log. `HCW_VAULT_DIR` points it at
another directory and `HCW_SRC_DIR` at another checkout, which is how the
test runs it. `sudo` resets the environment, so through the owner's line
they are always `/etc/hcw/ansible` and `/opt/hcw-src`.

### What changed from the hand-installed copy

- **The vault is replaced by rename.** The hand-installed copy ended with
  `install -m 0600 -o root -g root "$tmp/new" "$vault"`. On Ubuntu 26.04 that
  `install` (uutils coreutils 0.8.0) unlinks `vault.yml` first, then creates
  and writes the new file (seen with `strace`: `unlink`, then `openat(...,
  O_CREAT|O_EXCL)`). A run that stopped between the two, for example on a
  full disk, left no vault at all. The file is now installed as
  `.vault.yml.hcw-vault-set.<pid>` in the same directory and moved over
  `vault.yml` with `mv -f`, which is one `renameat`. The temporary name is
  removed on any exit, and it is not the `.vault.yml.next` that
  `scripts/lab/Register-LabAgent.ps1` uses, so the two writers never rename
  each other's half-written file.
- **A leading byte order mark is not part of the value.** The value was read
  as `utf-8`, and `str.strip()` does not remove U+FEFF. A value piped from a
  Windows tool that prepends one reached the vault with it, and a secret
  with an invisible first character fails wherever it is used, far from
  here. It is read as `utf-8-sig` now. The test pipes `EF BB BF` before a
  value, and the hand-installed copy fails that check.

Everything else is byte for byte the hand-installed copy, so the first run
after this role lands reports its copy task `changed` and every run after
that `ok`.

### Since then

- **Names the playbook defines are refused** (step 2 above; 2026-09-28,
  with the lab launcher). Until then the helper took any `vault_*` name,
  and this README and `lab-host/README.md` could only ask the owner never
  to set `vault_enabled` and its kind. The run after it lands reports the
  copy task `changed` once more.
- **Python runs isolated** (`-I`), in all four places the helper starts it.
  `python -` and `python -c` otherwise put the current directory first on
  `sys.path`, so a `yaml.py` wherever the owner ran `sudo` from would have
  run as root, the value-carrying step included. Found in the security
  review of the lab launcher's pull request; the test plants a `yaml.py` in
  the working directory and fails without `-I`.

## Tests

`tests/hcw-vault-set.test.sh` runs `files/hcw-vault-set` as it ships, as
root, against a scratch `HCW_VAULT_DIR` and a real `ansible-vault`. It
checks:

- the helper's two tool paths are where `bootstrap.sh` installs them, and
  its checkout is where `bootstrap.sh` keeps it;
- bad key names are refused (exit 2) and create nothing;
- against this repository's own playbook, `vault_enabled`, `vault_api_port`
  and the `vault` role's task vars `vault_seal_status` and
  `vault_state_advice` are refused, and every key the playbook reads from
  the vault passes;
- in a checkout made for the test, every kind of definition step 2 lists is
  refused with its file named, a name that is only a value passes, and a
  file that does not parse, a checkout with no role, or no checkout refuses
  every key;
- a `yaml.py` in the working directory is never imported;
- empty values are refused, before and after the vault exists;
- a missing password and a wrong one are refused;
- two keys can be set and one replaced, with CR, LF, BOM and spaces
  removed;
- YAML-looking values come back as the same strings;
- a key the helper did not write is kept;
- the file is Ansible Vault ciphertext, holds no value in the clear, and is
  `root:root` `0600`;
- every refused run leaves `vault.yml` byte for byte as it was;
- no temporary file is left behind.

The `ansible-lint (lab-host)` job in `.github/workflows/ci.yml` runs it with
`sudo` and the job's own ansible-core. Where `/usr/local/bin/ansible-vault`
or `/opt/uv/ansible-core/bin/python` (through the link `bootstrap.sh` moves
to each environment it builds from `lab-image/versions.env` once that
environment passes its checks, `HCW_ANSIBLE_VENV` there) is missing, the test links it to
the `ansible-vault` on `PATH` and the Python that runs it, and removes those
links at the end. It never replaces a file that is there. To run it without
a host, see `lab-host/README.md`, "Validating without a host".

## Variables

None. `files/hcw-vault-set` names `/etc/hcw/ansible` and `/opt/hcw-src`
itself (the second is `bootstrap.sh`'s `HCW_SRC_DIR` default, which the
test holds it to), and the documentation and the owner's one-liners name
`/usr/local/sbin/hcw-vault-set`, so no path can move alone.
`meta/argument_specs.yml` says so.

## Check mode

Safe: both tasks are `file` and `copy`.
