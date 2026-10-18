# workspace_reach

Proves, at the end of every run and every 15 minutes, that a Coder workspace
on this host can do the two things it does before a learner sees anything:

1. resolve the name in Coder's access URL and fetch the agent from
   `<url>/bin/coder-linux-amd64`. Coder's init script does that first and
   retries it forever when it cannot, which the learner sees as **"Agent is
   taking longer than expected to connect"**;
2. reach the lab repository a lab's startup script checks its folder out of
   (`git ls-remote`).

## Why it exists

On 2026-10-17 every lab workspace started its container and then waited for
an agent that could not resolve Coder's name. The workspaces' lookups went
to public resolvers that the `host_firewall` role refuses. Every run of the
playbook still passed, because nothing in it started a workspace (#1267;
`coder_sandbox`'s README, "Workspace DNS"). A container started with
`docker run --network` did resolve on that host, because Docker gives a
container created on its own network different nameservers from one created
on the default bridge and moved. Only a container created the way the
templates' containers are created shows what a learner gets.

## Where it runs

From `site.yml`'s `post_tasks`, after `privilege_checks` and before the
commit record, with `tags: [always]`:

- **After every role and the handlers they notified**, so it checks the host
  as it now is. A run that creates Coder's Caddy route reloads Caddy before
  this check fetches through it.
- **After every role, not among them**, so a failure that is not this
  host's (public DNS, the certificate, GitHub) leaves the add-ons, Vault and
  the backups applied. It stops only the commit record, which claims a
  converged host.
- **Whatever the tags**, so a narrowed run that touches the sandbox, the
  firewall, Caddy or Coder is checked as a full run is. It takes a few
  seconds.

## What it does

1. Reads, from the `hcw-lab` template in the playbook's checkout
   (`lab-host/coder/templates/hcw-lab/main.tf`), the repository of the
   workspace image (the `image` local, without its digest) and the lab
   repository (`repo_url`). It refuses to go on unless it finds exactly one
   of each. `lab_images` reads the image the same way.
2. Installs `/usr/local/libexec/hcw-workspace-reach`. Each attempt asks the
   sandbox daemon whether it answers and finds the newest image of that
   repository on it, which is the pin `lab_images` keeps there. It reads that
   image at every run, so a narrowed run that moves the pin never leaves the
   check naming a digest that has gone. It then starts one throwaway
   container shaped the way the template shapes a workspace: uid 65534,
   every capability dropped, no privilege gain, no nameserver of its own,
   no mount, no published port. The container is created as the Terraform
   docker provider (`kreuzwerker/docker` 4.6.0) creates one: on the default
   bridge, then disconnected from it and connected to a bridge network of
   its own, then started. From inside, it runs `getent hosts`, a 100-byte
   ranged `curl` of the agent, and `git ls-remote`. The script makes three
   attempts, 20 s apart, so a daemon or Coder restarting at that moment is
   not reported. It removes the container and the network whatever happens.
3. Installs `hcw-workspace-reach.service`. It runs the script as
   `hcw-coder-docker`, which owns the sandbox daemon's socket, so the check
   reaches that daemon and no other Docker. It runs with `ProtectSystem=strict`,
   `ProtectHome`, `PrivateTmp` and `NoNewPrivileges`, logs as
   `hcw-workspace-reach`, and reports a failure to `hcw-unit-failed@`
   (`alert-lab-unit-failed`). It runs only while the sandbox user lingers. The
   `coder_sandbox` role turns lingering off before it stops the daemon when
   Coder is turned off, so the check is skipped, not failed, from that moment.
   Installs `hcw-workspace-reach.timer`, which runs it 15 minutes after boot
   and every 15 minutes after that.
4. Enables the timer, then runs the service once. It fails the play with the
   check's own last line when the check fails, and when the check was
   skipped. The timer comes first, so a host left failing keeps alerting
   until it is put right.

While `workspace_reach_enabled` is false (group_vars ties it to
`coder_enabled`), the timer is stopped and disabled.

## What a failure says

The last line names the step that failed, what follows for learners, the
tool's own words (curl's, git's, the daemon's), and where to look:

- **cannot resolve:** the workspace's DNS. Look at `dns` in the sandbox
  daemon's `daemon.json` (the `coder_sandbox` role), the host's
  `/etc/resolv.conf` (the `host_firewall` role refuses anything but the
  stub), and the counters of `HCW-SANDBOX-OUT`.
- **resolved but could not fetch the agent:** Caddy, Coder, or the
  firewall's `hcw: https to this host` rule.
- **reached Coder but not the repository:** the firewall's `hcw: web
  egress` rule, or the repository itself.
- **the daemon does not answer**, **no image is on the sandbox daemon**, or
  **the check's container did not run:** the sandbox daemon or the
  `lab_images` role.

## Owner commands

Bash, on the host. Run the check now, exactly as the timer runs it:

```bash
sudo systemctl start hcw-workspace-reach.service; systemctl show -p Result --value hcw-workspace-reach.service
```

Good is `success`. What it said, without systemd's own lines:

```bash
sudo journalctl -t hcw-workspace-reach -n 3 --no-pager --output=cat
```

Good ends with a line beginning `workspace reach: OK:`. When the timer next
runs:

```bash
systemctl list-timers hcw-workspace-reach.timer --no-pager
```

## Variables

`workspace_reach_enabled`, `workspace_reach_user`,
`workspace_reach_docker_host`, `workspace_reach_coder_url`,
`workspace_reach_boot_delay` and `workspace_reach_interval`, in
`defaults/main.yml`; `meta/argument_specs.yml` is the contract.
`group_vars/all.yml` ties the first, the user and the URL to `coder_enabled`,
`coder_sandbox_user` and `coder_domain`.

## Check mode

Safe. The script, the unit and the timer show as diffs. The timer is enabled
only where a real run has installed it, and the check is not run.

## Tests

`tests/hcw-workspace-reach.test.sh` runs the script against a stand-in for
`docker` that records every call. It covers:

- the container's shape and its creation order;
- the image found at run time;
- each failure's message, with the tool's own words;
- the retries, a daemon that comes back among them;
- the clean-up;
- the URLs passed as environment rather than as script.

`scripts/lab-host-workspace-reach.test.mjs` holds:

- the check's place in `site.yml`;
- the unit's user, condition, journal name and failure report;
- that no template overrides the daemon's DNS;
- the agreement between this role's URL and the Compose file's
  `CODER_ACCESS_URL`.
