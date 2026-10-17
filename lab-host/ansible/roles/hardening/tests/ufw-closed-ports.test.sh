#!/usr/bin/env bash
# Runs ../tasks/ufw.yml (#953 stage 3) with ansible-core and community.general
# against the real ufw, with the lab host's group_vars, in a network and mount
# namespace of its own: ufw's iptables rules land in a scratch network
# namespace and its configuration in a scratch copy bound over /etc/ufw and
# /etc/default/ufw, so the machine running it keeps its own. The Arc agent's
# CLI is a stub that answers from scratch files. It checks:
#
# - seeded as the lab host was before stage 3 (22, 80 and 443 allowed, each
#   for IPv4 and IPv6) with Azure Arc SSH ready, a run deletes 22's pair and
#   keeps 80's and 443's; a second run, and a check-mode run, change nothing;
# - check mode reports a closed port's allow as a change, which is how the
#   nightly drift check sees one come back, and fails nothing;
# - a rule the delete does not match fails the run at the read-back, naming
#   it: a bare `ufw allow 22` (TCP and UDP), `limit`, an interface rule, a
#   port list and a destination address, and Ubuntu's OpenSSH application
#   profile; 2222 and 220 do not;
# - the Arc gate: while the agent is Disconnected, 22 is left as ufw has it,
#   closed through a network drop and reopened through a reset agent's
#   re-onboarding; it is allowed, with a line saying why, while the agent is
#   missing (a rebuilt host before onboarding), Expired, unreadable, or has
#   no incoming connections for 22; the first run with Arc SSH ready closes
#   it; a port written as a string goes through the gate the same way;
# - turning Arc SSH off: a run with arc_incoming_ssh_enabled false opens 22
#   though Arc is ready, and the arc role's guard (roles/arc/tasks/
#   ssh_off_guard.yml) refuses to turn Arc SSH off while ufw keeps 22 closed
#   or sshd listens on the loopback alone (a real listener stands in for it)
#   and lets it once 22 is open;
# - a port in both lists stops the run before any rule changes.
#
# As root, for the namespaces and iptables. CI runs it in the
# `ansible-lint (lab-host)` job with sudo, after installing ufw; no Docker.
set -euo pipefail

if [ -z "${HCW_UFW_TEST_NS:-}" ]; then
  [ "$(id -u)" -eq 0 ] || { echo "run as root: the test makes namespaces and writes iptables (sudo env \"PATH=\$PATH\" bash $0)" >&2; exit 1; }
  export HCW_UFW_TEST_NS=1
  exec unshare --net --mount --propagation private bash "${BASH_SOURCE[0]}" "$@"
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"
group_vars="$(cd "${role}/../.." && pwd)/group_vars/all.yml"
PATH="${PATH}:/usr/sbin:/sbin"

passed=0
failed=0
# ok NAME: count and print a passing check, TAP style.
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
# not_ok NAME [DETAIL]: count and print a failing check, with its detail indented.
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
# check NAME COMMAND [DETAIL]: run COMMAND through eval and report it as ok or not ok.
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

command -v ansible-playbook > /dev/null || { echo "ansible-playbook is not on PATH" >&2; exit 1; }
command -v ufw > /dev/null || { echo "ufw is not installed (apt-get install ufw)" >&2; exit 1; }
[ -r /usr/share/ufw/user.rules ] || { echo "ufw's pristine rules are not in /usr/share/ufw" >&2; exit 1; }

work="$(mktemp -d)"
# finish: remove the scratch directory, on every way out. The bind mounts
# and the network namespace go with this process.
finish() {
  [ -z "${listener:-}" ] || kill "${listener}" 2> /dev/null || true
  umount /etc/default/ufw /etc/ufw 2> /dev/null || true
  rm -rf "${work}"
}
trap finish EXIT

# A fresh ufw: the installed configuration with the package's own rule files,
# disabled, IPv6 on as on the lab host.
cp -a /etc/ufw "${work}/etc-ufw"
for f in before after user before6 after6 user6; do cp "/usr/share/ufw/${f}.rules" "${work}/etc-ufw/${f}.rules"; done
printf 'ENABLED=no\nLOGLEVEL=low\n' > "${work}/etc-ufw/ufw.conf"
cp /etc/default/ufw "${work}/default-ufw"
sed -i 's/^IPV6=.*/IPV6=yes/' "${work}/default-ufw"
mount --bind "${work}/etc-ufw" /etc/ufw
mount --bind "${work}/default-ufw" /etc/default/ufw
ip link set lo up

