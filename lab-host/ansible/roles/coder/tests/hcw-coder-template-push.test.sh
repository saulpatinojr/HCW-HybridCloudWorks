#!/usr/bin/env bash
# Tests ../templates/hcw-coder-template-push.j2, the helper this role renders
# to /usr/local/sbin/hcw-coder-template-push, by rendering it with the role's
# own defaults and running it against a stub `docker`. The stub answers only
# the four `docker exec` shapes the helper uses, against a scratch directory
# standing in for the coder container's filesystem, and runs the helper's
# in-container script with a fake `coder` that records what it was asked and
# with which token.
#
# No root and no Docker needed. CI runs it in the `ansible-lint (lab-host)`
# job with the job's Python, which has Jinja2 and PyYAML from ansible-core;
# lab-host/README.md ("Validating without a host") has the container line.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"
lab_host="$(cd "${here}/../../../.." && pwd)"
template="${role}/templates/hcw-coder-template-push.j2"
defaults="${role}/defaults/main.yml"
tasks="${role}/tasks/main.yml"
compose="${lab_host}/coder/docker-compose.yml"
bootstrap="${lab_host}/bootstrap.sh"
readme="${lab_host}/README.md"

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
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
cd "${work}"

# render OUT [NAME=VALUE]: the template rendered as the template module does
# (trim_blocks), from defaults/main.yml with any NAME=VALUE on top. An
# undefined name fails the render.
render() {
  "${python}" - "${template}" "${defaults}" "${@:2}" > "$1" <<'PY'
import sys, jinja2, yaml
template, defaults, overrides = sys.argv[1], sys.argv[2], sys.argv[3:]
values = yaml.safe_load(open(defaults, encoding="utf-8"))
values.update(item.split("=", 1) for item in overrides)
env = jinja2.Environment(undefined=jinja2.StrictUndefined, trim_blocks=True, keep_trailing_newline=True)
sys.stdout.write(env.from_string(open(template, encoding="utf-8").read()).render(**values))
PY
}
helper="${work}/hcw-coder-template-push"
render "${helper}"
ttl="$(sed -n 's/^coder_template_default_ttl: //p' "${defaults}")"

# --- What the helper names is what the rest of the repository says.
check "the role's default autostop is whole hours" "[[ '${ttl}' =~ ^[1-9][0-9]*h\$ ]]" "'${ttl}'"
check "the helper is rendered with the role's default autostop" "grep -qx \"default_ttl='${ttl}'\" '${helper}'"
# Not `{#`: bash's ${#name} is a length, and the raw block is why it can stay.
check "the rendered helper parses as bash and holds no template syntax" \
  "bash -n '${helper}' && ! grep -qE '\\{\\{|\\{%|raw %' '${helper}'"
check "the helper reads the checkout at /opt/hcw-src unless HCW_SRC_DIR says otherwise" \
  "grep -qxF 'src=\"\${HCW_SRC_DIR:-/opt/hcw-src}\"' '${helper}'"
check "bootstrap.sh keeps the playbook's checkout at /opt/hcw-src" \
  "grep -qxF 'HCW_SRC_DIR=\"\${HCW_SRC_DIR:-/opt/hcw-src}\"' '${bootstrap}'"
check "the helper's container is the Compose file's container_name" \
  "grep -qx 'container=coder' '${helper}' && grep -qx '    container_name: coder' '${compose}'"
check "the helper's Coder URL is the port Coder listens on inside its container" \
  "grep -qx 'coder_url=http://127.0.0.1:7080' '${helper}' && grep -qx '      CODER_HTTP_ADDRESS: \"0.0.0.0:7080\"' '${compose}'"
check "the owner's line in lab-host/README.md runs the installed path" \
  "grep -qxF '\$t | ssh hcw-lab \"sudo -n /usr/local/sbin/hcw-coder-template-push\"' '${readme}'"
