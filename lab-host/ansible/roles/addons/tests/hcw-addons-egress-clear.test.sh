#!/usr/bin/env bash
# Tests ../files/hcw-addons-egress-clear, which the addons role installs as
# /usr/local/libexec/hcw-addons-egress-clear and runs before it rebuilds the
# add-ons' egress rules in DOCKER-USER. Its whole job is to read what iptables
# prints and act on it, so it runs here against real iptables, in a scratch
# chain of its own (never DOCKER-USER), holding rules written the way the role
# writes them: the ansible.builtin.iptables inserts and the ufw block, with
# the role's comment, beside a rule with another comment, a rule whose comment
# only contains the role's, and Docker's uncommented RETURN.
#
# The cases are the two that broke the inline pipeline it replaces: an empty
# chain (grep found nothing and pipefail failed the task, lab host,
# 2026-10-10) and a chain holding the role's rules (`iptables -S` quotes the
# comment, and an unquoted re-read split it into three arguments).
#
# Needs root and iptables. CI runs it in the `ansible-lint (lab-host)` job;
# on a Linux workstation, bash:
#   sudo bash lab-host/ansible/roles/addons/tests/hcw-addons-egress-clear.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="${here}/../files/hcw-addons-egress-clear"

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  echo "needs root: it writes a scratch iptables chain (sudo bash $0)" >&2
  exit 2
fi

chain="HCW-T$$"
comment="hcw-addons egress (roles/addons)"
subnet=172.29.0.0/24
trap 'iptables -w -F "${chain}" 2>/dev/null || true; iptables -w -X "${chain}" 2>/dev/null || true' EXIT
iptables -w -N "${chain}"

# The chain's rules as `iptables -S` prints them, without the -N line.
rules() { iptables -w -S "${chain}" | grep -v -e '^-N ' || true; }

# What the role writes, in the role's insert order (each at the top).
write_role_rules() {
  iptables -w -I "${chain}" -s "${subnet}" -m comment --comment "${comment}" -j REJECT --reject-with icmp-port-unreachable
  iptables -w -I "${chain}" -s "${subnet}" -d 173.245.48.0/20 -p tcp --dport 443 -m conntrack --ctstate NEW -m comment --comment "${comment}" -j RETURN
  iptables -w -I "${chain}" -s "${subnet}" -d 103.21.244.0/22 -p tcp --dport 443 -m conntrack --ctstate NEW -m comment --comment "${comment}" -j RETURN
  iptables -w -I "${chain}" -s "${subnet}" -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "${comment}" -j RETURN
}

# 1. An empty chain: nothing to remove, exit 0, no output.
out="$(bash "${helper}" "${chain}" 2>&1)" && rc=0 || rc=$?
if [ "${rc}" -eq 0 ] && [ -z "${out}" ]; then
  ok "an empty chain exits 0 and prints nothing"
else
  not_ok "an empty chain exits 0 and prints nothing" "rc=${rc} output: ${out}"
fi

# 2. The role's rules among others: only the role's go, the rest keep their order.
iptables -w -A "${chain}" -s 10.9.0.0/16 -m comment --comment "another role" -j RETURN
iptables -w -A "${chain}" -s 10.8.0.0/16 -m comment --comment "old ${comment}" -j RETURN
iptables -w -A "${chain}" -j RETURN
others="$(rules)"
write_role_rules
# The ufw block's first rule, as iptables-restore would add it on a boot that
# found the live rules already there: a duplicate is the role's as well.
iptables -w -A "${chain}" -s "${subnet}" -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "${comment}" -j RETURN
role_count="$(rules | grep -c -F -e "--comment \"${comment}\"" || true)"
if [ "${role_count}" -ne 5 ]; then
  not_ok "set-up wrote five of the role's rules" "found ${role_count}: $(rules)"
fi
out="$(bash "${helper}" "${chain}" 2>&1)" && rc=0 || rc=$?
removed="$(grep -c '^removed ' <<<"${out}" || true)"
if [ "${rc}" -eq 0 ] && [ "${removed}" -eq 5 ]; then
  ok "the role's five rules are removed, one line each"
else
  not_ok "the role's five rules are removed, one line each" "rc=${rc} output: ${out}"
fi
if [ "$(rules)" = "${others}" ]; then
  ok "the other comment, the containing comment and Docker's RETURN stay, in order"
else
  not_ok "the other comment, the containing comment and Docker's RETURN stay, in order" "left: $(rules)"
fi

# 3. Again at once: nothing of the role's is left, so nothing is removed.
out="$(bash "${helper}" "${chain}" 2>&1)" && rc=0 || rc=$?
if [ "${rc}" -eq 0 ] && [ -z "${out}" ] && [ "$(rules)" = "${others}" ]; then
  ok "a second run removes nothing"
else
  not_ok "a second run removes nothing" "rc=${rc} output: ${out}"
fi

# 4. A chain that does not exist fails, with iptables' own message.
out="$(bash "${helper}" "${chain}-MISSING" 2>&1)" && rc=0 || rc=$?
if [ "${rc}" -ne 0 ] && [ -n "${out}" ]; then
  ok "a missing chain fails and says why"
else
  not_ok "a missing chain fails and says why" "rc=${rc} output: ${out}"
fi

echo "${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