# The Arc agent's CLI: `show --json` and the two `config get` reads, each
# answered from a file arc_state writes.
mkdir -p "${work}/bin" "${work}/arc"
cat > "${work}/bin/azcmagent" <<EOF
#!/bin/sh
case "\$1 \$2 \$3" in
  "show --json "*) cat "${work}/arc/show" ;;
  "config get incomingconnections.enabled") cat "${work}/arc/enabled" ;;
  "config get incomingconnections.ports") cat "${work}/arc/ports" ;;
  *) echo "stub azcmagent: unexpected arguments: \$*" >&2; exit 2 ;;
esac
EOF
chmod 0755 "${work}/bin/azcmagent"
agent="${work}/bin/azcmagent"
# arc_state SHOW ENABLED PORTS: what the stub prints for each read.
arc_state() { printf '%s\n' "$1" > "${work}/arc/show"; printf '%s\n' "$2" > "${work}/arc/enabled"; printf '%s\n' "$3" > "${work}/arc/ports"; agent="${work}/bin/azcmagent"; }
# arc_ready: onboarded and Connected, incoming connections on for 22, as agent 1.68 prints it.
arc_ready() { arc_state '{"status":"Connected","resourceName":"arcs-lab-hybrid-prod-cus-01"}' 'true' '[22]'; }
# arc_missing: no agent at the path, as on a rebuilt host before onboarding.
arc_missing() { agent="${work}/bin/no-azcmagent"; }

cat > "${work}/play.yml" <<EOF
- name: Run the hardening role's ufw tasks against a scratch ufw
  hosts: localhost
  connection: local
  gather_facts: false
  vars_files:
    - ${role}/defaults/main.yml
    - ${group_vars}
  tasks:
    - name: The Arc gate
      ansible.builtin.import_tasks: ${role}/tasks/arc_gate.yml
    - name: The ufw tasks
      ansible.builtin.import_tasks: ${role}/tasks/ufw.yml
    - name: Print what sshd and the listener check get from the gate
      ansible.builtin.debug:
        msg: "SSHD loopback_only={{ hardening_sshd_loopback_only | bool }} public={{ privilege_checks_public_tcp_ports | join(',') }}"
EOF
# The sshd drop-in the gate reads while the agent is Disconnected: the
# loopback pair, as every run with Arc ready writes it (#1257).
dropin="${work}/00-hcw-hardening.conf"
printf 'ListenAddress 127.0.0.1\nListenAddress ::1\n' > "${dropin}"
loopback='SSHD loopback_only=True public=80,443'
everywhere='SSHD loopback_only=False public=22,80,443'

cat > "${work}/ansible.cfg" <<'EOF'
[defaults]
stdout_callback = ansible.builtin.default
interpreter_python = auto_silent
retry_files_enabled = False
EOF
export ANSIBLE_CONFIG="${work}/ansible.cfg"

# run NAME [EXTRA_ARGS...]: run the play against the current agent stub;
# output to ${work}/NAME.out, exit code to ${work}/NAME.rc.
run() {
  local name="$1"
  shift
  set +e
  ANSIBLE_NOCOLOR=1 ANSIBLE_LOCALHOST_WARNING=0 ANSIBLE_INVENTORY_UNPARSED_WARNING=0 \
    ansible-playbook -i localhost, "${work}/play.yml" -e "hardening_arc_azcmagent_path=${agent}" \
    -e "hardening_sshd_dropin_path=${dropin}" "$@" > "${work}/${name}.out" 2>&1
  echo $? > "${work}/${name}.rc"
  set -e
}
# rc NAME: the exit code of run NAME.
rc() { cat "${work}/$1.rc"; }
# out NAME: everything run NAME printed.
out() { cat "${work}/$1.out"; }
# says NAME TEXT: true when run NAME printed TEXT.
says() { grep -qF -- "$2" "${work}/$1.out"; }
# recap NAME FIELD: a number from run NAME's PLAY RECAP line, such as changed.
recap() { sed -n "s/.*[[:space:]]$2=\([0-9]*\).*/\1/p" "${work}/$1.out" | tail -n 1; }
# admits PORT: the active rules hold an ALLOW for PORT, alone or /tcp, either family.
admits() { ufw status | grep -qE "^$1(/tcp)?( \(v6\))? +ALLOW"; }
# rules: ufw's listing, for a failure's detail.
rules() { ufw status 2>&1; }
# list KEY: the items of a block list in group_vars, one per line.
list() { sed -n "/^$1:/,/^[^ ]/p" "${group_vars}" | sed -n 's/^  - //p'; }
waits='Port 22 stays open to the internet on this run'

