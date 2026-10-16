#!/usr/bin/env bash
# Coder's GitHub sign-in policy (#954), as the coder role renders and checks
# it, with ansible-core's own modules:
#
# 1. ../templates/coder.env.j2, rendered by the template module from
#    group_vars/all.yml and this role's defaults and vars (the three vault
#    secrets are placeholders), carries exactly one
#    CODER_OAUTH2_GITHUB_ALLOWED_ORGS, CODER_OAUTH2_GITHUB_ALLOWED_TEAMS and
#    CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS line, with the owner's 2026-10-16
#    values: HybridCloudWorks, HybridCloudWorks/lab-learners and false.
# 2. ../tasks/signin_policy.yml, run on its own, passes group_vars'
#    allowlists and refuses each bad one with a message naming it: an empty
#    team list, a team whose organisation is not in the organisation list
#    (including one that differs only in case, because Coder compares the
#    names exactly), a team with no organisation or a second slash, and an
#    empty organisation list. With Coder disabled it checks nothing.
# 3. Every owner line in docs/runbooks/labs-host.md and lab-host/README.md
#    that pipes a token into Coder's CLI strips the carriage return with a
#    doubled backslash, and the runbook's lines that add and suspend a
#    learner are there.
#
# No root and no Docker; ansible-core on PATH. CI runs it in the
# `ansible-lint (lab-host)` job; lab-host/README.md ("Validating without a
# host") has the container line.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"
ansible="$(cd "${here}/../../.." && pwd)"

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

