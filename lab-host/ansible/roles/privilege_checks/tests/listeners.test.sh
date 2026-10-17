#!/usr/bin/env bash
# Runs ../tasks/listeners.yml (#958, LAB-12) with ansible-core against `ss`
# output read from a file instead of the kernel, and checks which listeners
# it refuses:
#
# - the lab host's own listeners as read on 2026-10-17
#   (ss-lab-host-2026-10-17.txt): refused for Caddy's UDP 443, the HTTP/3
#   listener #1233 turns off, and for nothing else; without that line, passed;
# - a TCP or UDP socket on 0.0.0.0, ::, * or a public address, on a port that
#   is not public, refused and named;
# - a public port over UDP refused, since only TCP 22, 80 and 443 may listen;
# - the loopback in every form ss prints (127.0.0.1, 127.0.0.53%lo, ::1,
#   ::ffff:127.0.0.1) passed;
# - no listener at all passed, and check mode refuses nothing.
#
# No root and no Docker; ansible-core on PATH. CI runs it in the
# `ansible-lint (lab-host)` job.
#
# Each check's condition is a single-quoted string that check() evaluates
# when it runs, so its expansions are meant to wait.
# shellcheck disable=SC2016
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"

passed=0
failed=0
# ok NAME: count and print a passing check, TAP style.
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
# not_ok NAME [DETAIL]: count and print a failing check, with its detail indented.
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
# check NAME CONDITION [DETAIL]: evaluate CONDITION and report it as ok or not ok.
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