# The lab host's lists are what is run: 22 closed behind the Arc gate, 80 and 443 served.
check "group_vars closes 22 behind the Arc gate and serves 80 and 443, and nothing else" \
  "[ \"\$(list hardening_ufw_closed_tcp_ports | tr '\n' ' ')\" = '22 ' ] && [ \"\$(list hardening_ufw_allowed_tcp_ports | tr '\n' ' ')\" = '80 443 ' ] && grep -qx 'hardening_ssh_arc_gate: true' '${group_vars}'" \
  "closed: $(list hardening_ufw_closed_tcp_ports | tr '\n' ' ')allowed: $(list hardening_ufw_allowed_tcp_ports | tr '\n' ' ')"

# 1. Seeded as the lab host was before stage 3, Arc SSH ready.
ufw default deny incoming > /dev/null
for port in 22 80 443; do ufw allow "${port}/tcp" > /dev/null; done
ufw --force enable > /dev/null
check "the seed admits 22, 80 and 443" "admits 22 && admits 80 && admits 443" "$(rules)"

arc_ready
run close
check "with Arc SSH ready, a run closes 22" \
  "[ \"\$(rc close)\" -eq 0 ] && [ \"\$(recap close changed)\" -ge 1 ] && ! says close '${waits}'" "$(out close)"
check "and ufw no longer admits 22, for either family" "! admits 22 && ! ufw status | grep -qE '^22'" "$(rules)"
check "and still admits 80 and 443, for both families" \
  "[ \"\$(ufw status | grep -cE '^(80|443)/tcp( \(v6\))? +ALLOW')\" -eq 4 ]" "$(rules)"
check "and ufw is active" "ufw status | grep -qx 'Status: active'" "$(rules)"
check "and sshd binds to the loopback alone, so the listener check admits only 80 and 443 (#1257)" \
  "says close '${loopback}'" "$(out close)"

# 2. Converged.
run again
check "a second run changes nothing" "[ \"\$(rc again)\" -eq 0 ] && [ \"\$(recap again changed)\" -eq 0 ]" "$(out again)"
run checked --check
check "a check-mode run changes nothing and fails nothing" \
  "[ \"\$(rc checked)\" -eq 0 ] && [ \"\$(recap checked changed)\" -eq 0 ]" "$(out checked)"

# 3. 22 allowed again the way the role used to allow it: check mode reports
#    the drift without failing, and a run takes it back out.
ufw allow 22/tcp > /dev/null
run drift --check
check "check mode reports a closed port's allow as a change, without failing" \
  "[ \"\$(rc drift)\" -eq 0 ] && [ \"\$(recap drift changed)\" -ge 1 ]" "$(out drift)"
check "and leaves the rule for the real run" "admits 22" "$(rules)"
run reclose
check "the next run closes it again" "[ \"\$(rc reclose)\" -eq 0 ] && ! admits 22" "$(out reclose)"

# 4. An allow the delete cannot match fails the run at the read-back.
ufw allow 22 > /dev/null
run bare
check "a bare 'ufw allow 22' fails the run" \
  "[ \"\$(rc bare)\" -ne 0 ] && says bare 'ufw still admits a closed port' && says bare '22 ALLOW Anywhere'" "$(out bare)"
