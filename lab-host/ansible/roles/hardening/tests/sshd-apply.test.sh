#!/usr/bin/env bash
# Runs ../tasks/sshd.yml (#953) with ansible-core against a stub sshd and
# scratch paths, with the role's handlers as written except that the
# systemd reload of ssh.service is replaced by a line in a log, which also
# records how many bytes root's authorized_keys held at that moment. It
# checks the order that keeps root's keys until sshd has loaded the drop-in:
#
# - a fresh write marks the reload pending BEFORE the drop-in is written
#   (the stub's sshd -t sees the marker), reloads, removes the marker, and
#   only then empties root's keys; a second run changes nothing;
# - a marker an interrupted run left behind makes the next run reload sshd
#   before it empties root's keys, though the drop-in is unchanged;
# - a drop-in that fails sshd -T's read-back is put back as it was, its
#   backup removed, the run stopped with root's keys untouched, and the
#   reload force_handlers still runs loads the restored drop-in;
# - check mode with a marker left behind reports it and changes nothing.
#
# As root, because the tasks set root as the owner of what they write. CI
# runs it in the `ansible-lint (lab-host)` job with sudo; no Docker.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"

passed=0
failed=0
# ok NAME: count and print a passing check, TAP style.
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
# not_ok NAME [DETAIL]: count and print a failing check, with its detail indented.
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
# check NAME COMMAND [DETAIL]: run COMMAND through eval and report it as ok or not ok.
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

[ "$(id -u)" -eq 0 ] || { echo "run as root: the tasks make root the owner of what they write (sudo env \"PATH=\$PATH\" bash $0)" >&2; exit 1; }
command -v ansible-playbook > /dev/null || { echo "ansible-playbook is not on PATH" >&2; exit 1; }
python=''
for candidate in python3 python; do
  if command -v "${candidate}" > /dev/null && "${candidate}" -c 'import yaml' 2> /dev/null; then
    python="$(command -v "${candidate}")"
    break
  fi
done
[ -n "${python}" ] || { echo "no Python with yaml on PATH; install ansible-core" >&2; exit 1; }

work="$(mktemp -d)"
# finish: remove the scratch directory, on every way out.
finish() { rm -rf "${work}"; }
trap finish EXIT

dropin="${work}/etc/ssh/sshd_config.d/00-hcw-hardening.conf"
marker="${work}/var/lib/hcw-hardening/sshd-reload-pending"
root_keys="${work}/root/.ssh/authorized_keys"
admin_keys="${work}/home/hcwadmin/.ssh/authorized_keys"
reloads="${work}/reloads.log"
sshd_log="${work}/sshd.log"
mkdir -p "$(dirname "${dropin}")" "${work}/bin"
: > "${reloads}"
: > "${sshd_log}"

# What sshd -T answers for any user: the settings the drop-in sets, as
# OpenSSH 10.2 printed them for it on the host (read over stdin,
# 2026-10-16). STUB_SSHD_T names the file, so a case can swap in a bad one.
cat > "${work}/sshd-T.good" <<'EOF'
logingracetime 30
permitrootlogin no
pubkeyauthentication yes
passwordauthentication no
kbdinteractiveauthentication no
x11forwarding no
allowtcpforwarding local
allowstreamlocalforwarding no
allowagentforwarding no
loglevel VERBOSE
authorizedkeysfile .ssh/authorized_keys
allowusers hcwadmin
authenticationmethods publickey
permittunnel no
persourcepenaltyexemptlist 127.0.0.1,::1
listenaddress 127.0.0.1:22
listenaddress [::1]:22
EOF
sed 's/^allowagentforwarding no$/allowagentforwarding yes/' "${work}/sshd-T.good" > "${work}/sshd-T.bad"

# The stub: -t logs whether the marker exists at that moment (the
# template's validate runs it while writing the drop-in), -T prints the
# settings above.
cat > "${work}/bin/sshd" <<EOF
#!/usr/bin/env bash
case "\$1" in
  -t) if [ -e '${marker}' ]; then echo "t marker-present \$*" >> '${sshd_log}'; else echo "t marker-absent \$*" >> '${sshd_log}'; fi ;;
  -T) cat "\${STUB_SSHD_T:-${work}/sshd-T.good}" ;;
  *) exit 2 ;;
esac
EOF
chmod 0755 "${work}/bin/sshd"

# The role's handlers as written, but for the reload of ssh.service, which
# becomes a log line holding the size of root's authorized_keys then.
# Restart ssh.socket is stubbed with true so the test needs no systemd.
"${python}" - "${role}/handlers/main.yml" "${work}/handlers.yml" "${reloads}" "${root_keys}" <<'PY'
import sys, yaml
handlers = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
for h in handlers:
    if h.get("name") == "Reload ssh":
        assert h.get("ansible.builtin.systemd_service", {}).get("state") == "reloaded", h
        h.pop("ansible.builtin.systemd_service")
        h["ansible.builtin.command"] = {"argv": [
            "bash", "-c", 'printf "reload root-keys-bytes=%s\\n" "$(wc -c < "$2" 2> /dev/null || echo none)" >> "$1"',
            "stub-reload", sys.argv[3], sys.argv[4]]}
    elif h.get("name") == "Restart ssh.socket":
        h.pop("ansible.builtin.systemd_service")
        h["ansible.builtin.command"] = {"argv": ["true"]}
