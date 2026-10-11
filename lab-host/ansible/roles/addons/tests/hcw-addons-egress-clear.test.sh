#!/usr/bin/env bash
# Tests ../files/hcw-addons-egress-clear, which the addons role installs as
# /usr/local/libexec/hcw-addons-egress-clear and runs around its rebuild of
# the add-ons' egress rules in DOCKER-USER: `guard` before the inserts, which
# holds a reject on the subnet and removes the role's rules in one
# transaction, and `unguard` after them. Its whole job is to read what
# iptables prints and act on it, so it runs here against real iptables, in a
# scratch chain of its own (never DOCKER-USER), holding rules written the way
# the role writes them, beside a rule with another comment, a rule whose
# comment only contains the role's, and Docker's uncommented RETURN.
#
# It covers the two failures of the inline pipeline it replaces (an empty
# chain failed the task under pipefail on the host, 2026-10-10; a quoted
# comment could not be deleted) and the property that pipeline lacked: the
# subnet is rejected from the moment the old rules go until the new ones are
# in, including when a run stops in between.
#
# Needs root and iptables. CI runs it in the `ansible-lint (lab-host)` job;
# on a Linux workstation, bash:
#   sudo bash lab-host/ansible/roles/addons/tests/hcw-addons-egress-clear.test.sh
#
# Each check's condition is a single-quoted string that check() evaluates
# when it runs, after the helper has acted, so its expansions are meant to
# wait, and the variables it reads (before, others) are read there.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="${here}/../files/hcw-addons-egress-clear"

passed=0
failed=0

# Records a passing check and prints it in TAP style.
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }

# Records a failing check and prints it, with an optional detail line, to stderr.
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }

# Passes check $1 when the condition string $2 holds; $3 is the detail on failure.
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

if [ "$(id -u)" -ne 0 ]; then
  echo "needs root: it writes a scratch iptables chain (sudo bash $0)" >&2
  exit 2
fi

chain="HCW-T$$"
comment="hcw-addons egress (roles/addons)"
guard_comment="${comment} rebuilding"
subnet=172.29.0.0/24
trap 'iptables -w -F "${chain}" 2>/dev/null || true; iptables -w -X "${chain}" 2>/dev/null || true' EXIT
iptables -w -N "${chain}"

# Prints the chain's rules as `iptables -S` lists them, without the -N line.
rules() { iptables -w -S "${chain}" | grep -v -e '^-N ' || true; }

# Counts the chain's rules whose comment is exactly $1.
count_with_comment() { rules | grep -c -F -e "--comment \"$1\"" || true; }

# Writes the role's rules as the role's tasks do, each inserted at the top:
# the reject first, then two allowed ranges, then the established return.
write_role_rules() {
  iptables -w -I "${chain}" -s "${subnet}" -m comment --comment "${comment}" -j REJECT --reject-with icmp-port-unreachable
  iptables -w -I "${chain}" -s "${subnet}" -d 173.245.48.0/20 -p tcp --dport 443 -m conntrack --ctstate NEW -m comment --comment "${comment}" -j RETURN
  iptables -w -I "${chain}" -s "${subnet}" -d 103.21.244.0/22 -p tcp --dport 443 -m conntrack --ctstate NEW -m comment --comment "${comment}" -j RETURN
  iptables -w -I "${chain}" -s "${subnet}" -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "${comment}" -j RETURN
}

# Runs the helper with the given arguments, setting $out and $rc.
run() { out="$(bash "${helper}" "$@" 2>&1)" && rc=0 || rc=$?; }

# 1. An empty chain, the host's first run: guard holds the reject, unguard lifts it.
run guard "${chain}" "${comment}" "${subnet}"
check "an empty chain: guard exits 0 and says it guarded" '[ "${rc}" -eq 0 ] && [ "${out}" = "guarded ${chain}: -s ${subnet} -m comment --comment \"${guard_comment}\" -j REJECT --reject-with icmp-port-unreachable" ]' "rc=${rc} output: ${out}"
check "the held reject is the chain's only rule" '[ "$(count_with_comment "${guard_comment}")" -eq 1 ] && [ "$(rules | wc -l)" -eq 1 ]' "left: $(rules)"
run unguard "${chain}" "${comment}"
check "unguard lifts it and the chain is empty again" '[ "${rc}" -eq 0 ] && [ -n "${out}" ] && [ -z "$(rules)" ]' "rc=${rc} output: ${out} left: $(rules)"
run unguard "${chain}" "${comment}"
check "unguard with nothing held exits 0 and prints nothing" '[ "${rc}" -eq 0 ] && [ -z "${out}" ]' "rc=${rc} output: ${out}"