installed="$("${python}" - "${tasks}" <<'PY'
import sys, yaml
for task in yaml.safe_load(open(sys.argv[1], encoding="utf-8")):
    module = task.get("ansible.builtin.template") or {}
    if module.get("src") == "hcw-coder-template-push.j2":
        print(module.get("dest"), module.get("owner"), module.get("group"), module.get("mode"), "when" in task)
PY
)"
check "the role installs it as /usr/local/sbin/hcw-coder-template-push, root:root 0750, unconditionally" \
  "[ '${installed}' = '/usr/local/sbin/hcw-coder-template-push root root 0750 False' ]" "${installed}"

# --- The stub docker, the fake coder, and the container's filesystem.
mkdir -p "${work}/bin" "${work}/container-bin"
export STUB_ROOT="${work}/container"
export STUB_STATE="${work}/state"
export STUB_LOG="${work}/docker-argv"
export STUB_CONTAINER_PATH="${work}/container-bin:/usr/bin:/bin"
mkdir -p "${STUB_ROOT}/tmp"

cat > "${work}/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Only `docker exec [-i] [-e NAME=VALUE]... coder <one of four commands>`.
set -euo pipefail
printf 'docker %s\n' "$*" >> "${STUB_LOG}"
[ "${1:-}" = exec ] || { echo "stub docker: unexpected command: $*" >&2; exit 99; }
shift
interactive=0
envs=()
while [ $# -gt 0 ]; do
  case "$1" in
    -i) interactive=1; shift ;;
    -e) envs+=("$2"); shift 2 ;;
    -*) echo "stub docker: unexpected option $1" >&2; exit 99 ;;
    *) break ;;
  esac
done
container="$1"; shift
if [ -n "${STUB_NO_CONTAINER:-}" ] || [ "${container}" != coder ]; then
  echo "Error response from daemon: No such container: ${container}" >&2
  exit 1
fi
if [ "$#" -eq 3 ] && [ "$1 $2 $3" = "mktemp -d /tmp/hcw-lab.XXXXXX" ]; then
  made="$(mktemp -d "${STUB_ROOT}/tmp/hcw-lab.XXXXXX")"
  printf '%s\n' "${made#"${STUB_ROOT}"}" | tee -a "${STUB_STATE}/made"
elif [ "$#" -eq 5 ] && [ "$1 $2 $3 $4" = "tar -xf - -C" ] && [ "${interactive}" = 1 ]; then
  exec tar -xf - -C "${STUB_ROOT}$5"
elif [ "$#" -eq 4 ] && [ "$1 $2 $3" = "rm -rf --" ]; then
  printf '%s\n' "$4" >> "${STUB_STATE}/removed"
  if [ -n "${STUB_RM_FAILS:-}" ]; then echo "rm: can't remove '$4': Permission denied" >&2; exit 1; fi
  exec rm -rf -- "${STUB_ROOT}$4"
elif [ "$#" -ge 3 ] && [ "$1 $2" = "sh -c" ] && [ "${interactive}" = 1 ]; then
  # The container sees only what -e passed, plus the stub's own plumbing.
  exec env -i PATH="${STUB_CONTAINER_PATH}" STUB_ROOT="${STUB_ROOT}" STUB_STATE="${STUB_STATE}" \
    FAKE_CODER_MODE="${FAKE_CODER_MODE:-}" "${envs[@]}" "$@"
else
  echo "stub docker: unexpected exec: $*" >&2
  exit 99
fi
STUB

