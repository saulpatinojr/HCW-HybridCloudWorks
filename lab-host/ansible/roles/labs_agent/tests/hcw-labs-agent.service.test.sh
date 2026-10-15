#!/usr/bin/env bash
# Tests ../templates/hcw-labs-agent.service.j2 and ../templates/labs-agent.env.j2
# (LAB-13, #959), rendered with the values the role really uses: its
# defaults, the labs_agent_* pins from group_vars/all.yml, then its vars,
# Ansible's precedence order, with each templated value resolved against the
# others the way Ansible resolves them lazily.
#
# What it holds: SIGTERM goes to the agent alone (KillMode=mixed, and the
# main process is node itself, not a shell that would swallow the signal),
# the stop timeout is the 30 s that covers the agent's shutdown budget and
# its two heartbeats (scripts/lab-job-limits.test.mjs holds that sum), the
# env file carries that budget, the unit keeps its failure notifier and its
# Docker dependency, and it sweeps orphaned job containers as root before
# the agent starts and after it exits (files/hcw-labjob-sweep, which
# tests/hcw-labjob-sweep.test.sh tests on its own). Before #959's fix the unit left KillMode at
# control-group, so systemd signalled the docker CLI with the agent, and no
# test rendered the unit at all.
#
# Needs no root and no Docker: bash and a Python with Jinja2 and PyYAML. CI
# runs it in the `ansible-lint (lab-host)` job with the job's Python, which
# has both from ansible-core; on a workstation, bash:
#   bash lab-host/ansible/roles/labs_agent/tests/hcw-labs-agent.service.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"
group_vars="$(cd "${role}/../../group_vars" && pwd)/all.yml"

passed=0
failed=0
# ok NAME: count and print a passing check, TAP style.
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
# not_ok NAME [DETAIL]: count and print a failing check, with its detail indented.
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
# check NAME COMMAND [DETAIL]: run COMMAND through eval and report it as ok or not ok.
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

python=''
for candidate in python3 python; do
  if command -v "${candidate}" > /dev/null && "${candidate}" -c 'import jinja2, yaml' 2> /dev/null; then
    python="$(command -v "${candidate}")"
    break
  fi
done
[ -n "${python}" ] || { echo "no Python with jinja2 and yaml on PATH; install ansible-core" >&2; exit 1; }

work="$(mktemp -d)"
finish() { rm -rf "${work}"; }
trap finish EXIT

# render TEMPLATE: the template rendered with the role's values on stdout.
# StrictUndefined, so a variable the role does not set fails the render
# rather than printing empty; a value that needs Ansible itself (a lookup,
# the hash filter) is left as written, and the check below that no template
# syntax survives catches it if a template uses one.
render() {
  "${python}" - "$1" "${role}/defaults/main.yml" "${group_vars}" "${role}/vars/main.yml" <<'PY'
import sys, jinja2, yaml
template, defaults, group_vars, role_vars = sys.argv[1:5]
load = lambda path: yaml.safe_load(open(path, encoding="utf-8")) or {}
values = dict(load(defaults))
values.update({k: v for k, v in load(group_vars).items() if k.startswith("labs_agent_")})
values.update(load(role_vars))
values["ansible_managed"] = "Ansible managed"
env = jinja2.Environment(undefined=jinja2.StrictUndefined, trim_blocks=True, keep_trailing_newline=True)
for _ in range(10):
    changed = False
    for key, value in list(values.items()):
        if isinstance(value, str) and ("{{" in value or "{%" in value):
            try:
                resolved = env.from_string(value).render(**values)
            except Exception:
                continue
            if resolved != value:
                values[key], changed = resolved, True
    if not changed:
        break
sys.stdout.write(env.from_string(open(template, encoding="utf-8").read()).render(**values))
PY
}

unit="${work}/hcw-labs-agent.service"
envfile="${work}/labs-agent.env"
render "${role}/templates/hcw-labs-agent.service.j2" > "${unit}"
render "${role}/templates/labs-agent.env.j2" > "${envfile}"

shutdown_ms="$(sed -n 's/^labs_agent_shutdown_timeout_ms: \([0-9][0-9]*\)$/\1/p' "${role}/defaults/main.yml")"

check "the unit render holds no template syntax" "! grep -qE '\{\{|\{%' '${unit}'"
check "the env render holds no template syntax" "! grep -qE '\{\{|\{%' '${envfile}'"
check "SIGTERM goes to the main process alone (KillMode=mixed), set once" \
  "[ \"\$(grep -c '^KillMode=' '${unit}')\" -eq 1 ] && grep -qxF 'KillMode=mixed' '${unit}'"
check "the main process is node itself, so the signal reaches the agent and not a shell" \
  "grep -qxF 'ExecStart=/usr/bin/node index.js' '${unit}'"
check "the stop timeout is 30 s, set once" \
  "[ \"\$(grep -c '^TimeoutStopSec=' '${unit}')\" -eq 1 ] && grep -qxF 'TimeoutStopSec=30' '${unit}'"
check "no TimeoutSec= line overrides the stop timeout" "! grep -q '^TimeoutSec=' '${unit}'"
check "a failure still reaches the notifier" "grep -qxF 'OnFailure=hcw-unit-failed@%n.service' '${unit}'"
check "the unit still requires Docker" "grep -qxF 'Requires=docker.service' '${unit}'"
check "the role's defaults name a shutdown budget" "[ -n '${shutdown_ms}' ]"
check "the env file carries the shutdown budget from the role's defaults" \
  "grep -qxF 'LABS_AGENT_SHUTDOWN_TIMEOUT_MS=${shutdown_ms}' '${envfile}'"
check "the role installs both templates" \
  "grep -qF 'src: hcw-labs-agent.service.j2' '${role}/tasks/main.yml' && grep -qF 'src: labs-agent.env.j2' '${role}/tasks/main.yml'"
check "orphaned job containers are swept as root before the agent starts" \
  "grep -qxF 'ExecStartPre=+/usr/local/libexec/hcw-labjob-sweep' '${unit}'"
check "and again after it exits, for a stop and a crash alike" \
  "grep -qxF 'ExecStopPost=+/usr/local/libexec/hcw-labjob-sweep' '${unit}'"
sweep_at="$(grep -nF 'dest: /usr/local/libexec/hcw-labjob-sweep' "${role}/tasks/main.yml" | cut -d: -f1)"
unit_at="$(grep -nF 'src: hcw-labs-agent.service.j2' "${role}/tasks/main.yml" | cut -d: -f1)"
check "the role installs the sweep the unit names, before the unit" \
  "[ -f '${role}/files/hcw-labjob-sweep' ] && [ -n '${sweep_at}' ] && [ -n '${unit_at}' ] && [ '${sweep_at}' -lt '${unit_at}' ]"

echo "# ${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
