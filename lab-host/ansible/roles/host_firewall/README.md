# host_firewall

The host's own iptables chains, beside ufw (#954, #958; owner decision
2026-10-16). Workspace egress is limited to what the labs need, and
host-local and private destinations are refused; containers on the host
daemon's bridges may open HTTP and HTTPS to the host and nothing else; and
the host's own new connections to Coder's internal network are refused.

## What it allows

Four chains, in both address families, loaded from
`/etc/hcw/firewall/hcw.v4.rules` and `hcw.v6.rules`:

- **`HCW-SANDBOX-OUT`**, jumped to first in `OUTPUT` for every packet a
  socket of `hcw-coder-docker` sends: the rootless daemon the `coder_sandbox`
  role runs and its workspaces. In order:
  1. DNS (UDP and TCP 53) to systemd-resolved's stub, `127.0.0.53`;
  2. TCP 443 to any address of the host but its loopback: Caddy, the host's
     only listener on `*:443`, which serves Coder's access URL (the
     workspace agent's way back to Coder) and the guided labs' names.
     Matched by address type, so a change of the host's address needs no
     run;
  3. refused: every other address of the host itself (`addrtype LOCAL`);
  4. refused: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
     `100.64.0.0/10`, `169.254.0.0/16`, `0.0.0.0/8`, `224.0.0.0/4` and
     `240.0.0.0/4`; for IPv6, `::1/128`, `fc00::/7`, `fe80::/10` and
     `ff00::/8`;
  5. replies (the reply direction of a flow);
  6. TCP 80 and 443 to everything else (Docker Hub, GitHub, Open VSX, the
     Terraform registry, Entra, ARM and Graph, PyPI, OCSP);
  7. refused: everything else, mail and SSH included.

  The refusals come before replies are let through, so a flow to a refused
  destination that was open when the rules first load is cut, not kept.
- **`HCW-BRIDGE-IN`**, jumped to first in `INPUT` for `docker0` and every
  `br-*` bridge (Coder and its database, Portainer, the add-ons): replies to
  connections the host opened (Caddy to a container, through its published
  port), IPv6 neighbour discovery, TCP 80 and 443 to the host (Coder reaches
  its own access URL through Caddy), and nothing else.
- **`HCW-CONTROL-OUT`**, jumped to from `OUTPUT`: the host's own new
  connections to Coder's internal network (`coder-control`) are refused;
  Coder reaches that network across its own bridge, which this chain never
  sees. The host's answers to connections opened from that network go (the
  reply direction only), so a flow the host itself opened there before the
  rules loaded is cut too. Nothing on the host opens a connection there
  (read on the host on 2026-10-16). The subnet is read at play time, from
  the network as Docker has it and from the Compose file the `coder` role
  deploys (which covers a host where `coder`, running after this role, has
  not created it yet), and is never written in the role.
- **`HCW-REFUSE`**, where the others send what they refuse: a TCP reset for
  TCP and port-unreachable for the rest, so a refused connection fails at
  once.

What the chains allow is `RETURN`ed to `INPUT` or `OUTPUT`, where ufw still
decides: these chains only ever take away, so a later ufw rule still holds
and nothing here can open what ufw closes. The policy is in `vars/main.yml`,
not `defaults/main.yml`, because it is an owner decision changed in a
reviewed pull request, never per run.

## Why this shape

- **Jumps first, above ufw's.** ufw's own chains accept some traffic
  outright before any user rule is read, so the host firewall's chains are
  jumped to from the top of `INPUT` and `OUTPUT`. `hcw-host-firewall` keeps
  each jump there and single: on every run it deletes every jump to an
  `HCW-*` chain that is not where `hcw.jumps` says, by its full
  specification, and inserts the wanted ones at the top, in the same
  transaction.
- **Matched by user.** The sandbox daemon and its workspaces run as
  `hcw-coder-docker`, and the sandbox chain filters that user's traffic, the
  daemon's own image pulls and DNS included. The jump names the user, and
  the helper looks the uid up when it loads it, so nothing holds a uid that
  could go stale. `scripts/lab-host-host-firewall.test.mjs` holds the
  sandbox daemon to the user-mode network driver this role is written for,
  so a change of driver has to revisit the role.