cat > "${work}/container-bin/coder" <<'FAKE'
#!/usr/bin/env bash
# The four commands the helper's script runs, answered the way Coder v2.37.3's
# CLI does (cli/templatepush.go, templateedit.go, templateversions.go,
# templatelist.go), with FAKE_CODER_MODE for the failures.
set -euo pipefail
state="${STUB_STATE}"
printf 'coder %s\n' "$*" >> "${state}/coder-argv"
printf '%s\n' "${CODER_SESSION_TOKEN-<unset>}" >> "${state}/coder-token"
printf '%s\n' "${CODER_URL-<unset>} ${NO_COLOR-<unset>}" >> "${state}/coder-env"
if [ "${CODER_SESSION_TOKEN-}" != "$(cat "${state}/accepted-token")" ]; then
  echo "error: You are signed out or your session has expired. Please sign in again to continue." >&2
  exit 1
fi
mode="${FAKE_CODER_MODE}"
unexpected() { echo "fake coder: unexpected coder $*" >&2; exit 97; }
case "${1:-} ${2:-}" in
  "templates push")
    [ "$#" -eq 6 ] && [ "$4" = --directory ] && [ "$6" = --yes ] || unexpected "$@"
    if [ "${mode}" = push-fails ]; then echo "error: template import provisioning failed" >&2; exit 1; fi
    (cd "${STUB_ROOT}$5" && ls -A | LC_ALL=C sort) > "${state}/pushed-files"
    printf '%s\n' "$5" > "${state}/pushed-dir"
    printf '%s\n' "$3" > "${state}/pushed-name"
    echo "Updated version at Sep 28 12:00:00!"
    ;;
  "templates edit")
    [ "$#" -eq 6 ] && [ "$4" = --default-ttl ] && [ "$6" = --yes ] || unexpected "$@"
    if [ "${mode}" = edit-fails ]; then echo "error: update template metadata: forbidden" >&2; exit 1; fi
    printf '%s\n' "$5" > "${state}/ttl"
    echo "Updated template metadata at Sep 28 12:00:01!"
    ;;
  "templates versions")
    [ "$#" -eq 6 ] && [ "$3" = list ] && [ "$5" = --column ] && [ "$6" = name,active ] || unexpected "$@"
    active=Active
    if [ "${mode}" = coloured ]; then active=$'\033[1mActive\033[0m'; fi
    printf 'NAME              ACTIVE\n'
    printf 'brave_turing7     \n'
    if [ "${mode}" != no-active ]; then printf 'vigilant_hopper1  %s\n' "${active}"; fi
    ;;
  "templates list")
    [ "$#" -eq 4 ] && [ "$3" = --column ] && [ "$4" = "name,default ttl" ] || unexpected "$@"
    reported="$(cat "${state}/ttl")"
    if [ "${mode}" = ttl-differs ]; then reported=2h; fi
    printf 'NAME     DEFAULT TTL\n'
    printf '%s  %s0m0s\n' "$(cat "${state}/pushed-name")" "${reported}"
    ;;
  *) unexpected "$@" ;;
esac
FAKE
chmod +x "${work}/bin/docker" "${work}/container-bin/coder"
export PATH="${work}/bin:${PATH}"

# The checkout: this repository's lab-host, under a scratch HCW_SRC_DIR,
# because the container line in lab-host/README.md mounts lab-host alone.
export HCW_SRC_DIR="${work}/src"
mkdir -p "${HCW_SRC_DIR}"
ln -s "${lab_host}" "${HCW_SRC_DIR}/lab-host"
template_dir="${HCW_SRC_DIR}/lab-host/coder/templates/hcw-lab"

TOKEN='AbCdE12345-abcdefghijKLMNOPQRST12'
out="${work}/out"
err="${work}/err"
# publish STDIN [ACCEPTED_TOKEN] [HELPER_ARGS...]: pipes STDIN (printf %b) into
# the helper with a fresh stub state; returns the helper's exit code.
publish() {
  local rc=0
  rm -rf "${STUB_STATE}"
  mkdir -p "${STUB_STATE}"
  : > "${STUB_LOG}"
  printf '%s\n' "${2:-${TOKEN}}" > "${STUB_STATE}/accepted-token"
  printf '%b' "$1" | bash "${helper}" "${@:3}" > "${out}" 2> "${err}" || rc=$?
  return "${rc}"
}
rc_of() { local rc=0; "$@" || rc=$?; echo "${rc}"; }
said() { printf 'rc=%s\n--- stdout\n%s\n--- stderr\n%s' "${rc}" "$(cat "${out}")" "$(cat "${err}")"; }
leftovers() { find "${STUB_ROOT}/tmp" -mindepth 1 | head -5; }
state() { cat "${STUB_STATE}/$1" 2> /dev/null || true; }