command -v ansible > /dev/null || { echo "ansible is not on PATH; install ansible-core" >&2; exit 1; }
command -v ansible-playbook > /dev/null || { echo "ansible-playbook is not on PATH; install ansible-core" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# group_vars/all.yml, the role's defaults and its vars, as extra vars so they
# apply the same way to the ad-hoc render and to the scratch playbook, whose
# directory has no group_vars of its own. A later -e wins over an earlier one.
common=(-e ansible_become=false -e @group_vars/all.yml -e @roles/coder/defaults/main.yml -e @roles/coder/vars/main.yml)

# 1. The environment file, rendered as the role renders it.
env_file="${work}/coder.env"
if (cd "${ansible}" && ansible localhost -c local "${common[@]}" -m ansible.builtin.template \
  -a "src=roles/coder/templates/coder.env.j2 dest=${env_file}" \
  -e vault_coder_oauth2_github_client_id=placeholder-client-id \
  -e vault_coder_oauth2_github_client_secret=placeholder-client-secret \
  -e vault_coder_postgres_password=placeholder) > "${work}/render.log" 2>&1; then
  ok "coder.env.j2 renders with group_vars and the role's defaults"
else
  not_ok "coder.env.j2 renders with group_vars and the role's defaults" "$(cat "${work}/render.log")"
  echo "coder-signin.test.sh: cannot go on without the rendered file" >&2
  exit 1
fi

line_count() { grep -c "^$1=" "${env_file}" || true; }
for name in CODER_OAUTH2_GITHUB_ALLOWED_ORGS CODER_OAUTH2_GITHUB_ALLOWED_TEAMS CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS; do
  check "coder.env sets ${name} exactly once" "[ \"\$(line_count ${name})\" = 1 ]" "$(grep -n '^CODER_OAUTH2_' "${env_file}" | sed 's/CLIENT_SECRET=.*/CLIENT_SECRET=(hidden)/')"
done
check "only members of HybridCloudWorks pass the organisation check" \
  "grep -qx 'CODER_OAUTH2_GITHUB_ALLOWED_ORGS=HybridCloudWorks' \"${env_file}\""
check "and of those, only the lab-learners team signs in" \
  "grep -qx 'CODER_OAUTH2_GITHUB_ALLOWED_TEAMS=HybridCloudWorks/lab-learners' \"${env_file}\""
check "sign-ups are off: an account is created by the owner, never by a first sign-in" \
  "grep -qx 'CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS=false' \"${env_file}\""
check "nothing lets every GitHub account in" \
  "! grep -q '^CODER_OAUTH2_GITHUB_ALLOW_EVERYONE=' \"${env_file}\""

# 2. The policy checks, on their own, against good and bad allowlists.
cat > "${work}/policy.yml" <<YAML
---
- name: Coder sign-in policy
  hosts: localhost
  connection: local
  gather_facts: false
  tasks:
    - name: Check the GitHub sign-in allowlists
      ansible.builtin.import_tasks: ${role}/tasks/signin_policy.yml
YAML

# policy NAME OVERRIDES: runs the checks with OVERRIDES (JSON extra vars, or
# '{}' for group_vars as they are) and leaves rc and output in ${work}/NAME.
policy() {
  local rc=0
  (cd "${ansible}" && ansible-playbook "${work}/policy.yml" "${common[@]}" -e "$2") > "${work}/$1.out" 2>&1 || rc=$?
  echo "${rc}" > "${work}/$1.rc"
}
rc_of() { cat "${work}/$1.rc"; }
said() { grep -qF -- "$2" "${work}/$1.out"; }

policy as_merged '{}'
check "group_vars' allowlists pass" "[ \"\$(rc_of as_merged)\" = 0 ]" "$(tail -n 30 "${work}/as_merged.out")"
check "and every check ran" "grep -qE 'ok=3 +changed=0 +unreachable=0 +failed=0 +skipped=0' \"${work}/as_merged.out\"" "$(tail -n 5 "${work}/as_merged.out")"

policy disabled '{"coder_enabled": false, "coder_oauth2_github_allowed_orgs": [], "coder_oauth2_github_allowed_teams": []}'
check "with Coder disabled nothing is checked" \
  "[ \"\$(rc_of disabled)\" = 0 ] && grep -qE 'ok=0 +changed=0 +unreachable=0 +failed=0 +skipped=3' \"${work}/disabled.out\"" "$(tail -n 30 "${work}/disabled.out")"

# refused KEY WHAT OVERRIDES MESSAGE: the run fails, saying MESSAGE.
refused() {
  policy "$1" "$3"
  check "refuses $2" "[ \"\$(rc_of $1)\" != 0 ] && said $1 '$4'" "$(tail -n 30 "${work}/$1.out")"
}
refused no_teams 'an empty team list' \
  '{"coder_oauth2_github_allowed_teams": []}' \
  'coder_oauth2_github_allowed_teams is empty'
refused other_org 'a team in an organisation that is not allowed' \
  '{"coder_oauth2_github_allowed_teams": ["OtherOrg/lab-learners"]}' \
  'coder_oauth2_github_allowed_teams has OtherOrg/lab-learners'
refused case_only 'a team whose organisation differs from the allowed one only in case' \
  '{"coder_oauth2_github_allowed_teams": ["hybridcloudworks/lab-learners"]}' \
  'coder_oauth2_github_allowed_teams has hybridcloudworks/lab-learners'
refused one_bad 'a bad team beside a good one' \
  '{"coder_oauth2_github_allowed_teams": ["HybridCloudWorks/lab-learners", "OtherOrg/admins"]}' \
  'coder_oauth2_github_allowed_teams has OtherOrg/admins'
refused no_org 'a team slug with no organisation' \
  '{"coder_oauth2_github_allowed_teams": ["lab-learners"]}' \
  'coder_oauth2_github_allowed_teams has lab-learners'
refused two_slashes 'a team with a second slash' \
  '{"coder_oauth2_github_allowed_teams": ["HybridCloudWorks/lab/learners"]}' \
  'coder_oauth2_github_allowed_teams has HybridCloudWorks/lab/learners'
refused no_orgs 'an empty organisation list' \
  '{"coder_oauth2_github_allowed_orgs": []}' \
  'coder_oauth2_github_allowed_orgs is empty'

policy two_orgs '{"coder_oauth2_github_allowed_orgs": ["HybridCloudWorks", "OtherOrg"], "coder_oauth2_github_allowed_teams": ["HybridCloudWorks/lab-learners", "OtherOrg/lab-learners"]}'
check "a team in a second allowed organisation passes" "[ \"\$(rc_of two_orgs)\" = 0 ]" "$(tail -n 30 "${work}/two_orgs.out")"

# 3. The owner's lines that hand a token to Coder's CLI. Each pipes it into
#    `coder sh -c '... tr -d \\r | { read -r CODER_SESSION_TOKEN; ...'`:
#    PowerShell passes the line as written, the host's shell keeps the single
#    quotes' contents, and the container's sh turns the unquoted \\r into \r,
#    which tr reads as a carriage return. With one backslash sh leaves a bare
#    r, so tr deletes every lowercase r from the token and keeps the carriage
#    return (the 2026-10-16 review of #954). Read from the repository's
#    checkout; a copy of lab-host/ alone has no docs/ and skips.
repo="$(cd "${ansible}/../.." && pwd)"
runbook="${repo}/docs/runbooks/labs-host.md"
any_tr="sh -c 'tr -d "
good_tr='tr -d \\r | { read -r CODER_SESSION_TOKEN;'
for name in docs/runbooks/labs-host.md lab-host/README.md; do
  doc="${repo}/${name}"
  if [ ! -f "${doc}" ]; then
    echo "skip - ${name} is not beside lab-host/ansible in this copy"
    continue
  fi
  all="$(grep -cF -- "${any_tr}" "${doc}" || true)"
  doubled="$(grep -F -- "${any_tr}" "${doc}" | grep -cF -- "${good_tr}" || true)"
  check "every token line in ${name} strips \\r with a doubled backslash (${doubled} of ${all})" \
    "[ \"${all}\" -gt 0 ] && [ \"${all}\" = \"${doubled}\" ]" \
    "$(grep -nF -- "${any_tr}" "${doc}" | grep -vF -- "${good_tr}" | cut -c1-160)"
done
if [ -f "${runbook}" ]; then
  check "the runbook creates a learner's account with the GitHub login type" \
    "grep -F -- \"\${good_tr}\" \"${runbook}\" | grep -qF -- 'coder users create --username \$login --email \$email --login-type github'"
  check "and suspends one, answering the CLI's confirmation" \
    "grep -F -- \"\${good_tr}\" \"${runbook}\" | grep -qF -- 'echo yes | coder users suspend \$login'"
fi

if [ "${failed}" -gt 0 ]; then
  echo "coder-signin.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "coder-signin.test.sh: all ${passed} checks passed"
