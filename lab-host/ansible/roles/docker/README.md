# docker

Docker Engine is the only runtime on the lab host (ADR 0032, no Kubernetes).
This role installs it from Docker's own apt repository at the versions pinned
in `group_vars/all.yml`, replacing the `curl -fsSL https://get.docker.com |
sh` step the Setup tab used to list.

## What it does

1. Installs `python3-docker` and `python3-requests` from Ubuntu: the
   `community.docker` modules the caddy role uses run on the target's
   interpreter and need them. These two are not pinned like the rest because
   they come from the Ubuntu archive, which drops a superseded version the
   day a security update replaces it, so an exact pin there fails the play
   on the next patch day; unattended-upgrades owns them instead.
2. Fetches Docker's signing key to `/etc/apt/keyrings/docker.asc`, refusing
   it unless its SHA256 matches `docker_apt_key_checksum` (the key is the
   root of trust for every version pin, so a pin on the versions without a
   pin on the key would be decorative), and adds the
   `stable` repository for the running release's codename (`resolute` on
   26.04, `noble` on 24.04; one key signs both) as a deb822 source
   (`/etc/apt/sources.list.d/docker.sources`) with `Signed-By`. The install
   step refreshes the cache itself, because the play-level refresh ran
   before this source existed.
3. Installs `docker-ce`, `docker-ce-cli`, `docker-ce-rootless-extras`,
   `containerd.io`, `docker-buildx-plugin` and `docker-compose-plugin` at
   exact versions with `install_recommends: false`, then holds all six with
   `dpkg --set-selections`. The install carries `allow_change_held_packages`,
   so a pin bump on a re-run moves a held package rather than failing with
   "held packages were changed". buildx and compose are pinned rather than
   left as recommends because Coder and its PostgreSQL (#679) are the Docker
   Compose services ADR 0032 names, and a compose plugin that floats is a pin
   that is not one. The rootless extras are the same build as `docker-ce`, so
   they take `docker_version`; they carry `rootlesskit` and
   `dockerd-rootless.sh`, which the `coder_sandbox` role runs Coder's
   workspaces under (LAB-5).
4. Writes `/etc/docker/daemon.json` from `docker_daemon_config`: `json-file`
   logs capped at 10 MB x 3 per container, `live-restore` so a daemon
   restart does not kill running jobs, and, since 2026-10-07 (LAB-5),
   **`userns-remap: default`** with the containerd image store off.
5. Restarts the daemon when `daemon.json` changed, through the `Restart
   docker` handler flushed straight after the write rather than at the end
   of the play, because the roles after this one must create their
   containers in the daemon's new data root. Then enables and starts
   `docker.service`.
6. With `userns-remap` on, stops the play unless the daemon reports
   `name=userns` in its security options, and carries the named volumes in
   `docker_userns_carry_volumes` into the remapped root once (below).

## User namespaces (LAB-5)

With `userns-remap: default` the daemon creates the `dockremap` user and
gives it a range of 65536 subordinate ids in `/etc/subuid` and
`/etc/subgid`. Every container's root is the first id of that range on the
host, and its uid N is that id plus N, so a process that escapes a
container is an unprivileged uid that owns nothing on the host. The job
containers `vps-agent` starts and Coder's server and PostgreSQL all run
that way.

Two settings come with it:

- **The containerd image store is off** (`features.containerd-snapshotter:
  false`). Docker 29 uses it by default on a fresh install, and it "is not
  available when using user namespace remapping"
  ([Docker docs](https://docs.docker.com/engine/storage/containerd/), read
  2026-10-07; moby#47377). The daemon uses the overlay2 graph driver
  instead.
- **Three of this host's own containers opt out with `--userns=host`**, and
  nothing else may: the agent's socket proxy (`labs_agent`), Coder's socket
  proxy (`../../coder/docker-compose.yml`) and Portainer. Each must open a
  Docker socket, and a remapped root cannot. A container created through
  the agent's proxy cannot ask for it: the proxy refuses any create that
  sets `UsernsMode` (`labs_agent/templates/docker-proxy.haproxy.cfg.j2`).
  The Caddy builder runs that way too, once, to write the binary into a
  root-owned host directory.

The switch is `docker_userns_remap` (true in `group_vars/all.yml`), which
chooses between `docker_daemon_userns_config` and
`docker_daemon_no_userns_config` for `daemon.json`. False is the way back:
no remap, and the containerd image store the daemon was installed with, on
its original data root (the Labs host runbook, "Taking it back").

Switching the setting gives the daemon a new data root
(`/var/lib/docker/<uid>.<gid>`) and hides everything in the old one. So the
run that switches stops every running container first, restarts the daemon
at once, and then copies the volumes listed in `docker_userns_carry_volumes`
from `/var/lib/docker/volumes/<name>/_data` into a new volume of the same
name with `/usr/local/libexec/hcw-docker-volume-carry`
(`files/hcw-docker-volume-carry.py`): Coder's PostgreSQL cluster, shifted
into the remapped range because a remapped container owns it, and
Portainer's database, copied as it is because Portainer runs with
`--userns=host`. The old root is only read, so removing `userns-remap` from
the configuration brings it and its data straight back. Images are pulled
again by the roles that run them and by `lab_images`; a learner's workspace
volume is not carried, because workspaces now run on the `coder_sandbox`
daemon.

A carry happens once per volume (a marker under
`/var/lib/hcw-docker/userns-carry/`). If a container started on the new
volume before the carry (a run interrupted after the restart), the helper
refuses, changes nothing, and says how to start again.
`tests/hcw-docker-volume-carry.test.sh` runs the helper as it ships against
a tree shaped like PostgreSQL's (CI, `ansible-lint (lab-host)`).

The old root's networks are not deleted by the switch: their bridge
interfaces stay in the kernel, down, with their addresses and routes. On
2026-10-08 that left two routes for each of the Coder networks' fixed subnets
(172.28.240.0/24, 172.28.241.0/24), the stale one first, so the host's own
traffic to Coder, Docker's port proxy on `127.0.0.1:7080` included, went into
an empty bridge and Caddy answered 503. So every run, once the daemon is up
and before any later role creates a network,
`/usr/local/libexec/hcw-docker-stale-bridges`
(`files/hcw-docker-stale-bridges.py`) deletes a bridge only by provenance,
not by name: its network must be recorded in another Docker data root on this
host (that root's `network/files/local-kv.db`), the running daemon must not
list it when checked again just before the delete, and nothing may be
attached. Another program's bridge named like Docker's is in no Docker
database, and a network the running daemon creates is recorded in its own
root, so neither can be deleted. One with an interface still attached is
left, and the run names it. In addition, it purges orphaned IPv4 `nat` table
rules (`POSTROUTING` masquerades and `DOCKER` returns/DNATs) whose `br-*`
interface no longer exists in the kernel, ensuring removed networks cannot
masquerade inter-container traffic (#1228).
`tests/hcw-docker-stale-bridges.test.sh` runs it against stand-ins for
`docker`, `ip`, and `iptables` and a scratch data root (CI, `ansible-lint (lab-host)`).

## Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `docker_version` | required | apt version string for `docker-ce` and `docker-ce-cli` |
| `docker_containerd_version` | required | apt version string for `containerd.io` |
| `docker_buildx_version` | required | apt version string for `docker-buildx-plugin` |
| `docker_compose_version` | required | apt version string for `docker-compose-plugin` |
| `docker_userns_remap` | `true` | The user-namespace switch; false is the way back |
| `docker_daemon_config` | `docker_daemon_base_config` (log driver, limits, live-restore) combined with `docker_daemon_userns_config` (`userns-remap: default`, containerd image store off) or, with the switch off, `docker_daemon_no_userns_config` | Rendered as `daemon.json` |
| `docker_legacy_root` | `/var/lib/docker` | The pre-remap data root the carry reads from |
| `docker_userns_carry_volumes` | `[]` (group_vars lists this host's two) | Volumes carried into the remapped root once, each `{name, remapped}` |
| `docker_userns_carry_state_dir` | `/var/lib/hcw-docker/userns-carry` | One marker per carried volume |
| `docker_apt_key_url` | Docker's gpg URL | Signing key source |
| `docker_apt_key_checksum` | required | `sha256:<hex>` the fetched key must match |
| `docker_apt_key_path` | `/etc/apt/keyrings/docker.asc` | Signing key location |
| `docker_apt_repository_url` | `https://download.docker.com/linux/ubuntu` | Repository base |

The version strings carry the Ubuntu release (`5:29.8.1-1~ubuntu.26.04~resolute`),
so `group_vars/all.yml` holds them in `docker_release_pins`, one entry per
codename, and sets the four inputs above from the running release's entry.
The role itself takes plain strings and knows nothing about the map.

To bump, read the available versions from each release's package index and
change both entries of `docker_release_pins`. Bash, from anywhere with
network access; the first line prints the newest version string of each
pinned package for Ubuntu 26.04, the second for 24.04:

```bash
curl -s https://download.docker.com/linux/ubuntu/dists/resolute/stable/binary-amd64/Packages | awk '/^Package: (docker-ce|docker-ce-cli|docker-ce-rootless-extras|containerd.io|docker-buildx-plugin|docker-compose-plugin)$/{p=$2} /^Version:/{if(p){print p, $2; p=""}}' | sort -k1,1 -k2,2V | awk '{v[$1]=$2} END{for(k in v) print k, v[k]}'
```

```bash
curl -s https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-amd64/Packages | awk '/^Package: (docker-ce|docker-ce-cli|docker-ce-rootless-extras|containerd.io|docker-buildx-plugin|docker-compose-plugin)$/{p=$2} /^Version:/{if(p){print p, $2; p=""}}' | sort -k1,1 -k2,2V | awk '{v[$1]=$2} END{for(k in v) print k, v[k]}'
```

## Handlers

`Restart docker`, flushed in this role (step 5). The flush runs every
handler notified so far in the play, the hardening role's included; they
would otherwise run at the end, and `force_handlers` in `site.yml` runs
them whatever fails later either way.

## Check mode

Safe. `deb822_repository` and the `apt` install report what they would do
without doing it. The remap check and the carry are skipped, because in
check mode the daemon is not restarted.
