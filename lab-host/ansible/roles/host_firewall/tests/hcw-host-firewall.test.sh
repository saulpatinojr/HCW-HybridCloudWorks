#!/usr/bin/env bash
# Tests ../files/hcw-host-firewall and the files ../templates render, which
# the host_firewall role installs as /usr/local/libexec/hcw-host-firewall and
# /etc/hcw/firewall/hcw.v4.rules, hcw.v6.rules and hcw.jumps (#954, #958).
# The templates are rendered with the role's own defaults and vars, and two
# documentation addresses standing in for the host's own, and loaded into
# real iptables, in a scratch network namespace of the test's own: the
# machine's tables are never read or written.
#
# It proves what the role relies on:
#   - loading the files twice changes nothing, and the second apply says so
#     by printing nothing;
#   - under --noflush, a chain line replaces the chain's contents, and a
#     transaction iptables rejects leaves the chain and the jumps as they were;
#   - each jump is first in its chain and single, however it was moved or
#     duplicated, and the rules around it (ufw's, DOCKER-USER) are untouched;
#   - packets the sandbox user sends, and packets containers on a bridge send
#     to the host, meet the verdict the owner decided for each destination
#     class: the rule that counted each probe's first packet is read from the
#     chain's counters, and every refusal comes back at once;
#   - a flow that was open when the rules first load is cut if it goes where
#     the rules now refuse;
#   - the host's own new connections to Coder's internal network are
#     refused, while its answers to connections opened from there still go
#     and other networks are not affected;
#   - remove takes every HCW-* jump and chain out and leaves the rest;
#   - ufw's own start, reload, and stop and start, run from its installed
#     scripts against a scratch configuration, leave the chains and jumps in
#     place (skipped, with a `skip -` line, where ufw is not installed, and
#     failed instead when HCW_REQUIRE_UFW=1, which CI sets).
#
# Needs iptables (nf_tables or legacy), iproute2, util-linux (unshare,
# nsenter) and a Python with Jinja2 and PyYAML. As root it runs in
# `unshare -n`; otherwise in `unshare -rn`, where it is root of a user
# namespace of its own, wherever the kernel allows that. CI runs it in the
# `ansible-lint (lab-host)` job; on a Linux workstation, bash:
#   sudo env "PATH=$PATH" bash lab-host/ansible/roles/host_firewall/tests/hcw-host-firewall.test.sh
#
# Each check's condition is a single-quoted string that check() evaluates
# when it runs, so its expansions are meant to wait, and the variables it
# reads (reserved_v4, snapshot, before_others, nd_before and the like) are
# read there.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"

# Into a scratch network namespace before anything else: every iptables and
# ip call below then reaches that namespace only.
if [ -z "${HCW_FIREWALL_TEST_NETNS:-}" ]; then
  export HCW_FIREWALL_TEST_NETNS=1
  if [ "$(id -u)" -eq 0 ]; then
    exec unshare -n bash "${BASH_SOURCE[0]}" "$@"
  fi
  exec unshare -rn bash "${BASH_SOURCE[0]}" "$@"
fi

passed=0
failed=0
# ok NAME: count and print a passing check, TAP style.
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
# not_ok NAME [DETAIL]: count and print a failing check, with its detail indented.
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
# check NAME CONDITION [DETAIL]: evaluate CONDITION and report it as ok or not ok.
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }
# skip NAME: a check this machine cannot run, said so.
skip() { echo "skip - $1"; }

python=''
for candidate in python3 python; do
  if command -v "${candidate}" >/dev/null && "${candidate}" -c 'import jinja2, yaml' 2>/dev/null; then
    python="$(command -v "${candidate}")"
    break
  fi
done
[ -n "${python}" ] || { echo "no Python with jinja2 and yaml on PATH; install ansible-core" >&2; exit 1; }

work="$(mktemp -d)"
# Readable by the unprivileged user some probes run as.
chmod 0755 "${work}"
child=''
echo_server=''
lock_holder=''
# finish: stop the child namespace's holder, its echo server and any lock
# holder, and remove the scratch directory.
finish() {
  [ -z "${echo_server}" ] || kill "${echo_server}" 2>/dev/null || true
  [ -z "${child}" ] || kill "${child}" 2>/dev/null || true
  [ -z "${lock_holder}" ] || kill "${lock_holder}" 2>/dev/null || true
  rm -rf "${work}"
}
trap finish EXIT

helper="${work}/hcw-host-firewall"
cp "${role}/files/hcw-host-firewall" "${helper}"
chmod 0755 "${helper}"
# The helper's lock, in the scratch directory rather than the machine's /run.
export HCW_FIREWALL_LOCK="${work}/lock"
conf="${work}/etc"
mkdir -p "${conf}"

# The owner decision of 2026-10-16, written out here so that a range dropped
# from vars/main.yml fails this test rather than reaching the host.
reserved_v4=(127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4)
reserved_v6=(::1/128 fc00::/7 fe80::/10 ff00::/8)
# The scratch namespace's own addresses, documentation ones.
own_v4=203.0.113.10
own_v6=2001:db8::10
# A stand-in for the subnet of Coder's internal network, which the role reads
# from Docker on the host.
control_v4=172.30.241.0/24

# render: the three files, as the template module renders them (trim_blocks),
# from defaults/main.yml and vars/main.yml, with what the role reads on the
# host replaced by the test's: the sandbox user is root (uid 0, the only user
# a user namespace of the test's own maps, and the one that runs every
# probe), and the internal network is the stand-in above. An undefined name
# fails the render.
"${python}" - "${role}" "${conf}" "${control_v4}" <<'PY'
import pathlib, sys, jinja2, yaml
role, out, control_v4 = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
values = {}
for name in ("defaults", "vars"):
    values.update(yaml.safe_load((role / name / "main.yml").read_text(encoding="utf-8")))
values.update(
    ansible_managed="Ansible managed",
    host_firewall_sandbox_user="root",
    host_firewall_control_subnets={"ipv4": [control_v4], "ipv6": []},
)
env = jinja2.Environment(undefined=jinja2.StrictUndefined, trim_blocks=True, keep_trailing_newline=True)
def render(template, dest, **extra):
    text = env.from_string((role / "templates" / template).read_text(encoding="utf-8")).render(**values, **extra)
    (out / dest).write_bytes(text.encode("utf-8"))
for name, family in values["host_firewall_families"].items():
    render("hcw.rules.j2", "hcw.v%d.rules" % family["version"], host_firewall_family_name=name)
render("hcw.jumps.j2", "hcw.jumps")
PY

rules4="${conf}/hcw.v4.rules"
rules6="${conf}/hcw.v6.rules"
jumps="${conf}/hcw.jumps"

# 1. The rendered files carry the decision.
check "the IPv4 file refuses every range the owner named" \
  '( for r in "${reserved_v4[@]}"; do grep -qxF -- "-A HCW-SANDBOX-OUT -d ${r} -m comment --comment \"hcw: private or reserved, refused\" -j HCW-REFUSE" "${rules4}" || exit 1; done )' \
  "$(grep -- '-d ' "${rules4}" || true)"