ufw delete allow 22 > /dev/null
# each_admits NAME RULE...: add the ufw rule (ufw's own arguments), run, expect
# the run to fail at the read-back, then delete the rule again.
each_admits() {
  local name="$1"
  shift
  ufw "$@" > /dev/null
  run "${name}"
  check "so does 'ufw $*'" "[ \"\$(rc ${name})\" -ne 0 ] && says ${name} 'ufw still admits a closed port'" "$(out "${name}"; rules)"
  ufw delete "$@" > /dev/null
}
each_admits limit limit 22/tcp
each_admits iface allow in on eth9 to any port 22 proto tcp
each_admits multiport allow proto tcp from any to any port 22,2222
each_admits address allow proto tcp from any to 192.0.2.1 port 22
ufw allow 2222/tcp > /dev/null
ufw allow 220/tcp > /dev/null
run neighbours
check "but 2222 and 220 are not 22" "[ \"\$(rc neighbours)\" -eq 0 ]" "$(out neighbours)"
ufw delete allow 2222/tcp > /dev/null
ufw delete allow 220/tcp > /dev/null
if [ -r /etc/ufw/applications.d/openssh-server ]; then
  ufw allow OpenSSH > /dev/null
  run profile
  check "so does Ubuntu's OpenSSH application profile" \
    "[ \"\$(rc profile)\" -ne 0 ] && says profile 'OpenSSH ALLOW Anywhere'" "$(out profile)"
  ufw delete allow OpenSSH > /dev/null
else
  # The profile ships with openssh-server; the CI runner has it.
  echo "skip - the OpenSSH application profile is not installed here"
fi
check "with those removed, ufw admits 22 nowhere" "! ufw status | grep -qE '^(22|OpenSSH)'" "$(rules)"

# 5. The Arc gate.
held='Port 22 is left as ufw has it on this run'
arc_state '{"status":"Disconnected","resourceName":"arcs-lab-hybrid-prod-cus-01"}' 'incomingconnections.enabled : true' 'incomingconnections.ports : [22]'
run blip
check "a Disconnected agent (a network drop) leaves a closed 22 closed" \
  "[ \"\$(rc blip)\" -eq 0 ] && [ \"\$(recap blip changed)\" -eq 0 ] && ! admits 22 && says blip '${held}'" "$(out blip)"
check "and keeps sshd on the loopback, as the drop-in has it" "says blip '${loopback}'" "$(out blip)"
# An agent reset with `azcmagent disconnect --force-local-only` (the way back
# from Expired) also reads Disconnected, its local settings kept; the owner
# has reopened 22 from the Web Console for Register-LabArc.ps1 -Connect, at
# ufw and in the drop-in (docs/runbooks/labs-host.md, "When Arc SSH is down").
arc_state '{"status":"Disconnected"}' 'true' '[22]'
ufw allow 22/tcp > /dev/null
printf '# ListenAddress lines removed from the Web Console\n' > "${dropin}"
run reset
check "and leaves a 22 reopened from the Web Console open, without failing, while the agent is reset" \
  "[ \"\$(rc reset)\" -eq 0 ] && [ \"\$(recap reset changed)\" -eq 0 ] && admits 22 && says reset '${held}'" "$(out reset)"
check "and sshd on every address, as the reopened drop-in has it, with 22 admitted by the listener check" \
  "says reset '${everywhere}' && says reset 'and sshd on every address'" "$(out reset)"
rm -f "${dropin}"
run reset-nodropin
check "and, with no drop-in to read, keeps sshd on the loopback, the role's default (CodeRabbit on #1263)" \
  "[ \"\$(rc reset-nodropin)\" -eq 0 ] && says reset-nodropin '${loopback}'" "$(out reset-nodropin)"
# A drop-in that is there and cannot be read (a directory in its place)
# stops the run rather than being taken for a missing one (CodeRabbit on #1264).
mkdir "${dropin}"
run reset-unreadable
check "but stops the run on a drop-in it cannot read" \
  "[ \"\$(rc reset-unreadable)\" -ne 0 ] && ! says reset-unreadable 'SSHD loopback_only='" "$(out reset-unreadable)"
