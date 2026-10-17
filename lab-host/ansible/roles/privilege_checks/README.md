# privilege_checks

The end-of-run checks for the lab host's container-runtime privilege
separation (estate review 2026-10-06, finding LAB-5; ADR 0032, amendment of
2026-10-07). `site.yml` runs this role from `post_tasks`, after every role
and the handlers they notified, so the agent has already been restarted out
of the docker group and `lab_images` has pulled the image the check job
uses. Every check fails the run with what to do; none of them changes
anything but the one script the role installs.

## What it checks

1. **`hcw-labs-agent` is in no docker group** (`id --name --groups`). It
   also prints the docker group's other members, each of which is root on
   the host, without failing: nothing in this playbook adds one, and the
   owner may have.
2. **The host daemon remaps user namespaces**: `docker info` reports
   `name=userns`.
3. **The agent's proxy is the narrow one**: its socket is a socket owned
   `root:hcw-labs-agent` with mode 0660, and its container is running with
   no network, a read-only root filesystem, every capability dropped and
   not privileged.
4. **A job still runs, and the proxy refuses what a job never sends.**
   `/usr/local/libexec/hcw-labs-agent-proxy-check.mjs`
   (`files/hcw-labs-agent-proxy-check.mjs`), run as `hcw-labs-agent` with
   the unit's `DOCKER_HOST` and `TMPDIR`, runs one `shell-echo` job through
   the agent's own `runInDocker` from its checkout, so the argv, the staging
   directory and the proxy are the ones a real job meets, and checks it
   printed its payload. Then `docker ps` must be refused as a call, and a
   job-shaped `docker run --privileged` must be refused for its body. It
   prints what it saw as JSON either way.
5. **While Coder is on, Coder's proxy carries the repository's policy and
   the sandbox daemon's socket**: every `KEY=value` the installed Compose
   file (`/etc/hcw/coder/docker-compose.yml`) sets for
   `coder-docker-proxy` is in the container's environment, its one mount is
   `/run/hcw-coder-docker`, and the daemon behind it reports
   `name=rootless`.
6. **Every deployed tool add-on runs as the addons role describes** (ADR
   0035): a read-only root, every capability dropped, not privileged, no
   bind mount, one port published on `127.0.0.1`, and the daemon's
   user-namespace remap.
7. **No IPv4 nat rule names a bridge that no longer exists** (#1228): a
   stale rule would masquerade traffic between containers as the gateway.
8. **Nothing listens beyond the loopback but the public ports**
   (`tasks/listeners.yml`; #958, LAB-12). `ss` lists every TCP and UDP
   listener, the rootless sandbox's forwarded ports included. The run fails,
   naming each one, unless it is on `127.0.0.0/8`, `::1` or an IPv4-mapped
   loopback address, or is TCP on a port in `privilege_checks_public_tcp_ports`
   (80 and 443: Caddy). No UDP port is public, now that Caddy
   serves no HTTP/3. sshd listens on the loopback alone (#1257), so port 22
   has left the list. The host daemon's published ports are also read from
   the `nat` table's `DOCKER` chain, IPv4 and IPv6. Every `DNAT` rule must
   name a loopback destination, which holds even with Docker's userland
   proxy off, when a published port has no listener. `tests/listeners.test.sh`
   runs both checks against the lab host's own output and against made-up
   cases.

## Why paths are written here

The defaults name the socket paths, the staging directory and the container
name directly rather than reading another role's `vars/main.yml`, which
Ansible does not promise to expose to a later role.
`scripts/lab-host-docker-proxy.test.mjs` holds every one of them to the
role that creates it, so a move in one fails CI rather than the host.

## Check mode

Reads only. The assertions that need a running daemon or the check job are
skipped, because in check mode the roles before this one changed nothing.