# 2. The role's rules among others: guard removes exactly the role's, in one
#    transaction with the reject it holds, which goes to the top.
iptables -w -A "${chain}" -s 10.9.0.0/16 -m comment --comment "another role" -j RETURN
iptables -w -A "${chain}" -s 10.8.0.0/16 -m comment --comment "old ${comment}" -j RETURN
iptables -w -A "${chain}" -j RETURN
others="$(rules)"
write_role_rules
# The ufw block's first rule, as iptables-restore would add it on a boot that
# found the live rules already there: a duplicate is the role's as well.
iptables -w -A "${chain}" -s "${subnet}" -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "${comment}" -j RETURN
check "set-up wrote five of the role's rules" '[ "$(count_with_comment "${comment}")" -eq 5 ]' "rules: $(rules)"
run guard "${chain}" "${comment}" "${subnet}"
check "guard removes the role's five rules and holds one reject" '[ "${rc}" -eq 0 ] && [ "$(grep -c "^removed " <<<"${out}")" -eq 5 ] && [ "$(grep -c "^guarded " <<<"${out}")" -eq 1 ]' "rc=${rc} output: ${out}"
check "the held reject is first, and the other rules stay after it in order" '[ "$(rules | head -n 1 | grep -c -F -e "--comment \"${guard_comment}\"")" -eq 1 ] && [ "$(rules | tail -n +2)" = "${others}" ]' "left: $(rules)"

# 3. A run that stopped after guard and is run again: still one reject, nothing else.
before="$(rules)"
run guard "${chain}" "${comment}" "${subnet}"
check "guard again holds no second reject and changes nothing" '[ "${rc}" -eq 0 ] && [ -z "${out}" ] && [ "$(rules)" = "${before}" ]' "rc=${rc} output: ${out} left: $(rules)"

# 4. The role's inserts land above the held reject; unguard then lifts only it.
write_role_rules
run unguard "${chain}" "${comment}"
check "after the rebuild, unguard removes the held reject alone" '[ "${rc}" -eq 0 ] && [ "$(grep -c "^unguarded " <<<"${out}")" -eq 1 ] && [ "$(count_with_comment "${guard_comment}")" -eq 0 ] && [ "$(count_with_comment "${comment}")" -eq 4 ]' "rc=${rc} output: ${out} left: $(rules)"
check "the role's reject is below its returns and above the other rules" '[ "$(rules | sed -n 4p | grep -c -e "-j REJECT")" -eq 1 ] && [ "$(rules | tail -n +5)" = "${others}" ]' "left: $(rules)"

# 5. More than one held reject (two runs that each stopped): unguard lifts all.
iptables -w -I "${chain}" -s "${subnet}" -m comment --comment "${guard_comment}" -j REJECT --reject-with icmp-port-unreachable
iptables -w -I "${chain}" -s "${subnet}" -m comment --comment "${guard_comment}" -j REJECT --reject-with icmp-port-unreachable
run unguard "${chain}" "${comment}"
check "unguard lifts every held reject" '[ "${rc}" -eq 0 ] && [ "$(count_with_comment "${guard_comment}")" -eq 0 ] && [ "$(count_with_comment "${comment}")" -eq 4 ]' "rc=${rc} output: ${out} left: $(rules)"

# 6. A chain that does not exist fails, with iptables' own message.
run guard "${chain}-MISSING" "${comment}" "${subnet}"
check "a missing chain fails and says why" '[ "${rc}" -ne 0 ] && [ -n "${out}" ]' "rc=${rc} output: ${out}"

# 7. Input that could break out of the iptables-restore line is refused.
before="$(rules)"
run guard "${chain}" "${comment}" "${subnet} -j ACCEPT"
check "a subnet that is not a CIDR is refused" '[ "${rc}" -eq 2 ] && [ "$(rules)" = "${before}" ]' "rc=${rc} output: ${out}"
run guard "${chain}" "${comment}\" -j ACCEPT \"" "${subnet}"
check "a comment holding a quote is refused" '[ "${rc}" -eq 2 ] && [ "$(rules)" = "${before}" ]' "rc=${rc} output: ${out}"
run guard "${chain}" "hcw-addons-egress" "${subnet}"
check "a comment without a space is refused" '[ "${rc}" -eq 2 ]' "rc=${rc} output: ${out}"

echo "${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
