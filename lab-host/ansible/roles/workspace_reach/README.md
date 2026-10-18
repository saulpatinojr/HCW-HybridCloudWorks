# workspace_reach

Proves, at every run and every 15 minutes, that a Coder workspace on this
host can do the two things it does before a learner sees anything:

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

## What it does

1. Reads the image and the repository from the `hcw-lab` template in the
   playbook's checkout (`lab-host/coder/templates/hcw-lab/main.tf`: the
   `image_digest`, `image` and `repo_url` locals). It refuses to go on
   unless it finds exactly one of each. `lab_images` reads the image the
   same way and has pulled it into the sandbox daemon by the time this role
   runs.
2. Installs `/usr/local/libexec/hcw-workspace-reach`. It starts one
   throwaway container on the sandbox daemon, as the sandbox daemon's user
   `hcw-coder-docker`, so the host firewall's sandbox chain judges its
   traffic as it judges a workspace's. The container is shaped the way the
   template shapes a workspace: the pinned image, uid 65534, every
   capability dropped, no privilege gain, no nameserver of its own, no
   mount, no published port. It is created as the Terraform docker provider
   (`kreuzwerker/docker` 4.6.0) creates one: on the default bridge, then
   disconnected from it and connected to a bridge network of its own, then
   started. From inside, it runs `getent hosts`, a 100-byte ranged `curl`
   of the agent, and `git ls-remote`. It tries three times, 20 s apart, so
   a daemon or Coder restarting at that moment is not reported, and removes
   the container and the network whatever happens.
3. Installs `hcw-workspace-reach.service`, which runs the script as
   `hcw-coder-docker` with `ProtectSystem=strict`, `ProtectHome`,
   `PrivateTmp` and `NoNewPrivileges`, and reports a failure to
   `hcw-unit-failed@` (`alert-lab-unit-failed`). Installs
   `hcw-workspace-reach.timer`, which runs it 15 minutes after boot and
   every 15 minutes after that.
4. Enables the timer, then runs the service once and fails the play with
   the check's own words when it fails. The timer comes first, so a host
   left failing keeps alerting until it is put right.

While `workspace_reach_enabled` is false (group_vars ties it to
`coder_enabled`), the timer is stopped and disabled: the sandbox daemon is
stopped too, and the check would only fail.

## What a failure says

The last line names the step that failed, what follows for learners, and
where to look:

- **cannot resolve:** the workspace's DNS. Look at `dns` in the sandbox
  daemon's `daemon.json` (the `coder_sandbox` role), the host's
  `/etc/resolv.conf` (the `host_firewall` role refuses anything but the
  stub), and the counters of `HCW-SANDBOX-OUT`.
- **resolved but could not fetch the agent:** Caddy, Coder, or the
  firewall's `hcw: https to this host` rule.
- **reached Coder but not the repository:** the firewall's `hcw: web
  egress` rule, or the repository itself.
- **the daemon does not answer**, **the image is not on the sandbox
  daemon**, or **the check's container did not run:** the sandbox daemon
  or the `lab_images` role.

## Owner commands

Bash, on the host. Run the check now, exactly as the timer runs it:

```bash
sudo systemctl start hcw-workspace-reach.service; systemctl show -p Result --value hcw-workspace-reach.service
```

Good is `success`. What it said:

```bash
sudo journalctl -u hcw-workspace-reach.service -n 5 --no-pager --output=cat
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

Safe. The script, the unit and the timer show as diffs, and the check is not
run.

## Tests

`tests/hcw-workspace-reach.test.sh` runs the script against a stand-in for
`docker` that records every call: the container's shape and its creation
order, each failure's message, the retries, the clean-up, and the URLs
passed as environment rather than as script. `scripts/lab-host-workspace-reach.test.mjs`
holds the role's place in `site.yml`, the unit's user and failure report,
and the agreement between this role's URL and the Compose file's
`CODER_ACCESS_URL`.