check "the IPv6 file refuses every range the owner named" \
  '( for r in "${reserved_v6[@]}"; do grep -qxF -- "-A HCW-SANDBOX-OUT -d ${r} -m comment --comment \"hcw: private or reserved, refused\" -j HCW-REFUSE" "${rules6}" || exit 1; done )' \
  "$(grep -- '-d ' "${rules6}" || true)"
check "DNS goes to systemd-resolved's stub only, over UDP and TCP" \
  '[ "$(grep -c -- "--dport 53 " "${rules4}")" -eq 2 ] && grep -q -- "-d 127.0.0.53/32 -p udp -m udp --dport 53 " "${rules4}" && grep -q -- "-d 127.0.0.53/32 -p tcp -m tcp --dport 53 " "${rules4}" && ! grep -q -- "--dport 53 " "${rules6}"'
check "the host's own HTTPS is matched by address type, loopback left out, and comes before host-local is refused" \
  '[ "$(grep -n -- "^-A HCW-SANDBOX-OUT ! -d 127.0.0.0/8 -p tcp -m tcp --dport 443 -m addrtype --dst-type LOCAL -m comment --comment \"hcw: https to this host\" -j RETURN$" "${rules4}" | cut -d: -f1)" -lt "$(grep -n -- "-m addrtype --dst-type LOCAL -m comment --comment \"hcw: host-local, refused\"" "${rules4}" | cut -d: -f1)" ] && grep -qxF -- "-A HCW-SANDBOX-OUT ! -d ::1/128 -p tcp -m tcp --dport 443 -m addrtype --dst-type LOCAL -m comment --comment \"hcw: https to this host\" -j RETURN" "${rules6}" && ! grep -q -- "${own_v4}\|${own_v6}" "${rules4}" "${rules6}"'
check "the order: resolver, the host's HTTPS, host-local and reserved refused, then replies, web egress, and the rest refused" \
  '[ "$(grep -- "^-A HCW-SANDBOX-OUT" "${rules4}" | sed -E "s/.*--comment \"([^\"]*)\".*/\1/" | uniq | tr "\n" "|")" = "hcw: the host resolver|hcw: https to this host|hcw: host-local, refused|hcw: private or reserved, refused|hcw: replies|hcw: web egress|hcw: refused|" ] && grep -qxF -- "-A HCW-SANDBOX-OUT -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -m comment --comment \"hcw: replies\" -j RETURN" "${rules4}" && [ "$(grep -- "^-A HCW-BRIDGE-IN" "${rules4}" | tail -n 1)" = "-A HCW-BRIDGE-IN -m comment --comment \"hcw: refused\" -j HCW-REFUSE" ]' \
  "$(grep -- "^-A HCW-SANDBOX-OUT" "${rules4}")"
check "a refusal is a TCP reset for TCP and port-unreachable for the rest, in both families" \
  '[ "$(grep -- "^-A HCW-REFUSE" "${rules4}" | tr "\n" "|")" = "-A HCW-REFUSE -p tcp -m comment --comment \"hcw: refused with a reset\" -j REJECT --reject-with tcp-reset|-A HCW-REFUSE -m comment --comment \"hcw: refused as unreachable\" -j REJECT --reject-with icmp-port-unreachable|" ] && [ "$(grep -- "^-A HCW-REFUSE" "${rules6}" | tail -n 1)" = "-A HCW-REFUSE -m comment --comment \"hcw: refused as unreachable\" -j REJECT --reject-with icmp6-port-unreachable" ]'
check "the jumps: the sandbox user's sockets and all the host sends in OUTPUT, docker0 and every br-* bridge in INPUT" \
  '[ "$(grep -v "^#" "${jumps}" | tr "\n" "|")" = "-A OUTPUT -m owner --uid-owner root -j HCW-SANDBOX-OUT|-A OUTPUT -j HCW-CONTROL-OUT|-A INPUT -i docker0 -j HCW-BRIDGE-IN|-A INPUT -i br-+ -j HCW-BRIDGE-IN|" ]' \
  "$(cat "${jumps}")"
check "the internal network: the host's answers go, in the reply direction only, and the rest is refused" \
  '[ "$(grep -- "^-A HCW-CONTROL-OUT" "${rules4}" | tr "\n" "|")" = "-A HCW-CONTROL-OUT -d ${control_v4} -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -m comment --comment \"hcw: replies on the internal network\" -j RETURN|-A HCW-CONTROL-OUT -d ${control_v4} -m comment --comment \"hcw: internal network, refused\" -j HCW-REFUSE|" ] && ! grep -q -- "^-A HCW-CONTROL-OUT" "${rules6}" && grep -qxF ":HCW-CONTROL-OUT - [0:0]" "${rules6}"' \
  "$(grep -- HCW-CONTROL-OUT "${rules4}")"
check "no file names DOCKER-USER, FORWARD or a chain of ufw's" \
  '! cat "${rules4}" "${rules6}" "${jumps}" | grep -v "^#" | grep -qE "DOCKER-USER|FORWARD|ufw"'

# The scratch namespace: a stand-in uplink with the host's own addresses and
# a default route, and a child namespace (a container) behind three veth
# pairs named like the host daemon's bridges, the third on the stand-in
# internal network.
ip link set lo up
ip link add hcw0 type dummy
ip link set hcw0 up
ip addr add "${own_v4}/24" dev hcw0
ip -6 addr add "${own_v6}/64" dev hcw0 nodad
ip route add default dev hcw0
ip -6 route add default dev hcw0
unshare -n sleep 600 &
child=$!
for _ in $(seq 50); do [ "$(readlink "/proc/${child}/ns/net")" != "$(readlink /proc/self/ns/net)" ] && break; sleep 0.1; done
ip link add br-hcwtest type veth peer name ctr0 netns "${child}"
ip link add docker0 type veth peer name ctr1 netns "${child}"
ip link add br-ctltest type veth peer name ctr2 netns "${child}"
ip addr add 172.30.241.1/24 dev br-ctltest
ip link set br-ctltest up
ip addr add 172.28.240.1/24 dev br-hcwtest
ip -6 addr add fd00:28::1/64 dev br-hcwtest nodad
ip addr add 172.17.0.1/16 dev docker0
ip link set br-hcwtest up
ip link set docker0 up
# inside CMD...: runs CMD in the child namespace, the containers' side of the bridges.
inside() { nsenter -t "${child}" -n "$@"; }
inside ip link set lo up
inside ip addr add 172.28.240.3/24 dev ctr0
inside ip -6 addr add fd00:28::3/64 dev ctr0 nodad
inside ip addr add 172.17.0.2/16 dev ctr1
inside ip link set ctr0 up
inside ip link set ctr1 up
inside ip addr add 172.30.241.2/24 dev ctr2
inside ip link set ctr2 up
inside ip route add default via 172.28.240.1