rmdir "${dropin}"
printf 'ListenAddress 127.0.0.1\nListenAddress ::1\n' > "${dropin}"
arc_ready
run reconnected
check "and the first run with the agent Connected again closes it" \
  "[ \"\$(rc reconnected)\" -eq 0 ] && ! admits 22 && ! says reconnected '${held}' && says reconnected '${loopback}'" "$(out reconnected)"

arc_missing
run waiting --check
check "check mode with no agent reports opening 22 as a change, and opens nothing" \
  "[ \"\$(rc waiting)\" -eq 0 ] && [ \"\$(recap waiting changed)\" -ge 1 ] && says waiting '${waits}' && ! admits 22" "$(out waiting)"
run rebuilt
check "with no agent (a rebuilt host before onboarding), a run allows 22 and says why" \
  "[ \"\$(rc rebuilt)\" -eq 0 ] && admits 22 && says rebuilt '${waits}' && says rebuilt 'agent NotInstalled'" "$(out rebuilt)"
check "and has sshd listen on every address, which the listener check admits, so onboarding reaches it over 22 (#1257)" \
  "says rebuilt '${everywhere}' && says rebuilt 'and sshd listens on every address'" "$(out rebuilt)"
check "for both families, beside 80 and 443" \
  "[ \"\$(ufw status | grep -cE '^(22|80|443)/tcp( \(v6\))? +ALLOW')\" -eq 6 ]" "$(rules)"

arc_state '{"status":"Expired","resourceName":"arcs-lab-hybrid-prod-cus-01"}' 'true' '[22]'
run expired
check "an Expired agent keeps 22 open" "[ \"\$(rc expired)\" -eq 0 ] && admits 22 && says expired 'agent Expired'" "$(out expired)"

arc_state '{"status":"Connected"}' 'true' '[]'
run noports
check "a Connected agent with no incoming port 22 keeps it open" \
  "[ \"\$(rc noports)\" -eq 0 ] && admits 22 && says noports 'on ports []'" "$(out noports)"

arc_state 'azcmagent: something went wrong' 'true' '[22]'
run garbled
check "an agent whose show is not JSON keeps 22 open" "[ \"\$(rc garbled)\" -eq 0 ] && admits 22 && says garbled 'agent Unreadable'" "$(out garbled)"

arc_state '{"status":}' 'true' '[22]'
run malformed
check "so does one whose show looks like JSON and is not (CodeRabbit on #1258)" \
  "[ \"\$(rc malformed)\" -eq 0 ] && [ \"\$(recap malformed failed)\" -eq 0 ] && admits 22 && says malformed 'agent Unreadable'" "$(out malformed)"

arc_state '[1, 2]' 'true' '[22]'
run nostatus
check "and so does JSON without a status" "[ \"\$(rc nostatus)\" -eq 0 ] && admits 22 && says nostatus 'agent Unreadable'" "$(out nostatus)"

arc_ready
run onboarded
check "the first run with Arc SSH ready closes 22" \
  "[ \"\$(rc onboarded)\" -eq 0 ] && ! admits 22 && ! says onboarded '${waits}'" "$(out onboarded)"

run ungated -e hardening_ssh_arc_gate=false -e "hardening_arc_azcmagent_path=${work}/bin/no-azcmagent"
check "with the gate off, 22 is closed whatever the agent, and sshd stays on the loopback (the role's default)" \
  "[ \"\$(rc ungated)\" -eq 0 ] && [ \"\$(recap ungated changed)\" -eq 0 ] && ! admits 22 && says ungated '${loopback}'" "$(out ungated)"

arc_missing
run quoted -e '{"hardening_ufw_closed_tcp_ports": ["22"], "hardening_ufw_allowed_tcp_ports": ["80", "443"]}'
check "a port written as a string still goes through the gate" \
  "[ \"\$(rc quoted)\" -eq 0 ] && admits 22 && says quoted '${waits}'" "$(out quoted)"
arc_ready
run requoted -e '{"hardening_ufw_closed_tcp_ports": ["22"], "hardening_ufw_allowed_tcp_ports": ["80", "443"]}'
check "and is closed once Arc SSH is ready" "[ \"\$(rc requoted)\" -eq 0 ] && ! admits 22" "$(out requoted)"