- **DNS through the stub.** All of the sandbox's DNS reaches `127.0.0.53`.
  `dockerd`, which rootlesskit runs in the host's network namespace,
  resolves its own names (image pulls) through the host's
  `/etc/resolv.conf`. Every container is given slirp4netns's forwarder
  `10.0.2.3` as its nameserver (`dns` in the sandbox daemon's
  `daemon.json`, the `coder_sandbox` role), and slirp4netns answers it by
  asking the nameserver in that same file. Before #1267 this README said
  the daemon's defaults already did that for every workspace network, and
  that only a container on the default bridge, "which no template uses",
  would be given the upstream servers. But the Terraform docker provider
  creates every workspace on the default bridge and moves it to the
  workspace's network afterwards. Each one kept systemd-resolved's
  upstream servers, which `dockerd` asked from the host's namespace as the
  sandbox user. This chain refused them at its last rule, and on
  2026-10-17 no workspace could resolve a name (`coder_sandbox`'s README,
  "Workspace DNS"). This role refuses a host whose `/etc/resolv.conf` names
  any nameserver but the stub. `coder_sandbox` refuses a rootlesskit whose
  forwarder is not `10.0.2.3`. The `workspace_reach` role creates a
  container the way the provider does, at every run and every 15 minutes,
  and fails the run or raises the alert when a lookup does not come back.
- **Refusals before replies.** `conntrack` is not installed on the host, so
  there is no flushing of flows that predate the rules; the rule order is
  what cuts them. Replies are matched in the reply direction only: the
  sandbox's own outbound traffic (DNS, the host's HTTPS, web egress) never
  needs that rule, because those rules match it whatever its state, so an
  outbound flow the rules no longer allow is cut too.
- **One transaction per family, compared first.** `apply` reads the live
  table, changes only what differs, and does it in one `iptables-restore
  --noflush` transaction, where a chain line flushes and refills that chain;
  a transaction iptables rejects changes nothing. Both families are built
  and dry-run (`--test`) before either is committed, and a jump to an
  `HCW-*` chain the file does not declare is refused before both, so a bad
  file leaves neither family half-loaded. The dry run is userspace only: on
  nf_tables it does not see what the kernel refuses at commit, which is
  reported for its family, and the fail-closed rescue then stops the
  sandbox. Every mode holds a lock in `/run` for the whole run, so a play's
  `apply` and a boot or reload cannot interleave. It prints a line per
  change and nothing otherwise, which is the role's `changed`. The files are
  written in the form `iptables -S` prints, and `apply` reads the table back
  and fails if it still differs, so a rule iptables normalises differently
  fails the first run instead of reloading on every one.
- **`HCW-REFUSE` resets TCP.** An ICMPv6 port-unreachable sent back from
  `OUTPUT` never reaches the local TCP socket, which then waits out its
  whole connect timeout; a reset fails it at once
  (`tests/hcw-host-firewall.test.sh` measures every refusal under a second).
- **ufw and Docker leave it alone.** ufw runs with `MANAGE_BUILTINS=no`:
  its start appends its own jumps, and its reload, stop and start flush only
  its own chains, so the jumps and chains stay (the test runs ufw's own
  `ufw-init` against a scratch configuration to prove it). Docker writes
  `FORWARD`, its own `DOCKER-*` chains and the `nat` and `raw` tables, never
  the filter table's `INPUT` or `OUTPUT` (moby 29.9 `iptabler`; on the host,
  read 2026-10-16, both chains held only ufw's jumps; a daemon restart was
  run against the loaded chains in a test container and `verify` still
  passed). Neither the add-ons' `DOCKER-USER` rules nor ufw's `after.rules`
  are touched.

## At boot

`hcw-host-firewall.service` runs `apply` after ufw (which appends its
jumps) and before the network, Docker and the sandbox user's manager. The
drop-in `/etc/systemd/system/user@<uid>.service.d/hcw-host-firewall.conf`,
on that user's manager only (by the uid read on the host), makes it
`Requires=` and `After=` the unit, so the sandbox daemon starts only once the
rules are loaded and not at all if loading failed. A drop-in left on
another uid's manager is removed. A failure is reported by
`OnFailure=hcw-unit-failed@%n.service`, the notifier `alert-lab-unit-failed`
reads (roles/hardening).