# What else lives in the tables, standing in for the host's: a ufw-like rule
# in INPUT and OUTPUT, and DOCKER-USER with one of the add-ons' rules, jumped
# to from FORWARD. None of it may change.
iptables -w -A INPUT -i lo -j ACCEPT
iptables -w -A OUTPUT -o lo -j ACCEPT
iptables -w -N DOCKER-USER
iptables -w -A DOCKER-USER -s 172.29.0.0/24 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment "hcw-addons egress (roles/addons)" -j RETURN
iptables -w -A FORWARD -j DOCKER-USER
# others_v4: the IPv4 rules that are not the helper's, which it must never change.
others_v4() { iptables -w -S | grep -v -e 'HCW-' || true; }
before_others="$(others_v4)"

# Runs the helper with the given arguments, setting $out and $rc.
run() { out="$("${helper}" "$@" 2>&1)" && rc=0 || rc=$?; }

# 1b. Flows open before the rules first load. An echo server in the child,
#     on every address it has; hold.py opens a connection to it, trades one
#     byte, says it is ready, waits for its go file, then tries again and
#     prints whether the flow survived. The first load comes in between
#     (section 3). One flow as uid 0 (the sandbox user here) to a private
#     address; and, where another user exists (the test runs as real root),
#     one as that user to the internal network.
# nsenter itself, not `inside`: a function run with & is a subshell, whose
# pid finish() would kill while the server it started lived on. nsenter -n
# execs, so $! is the server.
nsenter -t "${child}" -n "${python}" -c '
import socketserver
class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            data = self.request.recv(64)
            if not data:
                return
            self.request.sendall(data)
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer(("0.0.0.0", 9001), Echo).serve_forever()' &
echo_server=$!
cat >"${work}/hold.py" <<'PY'
import os, socket, sys, time
host, port, flag = sys.argv[1], int(sys.argv[2]), sys.argv[3]
for _ in range(50):
    try:
        s = socket.create_connection((host, port), timeout=2)
        break
    except OSError:
        time.sleep(0.1)
s.settimeout(2)
s.sendall(b"a")
before = "ok" if s.recv(1) == b"a" else "bad"
open(flag + ".ready", "w").close()
while not os.path.exists(flag + ".go"):
    time.sleep(0.05)
try:
    s.sendall(b"b")
    after = "open" if s.recv(1) == b"b" else "closed"
except (ConnectionResetError, BrokenPipeError, PermissionError, ConnectionRefusedError):
    after = "cut"
except socket.timeout:
    after = "timeout"
print("before=%s after=%s" % (before, after))
PY
real_root=''
[ "$(awk '$1 == 0 { print $2 }' /proc/self/uid_map)" = 0 ] && command -v setpriv >/dev/null && real_root=1
# Where the flows write their ready files, the other user's included.
mkdir -m 1777 "${work}/flags"
"${python}" "${work}/hold.py" 172.28.240.3 9001 "${work}/flags/flow-private" >"${work}/flow-private.out" 2>&1 &
held_private=$!
if [ -n "${real_root}" ]; then
  setpriv --reuid=65534 --regid=65534 --clear-groups -- "${python}" "${work}/hold.py" 172.30.241.2 9001 "${work}/flags/flow-internal" >"${work}/flow-internal.out" 2>&1 &
  held_internal=$!
fi
for _ in $(seq 100); do
  [ -e "${work}/flags/flow-private.ready" ] && { [ -z "${real_root}" ] || [ -e "${work}/flags/flow-internal.ready" ]; } && break
  sleep 0.1
done

# 2. Nothing loaded yet: verify says what is missing.
run verify "${conf}"
check "verify on an empty table exits 1 and names the missing chains and jumps" \
  '[ "${rc}" -eq 1 ] && grep -q "v4: HCW-SANDBOX-OUT does not exist" <<<"${out}" && grep -q "v6: HCW-BRIDGE-IN does not exist" <<<"${out}" && grep -q "v4: OUTPUT must start with these jumps" <<<"${out}"' \
  "rc=${rc} output: ${out}"

# 3. The first apply loads both families and puts the jumps first.
run apply "${conf}"
check "the first apply loads both families and reports each change" \
  '[ "${rc}" -eq 0 ] && grep -q "^v4: loaded HCW-BRIDGE-IN HCW-CONTROL-OUT HCW-REFUSE HCW-SANDBOX-OUT from " <<<"${out}" && grep -q "^v6: loaded " <<<"${out}" && grep -q "^v4: put -A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT first" <<<"${out}" && grep -q "^v4: put -A OUTPUT -j HCW-CONTROL-OUT first" <<<"${out}"' \
  "rc=${rc} output: ${out}"
check "each live chain is the file's rules, line for line, in both families" \
  '( for c in HCW-BRIDGE-IN HCW-CONTROL-OUT HCW-REFUSE HCW-SANDBOX-OUT; do [ "$(iptables -w -S "${c}" | grep -v "^-N")" = "$(grep "^-A ${c} " "${rules4}")" ] && [ "$(ip6tables -w -S "${c}" | grep -v "^-N")" = "$(grep "^-A ${c} " "${rules6}")" ] || exit 1; done )' \
  "live: $(iptables -w -S HCW-SANDBOX-OUT)"
check "each jump is first in its chain, above the ufw-like rule, in both families" \
  '[ "$(iptables -w -S OUTPUT | sed -n 2,4p | tr "\n" "|")" = "-A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT|-A OUTPUT -j HCW-CONTROL-OUT|-A OUTPUT -o lo -j ACCEPT|" ] && [ "$(iptables -w -S INPUT | sed -n 2,3p | tr "\n" "|")" = "-A INPUT -i docker0 -j HCW-BRIDGE-IN|-A INPUT -i br-+ -j HCW-BRIDGE-IN|" ] && [ "$(iptables -w -S INPUT | sed -n 4p)" = "-A INPUT -i lo -j ACCEPT" ] && [ "$(ip6tables -w -S OUTPUT | sed -n 2,3p | tr "\n" "|")" = "-A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT|-A OUTPUT -j HCW-CONTROL-OUT|" ]' \
  "INPUT: $(iptables -w -S INPUT | tr "\n" "|") OUTPUT: $(iptables -w -S OUTPUT | tr "\n" "|")"
run verify "${conf}"
check "verify after the apply exits 0 and prints nothing" '[ "${rc}" -eq 0 ] && [ -z "${out}" ]' "rc=${rc} output: ${out}"

# 3b. The flows held open across the first load (1b) are cut.
refused_count() { iptables -w -L "$1" -n -v -x | awk -v c="$2" 'index($0, "/* " c " */") { n += $1 } END { print n + 0 }'; }
private_refused_before="$(refused_count HCW-SANDBOX-OUT "hcw: private or reserved, refused")"
internal_refused_before="$(refused_count HCW-CONTROL-OUT "hcw: internal network, refused")"
touch "${work}/flags/flow-private.go"
wait "${held_private}" 2>/dev/null || true
check "a flow the sandbox user held open to a private address is cut once the rules load" \
  '[ "$(cat "${work}/flow-private.out")" = "before=ok after=cut" ] && [ "$(refused_count HCW-SANDBOX-OUT "hcw: private or reserved, refused")" -gt "${private_refused_before}" ]' \
  "$(cat "${work}/flow-private.out")"
