#!/usr/bin/python3
"""Delete the bridges a Docker data root this daemon no longer uses left behind.

Installed by the docker role as /usr/local/libexec/hcw-docker-stale-bridges
and run by it on every bootstrap, after the daemon is up.

Why (2026-10-08). Turning userns-remap on moves the daemon to another data
root, and the networks of the old root are not deleted: their bridge
interfaces stay in the kernel, down, with their addresses and routes. The
Coder networks have fixed subnets (172.28.240.0/24 and 172.28.241.0/24), so
the new daemon made new bridges on the same subnets, and the host then held
two routes for each. The stale bridge's route came first, so the host's own
traffic to the Coder container, Docker's port proxy on 127.0.0.1:7080
included, went into an empty bridge and timed out. Container-to-container
traffic does not use the host's routes, so Coder and PostgreSQL still talked
and nothing looked wrong from inside. Caddy answered 503.

What is deleted is decided by provenance, not by name (review of #1025). A
bridge `br-<12 hex>` is deleted only when all of these hold:

  - its network is recorded in another Docker data root on this host: the
    12 hex digits begin a 64-hex id in that root's network database
    (network/files/local-kv.db), under the legacy root or a remapped
    `<uid>.<gid>` root, whichever the running daemon is not using. Another
    program's bridge with a Docker-looking name is in no Docker database,
    and a network the running daemon creates is recorded in its own root,
    never another, so neither can qualify;
  - the running daemon does not list it, checked again just before the
    delete;
  - nothing is attached to it.

A qualifying bridge with an interface attached is reported and left alone.
docker0, every bridge of the running root and every other program's bridge
stay, whatever they are named.

Any rule in the IPv4 nat table (POSTROUTING masquerade or DOCKER chain return/DNAT)
referencing a br-* interface that does not exist among live bridges on the host
is deleted so orphaned rules cannot masquerade or misroute traffic (#1228).

    hcw-docker-stale-bridges [--dry-run] [--docker-dir /var/lib/docker]

Prints one JSON object on stdout, {"deleted": [...], "kept_attached": [...], "deleted_rules": [...]},
and exits 0; exits non-zero with the reason on stderr when docker, ip or iptables
cannot be read. --dry-run reports what it would delete and deletes nothing.
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys

DOCKER_BRIDGE = re.compile(r"^br-([0-9a-f]{12})$")
NETWORK_ID = re.compile(rb"[0-9a-f]{64}")
REMAPPED_ROOT = re.compile(r"^[0-9]+\.[0-9]+$")
NETWORK_DB = os.path.join("network", "files", "local-kv.db")


def run(argv):
    executable = shutil.which(argv[0])
    if executable:
        argv = [executable] + argv[1:]
    result = subprocess.run(argv, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(
            f"hcw-docker-stale-bridges: {' '.join(argv)} failed: {result.stderr.strip()}",
            file=sys.stderr,
        )
        sys.exit(1)
    return result.stdout


def owned_prefixes():
    """The 12-hex prefix of every bridge network the running daemon lists."""
    ids = run(["docker", "network", "ls", "--no-trunc", "--filter", "driver=bridge", "--format", "{{.ID}}"])
    return {network_id[:12] for network_id in ids.split()}


def running_root():
    return os.path.realpath(run(["docker", "info", "--format", "{{.DockerRootDir}}"]).strip())


def data_roots(docker_dir):
    """The legacy root and every remapped `<uid>.<gid>` root beneath it."""
    roots = [docker_dir]
    try:
        roots += [
            os.path.join(docker_dir, name)
            for name in sorted(os.listdir(docker_dir))
            if REMAPPED_ROOT.match(name)
        ]
    except FileNotFoundError:
        return []
    return roots


def recorded_prefixes(root):
    """The 12-hex prefix of every 64-hex id in a root's network database."""
    try:
        with open(os.path.join(root, NETWORK_DB), "rb") as handle:
            data = handle.read()
    except (FileNotFoundError, NotADirectoryError):
        return set()
    return {match.group(0)[:12].decode("ascii") for match in NETWORK_ID.finditer(data)}


def other_roots_prefixes(docker_dir, current):
    prefixes = set()
    current_norm = os.path.normcase(current)
    for root in data_roots(docker_dir):
        if os.path.normcase(os.path.realpath(root)) != current_norm:
            prefixes |= recorded_prefixes(root)
    return prefixes


def bridge_names():
    links = json.loads(run(["ip", "-j", "link", "show", "type", "bridge"]) or "[]")
    return [link["ifname"] for link in links if "ifname" in link]


def attached(bridge):
    return json.loads(run(["ip", "-j", "link", "show", "master", bridge]) or "[]")


def candidates(bridges, left_behind, owned):
    """Bridges whose network another root recorded and the running daemon does not list."""
    found = []
    for name in bridges:
        match = DOCKER_BRIDGE.match(name)
        if match and match.group(1) in left_behind and match.group(1) not in owned:
            found.append(name)
    return found


def nat_rule_lines():
    """Rules from the IPv4 nat table as iptables -S outputs them."""
    output = run(["iptables", "-w", "-t", "nat", "-S"])
    return [line.strip() for line in output.splitlines() if line.startswith("-A ")]


def rule_bridge_interfaces(tokens):
    """The br-* interfaces referenced by -o, ! -o, -i, or ! -i in a rule's tokens."""
    ifaces = []
    i = 0
    while i < len(tokens):
        if tokens[i] in ("-o", "-i") and i + 1 < len(tokens):
            iface = tokens[i + 1]
            if iface.startswith("br-") and not iface.endswith("+"):
                ifaces.append(iface)
            i += 2
        elif tokens[i] == "!" and i + 2 < len(tokens) and tokens[i + 1] in ("-o", "-i"):
            iface = tokens[i + 2]
            if iface.startswith("br-") and not iface.endswith("+"):
                ifaces.append(iface)
            i += 3
        else:
            i += 1
    return ifaces


def stale_nat_rules(live_bridges):
    """Rules in the IPv4 nat table whose br-* interface is not among live_bridges."""
    stale = []
    for line in nat_rule_lines():
        tokens = shlex.split(line)
        if len(tokens) < 2 or tokens[0] != "-A":
            continue
        chain = tokens[1]
        if chain in ("POSTROUTING", "DOCKER") or chain.startswith("DOCKER"):
            bridge_ifaces = rule_bridge_interfaces(tokens)
            if bridge_ifaces and any(iface not in live_bridges for iface in bridge_ifaces):
                stale.append((line, chain, tokens[2:]))
    return stale


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="report, delete nothing")
    parser.add_argument("--docker-dir", default="/var/lib/docker", help="the legacy data root")
    args = parser.parse_args()

    left_behind = other_roots_prefixes(args.docker_dir, running_root())
    report = {"deleted": [], "kept_attached": [], "deleted_rules": []}
    for bridge in candidates(bridge_names(), left_behind, owned_prefixes()):
        if attached(bridge):
            report["kept_attached"].append(bridge)
            continue
        # Checked again just before the delete: the running daemon may have
        # listed a network since the first read.
        if DOCKER_BRIDGE.match(bridge).group(1) in owned_prefixes():
            continue
        if not args.dry_run:
            run(["ip", "link", "delete", bridge])
        report["deleted"].append(bridge)

    live_bridges = set(bridge_names()) - set(report["deleted"])
    for line, chain, rule_spec in stale_nat_rules(live_bridges):
        if not args.dry_run:
            run(["iptables", "-w", "-t", "nat", "-D", chain] + rule_spec)
        report["deleted_rules"].append(line)

    print(json.dumps(report))


if __name__ == "__main__":
    main()
