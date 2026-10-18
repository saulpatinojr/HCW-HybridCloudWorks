# coder_sandbox

A second Docker daemon, **rootless**, run by the unprivileged system user
`hcw-coder-docker`, for Coder's workspaces and nothing else (estate review
2026-10-06, finding LAB-5; ADR 0032, amendment of 2026-10-07). Coder's
server reaches it through `coder-docker-proxy`
(`../../../coder/docker-compose.yml`), which mounts its socket directory,
and never reaches the host's daemon at all.

## Why a separate rootless daemon, and not an authorisation plugin

Until 2026-10-07 the proxy in front of Coder's server held the host's own
socket. It narrows the Docker API to the sections the provisioner needs, but
it reads paths, not bodies: a compromised server could still create a
privileged container with `/` bound, which on the host daemon is root.
Containing that needs either a body-aware authorisation layer on the host
daemon, or a daemon whose every container is unprivileged by construction.

- **An authorisation plugin** (`opa-docker-authz` and similar) sits in the
  host daemon and judges every request's body against a policy. Three
  things weighed against it here. The plugin cannot tell Coder's requests
  from root's own (Ansible and Compose create this host's containers,
  including the two that must bind a socket), so the policy would need a
  caller marker that it then has to trust. A policy that denies by field
  is only as good as its list, and Docker's JSON decoder accepts keys in any
  case and through escapes that a policy must reproduce exactly. And a
  plugin that is down stops the whole daemon answering. The published
  managed plugin was also last pushed in January 2024 (0.9), behind the
  source releases (0.11 on 2026-10-06).
- **A rootless daemon** needs no policy: everything it does, it does as
  `hcw-coder-docker` inside that user's namespace, so a privileged container
  is privileged only there and `/` is what that user may see. It comes from
  the same Docker apt repository at the same pin as `docker-ce`
  (`docker-ce-rootless-extras`), and the check that it is rootless is one
  line of `docker info`. The cost is a second image store (the workspace
  image is pulled into it, by `lab_images`), a user manager kept up by
  lingering, and cgroup delegation so the template's limits still apply.

## What it does

1. Installs `uidmap`, `dbus-user-session` and `slirp4netns` from Ubuntu.
2. Refuses to go on where unprivileged user namespaces are restricted
   (`kernel.apparmor_restrict_unprivileged_userns`, 1 on Ubuntu 24.04 and
   later) and `/etc/apparmor.d/rootlesskit` is missing. Ubuntu's `apparmor`
   package ships that profile for `/usr/bin/rootlesskit` (`userns,`);
   `docker-ce-rootless-extras` ships three binaries and no profile (read
   2026-10-07), so the profile is checked, not written.