open(sys.argv[2], "w", encoding="utf-8").write(yaml.safe_dump(handlers, sort_keys=False))
PY

# A play outside the role looks for templates beside the playbook, so the
# role's own template is linked there.
mkdir -p "${work}/templates"
ln -s "${role}/templates/sshd_hardening.conf.j2" "${work}/templates/sshd_hardening.conf.j2"

cat > "${work}/play.yml" <<EOF
- name: Run the hardening role's sshd tasks against a stub sshd and scratch paths
  hosts: localhost
  connection: local
  gather_facts: false
  force_handlers: true
  vars_files:
    - ${role}/defaults/main.yml
    - ${role}/vars/main.yml
  handlers:
    - name: The role's handlers, the reload stubbed
      ansible.builtin.import_tasks: ${work}/handlers.yml
  tasks:
    - name: The sshd tasks
      ansible.builtin.import_tasks: ${role}/tasks/sshd.yml
EOF

cat > "${work}/ansible.cfg" <<'EOF'
[defaults]
stdout_callback = ansible.builtin.default
interpreter_python = auto_silent
retry_files_enabled = False
EOF
export ANSIBLE_CONFIG="${work}/ansible.cfg"

# run NAME [EXTRA_ARGS...]: run the play; output to ${work}/NAME.out, exit
# code to ${work}/NAME.rc.
run() {
  local name="$1"
  shift
  set +e
  ANSIBLE_NOCOLOR=1 ANSIBLE_LOCALHOST_WARNING=0 ANSIBLE_INVENTORY_UNPARSED_WARNING=0 \
    ansible-playbook -i localhost, "${work}/play.yml" \
    -e hardening_admin_user=hcwadmin \
    -e "hardening_sshd_binary=${work}/bin/sshd" \
    -e "hardening_sshd_dropin_path=${dropin}" \
    -e "hardening_sshd_reload_marker=${marker}" \
    -e "hardening_root_authorized_keys_path=${root_keys}" \
    -e "hardening_admin_authorized_keys_path=${admin_keys}" \
    "$@" > "${work}/${name}.out" 2>&1
  echo $? > "${work}/${name}.rc"
  set -e
}
# rc NAME: the exit code of run NAME.
rc() { cat "${work}/$1.rc"; }
# out NAME: everything run NAME printed.
out() { cat "${work}/$1.out"; }
# says NAME TEXT: true when run NAME printed TEXT.
says() { grep -qF -- "$2" "${work}/$1.out"; }
# reload_count: how many times the stand-in reload has run so far.
reload_count() { wc -l < "${reloads}" | tr -d ' '; }
# last_reload: the most recent stand-in reload's line, with root's key bytes at that moment.
last_reload() { tail -n 1 "${reloads}"; }
# root_has_key: root's authorized_keys holds one stand-in key, as before the first run.
root_has_key() { mkdir -p "$(dirname "${root_keys}")"; echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStandInRootKey stand-in' > "${root_keys}"; }
# backups: how many files beside the drop-in its directory holds, a backup being one.
backups() { find "$(dirname "${dropin}")" -mindepth 1 ! -name "$(basename "${dropin}")" | wc -l | tr -d ' '; }

# 1. A fresh write.
root_has_key
run fresh
check "a fresh write passes" "[ \"\$(rc fresh)\" -eq 0 ]" "$(out fresh)"
check "and writes the drop-in" \
  "grep -qxF 'AllowUsers hcwadmin' '${dropin}' && grep -qxF 'ListenAddress 127.0.0.1' '${dropin}' && grep -qxF 'ListenAddress ::1' '${dropin}'" \
  "$(cat "${dropin}" 2>&1)"
check "the reload was marked pending before the drop-in was written (sshd -t saw the marker)" \
  "grep -qE '^t marker-present -t -f ' '${sshd_log}' && ! grep -qE '^t marker-absent -t -f ' '${sshd_log}'" "$(cat "${sshd_log}")"
check "sshd was reloaded once, while root's keys were still there" \
  "[ \"\$(reload_count)\" -eq 1 ] && last_reload | grep -qE '^reload root-keys-bytes=[1-9]'" "$(cat "${reloads}")"
check "the reload removed the marker" "[ ! -e '${marker}' ]"
check "root's authorized_keys is empty afterwards, mode 0600" \
  "[ -f '${root_keys}' ] && [ ! -s '${root_keys}' ] && [ \"\$(stat -c '%a' '${root_keys}')\" = 600 ]"
check "no backup of the drop-in is left" "[ \"\$(backups)\" -eq 0 ]" "$(ls -la "$(dirname "${dropin}")")"

# 2. The same again changes nothing and reloads nothing.
run again
check "a second run passes and changes nothing" \
  "[ \"\$(rc again)\" -eq 0 ] && grep -qE 'localhost +: ok=[0-9]+ +changed=0 ' '${work}/again.out'" "$(out again)"
check "and does not reload sshd" "[ \"\$(reload_count)\" -eq 1 ]" "$(cat "${reloads}")"

# 3. An earlier run was interrupted after writing the drop-in: its marker is
# there, the drop-in is unchanged, and root still has a key.
echo 'left by an interrupted run' > "${marker}"
root_has_key
run interrupted
check "a marker left behind makes the run reload sshd" \
  "[ \"\$(rc interrupted)\" -eq 0 ] && [ \"\$(reload_count)\" -eq 2 ]" "$(out interrupted)"
check "before root's keys are emptied" "last_reload | grep -qE '^reload root-keys-bytes=[1-9]'" "$(cat "${reloads}")"
check "and the reload removed the marker" "[ ! -e '${marker}' ]"
check "and root's keys are empty after it" "[ ! -s '${root_keys}' ]"

# 4. Check mode with a marker left behind reports it and changes nothing.
echo 'left by an interrupted run' > "${marker}"
root_has_key
run check-marker --check
check "check mode with a marker passes and reports a change" \
  "[ \"\$(rc check-marker)\" -eq 0 ] && grep -qE 'localhost +: ok=[0-9]+ +changed=[1-9]' '${work}/check-marker.out'" "$(out check-marker)"
check "and leaves the marker, root's keys and sshd alone" \
  "[ -e '${marker}' ] && [ -s '${root_keys}' ] && [ \"\$(reload_count)\" -eq 2 ]" "$(cat "${reloads}")"
run clear-marker
check "the next real run reloads and clears it" "[ \"\$(rc clear-marker)\" -eq 0 ] && [ ! -e '${marker}' ] && [ \"\$(reload_count)\" -eq 3 ]"

# 5. A drop-in that sshd -T says does not apply: the previous one goes back,
# its backup goes, the run stops, root's keys stay, and the reload
# force_handlers runs loads the restored drop-in.
printf '# the settings sshd had\n' > "${dropin}"
root_has_key
STUB_SSHD_T="${work}/sshd-T.bad" run bad
check "a drop-in sshd -T does not confirm fails the run" \
  "[ \"\$(rc bad)\" -ne 0 ] && says bad 'The sshd drop-in did not pass its checks' && says bad 'allowagentforwarding yes'" "$(out bad)"
check "and the previous drop-in is back as it was" "[ \"\$(cat '${dropin}')\" = '# the settings sshd had' ]" "$(cat "${dropin}")"
check "and its backup is removed" "[ \"\$(backups)\" -eq 0 ]" "$(ls -la "$(dirname "${dropin}")")"
check "and root's keys are untouched" "[ -s '${root_keys}' ]"
check "and the reload still runs, on the restored drop-in, and clears the marker" \
  "[ \"\$(reload_count)\" -eq 4 ] && [ ! -e '${marker}' ]" "$(cat "${reloads}")"

# 6. While Azure Arc SSH is not ready, tasks/arc_gate.yml sets
# hardening_sshd_loopback_only false: the drop-in lists no ListenAddress, and
# sshd -T must not report the loopback pair (#1257). As a rebuilt host's runs
# before onboarding, which reach it over port 22.
grep -v '^listenaddress ' "${work}/sshd-T.good" > "${work}/sshd-T.public"
printf 'listenaddress [::]:22\nlistenaddress 0.0.0.0:22\n' >> "${work}/sshd-T.public"
STUB_SSHD_T="${work}/sshd-T.public" run public -e hardening_sshd_loopback_only=false
check "with sshd on every address, the drop-in lists no ListenAddress and the run passes" \
  "[ \"\$(rc public)\" -eq 0 ] && grep -qxF 'AllowUsers hcwadmin' '${dropin}' && ! grep -q '^ListenAddress' '${dropin}' && [ \"\$(reload_count)\" -eq 5 ]" \
  "$(out public; cat "${dropin}")"
STUB_SSHD_T="${work}/sshd-T.good" run public-mismatch -e hardening_sshd_loopback_only=false
check "and a run whose sshd still reports the loopback pair stops" \
  "[ \"\$(rc public-mismatch)\" -ne 0 ] && says public-mismatch 'The sshd drop-in did not pass its checks'" "$(out public-mismatch)"

if [ "${failed}" -gt 0 ]; then
  echo "sshd-apply.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "sshd-apply.test.sh: all ${passed} checks passed"