# 6. Turning Arc SSH off (arc_incoming_ssh_enabled false): the hardening role
#    opens 22 before the arc role clears the agent's ports, and the arc role's
#    guard (roles/arc/tasks/ssh_off_guard.yml) refuses while ufw keeps 22
#    closed, as in a run narrowed to its tag.
# guard NAME [EXTRA_ARGS...]: run the arc role's guard alone, as Arc SSH is on.
guard() {
  local name="$1"
  shift
  set +e
  ANSIBLE_NOCOLOR=1 ANSIBLE_LOCALHOST_WARNING=0 ANSIBLE_INVENTORY_UNPARSED_WARNING=0 \
    ansible-playbook -i localhost, "${work}/guard.yml" -e arc_incoming_current=true -e '{"arc_ports_current": ["22"]}' "$@" \
    > "${work}/${name}.out" 2>&1
  echo $? > "${work}/${name}.rc"
  set -e
}
cat > "${work}/guard.yml" <<EOF
- name: Run the arc role's guard against a scratch ufw
  hosts: localhost
  connection: local
  gather_facts: false
  vars_files:
    - $(cd "${role}/.." && pwd)/arc/defaults/main.yml
  tasks:
    - name: The guard
      ansible.builtin.import_tasks: $(cd "${role}/.." && pwd)/arc/tasks/ssh_off_guard.yml