3. Creates the system user `hcw-coder-docker` (home
   `/var/lib/hcw-coder-docker`, 0700) in no group but its own, and gives it
   a 65536-id subordinate uid and gid range placed after every range
   already in `/etc/subuid` and `/etc/subgid` (dockremap's among them), so
   no two namespaces share host ids.
4. Delegates the cpu, cpuset, io, memory and pids controllers to user
   managers (`/etc/systemd/system/user@.service.d/delegate.conf`, the
   drop-in Docker's rootless guide gives). The workspace template's
   `cpu_quota` needs cpu, which systemd does not delegate by default.
5. Creates `/run/hcw-coder-docker` (0750, the user's) now and at every boot
   (`/etc/tmpfiles.d/hcw-coder-docker.conf`), before Docker starts the
   proxy that mounts it and before rootlesskit copies `/run` up.
6. Writes the daemon's `daemon.json` (`~/.config/docker/`, root-owned,
   group-readable, so the daemon cannot rewrite it): the socket in that
   directory, `json-file` logs 10 MB x 3, and `dns: ["10.0.2.3"]` for every
   container it starts (see "Workspace DNS" below).
7. Installs the user unit `/etc/systemd/user/hcw-coder-docker.service`
   (what `dockerd-rootless-setuptool.sh install` writes, with the network
   driver named), enables it for user managers the way `systemctl --global
   enable` does, with `ConditionUser=hcw-coder-docker` so no other user's
   manager runs it, and turns lingering on so the user's manager, and the
   daemon with it, starts at boot with no login.
8. Restarts the user's manager when the unit, the configuration, the ids
   or the delegation changed (that stops the workspaces running on it),
   waits for the socket, and refuses to continue unless `docker info`
   there reports `name=rootless`, cgroup v2 with the systemd driver, and
   memory, CPU quota and pids limits.
9. Reads rootlesskit's API (`/run/user/<uid>/dockerd-rootless/api.sock`,
   `GET /v1/info`) and refuses to continue unless its DNS forwarder is
   the nameserver `daemon.json` gives every workspace.

While `coder_sandbox_enabled` is false (group_vars ties it to
`coder_enabled`), lingering is turned off and the user's manager stopped,
which stops the daemon. Its images and volumes stay under the user's home.

## Workspace DNS

rootlesskit runs `dockerd` in the host's network namespace; only the
containers live in the namespace slirp4netns serves. A container's lookups
go to `dockerd`'s embedded resolver, which forwards them to the nameservers
the container was given when it was created. Which ones depends on the
network it was created on:

- **Created on its own network**, as `docker run --network <net>` does: the
  host's `/etc/resolv.conf`, which names only systemd-resolved's stub
  `127.0.0.53`. The resolver forwards from the host's namespace as
  `hcw-coder-docker` to the stub, and the `host_firewall` role allows that.
- **Created on the default bridge and moved afterwards**, as the Terraform
  docker provider (`kreuzwerker/docker` 4.6.0) creates every workspace. It
  calls `ContainerCreate` with the network mode `bridge`, then
  `NetworkDisconnect` from `bridge`, then `NetworkConnect` to the
  workspace's network. A container on the default bridge cannot reach the
  stub, so Docker gives it systemd-resolved's upstream servers from
  `/run/systemd/resolve/resolv.conf`, and it keeps them after the move. The
  resolver then asks those public servers from the host's namespace, as
  `hcw-coder-docker`, on UDP 53, and the firewall refuses that. The
  workspace's own `/etc/resolv.conf` shows it: `Based on host file:
  '/run/systemd/resolve/resolv.conf'`, `ExtServers: [host(…) host(…)
  host(…)]`. On 2026-10-17 no workspace could resolve Coder's name, so none
  could download its agent, and every lab sat at "Agent is taking longer
  than expected to connect" (#1267).

`dns: ["10.0.2.3"]` gives every container slirp4netns's own forwarder
instead, whichever network it was created on (`ExtServers: [10.0.2.3]`).
The resolver forwards to it from the container's namespace, and
slirp4netns answers by asking the nameserver in the host's
`/etc/resolv.conf`, which is the stub, so the firewall allows it.
`dockerd`'s own lookups (image pulls) read `/etc/resolv.conf` and reach the
stub directly. The `host_firewall` role refuses a host whose
`/etc/resolv.conf` names any other nameserver. This role refuses a
rootlesskit whose forwarder is not `10.0.2.3`. The `workspace_reach` role
creates a container the way the provider does, at every run and every 15
minutes, to prove a lookup and the agent download work.

## Owner commands

Bash, on the host. The daemon's own view:

```bash
sudo docker -H unix:///run/hcw-coder-docker/docker.sock info --format '{{json .SecurityOptions}} cgroup v{{.CgroupVersion}} {{.CgroupDriver}}'
```

Good is a list containing `"name=rootless"`, then `cgroup v2 systemd`. The
workspaces it runs:

```bash
sudo docker -H unix:///run/hcw-coder-docker/docker.sock ps --format '{{.Names}} {{.Labels}}'
```

Every line names a `coder-...` container with `com.coder.resource=true`
among its labels. The DNS forwarder rootlesskit runs for them:

```bash
sudo curl -s --unix-socket "/run/user/$(id -u hcw-coder-docker)/dockerd-rootless/api.sock" http://rootlesskit/v1/info
```

Good is JSON whose `networkDriver` reads `"driver":"slirp4netns","dns":["10.0.2.3"]`.
Its log, through the user's journal:

```bash
sudo journalctl _UID=$(id -u hcw-coder-docker) -n 80 --no-pager
```

## Variables

`coder_sandbox_enabled`, `coder_sandbox_user`, `coder_sandbox_home`,
`coder_sandbox_subid_count`, `coder_sandbox_unit_name`,
`coder_sandbox_log_opts` and `coder_sandbox_start_timeout`, in
`defaults/main.yml`; `meta/argument_specs.yml` is the contract. The socket
directory is fixed in `vars/main.yml`, not a knob: the Compose file mounts
it by that literal path, and `template.test.mjs` asserts both agree.

## Check mode

Safe. The waits and the `docker info` assertion are skipped, because in
check mode nothing was started.