# --- A publish, with the token as a Windows clipboard can send it.
rc="$(rc_of publish "\xef\xbb\xbf ${TOKEN} \r\nthe second line is never read\n")"
check "a publish exits 0" "[ '${rc}' = 0 ]" "$(said)"
made="$(state made)"
check "it ends with the version Coder calls active and the autostop Coder reports" \
  "[ \"\$(tail -n 1 '${out}')\" = 'hcw-coder-template-push: published hcw-lab from ${template_dir}. Active version: vigilant_hopper1. Default autostop: ${ttl}0m0s.' ]" "$(said)"
check "it says what it copies, and where" \
  "grep -qxF 'hcw-coder-template-push: copying main.tf .terraform.lock.hcl README.md from ${template_dir} to ${made} in the coder container' '${out}'" "$(said)"
check "Coder receives main.tf, the lock file and the README, and not the test beside them" \
  "[ \"\$(state pushed-files | tr '\n' ' ')\" = '.terraform.lock.hcl README.md main.tf ' ]" "$(state pushed-files)"
check "it runs push, edit and the two read-backs, in that order, with nothing else" \
  "[ \"\$(state coder-argv)\" = \"\$(printf '%s\n' 'coder templates push hcw-lab --directory ${made} --yes' 'coder templates edit hcw-lab --default-ttl ${ttl} --yes' 'coder templates versions list hcw-lab --column name,active' 'coder templates list --column name,default ttl')\" ]" \
  "$(state coder-argv)"
check "every coder command gets the token, byte order mark, blanks and carriage return removed" \
  "[ \"\$(state coder-token | sort -u)\" = '${TOKEN}' ] && [ \"\$(state coder-token | wc -l)\" -eq 4 ]" "$(state coder-token)"
check "every coder command talks to Coder inside its container, with colour off" \
  "[ \"\$(state coder-env | sort -u)\" = 'http://127.0.0.1:7080 1' ]" "$(state coder-env)"
check "the token is in no docker argument" "! grep -qF '${TOKEN}' '${STUB_LOG}'"
check "the token is in no coder argument" "! grep -qF '${TOKEN}' '${STUB_STATE}/coder-argv'"
check "the token is never printed" "! grep -qF '${TOKEN}' '${out}' '${err}'"
check "Coder's own output reaches the terminal on stderr, and stdout keeps only the helper's lines" \
  "grep -q 'Updated version at' '${err}' && grep -q 'Updated template metadata at' '${err}' && [ \"\$(grep -vc '^hcw-coder-template-push: ' '${out}')\" = 0 ]" "$(said)"
check "the copy is made at a fresh /tmp/hcw-lab.* path, pushed from, and removed" \
  "[[ '${made}' =~ ^/tmp/hcw-lab\\.[A-Za-z0-9]+\$ ]] && [ \"\$(state pushed-dir)\" = '${made}' ] && [ \"\$(state removed)\" = '${made}' ] && [ -z \"\$(leftovers)\" ]" \
  "made=${made} removed=$(state removed) left=$(leftovers)"
# One entry per call; the in-container script's own lines follow its call.
check "docker is asked for exactly four things" "[ \"\$(grep -c '^docker ' '${STUB_LOG}')\" -eq 4 ]" "$(cat "${STUB_LOG}")"