command -v ansible-playbook > /dev/null || { echo "ansible-playbook is not on PATH; install ansible-core" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

cat > "${work}/play.yml" <<EOF
- name: Run the listener check against a fixture
  hosts: localhost
  connection: local
  gather_facts: false
  vars_files:
    - ${role}/defaults/main.yml
  tasks:
    - name: The listener check
      ansible.builtin.import_tasks: ${role}/tasks/listeners.yml
EOF

# A configuration of its own, so the run is the same from any directory.
cat > "${work}/ansible.cfg" <<'EOF'
[defaults]
stdout_callback = ansible.builtin.default
interpreter_python = auto_silent
retry_files_enabled = False
EOF
export ANSIBLE_CONFIG="${work}/ansible.cfg"

# run NAME FIXTURE [EXTRA_ARGS...]: run the check with ss's output read from
# FIXTURE and no published-port rules (a later -e gives some); the output goes
# to ${work}/NAME.out and the exit code to NAME.rc.
run() {
  local name="$1" fixture="$2"
  shift 2
  set +e
  ANSIBLE_NOCOLOR=1 ANSIBLE_LOCALHOST_WARNING=0 ANSIBLE_INVENTORY_UNPARSED_WARNING=0 \
    ansible-playbook -i localhost, "${work}/play.yml" \
    -e "{\"privilege_checks_listeners_argv\": [\"cat\", \"${fixture}\"]}" \
    -e '{"privilege_checks_dnat_argv": [["cat", "/dev/null"], ["cat", "/dev/null"]]}' \
    -e '{"privilege_checks_host": {"host_info": {"FirewallBackend": {"Driver": "iptables"}}}}' \
    "$@" > "${work}/${name}.out" 2>&1
  echo $? > "${work}/${name}.rc"
  set -e
}
# rc NAME: the exit code of run NAME.
rc() { cat "${work}/$1.rc"; }
# says NAME TEXT: true when run NAME printed TEXT.
says() { grep -qF -- "$2" "${work}/$1.out"; }
# fixture NAME LINE...: a file of ss lines, one per argument, in ${work}.
fixture() { local name="$1"; shift; printf '%s\n' "$@" > "${work}/${name}.ss"; echo "${work}/${name}.ss"; }

live="${here}/ss-lab-host-2026-10-17.txt"
run live "${live}"
check "the lab host as read on 2026-10-17 is refused" '[ "$(rc live)" -ne 0 ]' "$(tail -n 5 "${work}/live.out")"
check "for Caddy's UDP 443 (HTTP/3, which #1233 turns off), named" 'says live "udp *:443"'
# named NAME: the whole list the failure names, between "may: " and the
# ". Bind the service" that follows it; addresses carry periods of their own.
named() { sed -n 's/.*may: \(.*\)\. Bind the service.*/\1/p' "${work}/$1.out" | head -n 1; }
check "and for nothing else: Coder, Vault, Portainer, Arc and node_exporter are all on the loopback" \
  '[ "$(named live)" = "udp *:443" ]' "named: $(named live)"

grep -v -E '^udp +UNCONN +[0-9]+ +[0-9]+ +\*:443 ' "${live}" > "${work}/live-no-http3.ss"
run live-no-http3 "${work}/live-no-http3.ss"
check "without HTTP/3, the lab host passes" '[ "$(rc live-no-http3)" -eq 0 ]' "$(tail -n 5 "${work}/live-no-http3.out")"

run wildcard "$(fixture wildcard 'tcp LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*')"
check "TCP on 0.0.0.0 at a port that is not public is refused and named" \
  '[ "$(rc wildcard)" -ne 0 ] && says wildcard "tcp 0.0.0.0:8080"'

run v6any "$(fixture v6any 'tcp LISTEN 0 4096 [::]:5432 [::]:*')"
check "TCP on :: is refused and named" '[ "$(rc v6any)" -ne 0 ] && says v6any "tcp [::]:5432"'

run star "$(fixture star 'tcp LISTEN 0 4096 *:9443 *:*')"
check "TCP on * is refused and named" '[ "$(rc star)" -ne 0 ] && says star "tcp *:9443"'

run public "$(fixture public 'tcp LISTEN 0 4096 192.0.2.5:9000 0.0.0.0:*')"
check "TCP on a public address is refused and named" '[ "$(rc public)" -ne 0 ] && says public "tcp 192.0.2.5:9000"'

run twoudp "$(fixture twoudp 'udp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:*' 'udp UNCONN 0 0 127.0.0.1:323 0.0.0.0:*' 'udp UNCONN 0 0 *:443 *:*')"
check "every listener beyond the loopback is named, not the first alone" \
  '[ "$(rc twoudp)" -ne 0 ] && [ "$(named twoudp)" = "udp 0.0.0.0:5353, udp *:443" ]' "named: $(named twoudp)"

run udp22 "$(fixture udp22 'udp UNCONN 0 0 0.0.0.0:22 0.0.0.0:*')"
check "a public port over UDP is refused: only TCP may listen beyond the loopback" \
  '[ "$(rc udp22)" -ne 0 ] && says udp22 "udp 0.0.0.0:22"'

run fronts "$(fixture fronts \
  'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*' \
  'tcp LISTEN 0 4096 [::]:22 [::]:*' \
  'tcp LISTEN 0 4096 *:80 *:*' \
  'tcp LISTEN 0 4096 *:443 *:*')"
check "sshd and Caddy on TCP 22, 80 and 443 pass, on every address" '[ "$(rc fronts)" -eq 0 ]' "$(tail -n 5 "${work}/fronts.out")"

run loopback "$(fixture loopback \
  'tcp LISTEN 0 4096 127.0.0.1:7080 0.0.0.0:*' \
  'tcp LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*' \
  'udp UNCONN 0 0 127.0.0.54:53 0.0.0.0:*' \
  'tcp LISTEN 0 4096 [::1]:40342 [::]:*' \
  'tcp LISTEN 0 4096 [::ffff:127.0.0.1]:4317 *:*')"
check "the loopback passes in every form ss prints" '[ "$(rc loopback)" -eq 0 ]' "$(tail -n 5 "${work}/loopback.out")"

run none "$(fixture none)"
check "no listener at all passes" '[ "$(rc none)" -eq 0 ]' "$(tail -n 5 "${work}/none.out")"

run checkmode "$(fixture checkmode 'tcp LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*')" --check
check "check mode refuses nothing" '[ "$(rc checkmode)" -eq 0 ]' "$(tail -n 5 "${work}/checkmode.out")"

run port22closed "$(fixture port22closed 'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*')" -e '{"privilege_checks_public_tcp_ports": [80, 443]}'
check "with 22 off the public list (#953 stage 3), sshd on 0.0.0.0 is refused" \
  '[ "$(rc port22closed)" -ne 0 ] && says port22closed "tcp 0.0.0.0:22"'

# Published ports, from the rules that carry them (#1252 review).
# dnat NAME IPV4_FILE IPV6_FILE: run with no listeners and these DOCKER chains.
dnat() {
  run "$1" "$(fixture "$1-ss")" -e "{\"privilege_checks_dnat_argv\": [[\"cat\", \"$2\"], [\"cat\", \"$3\"]]}"
}
empty="$(fixture empty-chain)"
dnat dnat-live "${here}/dnat-lab-host-2026-10-17.txt" "${empty}"
check "the lab host's five published ports, every one on 127.0.0.1, pass" '[ "$(rc dnat-live)" -eq 0 ]' "$(tail -n 5 "${work}/dnat-live.out")"

dnat dnat-any "$(fixture dnat-any '-A DOCKER ! -i docker0 -p tcp -m tcp --dport 8080 -j DNAT --to-destination 172.17.0.3:8080')" "${empty}"
check "a port published on every address (no -d) is refused and named" \
  '[ "$(rc dnat-any)" -ne 0 ] && says dnat-any "--dport 8080 -j DNAT"'

dnat dnat-public "$(fixture dnat-public '-A DOCKER -d 192.0.2.5/32 ! -i docker0 -p tcp -m tcp --dport 8080 -j DNAT --to-destination 172.17.0.3:8080')" "${empty}"
check "a port published on a public address is refused" '[ "$(rc dnat-public)" -ne 0 ] && says dnat-public "-d 192.0.2.5/32"'

dnat dnat-v6 "${empty}" "$(fixture dnat-v6 \
  '-A DOCKER -d ::1/128 ! -i docker0 -p tcp -m tcp --dport 9443 -j DNAT --to-destination [fd00::2]:9443' \
  '-A DOCKER ! -i docker0 -p tcp -m tcp --dport 8443 -j DNAT --to-destination [fd00::3]:8443')"
check "IPv6: ::1 passes, and a port published on every address is refused alone" \
  '[ "$(rc dnat-v6)" -ne 0 ] && says dnat-v6 "--dport 8443" && ! says dnat-v6 "--dport 9443 -j DNAT"'

run dnat-nochain "$(fixture dnat-nochain-ss)" -e '{"privilege_checks_dnat_argv": [["sh", "-c", "echo iptables: No chain/target/match by that name. >&2; exit 1"], ["cat", "/dev/null"]]}'
check "a DOCKER chain that does not exist reads as no rules" '[ "$(rc dnat-nochain)" -eq 0 ]' "$(tail -n 5 "${work}/dnat-nochain.out")"

run dnat-denied "$(fixture dnat-denied-ss)" -e '{"privilege_checks_dnat_argv": [["cat", "/dev/null"], ["sh", "-c", "echo ip6tables v1.8.11 nf_tables: Could not fetch rule set generation id: Permission denied >&2; exit 4"]]}'
check "a table that cannot be read fails the run instead of passing as no rules" \
  '[ "$(rc dnat-denied)" -ne 0 ] && says dnat-denied "Permission denied"' "$(tail -n 5 "${work}/dnat-denied.out")"

# The published-port read covers Docker's iptables backend alone (#1253 review).
run backend-nft "$(fixture backend-nft-ss)" -e '{"privilege_checks_host": {"host_info": {"FirewallBackend": {"Driver": "nftables"}}}}'
check "a Docker on its nftables backend is refused: its publications would read as none" \
  '[ "$(rc backend-nft)" -ne 0 ] && says backend-nft "firewall backend '"'"'nftables'"'"'"' "$(tail -n 5 "${work}/backend-nft.out")"
run backend-none "$(fixture backend-none-ss)" -e '{"privilege_checks_host": {"host_info": {}}}'
check "and so is a daemon that reports no firewall backend at all" \
  '[ "$(rc backend-none)" -ne 0 ] && says backend-none "firewall backend '"''"'"' "$(tail -n 5 "${work}/backend-none.out")"

if [ "${failed}" -eq 0 ]; then
  echo "listeners.test.sh: all ${passed} checks passed"
else
  echo "listeners.test.sh: ${failed} failed, ${passed} passed" >&2
  exit 1
fi