The play fails closed too. `coder_sandbox` runs first and has already
started the sandbox user's manager, so the role installs the unit and the
drop-in before anything that can fail to load (adding `Requires=` to a
running manager changes nothing until its next start). The rest runs in one
block. Each successful run, once the read-back passes, records the three
files in `/etc/hcw/firewall/verified` as the last policy verified live. If
anything in the block fails, the rescue runs the helper's `verify` against
that record. Only an exact match, every `HCW-*` chain and jump in both
families, counts as governed; the shape alone does not, since a chain
weakened since (an early `RETURN`, a refusal chain that no longer refuses)
keeps its shape. Otherwise, or with no record at all, it stops
`user@<uid>.service`, which stops the workspaces, and fails the play with
what to do. When the live rules still equal the record (a load iptables
refuses changes nothing), it stops nothing and says so. In check mode it
never stops anything.
Recovering after a stop means running the role on its own
(`--tags host_firewall`) before a plain run, since a plain run starts the
manager in `coder_sandbox` and the manager waits for the firewall; the
runbook's "Putting it back" has the commands.

The unit has `RefuseManualStop=yes`: stopping or restarting it would stop
the sandbox user's manager with it (and every workspace) without removing a
rule. Re-apply with `sudo systemctl reload hcw-host-firewall`, or run the
helper. The role never restarts it.

## Taking it out

`host_firewall_state: absent` removes all of it, in this order: the
drop-in, so no user manager requires the unit any more, and a
`daemon-reload`; the unit disabled, its file removed, another
`daemon-reload`, and the leftover stopped (with the file gone it no longer
refuses); then `hcw-host-firewall remove`, which deletes every jump to an
`HCW-*` chain and then flushes and deletes the chains, one transaction per
family; then the helper and the rules files. The play then fails if any
`HCW-*` rule is still loaded. Nothing restarts the user's manager or Docker.
The runbook's "Taking it out" has the command.

## Owner commands

Bash, on the host. Whether the live table matches the files:

```bash
sudo /usr/local/libexec/hcw-host-firewall verify
```

Good is no output and exit status 0. The chains, with their counters:

```bash
sudo iptables -L HCW-SANDBOX-OUT -v -n --line-numbers
```

`docs/runbooks/labs-host.md`, "Host firewall for the sandbox and bridges",
has how to read them, how to find what a lab cannot reach, how to recover
from a failed boot load, and how to take it out.

## Variables

`host_firewall_state` (default `present`) and `host_firewall_sandbox_user`
(default `hcw-coder-docker`), in `defaults/main.yml`; `meta/argument_specs.yml`
is the contract. In this playbook `group_vars/all.yml` sets
`host_firewall_sandbox_user` to `{{ coder_sandbox_user }}`, so the jump always
matches the user the sandbox daemon runs as. Everything else is the policy in `vars/main.yml`, including
the internal network's name (`host_firewall_control_network`) and the
Compose file its subnet is also read from.

## Check mode

Safe. Nothing is loaded or removed; the read-back runs and reports
`changed` when the live table differs from what the run would leave, which
is what the nightly drift check reads.

## Tests

`tests/hcw-host-firewall.test.sh` renders the templates with the role's
values and loads them into real iptables in a scratch network namespace
(`unshare -n` as root, `unshare -rn` otherwise): idempotent loads,
`--noflush` replacing a chain, a refused transaction changing nothing, a bad
IPv6 file leaving IPv4 uncommitted, the lock held against a second run, the
jumps put back first and single, flows open before the first load cut, the
verdict for each destination class read from the counters with real
packets, the internal network refused to the host's own connections while
the host's answers still go, `remove`, and ufw's start, reload and restart
(failed rather than skipped when `HCW_REQUIRE_UFW=1`, which CI sets). CI
runs it in the `ansible-lint (lab-host)` job; on a Linux machine, bash:

```bash
sudo env "PATH=$PATH" bash lab-host/ansible/roles/host_firewall/tests/hcw-host-firewall.test.sh
```

A passing result has no `not ok` line and ends with the number passed and
`0 failed`. `scripts/lab-host-host-firewall.test.mjs` holds the role's
contract as text: the chain names and order, the jumps, every range, the
add-ons' rules untouched, the unit's ordering and failure report, the
removal order and the role's place in `site.yml`.