if [ -n "${real_root}" ]; then
  touch "${work}/flags/flow-internal.go"
  wait "${held_internal}" 2>/dev/null || true
  check "a flow the host held open to the internal network is cut once the rules load" \
    '[ "$(cat "${work}/flow-internal.out")" = "before=ok after=cut" ] && [ "$(refused_count HCW-CONTROL-OUT "hcw: internal network, refused")" -gt "${internal_refused_before}" ]' \
    "$(cat "${work}/flow-internal.out")"
else
  skip "no user but root exists in this user namespace, so a flow held by another user is not probed"
fi

# 4. Idempotent: a second apply changes nothing, and keeps the counters (the
#    chains were just loaded, so every counter starts at zero).
"${python}" -c 'import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.sendto(b"x", ("127.0.0.53", 53))' 2>/dev/null || true
counted="$(iptables -w -S HCW-SANDBOX-OUT -v | grep -c -- '-c [1-9]' || true)"
snapshot="$(iptables -w -S; ip6tables -w -S)"
run apply "${conf}"
check "a second apply exits 0, prints nothing and leaves both tables as they were" \
  '[ "${rc}" -eq 0 ] && [ -z "${out}" ] && [ "$(iptables -w -S; ip6tables -w -S)" = "${snapshot}" ]' "rc=${rc} output: ${out}"
check "and does not reload the chain (its counters survive)" \
  '[ "${counted}" -ge 1 ] && [ "$(iptables -w -S HCW-SANDBOX-OUT -v | grep -c -- "-c [1-9]" || true)" -eq "${counted}" ]' \
  "counted before: ${counted}; after: $(iptables -w -S HCW-SANDBOX-OUT -v | grep -c -- '-c [1-9]' || true)"

# 5. --noflush replaces a chain's contents: a stray rule and a lost one are
#    both put right by one load.
iptables -w -I HCW-SANDBOX-OUT 1 -j RETURN
iptables -w -D HCW-SANDBOX-OUT -d 10.0.0.0/8 -m comment --comment "hcw: private or reserved, refused" -j HCW-REFUSE
run verify "${conf}"
check "verify names a chain that drifted, line by line" \
  '[ "${rc}" -eq 1 ] && grep -q "v4: HCW-SANDBOX-OUT differs from" <<<"${out}" && grep -qxF "  + -A HCW-SANDBOX-OUT -j RETURN" <<<"${out}" && grep -q "^  - -A HCW-SANDBOX-OUT -d 10.0.0.0/8 " <<<"${out}"' \
  "rc=${rc} output: ${out}"
run apply "${conf}"
check "apply refills the drifted chain, and only that family" \
  '[ "${rc}" -eq 0 ] && [ "${out}" = "v4: loaded HCW-BRIDGE-IN HCW-CONTROL-OUT HCW-REFUSE HCW-SANDBOX-OUT from ${rules4}" ] && [ "$(iptables -w -S HCW-SANDBOX-OUT | grep -v "^-N")" = "$(grep "^-A HCW-SANDBOX-OUT" "${rules4}")" ]' \
  "rc=${rc} output: ${out}"

# 6. A transaction the kernel rejects at commit changes nothing: the chain
#    keeps its rules and the jumps their places. A jump to a chain that does
#    not exist is refused only at commit (the dry run does not see it).
bad="${work}/bad"
cp -r "${conf}" "${bad}"
sed -i 's/^COMMIT$/-A HCW-SANDBOX-OUT -j NO-SUCH-CHAIN\nCOMMIT/' "${bad}/hcw.v4.rules"
before="$(iptables -w -S)"
run apply "${bad}"
check "a load iptables refuses at commit exits 3 and says nothing in it was applied" \
  '[ "${rc}" -eq 3 ] && grep -q "refused the IPv4 transaction; nothing in it was applied" <<<"${out}"' "rc=${rc} output: ${out}"
check "and the IPv4 table is exactly as it was" '[ "$(iptables -w -S)" = "${before}" ]' "now: $(iptables -w -S HCW-SANDBOX-OUT)"

# 6a. The commit-time refusal these files could carry, a jump to an HCW-*
#     chain they do not declare, is refused by the helper's own parse,
#     before either family is touched: IPv4 differs and comes first, and is
#     still not committed.
iptables -w -D HCW-SANDBOX-OUT -d 10.0.0.0/8 -m comment --comment "hcw: private or reserved, refused" -j HCW-REFUSE
undeclared="${work}/undeclared"
cp -r "${conf}" "${undeclared}"
sed -i 's/^COMMIT$/-A HCW-SANDBOX-OUT -j HCW-NO-SUCH-CHAIN\nCOMMIT/' "${undeclared}/hcw.v6.rules"
before="$(iptables -w -S; ip6tables -w -S)"
run apply "${undeclared}"
check "a jump to an undeclared HCW-* chain is refused before anything, with exit 2" \
  '[ "${rc}" -eq 2 ] && grep -qF "hcw.v6.rules: a rule jumps to HCW-NO-SUCH-CHAIN, which the file does not declare" <<<"${out}"' "rc=${rc} output: ${out}"
check "and neither family changed" '[ "$(iptables -w -S; ip6tables -w -S)" = "${before}" ]' "now: $(iptables -w -S HCW-SANDBOX-OUT)"

# 6b. Both families are dry-run before either is committed: an IPv6 rule
#     iptables cannot parse stops the run with IPv4 as it was, although
#     IPv4 differs and comes first.
bad6="${work}/bad6"
cp -r "${conf}" "${bad6}"
sed -i 's/^COMMIT$/-A HCW-SANDBOX-OUT -m no-such-match -j RETURN\nCOMMIT/' "${bad6}/hcw.v6.rules"
run apply "${bad6}"
check "an IPv6 rule iptables refuses in its dry run exits 3 before either family changes" \
  '[ "${rc}" -eq 3 ] && grep -q "refused the IPv6 transaction in its dry run; nothing in either family was changed" <<<"${out}" && ! grep -q "^v4: loaded" <<<"${out}"' "rc=${rc} output: ${out}"
check "and IPv4 keeps its drift: it was not committed ahead of IPv6" '[ "$(iptables -w -S; ip6tables -w -S)" = "${before}" ]' "now: $(iptables -w -S HCW-SANDBOX-OUT)"
run apply "${conf}"
check "and the good files then load IPv4 alone" \
  '[ "${rc}" -eq 0 ] && [ "${out}" = "v4: loaded HCW-BRIDGE-IN HCW-CONTROL-OUT HCW-REFUSE HCW-SANDBOX-OUT from ${rules4}" ]' "rc=${rc} output: ${out}"