first="${made}"
rc="$(rc_of publish "${TOKEN}\n")"
check "a second publish also exits 0, from a path of its own" \
  "[ '${rc}' = 0 ] && [ -n \"\$(state made)\" ] && [ \"\$(state made)\" != '${first}' ] && [ -z \"\$(leftovers)\" ]" "$(said)"
rc="$(rc_of publish "${TOKEN}")"
check "a token with no newline after it is read" "[ '${rc}' = 0 ]" "$(said)"

# --- Refused before Docker is asked anything (exit 2).
refused_before_docker() {
  local expected="$1"
  [ "${rc}" = 2 ] && grep -qF "${expected}" "${err}" && [ ! -s "${STUB_LOG}" ] && return 0
  said >&2
  return 1
}
for empty in '' '\n' '  \r\n' '\xef\xbb\xbf\r\n'; do
  rc="$(rc_of publish "${empty}")"
  check "an empty token ('${empty}') is refused" "refused_before_docker 'the token on stdin was empty; nothing published'"
done
line='(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-coder-template-push"'
for wrong in "${line}" "${TOKEN}-x" "${TOKEN%%-*}" "${TOKEN} ${TOKEN}" "${TOKEN};id" "A$(printf 'b%.0s' {1..130})-c"; do
  rc="$(rc_of publish "${wrong}\n")"
  check "a first line that is not a token is refused and not shown: ${wrong:0:40}" \
    "refused_before_docker 'is not a Coder token' && ! grep -qF -- '${wrong:0:12}' '${out}' && ! grep -qF -- 'Get-Clipboard' '${err}'"
done

# --- Refused by Coder, or failed part-way (exit 1, copy removed).
failed_after_copy() {
  local expected="$1"
  [ "${rc}" = 1 ] && grep -qF "${expected}" "${err}" && [ -z "$(leftovers)" ] && [ -n "$(state removed)" ] && return 0
  said >&2
  return 1
}
rc="$(rc_of publish "${TOKEN}\n" 'Zz98765432-abcdefghijKLMNOPQRST12')"
check "a token Coder refuses fails with Coder's message, and only the push was tried" \
  "failed_after_copy 'You are signed out or your session has expired' && grep -qF 'publishing hcw-lab failed' '${err}' && [ \"\$(state coder-argv | wc -l)\" -eq 1 ]"
export FAKE_CODER_MODE=push-fails
rc="$(rc_of publish "${TOKEN}\n")"
check "a failed push fails, and the autostop is not touched" \
  "failed_after_copy 'template import provisioning failed' && ! grep -q 'templates edit' '${STUB_STATE}/coder-argv'"
export FAKE_CODER_MODE=edit-fails
rc="$(rc_of publish "${TOKEN}\n")"
check "a failed autostop edit fails" "failed_after_copy 'update template metadata: forbidden'"
export FAKE_CODER_MODE=no-active
rc="$(rc_of publish "${TOKEN}\n")"
check "no active version in Coder's list fails" "failed_after_copy 'Coder listed no single active version of it'"
export FAKE_CODER_MODE=ttl-differs
rc="$(rc_of publish "${TOKEN}\n")"
check "an autostop Coder reports differently fails" \
  "failed_after_copy \"Coder reports a default autostop of '2h0m0s', not ${ttl}0m0s\""
export FAKE_CODER_MODE=coloured
rc="$(rc_of publish "${TOKEN}\n")"
check "a coloured Active is still read" "[ '${rc}' = 0 ] && grep -q 'Active version: vigilant_hopper1\\.' '${out}'" "$(said)"
export FAKE_CODER_MODE=''

export STUB_NO_CONTAINER=1
rc="$(rc_of publish "${TOKEN}\n")"
check "with no coder container it fails at once and says what to check" \
  "[ '${rc}' = 1 ] && grep -qF 'Coder is probably not running' '${err}' && [ \"\$(grep -c '^docker ' '${STUB_LOG}')\" -eq 1 ] && [ -z \"\$(state coder-argv)\" ]" "$(said)"
