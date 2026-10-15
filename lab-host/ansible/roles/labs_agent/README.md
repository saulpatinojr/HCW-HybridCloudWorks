# labs_agent

Runs `vps-agent/` as the `hcw-labs-agent` systemd service the admin Labs
page's Setup tab describes, host-native (ADR 0032), from a checkout of this
repository at the commit the playbook itself runs from. It is the last role in `site.yml` because it
needs Docker (the agent's job is `docker run`) and reads the same vault Caddy
does.

## systemd, not a container

ADR 0032 settled this: vps-agent is host-native. The reasons are the ones
that made it the right call before the ADR said so:

- The agent's entire purpose is to spawn `docker run`. A containerised agent
  needs a Docker socket mounted and a Docker CLI baked into an image the
  repository does not have (there is no `vps-agent/Dockerfile`), which is a
  second supply chain to pin for no isolation gain. Since 2026-10-07 the
  agent reaches Docker through its own socket proxy and holds no socket and
  no docker group (step 1, below), whichever way it runs.
- The env contract in `vps-agent/.env.example` and the Agents tab's own
  diagnostics (`systemctl restart hcw-labs-agent`, `journalctl -u
  hcw-labs-agent`) already assume a host service.

## What it does

1. `hcw-labs-agent` system user, primary group of the same name, and **no
   other group** (LAB-5, 2026-10-07): `groups: []` with `append: false`
   takes it out of `docker` on a host where an earlier run put it there,
   because the docker group is root on the host. It reaches Docker through
   `hcw-labs-agent-docker-proxy` instead (`tasks/docker_proxy.yml`): HAProxy
   from Docker's official image at `labs_agent_docker_proxy_image_digest`,
   configured from `templates/docker-proxy.haproxy.cfg.j2`, listening on
   `/run/hcw-labs-agent-docker/docker.sock`, `root:hcw-labs-agent` `0660`
   in a directory systemd-tmpfiles creates at boot. It passes on exactly the
   calls `docker run --rm` and `docker rm -f` make for a job (read from
   Docker CLI 29.8.1, `scripts/fixtures/docker-cli-agent-requests.json`)
   and refuses every other call, and every container create whose body asks
   for privilege, a host namespace, the opt-out of the daemon's user
   namespaces, an added capability, a device, a mount, or a bind other than
   the job's own read-only staging directory. The template's header says why
   regular expressions are sound for those rules and what they cannot do
   (require a setting to be present; the sandbox flags stay the runner's
   own contract). The container runs with `--userns=host` (it must open the
   host's socket under the remap), root with every capability dropped, no
   network at all, a read-only root filesystem and no privilege gain. The
   unit's `DOCKER_HOST` names the socket, and `ExecStartPre` waits for it.
   `scripts/lab-host-docker-proxy.test.mjs` evaluates the file's rules
   against the recorded calls and the escapes; CI parses the rendered file
   with `haproxy -c` at the pinned image; and the `privilege_checks` role
   runs one job through it, as this user, at the end of every run.
2. Node.js 26 from NodeSource's `node_26.x` repository at
   `labs_agent_node_version`, held; the
   install carries `allow_change_held_packages` so a pin bump on a re-run
   moves the held package instead of failing. The NodeSource signing key
   is refused unless its SHA256 matches `labs_agent_node_apt_key_checksum`,
   since apt trusts that key for the pinned package.
3. `git` checkout of `labs_agent_repo_url` at `labs_agent_repo_ref` into
   `/opt/hcw-labs-agent` (root-owned; the agent reads its own code and
   cannot change it), then `npm ci --omit=dev` in `vps-agent/`.
   `labs_agent_repo_ref` is not a pin: `group_vars/all.yml` sets it to the
   full sha of HEAD in the playbook's own checkout, which `bootstrap.sh`
   leaves detached at the commit it resolved (`origin/main` by default), so
   the agent runs the same commit as the playbook and moves when it does.
   An explicit `-e labs_agent_repo_ref=<sha>` on the `bootstrap.sh` line
   holds the agent at another commit (`lab-host/README.md`, "Re-running").
   A stamp in `/var/lib/hcw-labs-agent/deps-installed-<sha256 of the
   checked-out commit and the Node.js pin>` records that the install ran for
   this commit on this Node.js. It is keyed on the commit the checkout task
   reports landing on, not on the ref as written, so a ref that names a
   moving target still reinstalls when the commit moves; a re-run on the same
   commit is a no-op, and a new commit or a bumped Node.js reinstalls. Only
   the current commit's stamp is kept: the role deletes any other before the
   install, because `node_modules` holds one commit's dependencies, and a
   stamp left from an earlier visit would otherwise skip the install on a
   return to that commit (a hold released, a rollback undone).
4. If `/etc/hcw/labs-agent.pem` does not exist, generates an RSA-4096 key and
   a self-signed certificate **on this host** (`CN=<labs_agent_id>`, 730
   days), as `.env.example` asks. The PEM is `root:hcw-labs-agent` mode
   `0640`: root owns it, the service's group can read it, nobody else can,
   and there are no ACLs. The certificate alone is written to
   `/etc/hcw/labs-agent.crt` (0644) for upload to the app registration;
   the private key never leaves the host. Every run checks the remaining
   validity with `openssl x509 -checkend` and prints a warning within
   `labs_agent_certificate_warn_days` (60) of expiry; the two-step rotation
   — register the next public certificate first, then swap the PEM — is in
   `lab-host/README.md` under "Rotating the agent certificate".
5. Writes `/etc/hcw/labs-agent.env` (root, 0600, `no_log`) with exactly the
   names in `vps-agent/.env.example`; `LABS_AGENT_CERT_PATH` is
   `/etc/hcw/labs-agent.pem`.
6. Installs `hcw-labs-agent.service` (`Restart=on-failure`,
   `Requires=docker.service`, `NoNewPrivileges`, `ProtectSystem=full`,
   `PrivateTmp`) and starts it **only when all four identity values are
   set**. Otherwise it explicitly stops and disables the unit and deletes
   `/etc/hcw/labs-agent.env` — so removing a value from the vault and
   re-running is a revocation: the agent goes offline and a manual
   `systemctl start` cannot bring it back on the old credentials — and
   prints what is missing. The identity is an owner step recorded in
   `docs/standards/required-inputs.md` section 4.7.
   The unit also sets `KillMode=mixed` and `TimeoutStopSec=30` (LAB-13,
   #959). On a stop or a reboot, SIGTERM reaches the agent alone, never
   the `docker` CLI it runs. The agent interrupts each running job, starts
   removing its container through the proxy, and without waiting for that
   removal reports it `failed` with
   *The lab host was restarting and this job was interrupted. Submit it
   again.* It then waits up to `LABS_AGENT_SHUTDOWN_TIMEOUT_MS` for those
   reports, says `offline`, and exits. A removal can take longer than that
   window, and a crash removes nothing, so the unit itself owns the
   containers: `/usr/local/libexec/hcw-labjob-sweep` (from `files/`) runs as
   root after the agent exits and before it starts, and removes every
   container labelled `hcw.lab-job` through the daemon's own socket.
   `tests/hcw-labs-agent.service.test.sh` renders the unit and the env file
   with the role's defaults and checks those lines;
   `tests/hcw-labjob-sweep.test.sh` tests the sweep against a stand-in for
   `docker`.

`lib/docker-runner.js` stages each job's payload under `os.tmpdir()` and
bind-mounts that path into the job container. With `PrivateTmp` the unit's
`/tmp` is invisible to the Docker daemon, so the unit sets
`TMPDIR=/var/lib/hcw-labs-agent/tmp`, a real host directory owned by the
agent, and the role creates it (0750, so only the agent lists it). Inside
it, the runner makes each per-job `labjob-*` directory 0755 and the payload
copy 0644, because the container runs as 65534:65534 and could not traverse
the 0700 directory `mkdtemp` creates; each directory exists for one job,
holds only that job's payload copy, and is removed when the job ends.

The role sets no Docker labels and passes nothing to the jobs the agent
starts; the `hcw.lab-job` label ADR 0032 requires on every job container is
the agent's own code change (#675), not this role's.

## Variables

Pins and identity (required, from `group_vars/all.yml`): `labs_agent_user`,
`labs_agent_home`, `labs_agent_repo_url`, `labs_agent_repo_ref` (derived
there from the playbook's checkout, above), `labs_agent_node_version`,
`labs_agent_id`.

From the vault (each defaults to its `vault_` twin, empty when absent):
`labs_agent_api_base`, `labs_agent_tenant_id`, `labs_agent_client_id`,
`labs_agent_api_scope`.

Job limits with the `.env.example` defaults: `labs_agent_max_concurrent`,
`labs_agent_poll_ms`, `labs_agent_job_memory`, `labs_agent_job_cpus`,
`labs_agent_job_pids`, `labs_agent_job_nofile`.

Stopping (LAB-13, #959), a pair that has to fit together:

| Variable | Default | Rendered as | What it bounds |
| --- | --- | --- | --- |
| `labs_agent_shutdown_timeout_ms` | `5000` | `LABS_AGENT_SHUTDOWN_TIMEOUT_MS` in `/etc/hcw/labs-agent.env` | How long the agent waits after SIGTERM for the reports of the jobs it interrupted |
| `labs_agent_timeout_stop_sec` | `30` | `TimeoutStopSec=` in the unit | How long systemd waits for the agent to exit before it kills what is left of the unit |

`labs_agent_timeout_stop_sec` × 1000 must be at least
`labs_agent_shutdown_timeout_ms` plus the two 5-second shutdown heartbeats:
30 000 ≥ 5000 + 2 × 5000 with the defaults.
`scripts/lab-job-limits.test.mjs` fails on defaults that do not fit, and an
override has to keep the sum itself.

Paths and the unit name are in `defaults/main.yml`;
`meta/argument_specs.yml` is the contract.

## Handlers

`Restart hcw-labs-agent`, which is itself conditional on the identity being
configured so an unconfigured host never starts a crash-looping unit.

## Check mode

Safe. `git`, `shell` with `creates`, `template` and `systemd_service` all
report without acting; the stop-and-disable task is guarded on the unit
file existing, so a never-bootstrapped host does not fail on a unit systemd
has never seen.