# 6c. One run at a time: while another run holds the lock, apply waits, and
#     gives up after the wait without changing anything.
# The holder takes the lock on its own descriptor and then becomes the sleep,
# so killing that one process lets the lock go.
(
  exec 8>>"${HCW_FIREWALL_LOCK}"
  flock 8
  exec sleep 30
) &
lock_holder=$!
for _ in $(seq 50); do flock -n "${HCW_FIREWALL_LOCK}" true || break; sleep 0.1; done
iptables -w -D HCW-SANDBOX-OUT -d 10.0.0.0/8 -m comment --comment "hcw: private or reserved, refused" -j HCW-REFUSE
before="$(iptables -w -S; ip6tables -w -S)"
export HCW_FIREWALL_LOCK_WAIT=1
run apply "${conf}"
unset HCW_FIREWALL_LOCK_WAIT
check "apply waits for another run's lock, and gives up after the wait with exit 2" \
  '[ "${rc}" -eq 2 ] && grep -q "another hcw-host-firewall run held .* for 1s; nothing was changed" <<<"${out}"' "rc=${rc} output: ${out}"
check "and changed nothing while it waited" '[ "$(iptables -w -S; ip6tables -w -S)" = "${before}" ]' "now: $(iptables -w -S HCW-SANDBOX-OUT)"
kill "${lock_holder}" 2>/dev/null || true
wait "${lock_holder}" 2>/dev/null || true
lock_holder=''
run apply "${conf}"
check "and once the lock is free, apply puts IPv4 right" \
  '[ "${rc}" -eq 0 ] && [ "${out}" = "v4: loaded HCW-BRIDGE-IN HCW-CONTROL-OUT HCW-REFUSE HCW-SANDBOX-OUT from ${rules4}" ]' "rc=${rc} output: ${out}"

# 7. Jumps: duplicated, moved below another rule, or missing, put right.
iptables -w -A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT
iptables -w -I INPUT 1 -p tcp --dport 9 -j DROP
ip6tables -w -D OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT
ip6tables -w -D OUTPUT -j HCW-CONTROL-OUT
run verify "${conf}"
check "verify names a duplicated jump, a jump below another rule and a missing one" \
  '[ "${rc}" -eq 1 ] && grep -q "live at 4 -A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT" <<<"${out}" && grep -q "live at 2 -A INPUT -i docker0 -j HCW-BRIDGE-IN" <<<"${out}" && grep -q "^v6: OUTPUT must start" <<<"${out}" && grep -q "  live: none" <<<"${out}"' \
  "rc=${rc} output: ${out}"
run apply "${conf}"
check "apply leaves exactly one of each jump, first, and the other rules in their order" \
  '[ "${rc}" -eq 0 ] && [ "$(iptables -w -S OUTPUT | grep -c HCW-SANDBOX-OUT)" -eq 1 ] && [ "$(iptables -w -S OUTPUT | sed -n 2,4p | tr "\n" "|")" = "-A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT|-A OUTPUT -j HCW-CONTROL-OUT|-A OUTPUT -o lo -j ACCEPT|" ] && [ "$(iptables -w -S INPUT | sed -n 2,5p | tr "\n" "|")" = "-A INPUT -i docker0 -j HCW-BRIDGE-IN|-A INPUT -i br-+ -j HCW-BRIDGE-IN|-A INPUT -p tcp -m tcp --dport 9 -j DROP|-A INPUT -i lo -j ACCEPT|" ] && [ "$(ip6tables -w -S OUTPUT | sed -n 2,3p | tr "\n" "|")" = "-A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT|-A OUTPUT -j HCW-CONTROL-OUT|" ]' \
  "rc=${rc} output: ${out} INPUT: $(iptables -w -S INPUT | tr "\n" "|")"
check "and reports what it moved without reloading a chain" \
  '! grep -q "loaded" <<<"${out}" && grep -q "^v4: removed -A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT" <<<"${out}" && grep -q "^v6: put -A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT first" <<<"${out}"' \
  "output: ${out}"
iptables -w -D INPUT -p tcp --dport 9 -j DROP
run verify "${conf}"
check "verify passes again" '[ "${rc}" -eq 0 ]' "rc=${rc} output: ${out}"
check "DOCKER-USER, FORWARD and the ufw-like rules are untouched" '[ "$(others_v4)" = "${before_others}" ]' "now: $(others_v4)"

# 8. The verdicts. probe PROTO HOST PORT [INTERFACE] connects (TCP) or sends
#    one datagram and waits for an answer (UDP), and prints the outcome and
#    the seconds it took. verdict CMD CHAIN PROBE... reads the chain's
#    counters, runs the probe, reads them again, and prints every rule whose
#    count grew, as TARGET=COMMENT joined by ";", then "#" and the probe's
#    outcome. More than one rule can grow for one probe: a reset refusing a
#    connection to the internal network goes back to the host's own address
#    on it, which is in that network too, and is counted as a reply there.
#    (Read twice rather than zeroed: iptables 1.8.10, Ubuntu 24.04's, cannot
#    zero these rules' counters.)
cat >"${work}/probe.py" <<'PY'
import socket, sys, time
proto, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
family = socket.AF_INET6 if ":" in host else socket.AF_INET
s = socket.socket(family, socket.SOCK_STREAM if proto == "tcp" else socket.SOCK_DGRAM)
s.settimeout(1.0)
address = (host, port) if family == socket.AF_INET else (host, port, 0, socket.if_nametoindex(sys.argv[4]) if len(sys.argv) > 4 else 0)
start = time.monotonic()
try:
    s.connect(address)
    if proto == "udp":
        s.send(b"hcw")
        s.recv(1)
    outcome = "connected"
except (ConnectionRefusedError, PermissionError, ConnectionResetError):
    outcome = "refused"
except socket.timeout:
    outcome = "timeout"
except OSError as error:
    outcome = "error-%d" % error.errno