unset STUB_NO_CONTAINER
export STUB_RM_FAILS=1
rc="$(rc_of publish "${TOKEN}\n")"
check "a copy that cannot be removed makes a publish fail" \
  "[ '${rc}' = 1 ] && grep -qF 'could not remove /tmp/hcw-lab.' '${err}'" "$(said)"
unset STUB_RM_FAILS
rm -rf "${STUB_ROOT:?}/tmp" && mkdir -p "${STUB_ROOT}/tmp"

# --- What is copied, in a checkout made for the test.
fake="${work}/fake-src/lab-host/coder/templates/hcw-lab"
mkdir -p "${fake}/.terraform/providers"
printf 'terraform {}\n' > "${fake}/main.tf"
printf 'locals {}\n' > "${fake}/extra.tf"
printf '# hcw-lab\n' > "${fake}/README.md"
printf 'test\n' > "${fake}/template.test.mjs"
printf 'notes\n' > "${fake}/notes.txt"
printf 'state\n' > "${fake}/.terraform/providers/x"
export HCW_SRC_DIR="${work}/fake-src"
rc="$(rc_of publish "${TOKEN}\n")"
check "every *.tf is copied; tests, notes, .terraform/ and a missing lock file are not" \
  "[ '${rc}' = 0 ] && [ \"\$(state pushed-files | tr '\n' ' ')\" = 'README.md extra.tf main.tf ' ]" "$(state pushed-files) $(said)"
rm "${fake}/main.tf" "${fake}/extra.tf"
rc="$(rc_of publish "${TOKEN}\n")"
check "a template directory with no *.tf is refused" "refused_before_docker 'no *.tf file in ${fake}; nothing published'"
ln -s /etc/hostname "${fake}/main.tf"
rc="$(rc_of publish "${TOKEN}\n")"
check "a symbolic link is refused, so nothing outside the checkout reaches Coder" \
  "refused_before_docker 'refusing ${fake}/main.tf: it is a symbolic link'"
export HCW_SRC_DIR="${work}/no-checkout"
rc="$(rc_of publish "${TOKEN}\n")"
check "no checkout is refused" "refused_before_docker 'no template at ${work}/no-checkout/lab-host/coder/templates/hcw-lab'"
addon_tpl="${work}/fake-src/lab-host/coder/templates/amo-guided-lab"
mkdir -p "${addon_tpl}"
printf 'terraform {}\n' > "${addon_tpl}/main.tf"
export HCW_SRC_DIR="${work}/fake-src"
rc="$(rc_of publish "${TOKEN}\n" "${TOKEN}" amo-guided-lab)"
check "an explicit template name argument publishes that template" \
  "[ '${rc}' = 0 ] && [ \"\$(state pushed-name)\" = 'amo-guided-lab' ] && grep -q 'published amo-guided-lab' '${out}'" "$(said)"
rc="$(rc_of publish "${TOKEN}\n" "${TOKEN}" '../bad')"
check "an invalid template name is refused before Docker is asked anything" \
  "refused_before_docker \"invalid template name '../bad'\""
rc="$(rc_of publish "${TOKEN}\n" "${TOKEN}" hcw-lab extra)"
check "more than one argument is refused before Docker is asked anything" \
  "refused_before_docker 'usage: hcw-coder-template-push [template-name]'"
export HCW_SRC_DIR="${work}/src"

# --- An autostop that is not whole hours, rendered in spite of the role's assert.
render "${helper}" coder_template_default_ttl=90m
rc="$(rc_of publish "${TOKEN}\n")"
check "the helper refuses an autostop that is not whole hours itself" \
  "refused_before_docker \"the default autostop '90m' is not whole hours\""

echo "1..$((passed + failed))"
if [ "${failed}" -ne 0 ]; then
  echo "hcw-coder-template-push.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "hcw-coder-template-push.test.sh: all ${passed} checks passed"