EOF
# A stand-in for sshd's listener on port 22, at the address given, so the
# guard's `ss` read sees what sshd would leave (#1257). With `ssh` it sends
# an SSH banner to each connection, as sshd does; without, it sends nothing.
cat > "${work}/listen.py" <<'EOF'
import socket, sys
family = socket.AF_INET6 if ":" in sys.argv[1] else socket.AF_INET
s = socket.socket(family, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
if family == socket.AF_INET6:
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
s.bind((sys.argv[1], 22))
s.listen(5)
while True:
    conn, _ = s.accept()
    if sys.argv[2:] == ["ssh"]:
        conn.sendall(b"SSH-2.0-OpenSSH_10.2p1 stand-in\r\n")
    conn.close()
EOF
# listen_on ADDRESS [ssh]: replace the stand-in with one on ADDRESS, and wait
# for it to listen, at most five seconds; a stand-in that cannot bind fails
# the test rather than hanging it (CodeRabbit on #1263).
listen_on() {
  if [ -n "${listener:-}" ]; then
    kill "${listener}" 2> /dev/null || true
    wait "${listener}" 2> /dev/null || true
  fi
  python3 "${work}/listen.py" "$@" > "${work}/listen.log" 2>&1 &
  listener=$!
  local tries=0
  until ss -Hltn 'sport = :22' | grep -q .; do
    tries=$((tries + 1))
    if ! kill -0 "${listener}" 2> /dev/null || [ "${tries}" -ge 50 ]; then
      not_ok "the stand-in listener on $1 did not start" "$(cat "${work}/listen.log")"
      echo "ufw-closed-ports.test.sh: stopped at a listener that did not start" >&2
      exit 1
    fi
    sleep 0.1
  done
}
listen_on 0.0.0.0 ssh
guard guard_closed -e arc_incoming_ssh_enabled=false
check "the arc role refuses to turn Arc SSH off while ufw keeps 22 closed" \
  "[ \"\$(rc guard_closed)\" -ne 0 ] && says guard_closed 'does not admit port 22 from Anywhere' && ! admits 22" "$(out guard_closed)"
ufw allow proto tcp from 192.0.2.5 to any port 22 > /dev/null
guard guard_source -e arc_incoming_ssh_enabled=false
check "and while 22 is allowed from one source only" \
  "[ \"\$(rc guard_source)\" -ne 0 ] && says guard_source 'does not admit port 22 from Anywhere'" "$(out guard_source)"
ufw delete allow proto tcp from 192.0.2.5 to any port 22 > /dev/null
printf '#!/bin/sh\necho "ERROR: problem running iptables" >&2\nexit 1\n' > "${work}/bin/ufw-broken"
chmod 0755 "${work}/bin/ufw-broken"
guard guard_broken -e arc_incoming_ssh_enabled=false -e "arc_ufw_path=${work}/bin/ufw-broken"
check "and while an installed ufw does not answer (CodeRabbit on #1261)" \
  "[ \"\$(rc guard_broken)\" -ne 0 ] && says guard_broken 'did not answer' && says guard_broken '(rc 1)'" "$(out guard_broken)"
guard guard_noufw -e arc_incoming_ssh_enabled=false -e "arc_ufw_path=${work}/bin/no-ufw"
check "but lets it with no ufw at all, which filters nothing" "[ \"\$(rc guard_noufw)\" -eq 0 ]" "$(out guard_noufw)"
guard guard_ssbroken -e arc_incoming_ssh_enabled=false -e "arc_ufw_path=${work}/bin/no-ufw" -e "arc_ss_path=${work}/bin/ufw-broken"
check "and refuses while ss does not answer" \
  "[ \"\$(rc guard_ssbroken)\" -ne 0 ] && says guard_ssbroken '\`ss\` did not answer (rc 1)'" "$(out guard_ssbroken)"
listen_on 127.0.0.1 ssh
guard guard_loopback -e arc_incoming_ssh_enabled=false -e "arc_ufw_path=${work}/bin/no-ufw"
check "and refuses, with nothing filtering 22, while sshd listens on the loopback alone (#1257)" \
  "[ \"\$(rc guard_loopback)\" -ne 0 ] && says guard_loopback 'sshd listens on the loopback alone'" "$(out guard_loopback)"
listen_on 0.0.0.0
guard guard_nobanner -e arc_incoming_ssh_enabled=false -e "arc_ufw_path=${work}/bin/no-ufw"
check "and while what listens on 22 beyond the loopback is not sshd (CodeRabbit on #1263)" \
  "[ \"\$(rc guard_nobanner)\" -ne 0 ] && says guard_nobanner 'sent no SSH banner'" "$(out guard_nobanner)"
listen_on :: ssh
run arcoff -e arc_incoming_ssh_enabled=false
check "a run that turns Arc SSH off opens 22 first, though Arc is ready, and says why" \
  "[ \"\$(rc arcoff)\" -eq 0 ] && admits 22 && says arcoff 'being turned off (arc_incoming_ssh_enabled is false)' && says arcoff 'with arc_incoming_ssh_enabled true again'" "$(out arcoff)"
guard guard_open -e arc_incoming_ssh_enabled=false
check "and then the arc role's guard lets it" "[ \"\$(rc guard_open)\" -eq 0 ]" "$(out guard_open)"
ufw insert 1 deny in on eth9 to any port 22 proto tcp > /dev/null
check "(the DENY is listed ahead of the allow)" "[ \"\$(ufw status | grep -m 1 -E '^22/tcp' | grep -c DENY)\" -eq 1 ]" "$(rules)"
guard guard_deny -e arc_incoming_ssh_enabled=false
check "but not with a DENY for 22 ahead of the allow, which ufw would match first (CodeRabbit on #1261)" \
  "[ \"\$(rc guard_deny)\" -ne 0 ] && says guard_deny 'has a DENY or REJECT rule for port 22'" "$(out guard_deny; rules)"
ufw delete deny in on eth9 to any port 22 proto tcp > /dev/null
guard guard_on
check "the guard reads nothing while Arc SSH stays on" \
  "[ \"\$(rc guard_on)\" -eq 0 ] && ! says guard_on 'would be left'" "$(out guard_on)"
run arcback
check "and with Arc SSH wanted again, the next run closes 22" "[ \"\$(rc arcback)\" -eq 0 ] && ! admits 22" "$(out arcback)"

# 7. A port in both lists stops the run before any rule changes.
before="$(rules)"
run both -e '{"hardening_ufw_allowed_tcp_ports": [22, 80, 443]}'
check "22 in both lists stops the run" \
  "[ \"\$(rc both)\" -ne 0 ] && says both '22 is in both hardening_ufw_allowed_tcp_ports and hardening_ufw_closed_tcp_ports'" "$(out both)"
check "before any rule changes" "[ \"\$(rules)\" = \"\${before}\" ]" "$(rules)"

if [ "${failed}" -gt 0 ]; then
  echo "ufw-closed-ports.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "ufw-closed-ports.test.sh: all ${passed} checks passed"