print("%s %.2f" % (outcome, time.monotonic() - start))
PY
# probe PROTO ADDRESS PORT [DEVICE]: one connection or datagram from this
# namespace, printing how it ended and how long that took.
probe() { "${python}" "${work}/probe.py" "$@"; }
# counts CMD CHAIN: the packet count of each rule of CHAIN, one per line.
counts() { "$1" -w -L "$2" -n -v -x | awk 'NR > 2 { print $1 }'; }
# verdict CMD CHAIN PROBE...: runs PROBE and prints each rule of CHAIN whose
# packet count grew, as TARGET=COMMENT joined by ";", then "#" and the
# probe's own outcome.
verdict() {
  local cmd="$1" chain="$2" result before
  shift 2
  before="$(counts "${cmd}" "${chain}" | tr '\n' ' ')"
  result="$("$@")"
  "${cmd}" -w -L "${chain}" -n -v -x | awk -v before="${before}" '
    BEGIN { split(before, was, " ") }
    NR > 2 {
      i++
      if ($1 > was[i]) {
        comment = ""
        if (match($0, /\/\* .* \*\//)) comment = substr($0, RSTART + 3, RLENGTH - 6)
        printf "%s%s=%s", (n++ ? ";" : ""), $3, comment
      }
    }' | tr -d '\n'
  echo "#${result}"
}
# met GOT TARGET COMMENT: true when the verdict GOT counted TARGET=COMMENT
# and, for a refusal, the probe was refused within its first second, or, for
# anything else, no refusal was counted at all.
met() {
  local grown="${1%%#*}" outcome="${1#*#}"
  [[ ";${grown};" == *";$2=$3;"* ]] || return 1
  if [ "$2" = HCW-REFUSE ]; then
    [[ "${outcome}" =~ ^refused\ 0\. ]]
  else
    [[ "${grown}" != *HCW-REFUSE=* ]]
  fi
}
# expect NAME WANT-TARGET WANT-COMMENT CMD CHAIN PROBE...: the verdict.
expect() {
  local name="$1" target="$2" comment="$3" got
  shift 3
  got="$(verdict "$@")"
  if met "${got}" "${target}" "${comment}"; then
    ok "${name}"
  else
    not_ok "${name}" "want ${target}=${comment}, got ${got}"
  fi
}
# sandbox4 and sandbox6 NAME TARGET COMMENT PROBE-ARGS...: expect for a probe
# the sandbox user sends, read from HCW-SANDBOX-OUT of that family.
sandbox4() { expect "$1" "$2" "$3" iptables HCW-SANDBOX-OUT probe "${@:4}"; }
sandbox6() { expect "$1" "$2" "$3" ip6tables HCW-SANDBOX-OUT probe "${@:4}"; }

sandbox4 "sandbox: DNS to systemd-resolved's stub over UDP" RETURN "hcw: the host resolver" udp 127.0.0.53 53
sandbox4 "sandbox: DNS to the stub over TCP" RETURN "hcw: the host resolver" tcp 127.0.0.53 53
sandbox4 "sandbox: HTTPS to the host's own address (Coder, the guided labs)" RETURN "hcw: https to this host" tcp "${own_v4}" 443
sandbox4 "sandbox: SSH to the host's own address is refused" HCW-REFUSE "hcw: host-local, refused" tcp "${own_v4}" 22
sandbox4 "sandbox: HTTP to the host's own address is refused" HCW-REFUSE "hcw: host-local, refused" tcp "${own_v4}" 80
sandbox4 "sandbox: HTTPS to another address of the host (any of them answers as Caddy) is allowed" RETURN "hcw: https to this host" tcp 172.28.240.1 443
sandbox4 "sandbox: HTTPS on the loopback is refused" HCW-REFUSE "hcw: host-local, refused" tcp 127.0.0.1 443
sandbox4 "sandbox: a loopback service is refused" HCW-REFUSE "hcw: host-local, refused" tcp 127.0.0.1 9000
sandbox4 "sandbox: DNS to the other stub address is refused" HCW-REFUSE "hcw: host-local, refused" udp 127.0.0.54 53
sandbox4 "sandbox: a bridge gateway address of the host is refused" HCW-REFUSE "hcw: host-local, refused" tcp 172.28.240.1 9000
sandbox4 "sandbox: 172.16.0.0/12 is refused" HCW-REFUSE "hcw: private or reserved, refused" tcp 172.31.0.2 9000
sandbox4 "sandbox: 10.0.0.0/8 is refused" HCW-REFUSE "hcw: private or reserved, refused" tcp 10.1.2.3 443
sandbox4 "sandbox: 192.168.0.0/16 is refused" HCW-REFUSE "hcw: private or reserved, refused" tcp 192.168.1.10 443
sandbox4 "sandbox: 100.64.0.0/10 is refused" HCW-REFUSE "hcw: private or reserved, refused" tcp 100.64.0.1 443
sandbox4 "sandbox: the link-local metadata address is refused" HCW-REFUSE "hcw: private or reserved, refused" tcp 169.254.169.254 80
sandbox4 "sandbox: multicast is refused" HCW-REFUSE "hcw: private or reserved, refused" udp 224.0.0.251 5353
sandbox4 "sandbox: 240.0.0.0/4 is refused" HCW-REFUSE "hcw: private or reserved, refused" tcp 240.0.0.1 443
sandbox4 "sandbox: HTTPS to a public address is allowed" RETURN "hcw: web egress" tcp 198.51.100.7 443
sandbox4 "sandbox: HTTP to a public address is allowed" RETURN "hcw: web egress" tcp 198.51.100.7 80
sandbox4 "sandbox: SMTP to a public address is refused" HCW-REFUSE "hcw: refused" tcp 198.51.100.7 25
sandbox4 "sandbox: SSH to a public address is refused" HCW-REFUSE "hcw: refused" tcp 198.51.100.7 22
sandbox4 "sandbox: DNS to a public resolver is refused" HCW-REFUSE "hcw: refused" udp 198.51.100.7 53
sandbox4 "sandbox: UDP 443 to a public address is refused" HCW-REFUSE "hcw: refused" udp 198.51.100.7 443
check "the 0.0.0.0/8 refusal is loaded" 'iptables -w -C HCW-SANDBOX-OUT -d 0.0.0.0/8 -m comment --comment "hcw: private or reserved, refused" -j HCW-REFUSE'
sandbox6 "sandbox v6: HTTPS to the host's own address" RETURN "hcw: https to this host" tcp "${own_v6}" 443
sandbox6 "sandbox v6: SSH to the host's own address is refused" HCW-REFUSE "hcw: host-local, refused" tcp "${own_v6}" 22
sandbox6 "sandbox v6: ::1 is refused" HCW-REFUSE "hcw: host-local, refused" tcp ::1 9000
sandbox6 "sandbox v6: HTTPS on ::1 is refused" HCW-REFUSE "hcw: host-local, refused" tcp ::1 443
sandbox6 "sandbox v6: fc00::/7 is refused" HCW-REFUSE "hcw: private or reserved, refused" tcp fd00::1 443
sandbox6 "sandbox v6: fe80::/10 is refused" HCW-REFUSE "hcw: private or reserved, refused" tcp fe80::99 443 hcw0
sandbox6 "sandbox v6: ff00::/8 is refused" HCW-REFUSE "hcw: private or reserved, refused" udp ff02::fb 5353 hcw0
sandbox6 "sandbox v6: HTTPS to a public address is allowed" RETURN "hcw: web egress" tcp 2001:db8:1::5 443
sandbox6 "sandbox v6: SMTP to a public address is refused" HCW-REFUSE "hcw: refused" tcp 2001:db8:1::5 25
sandbox6 "sandbox v6: DNS to a public resolver is refused" HCW-REFUSE "hcw: refused" udp 2001:db8:1::5 53

# bridge4 and bridge6 NAME TARGET COMMENT PROBE-ARGS...: expect for a probe a
# container sends to the host, read from HCW-BRIDGE-IN of that family.
bridge4() { expect "$1" "$2" "$3" iptables HCW-BRIDGE-IN inside "${python}" "${work}/probe.py" "${@:4}"; }
bridge6() { expect "$1" "$2" "$3" ip6tables HCW-BRIDGE-IN inside "${python}" "${work}/probe.py" "${@:4}"; }
bridge4 "bridge: HTTPS from a container to the host is allowed" RETURN "hcw: http and https to this host" tcp 172.28.240.1 443
bridge4 "bridge: HTTP from a container to the host is allowed" RETURN "hcw: http and https to this host" tcp 172.28.240.1 80
bridge4 "bridge: SSH from a container to the host is refused" HCW-REFUSE "hcw: refused" tcp 172.28.240.1 22
bridge4 "bridge: any other port from a container is refused" HCW-REFUSE "hcw: refused" tcp 172.28.240.1 9000
bridge4 "bridge: DNS from a container to the host is refused" HCW-REFUSE "hcw: refused" udp 172.28.240.1 53
bridge4 "bridge: docker0 is governed too" HCW-REFUSE "hcw: refused" tcp 172.17.0.1 22
bridge4 "bridge: HTTPS on docker0 is allowed" RETURN "hcw: http and https to this host" tcp 172.17.0.1 443
bridge4 "bridge: the host's public address from a container, HTTPS allowed" RETURN "hcw: http and https to this host" tcp "${own_v4}" 443
bridge4 "bridge: the host's public address from a container, SSH refused" HCW-REFUSE "hcw: refused" tcp "${own_v4}" 22
# The first IPv6 packet each way needs neighbour discovery, which the chain
# must let through or nothing would reach the host at all. One probe first,
# so the verdicts below count the probes' own packets.
nd_count() { ip6tables -w -L HCW-BRIDGE-IN -n -v -x | awk '/neighbour discovery/ { n += $1 } END { print n + 0 }'; }
nd_before="$(nd_count)"
warm="$(inside "${python}" "${work}/probe.py" tcp fd00:28::1 443)"
check "bridge v6: neighbour discovery from a container is let through, and the host answers" \
  '[ "$(nd_count)" -gt "${nd_before}" ] && [[ "${warm}" =~ ^refused ]]' \
  "probe: ${warm}; $(ip6tables -w -L HCW-BRIDGE-IN -n -v -x)"
bridge6 "bridge v6: HTTPS from a container to the host is allowed" RETURN "hcw: http and https to this host" tcp fd00:28::1 443
bridge6 "bridge v6: SSH from a container to the host is refused" HCW-REFUSE "hcw: refused" tcp fd00:28::1 22

# 9. A connection the host opens to a container (Caddy to Coder and the
#    add-ons, through their published ports) still works: its replies are let
#    back in. The test's probes run as the sandbox user, so its jump comes out
#    first, and the apply after it puts the jump back.
iptables -w -D OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT
inside "${python}" -c 'import socket; s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", 8080)); s.listen(); s.settimeout(5); c, _ = s.accept(); c.close()' &
listener=$!
sleep 0.5
got="$(verdict iptables HCW-BRIDGE-IN probe tcp 172.28.240.3 8080)"
wait "${listener}" 2>/dev/null || true
check "bridge: the host's own connection to a container completes, its replies counted as replies" \
  'met "${got}" RETURN "hcw: replies to host flows" && [[ "${got#*#}" =~ ^connected ]]' "got ${got}"

# 9b. Coder's internal network, in the same window (uid 0 is not the sandbox
#     user here, so its packets meet HCW-CONTROL-OUT alone). The host's new
#     connection to it is refused at once; a connection a container there
#     opens to the host on 443 still completes, because the host's answers
#     go; and the host's connection to a container on another network was not
#     touched (above).
control() { expect "$1" "$2" "$3" iptables HCW-CONTROL-OUT "${@:4}"; }
control "internal network: the host's new TCP connection to it is refused" HCW-REFUSE "hcw: internal network, refused" probe tcp 172.30.241.2 9000
control "internal network: the host's UDP to it is refused" HCW-REFUSE "hcw: internal network, refused" probe udp 172.30.241.2 53
"${python}" -c 'import socket; s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("172.30.241.1", 443)); s.listen(); s.settimeout(5); c, _ = s.accept(); c.close()' &
listener=$!
sleep 0.5
got="$(verdict iptables HCW-CONTROL-OUT inside "${python}" "${work}/probe.py" tcp 172.30.241.1 443)"
wait "${listener}" 2>/dev/null || true
check "internal network: a container there reaching the host on 443 completes, the host's answers let through" \
  'met "${got}" RETURN "hcw: replies on the internal network" && [[ "${got#*#}" =~ ^connected ]]' "got ${got}"
# Another uid than 0 exists only where the test runs as real root; a user
# namespace of the test's own maps uid 0 alone.
if [ -n "${real_root}" ]; then
  as_nobody() { setpriv --reuid=65534 --regid=65534 --clear-groups -- "$@"; }
  control "internal network: the same from an unprivileged process of the host" HCW-REFUSE "hcw: internal network, refused" as_nobody "${python}" "${work}/probe.py" tcp 172.30.241.2 9000
  inside "${python}" -c 'import socket; s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", 8080)); s.listen(); s.settimeout(5); c, _ = s.accept(); c.close()' &
  listener=$!
  sleep 0.5
  got="$(verdict iptables HCW-CONTROL-OUT as_nobody "${python}" "${work}/probe.py" tcp 172.28.240.3 8080)"
  wait "${listener}" 2>/dev/null || true
  check "internal network: that process's connection to a container on another network is not touched" \
    '[ -z "${got%%#*}" ] && [[ "${got#*#}" =~ ^connected ]]' "got ${got}"
else
  skip "only uid 0 exists in this user namespace, so an unprivileged process is not probed"
fi

run apply "${conf}"
check "apply puts a removed jump back, and says so" \
  '[ "${rc}" -eq 0 ] && grep -qxF "v4: put -A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT first" <<<"${out}" && ! grep -q loaded <<<"${out}"' "rc=${rc} output: ${out}"
run verify "${conf}"
check "and verify passes" '[ "${rc}" -eq 0 ]' "rc=${rc} output: ${out}"

# 10. ufw, run from its installed scripts against a scratch configuration
#     with the host's settings (MANAGE_BUILTINS=no, IPv6 on): starting it
#     after the chains are loaded, reloading it, and stopping and starting it
#     leave them first; and loaded after ufw, as at boot, they go above it.
ufw_init="$(command -v /usr/lib/ufw/ufw-init /lib/ufw/ufw-init 2>/dev/null | head -n 1 || true)"
if [ -z "${ufw_init}" ] || [ ! -r /usr/share/ufw/before.rules ]; then
  if [ "${HCW_REQUIRE_UFW:-}" = 1 ]; then
    not_ok "ufw is required here (HCW_REQUIRE_UFW=1) and is not installed, so its start, reload and restart were not run"
  else
    skip "ufw is not installed here, so its start, reload and restart are not run"
  fi
else
  ufw_root="${work}/ufw"
  mkdir -p "${ufw_root}/etc/ufw" "${ufw_root}/etc/default" "${ufw_root}/lib/ufw"
  cp "$(dirname "${ufw_init}")/ufw-init-functions" "${ufw_root}/lib/ufw/"
  for f in before after user before6 after6 user6; do cp "/usr/share/ufw/${f}.rules" "${ufw_root}/etc/ufw/"; done
  printf 'ENABLED=yes\nLOGLEVEL=off\n' >"${ufw_root}/etc/ufw/ufw.conf"
  printf '%s\n' 'IPV6=yes' 'DEFAULT_INPUT_POLICY="DROP"' 'DEFAULT_OUTPUT_POLICY="ACCEPT"' 'DEFAULT_FORWARD_POLICY="DROP"' \
    'DEFAULT_APPLICATION_POLICY="SKIP"' 'MANAGE_BUILTINS=no' 'IPT_SYSCTL=' 'IPT_MODULES=""' >"${ufw_root}/etc/default/ufw"
  ufw() { sh "${ufw_init}" --rootdir "${ufw_root}" --datadir "${ufw_root}" "$@" >/dev/null 2>&1; }
  ufw start && started=0 || started=$?
  run verify "${conf}"
  check "ufw starts after the chains are loaded, and they stay first" \
    '[ "${started}" -eq 0 ] && iptables -w -S INPUT | grep -q -- "-j ufw-before-input" && [ "${rc}" -eq 0 ]' "ufw-init start: ${started}; verify: ${out}"
  ufw force-reload && reloaded=0 || reloaded=$?
  run verify "${conf}"
  check "ufw reload leaves the chains and every jump in place" \
    '[ "${reloaded}" -eq 0 ] && [ "${rc}" -eq 0 ] && [ "$(iptables -w -S INPUT | grep -c -- "-j ufw-before-input")" -eq 1 ]' "ufw-init force-reload: ${reloaded}; verify: ${out}"
  ufw stop && ufw start && restarted=0 || restarted=$?
  run verify "${conf}"
  check "ufw stop and start leave them in place too" '[ "${restarted}" -eq 0 ] && [ "${rc}" -eq 0 ]' "ufw-init stop/start: ${restarted}; verify: ${out}"
  for cmd in iptables ip6tables; do
    "${cmd}" -w -D OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT
    "${cmd}" -w -D OUTPUT -j HCW-CONTROL-OUT
  done
  iptables -w -D INPUT -i docker0 -j HCW-BRIDGE-IN
  iptables -w -D INPUT -i br-+ -j HCW-BRIDGE-IN
  run apply "${conf}"
  check "loaded after ufw, as at boot, the jumps go above ufw's" \
    '[ "${rc}" -eq 0 ] && [ "$(iptables -w -S INPUT | sed -n 2,3p | tr "\n" "|")" = "-A INPUT -i docker0 -j HCW-BRIDGE-IN|-A INPUT -i br-+ -j HCW-BRIDGE-IN|" ] && [ "$(iptables -w -S OUTPUT | sed -n 2,4p | tr "\n" "|")" = "-A OUTPUT -m owner --uid-owner 0 -j HCW-SANDBOX-OUT|-A OUTPUT -j HCW-CONTROL-OUT|-A OUTPUT -o lo -j ACCEPT|" ]' \
    "rc=${rc} output: ${out} OUTPUT: $(iptables -w -S OUTPUT | tr "\n" "|")"
  check "ufw's own loopback accept is below the sandbox and control jumps" \
    'iptables -w -S ufw-before-output | grep -q -- "-A ufw-before-output -o lo -j ACCEPT" && [ "$(iptables -w -S OUTPUT | grep -n -- "-j ufw-before-output" | cut -d: -f1)" -gt 3 ]'
fi

# 11. Files the helper must refuse, before touching anything.
before="$(iptables -w -S; ip6tables -w -S)"
refuse="${work}/refuse"
cp -r "${conf}" "${refuse}"
sed -i 's/^COMMIT$/-A OUTPUT -j ACCEPT\nCOMMIT/' "${refuse}/hcw.v4.rules"
run apply "${refuse}"
check "a rules file that appends to a built-in chain is refused" \
  '[ "${rc}" -eq 2 ] && grep -q "appends to OUTPUT, which the file does not declare" <<<"${out}"' "rc=${rc} output: ${out}"
cp "${conf}/hcw.v4.rules" "${refuse}/hcw.v4.rules"
sed -i 's/^\*filter$/*filter\n:DOCKER-USER - [0:0]/' "${refuse}/hcw.v4.rules"
run apply "${refuse}"
check "a rules file that declares (and so would flush) a chain not named HCW-* is refused" \
  '[ "${rc}" -eq 2 ] && grep -q "declare HCW-\* chains only" <<<"${out}"' "rc=${rc} output: ${out}"
cp "${conf}/hcw.v4.rules" "${refuse}/hcw.v4.rules"
sed -i 's/--uid-owner root/--uid-owner hcw-no-such-user/' "${refuse}/hcw.jumps"
run apply "${refuse}"
check "a jump naming a user that does not exist is refused" \
  '[ "${rc}" -eq 2 ] && grep -q "the user hcw-no-such-user does not exist" <<<"${out}"' "rc=${rc} output: ${out}"
check "and none of them changed either table" '[ "$(iptables -w -S; ip6tables -w -S)" = "${before}" ]'

# 12. remove, the role's absent path: every HCW-* jump and chain out of both
#     families, in one transaction each, and nothing else touched.
# hcw_lines: how many rules of both families name an HCW-* chain.
hcw_lines() { { iptables -w -S; ip6tables -w -S; } | grep -c -e ' HCW-' || true; }
# others_both: the rules of both families that are not the helper's.
others_both() { { iptables -w -S; ip6tables -w -S; } | grep -v -e 'HCW-' || true; }
before_remove="$(others_both)"
check "before remove, the chains and jumps are loaded" '[ "$(hcw_lines)" -gt 0 ]'
run remove
check "remove takes every HCW-* jump and chain out of both families, and says so" \
  '[ "${rc}" -eq 0 ] && grep -q "^v4: removed the HCW-\* jumps and the chains HCW-BRIDGE-IN HCW-CONTROL-OUT HCW-REFUSE HCW-SANDBOX-OUT$" <<<"${out}" && grep -q "^v6: removed " <<<"${out}" && [ "$(hcw_lines)" -eq 0 ]' \
  "rc=${rc} output: ${out} left: $({ iptables -w -S; ip6tables -w -S; } | grep HCW- || true)"
check "and leaves everything else (ufw's, DOCKER-USER, the ufw-like rules) as it was" '[ "$(others_both)" = "${before_remove}" ]' "now: $(others_both)"
run remove
check "remove again has nothing to do: exits 0 and prints nothing" '[ "${rc}" -eq 0 ] && [ -z "${out}" ]' "rc=${rc} output: ${out}"
run apply "${conf}"
run verify "${conf}"
check "and apply loads it all again from nothing" '[ "${rc}" -eq 0 ]' "rc=${rc} output: ${out}"

echo "${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
