# portainer

Portainer Business Edition on the lab host, for the owner and nobody else
(owner decision 2026-09-26; ADR 0032, amendment of that date). A single
container with the Docker socket and a named data volume, its HTTPS UI
published on the host's loopback and reached through an SSH tunnel. There
is no Caddy route and nothing public. Off until `portainer_enabled` is true.

## What it does

1. **Fails closed** unless the publish address is `127.0.0.1`. The address
   is fixed in `vars/main.yml`, and the assertion is there so an override
   cannot move it. Portainer holds the Docker socket, which is root on this
   host, and Docker writes its own iptables rules for a published port ahead
   of ufw's, so ufw would not stop a publish on `0.0.0.0`.
2. With `portainer_enabled` true: creates the `portainer-data` volume and
   runs the `portainer` container from `portainer_image@portainer_image_digest`
   with `restart: unless-stopped`, `/var/run/docker.sock` and the volume at
   `/data`, `127.0.0.1:9443:9443`, `--http-disabled` (so the plain-HTTP port
   9000 does not listen even inside the container; neither 9000 nor the Edge
   tunnel's 8000 is published), `no-new-privileges` and a 512 MiB memory
   limit. It then waits for `https://127.0.0.1:9443/api/system/status`.
   Since 2026-10-07 the container also runs with `--userns=host`: the
   daemon remaps every container's root to an unprivileged range (LAB-5,
   `../docker/README.md`), and a remapped root cannot open the socket that
   is Portainer's whole purpose. Its volume was carried into the remapped
   data root as it was, on the run that turned the remap on. Portainer shows
   the host daemon only; Coder's workspaces run on the `coder_sandbox`
   daemon, which it does not see. **A Docker restart no longer strands it**
   (#1328): the container holds the daemon's socket as a bind-mounted file,
   so a daemon restart (any docker-ce upgrade) leaves a running Portainer on
   the old, unlinked socket. It still answers, but its `local` environment
   reads down and the check below raises the lab alert; the 2026-10-21
   bootstrap (Docker 29.9.1 to 29.9.2) left it so until `sudo docker restart
   portainer`. Before the container task the role installs the
   `labs_agent` role's `hcw-docker-proxy-stale` helper (the same file, to the
   same path, the agent's socket proxy needed in #1135) and asks it about
   Portainer; a Portainer that started before the daemon's current start is
   restarted onto the new socket, one that did not is left alone, and the
   run says which.
3. With it false: removes the container and keeps the volume, so turning it
   back on brings back the same administrator, settings and licence.

It creates no administrator and holds no licence key. Both are the owner's,
entered in the UI; neither is in the repository or the Ansible vault.

## Business Edition, and the licence it runs under

The owner ran Portainer EE 2.39.4 before the reinstall. Business Edition is
free under Portainer's
[3 Nodes Free licence](https://www.portainer.io/legal/3nf-license-agreement)
(last modified 2023-07-06, read 2026-09-26): "for internal business purposes
only, limited to no more than one (1) server instance and a total of three
(3) nodes including the server instance". A standalone Docker host is one
node ([what is a node](https://docs.portainer.io/faqs/licensing/what-is-a-node-for-licensing-purposes)),
so this host is one server instance and one node. The key is issued for a
year and renewed without cost each year while the use stays within three
nodes. Two clauses to keep in mind: one 3 Nodes Free licence per
organisation, and no use "to provide services to third parties". Portainer
here is the owner's administration tool; learners never reach it, and the
labs they use run in Coder. If the use ever outgrows that, the Community
Edition image `portainer/portainer-ce` is the same release under the zlib
licence with no key, and switching is a change to `portainer_image` and the
digest.

## The first-administrator window and the setup token

Two guards against someone else claiming a fresh instance, both measured on
2.45.1 on 2026-09-26:

- Until an administrator exists, Portainer stops serving five minutes after
  it starts. The container keeps running (so no restart policy brings it
  back), and every request answers **303** with `Administrator
  initialization timeout`. `sudo docker restart portainer` opens a new five
  minutes.
- Creating the administrator needs the one-time setup token Portainer prints
  in its log at every start (`setup_token=...`, "Paste it into the setup
  screen, or send it in the X-Setup-Token header"). Without it the request
  is refused with 403. The role leaves this on: `--no-setup-token` would
  remove the one guard that does not depend on the loopback.

The role's wait accepts 303 as "up" and says which state it found, so a run
that comes later does not fail on it. The owner procedure (tunnel, restart,
token, administrator, licence) is in `docs/runbooks/labs-host.md`, "Portainer
through an SSH tunnel". An 11-character administrator password was refused
and a 32-character one accepted.

## The check

Since 2026-10-19 (#1282) the role also installs a read-only check of
Portainer itself, so the owner's container UI for the lab host cannot be
down, unlicensed or drifting without anyone seeing it. The site's Health Hub
shows it as the **Portainer** card on the Enhanced hub, beside the other
lab-host probes; the card goes critical when no report has arrived for 45
minutes, so a timer that stops is seen too.

**What it reads.** `/usr/local/libexec/hcw-portainer-check` (Python 3,
standard library only, `files/hcw-portainer-check`) makes six kinds of
`GET` against `https://127.0.0.1:9443/api`, each with the token in
`X-API-Key`:

| Read | For |
| --- | --- |
| `/system/status` | `Version` |
| `/system/version` | `ServerEdition` (EE or BE as `EE`, CE as `CE`; anything else leaves the field out) and `UpdateAvailable`, said in the journal line |
| `/licenses` | `valid` and `expiresAt` (epoch seconds). Valid when one licence says so; not valid when one says so and none is; unknown when Portainer says neither, which a fresh instance does |
| `/endpoints` | The environment whose `Name` is `portainer_check_environment_name` (`local`), found by name because its `Id` is 3 on this host, not 1; `Status` 1 is up. While it reads down the check asks again every 2 seconds, for up to `portainer_check_environment_wait_seconds`, because a Portainer that has only just started can read down for a moment |
| `/endpoints/<id>/docker/containers/json?all=true` | Docker's own list: `State` counted as running, restarting and exited; `(unhealthy)` in `Status` counted as unhealthy |
| `/docker/<id>/containers/<container>/image_status` | One per running container: `updated` or `outdated` is a verdict and is counted as checked; `processing`, `skipped` and `error` are not. The reads share a 90 s budget, so a slow registry leaves containers unchecked rather than failing the run |

Certificate verification is off for these reads, because the certificate is
the one Portainer generates for itself and the connection never leaves the
loopback: the script refuses a URL on any other address, so the setting
cannot be carried somewhere it would matter.

**What it reports.** One JSON object, `{"check": "portainer", "report":
{...}}`, whose report holds `checkedAt`, `up`, `version`, `edition`,
`licenseValid`, `licenseExpiresAt`, `environmentName`, `environmentUp`,
`containers` (`total`, `running`, `unhealthy`, `restarting`, `exited`),
`imagesChecked`, `imagesOutdated` and `error`: counts, states, a version and
dates, never a container's name, an image's name or a digest. The site
refuses a report holding anything else (`functions/src/lib/labs/host-checks.js`),
which is what lets the Health Hub show it to an admin without showing what
runs on the host. With no container running, zero images were checked and
zero are outdated; `null` in those two fields means the containers could not
be read at all. The journal gets one summary line in the same terms
(`<version>` is `portainer_image_tag` in `group_vars/all.yml`):

```text
hcw-portainer-check: checked: Portainer <version> EE up; environment local up with 8 containers (7 running, 0 unhealthy, 0 restarting, 1 exited); 7 images checked, 0 outdated; licence valid to 2027-09-26; reported to the site
```

**How it reaches the site.** Through the lab agent's own CLI,
`vps-agent/bin/report-host-check.js`, run as the agent's user with the
agent's environment file and checkout through `systemd-run`, exactly as
`hcw-coder-automation` hands the site its reports (`../coder/README.md`,
"Coder automation"): the same `--uid`, `--gid`, `EnvironmentFile`,
`WorkingDirectory` and sandboxing properties, the JSON on stdin, the exit
status propagated by `--wait`. The agent's values are repeated in this role's
`portainer_check_agent_*` defaults because roles do not read each other's
variables; the test beside this role fails when they part from the coder
role's or the `labs_agent` role's.

**The token, and why it is root-only and read through a credential.** Owner
decision 2026-10-19: the check runs with the owner's own Portainer access
token (`hcw-portainer-write`, kept on the owner's account), not with a token
of a read-only Portainer user. A Portainer access token carries the whole
authority of its user, so this one can do anything the owner can in
Portainer, and the handling follows from that:

- It is set with `hcw-vault-set` as `vault_portainer_api_token` and never
  declared by this role (`hcw-vault-set` refuses a key the playbook
  defines). The role reads it with
  `lookup('ansible.builtin.vars', 'vault_portainer_api_token', default='')`,
  so a host without it installs the check and leaves it skipped.
- The role writes it to `/etc/hcw/portainer/api-token`, root `0600`, in a
  root `0700` directory, with `no_log` on the task. Root on this host can
  already read Portainer's volume, so a root-only file adds no reach to
  someone who has root, and nothing else can read it.
- The unit's `LoadCredential=api-token:/etc/hcw/portainer/api-token` copies
  it into the unit's private credentials directory for each run, and the
  script reads `$CREDENTIALS_DIRECTORY/api-token` and nothing else: never an
  argument, which `ps`, the unit file and the journal would show, and never
  the environment, which every child inherits. The environment the script
  gives `systemd-run` is `PATH` and `LC_ALL` alone, so neither the token
  nor `$CREDENTIALS_DIRECTORY` reaches the agent's CLI.
- Every line the script prints is scrubbed of the token first, and the
  test's leak check reads every output, every `systemd-run` argument and
  every report for it.
- It is rotated on every host rebuild (`docs/standards/required-inputs.md`,
  section 4.7).

**Why GET only.** The token could change anything; the check has one job,
which is to read. The script has one HTTP method, and the test's fake
Portainer answers every other method with 405 and records it, so a change
that made the check write would fail the test before it reached the host.

**When it fails.** The run exits 1, and the unit's
`OnFailure=hcw-unit-failed@%n.service` raises the lab alert (LAB-2;
`alert-lab-unit-failed`), when Portainer does not answer, refuses the token
(it was revoked or replaced), lists no environment of that name or lists it
down, or when the report does not reach the site. The report goes out first
whatever happened, with `up` false where that is what was seen and `error`
set to the reason, so the card says why. Unhealthy or restarting containers,
outdated images and a licence that is not valid are the site's warnings and
the run's exit 0: they are states to look at, not a check that could not do
its job. A read the report can do without (the edition, the licence) that
fails leaves its fields unknown and a note in the journal.

**Turning it on.** With the token on the clipboard, PowerShell:

```powershell
(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_portainer_api_token"
```

Then re-run `bootstrap.sh`. The run writes the file, enables the timer, runs
the check once and prints its line; until then it prints `The Portainer
check is not configured: set vault_portainer_api_token (lab-host/README.md,
"Portainer") and re-run bootstrap.sh.` and the timer stays off. A run with
the check failing says so and goes on: this role runs among the others, and
a token the owner has yet to put right should not leave Vault, the add-ons
and the backups unapplied behind it. Removing the key removes the file, and
the unit's `ConditionPathExists=` skips every run from then on, so turning
the check off pages nobody.

**Owner commands.** Bash, on the host. Run the check now, exactly as the
timer runs it:

```bash
sudo systemctl start hcw-portainer-check.service; systemctl show -p Result --value hcw-portainer-check.service
```

Good is `success`. What it said, without systemd's own lines:

```bash
sudo journalctl -t hcw-portainer-check -n 3 --no-pager --output=cat
```

Good ends with a line beginning `hcw-portainer-check: checked:`. When the
timer next runs:

```bash
systemctl list-timers hcw-portainer-check.timer --no-pager
```

## Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `portainer_enabled` | required (`false` in `group_vars`) | Run or remove the container |
| `portainer_image`, `portainer_image_tag`, `portainer_image_digest` | required | The pin; run as `image@digest` |
| `portainer_container_name` | `portainer` | The name ADR 0032's validation list checks for |
| `portainer_volume_name` | `portainer-data` | Data volume, kept while disabled |
| `portainer_https_port` | `9443` | Port on `127.0.0.1`; the address is fixed |
| `portainer_memory` | `512m` | Memory limit |
| `portainer_check_enabled` | `true` | Install and run the check; it also needs `portainer_enabled` and the vault key |
| `portainer_check_interval`, `portainer_check_boot_delay` | `15min`, `5min` | The timer |
| `portainer_check_environment_name` | `local` | The environment reported on, found by name |
| `portainer_check_script`, `portainer_check_unit` | `/usr/local/libexec/hcw-portainer-check`, `hcw-portainer-check` | Where the check is installed, and its unit and journal name |
| `portainer_check_token_file`, `portainer_check_config_file` | `/etc/hcw/portainer/api-token`, `/etc/hcw/portainer/check.json` | The token (root `0600`) and the configuration beside it; the directory is derived in `vars/main.yml` |
| `portainer_check_report_timeout_seconds` | `60` | How long the site's CLI may take |
| `portainer_check_environment_wait_seconds` | `30` | How long the check keeps asking while the environment reads down (a Portainer that has only just started); `0` asks once |
| `portainer_check_agent_user`, `_group`, `_env_file`, `_app_dir`, `_node`, `portainer_check_systemd_run`, `portainer_check_report_cli` | the coder role's values | The lab agent's user and paths, `systemd-run`, and the CLI |

`meta/argument_specs.yml` is the contract.

## Bumping the pin

Portainer publishes LTS and STS lines, and the pin follows the newest LTS:
an STS line is superseded within weeks and gets no patches after that.
endoflife.date has no Portainer product, so nothing checks this pin
automatically (`scripts/version-floors.json`, `unsourced`). The release
list, newest first, with LTS or STS in each title; bash, anywhere with `gh`:

```bash
gh api repos/portainer/portainer/releases -X GET -f per_page=10 --jq '.[] | "\(.tag_name)  \(.published_at[0:10])  \(.name)"'
```

The digest is the image **index**, read with `docker buildx imagetools
inspect`, and cross-checked against the registry's `Docker-Content-Digest`,
which must print the same `sha256:`. The tag in the commands below is an
example: use the one you are pinning (`portainer_image_tag` in
`group_vars/all.yml`). Bash, anywhere with Docker:

```bash
docker buildx imagetools inspect portainer/portainer-ee:2.45.1 | head -3
```

```bash
curl -fsSI -H "Authorization: Bearer $(curl -fsS 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:portainer/portainer-ee:pull' | sed -E 's/.*"token":"([^"]+)".*/\1/')" -H 'Accept: application/vnd.oci.image.index.v1+json' https://registry-1.docker.io/v2/portainer/portainer-ee/manifests/2.45.1 | grep -i docker-content-digest
```

On 2026-09-26 both printed
`sha256:0cd22f754ac52fcfceb362d5ce8f47ee23a5f6427484db17ebfaa4c8a00f7718`,
and `portainer-ee:lts`, `:latest` and `:sts` resolved to it. Portainer
migrates its database forward on start; read the release notes of every
release between the old pin and the new before moving it.

## Check mode

Safe. `docker_volume` and `docker_container` report what they would do; the
wait is skipped. The check's script, units and configuration show as diffs
and the token file as a change without its content; the timer is enabled
only where a real run has installed it, and the check is not run.

## Tests

`tests/hcw-portainer-check.test.py` runs the script as it ships against a
fake Portainer (a decoy environment with Id 1 beside the local one with Id
3, Docker's container list, an image verdict per container, every method
but `GET` answered 405 and recorded), a fake `systemd-run` that reads the
environment file and runs the CLI in the agent's checkout, and a fake site
CLI that records the payload. It covers the healthy report, an unhealthy
container, a restarting one, an outdated image, an image still being
processed, no container running, each licence state, each edition label, a
missing or down environment, a refused token, Portainer down (the `up:false`
report still delivered, exit 1), the site's CLI failing (exit 1), a URL off
the loopback refused, and that the token and no container or image name is
in any output, any `systemd-run` argument or any report. It also renders the
role's files with its defaults and holds them to the coder role, the
`labs_agent` role, the hardening role's notifier and this README's
not-configured sentence, where PyYAML and Jinja2 are importable (CI's are;
under `python -I` on a workstation that has them as user-site installs,
those checks are skipped and say so). CI runs it in the
`ansible-lint (lab-host)` job. Needs neither root nor Docker.

`tests/portainer-stale-socket.test.sh` holds the restart above to its wiring:
the role installs the helper from the `labs_agent` role's files to the path
that role uses, asks it about this role's container before the container task,
records `portainer_stale` only for the exact answer `stale`, ties the
container task's `restart:` to it (and not to every run), skips the question in
check mode, and says so when it restarts. It also runs the helper against
stand-ins for `systemctl` and `docker`, with the real GNU date and this role's
own container name: a Portainer older than the daemon is `stale`, a newer one
`fresh`, one not running or not there `absent`. Breaking each of those in turn
turned it red. CI runs it in the same job. Needs neither root, Docker nor
Ansible, and so it does not prove a live restart: that shows on the first
bootstrap that upgrades Docker, as the line `Portainer was restarted onto the
daemon's new socket` in the run and `environment local up` in the check.
