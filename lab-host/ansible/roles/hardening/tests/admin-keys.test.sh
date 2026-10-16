#!/usr/bin/env bash
# Runs ../tasks/admin_keys.yml (#953) with ansible-core against a journal
# fixture and scratch copies of the two authorized_keys files it reads, and
# checks the refusals and the write: an empty key list and a malformed or
# unreadable entry stop the run with nothing written. The lockout guard:
# with logins in the journal, a list without the key of the most recent
# login as the administrative user or root stops the run, whatever else is
# on file, and one with it passes; with no login in the journal it falls
# back to the files, and a list that shares no key with the administrative
# user's file, or with root's while the user's has none, stops it; a journal
# that cannot be read stops it too. Each refusal prints fingerprints, the
# override lets it through, a list that passes writes the user's file to the
# list exactly, and a second run changes nothing. Keys are throwaway ones
# ssh-keygen makes here, and the journal lines are sshd's INFO format with
# TEST-NET addresses. The administrative user is the account running the
# test, so no root is needed; ansible-core and ssh-keygen on PATH, no
# Docker. CI runs it in the `ansible-lint (lab-host)` job.
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

for tool in ansible-playbook ssh-keygen; do
  command -v "${tool}" > /dev/null || { echo "${tool} is not on PATH" >&2; exit 1; }
done

work="$(mktemp -d)"
# finish: remove the scratch directory, on every way out.
finish() { rm -rf "${work}"; }
trap finish EXIT

# Three throwaway keys, each with a comment, and each one's bare line
# (type and key) and fingerprint.
for k in one two three; do
  ssh-keygen -q -t ed25519 -N '' -C "test-${k}@example" -f "${work}/${k}" > /dev/null
  cut -d' ' -f1,2 "${work}/${k}.pub" > "${work}/${k}.bare"
  ssh-keygen -l -E sha256 -f "${work}/${k}.pub" | cut -d' ' -f2 > "${work}/${k}.fp"
done
bare() { cat "${work}/$1.bare"; }
fp() { cat "${work}/$1.fp"; }

cat > "${work}/play.yml" <<EOF
- name: Run the hardening role's key tasks against scratch files
  hosts: localhost
  connection: local
  gather_facts: false
  vars_files:
    - ${role}/defaults/main.yml
    - ${role}/vars/main.yml
  tasks:
    - name: The key tasks
      ansible.builtin.import_tasks: ${role}/tasks/admin_keys.yml
EOF

# A configuration of its own, so the run is the same from any directory:
# lab-host/ansible/ansible.cfg, which CI's working directory would pick up,
# turns become on and prints results as folded YAML.
cat > "${work}/ansible.cfg" <<'EOF'
[defaults]
stdout_callback = ansible.builtin.default
interpreter_python = auto_silent
retry_files_enabled = False
EOF
export ANSIBLE_CONFIG="${work}/ansible.cfg"

admin_file="${work}/admin/.ssh/authorized_keys"
root_file="${work}/root/.ssh/authorized_keys"
journal="${work}/journal"
me="$(id -un)"

# reset: empty scratch homes, as a host has them, and an empty journal (a
# fresh host); then admin_has/root_has write a file's lines and journal_has
# the journal's.
reset() { rm -rf "${work}/admin" "${work}/root"; mkdir -p "${work}/admin" "${work}/root"; : > "${journal}"; }
admin_has() { mkdir -p "$(dirname "${admin_file}")"; printf '%s\n' "$@" > "${admin_file}"; }
root_has() { mkdir -p "$(dirname "${root_file}")"; printf '%s\n' "$@" > "${root_file}"; }
journal_has() { printf '%s\n' "$@" > "${journal}"; }
# login USER KEY: sshd's INFO line for an accepted login with that key.
login() { printf 'Accepted publickey for %s from 192.0.2.7 port 50022 ssh2: ED25519 %s' "$1" "$(fp "$2")"; }

# run NAME KEYS_JSON [EXTRA_ARGS...]: run the play with this key list, the
# journal read from ${journal}; the output goes to ${work}/NAME.out and the
# exit code to ${work}/NAME.rc. A later -e overrides the journal command.
run() {
  local name="$1" keys="$2"
  shift 2
  set +e
  ANSIBLE_NOCOLOR=1 ANSIBLE_LOCALHOST_WARNING=0 ANSIBLE_INVENTORY_UNPARSED_WARNING=0 \
    ansible-playbook -i localhost, "${work}/play.yml" \
    -e "hardening_admin_user=${me}" \
    -e "hardening_admin_authorized_keys_path=${admin_file}" \
    -e "hardening_root_authorized_keys_path=${root_file}" \
    -e "{\"hardening_ssh_login_journal_argv\": [\"cat\", \"${journal}\"]}" \
    -e "{\"hardening_admin_authorized_keys\": ${keys}}" \
    "$@" > "${work}/${name}.out" 2>&1
  echo $? > "${work}/${name}.rc"
  set -e
}
rc() { cat "${work}/$1.rc"; }
out() { cat "${work}/$1.out"; }
says() { grep -qF -- "$2" "${work}/$1.out"; }
json() { printf '["%s"]' "$1"; }

# 1. An empty list stops the run before anything is written.
reset
admin_has "$(cat "${work}/one.pub")"
run empty '[]'
check "an empty key list fails the run" "[ \"\$(rc empty)\" -ne 0 ]" "$(out empty)"
check "and says the list is empty and where to add a key" \
  "says empty 'hardening_admin_authorized_keys is empty' && says empty 'lab-host/ansible/group_vars/all.yml'" "$(out empty)"
check "and leaves the administrative user's file as it was" "grep -qxF \"\$(cat '${work}/one.pub')\" '${admin_file}' && [ \"\$(wc -l < '${admin_file}')\" -eq 1 ]"

# 2. An entry with authorized_keys options, or that is not a key, is refused.
reset
admin_has "$(cat "${work}/one.pub")"
run options "$(json "no-pty $(bare one)")"
check "an entry with options fails the run" "[ \"\$(rc options)\" -ne 0 ] && says options 'Entry 1 of hardening_admin_authorized_keys is not one public key'" "$(out options)"
run notakey '["ssh-ed25519 not-a-key"]'
check "an entry that is not a key fails the run" "[ \"\$(rc notakey)\" -ne 0 ] && says notakey 'Entry 1 of hardening_admin_authorized_keys is not one public key'" "$(out notakey)"
check "and neither touched the administrative user's file" "[ \"\$(cat '${admin_file}')\" = \"\$(cat '${work}/one.pub')\" ]"

# 3. The lockout guard with an empty journal (a fresh host) falls back to
# the files, the administrative user's first.
reset
admin_has "$(cat "${work}/one.pub")"
root_has "$(cat "${work}/two.pub")"
run lockout "$(json "$(bare two)")"
check "with an empty journal, a list sharing no key with the user's file fails the run, even when root's file has it" \
  "[ \"\$(rc lockout)\" -ne 0 ] && says lockout 'No key in hardening_admin_authorized_keys' && says lockout 'the journal has no SSH login to go by'" "$(out lockout)"
check "and names the user's file and both sides' fingerprints" \
  "says lockout '${admin_file}' && says lockout \"\$(fp two)\" && says lockout \"\$(fp one)\"" "$(out lockout)"
check "and says how to override it" "says lockout 'hardening_admin_keys_replace_all=true'" "$(out lockout)"
check "and leaves the user's file as it was" "[ \"\$(cat '${admin_file}')\" = \"\$(cat '${work}/one.pub')\" ]"

run lockout-check "$(json "$(bare two)")" --check
check "check mode refuses the same list" "[ \"\$(rc lockout-check)\" -ne 0 ] && says lockout-check 'No key in hardening_admin_authorized_keys'" "$(out lockout-check)"

# 4. The override lets that list through, and the file becomes the list.
run override "$(json "$(bare two)")" -e hardening_admin_keys_replace_all=true
check "hardening_admin_keys_replace_all=true lets it through" "[ \"\$(rc override)\" -eq 0 ]" "$(out override)"
check "and says so" "says override 'hardening_admin_keys_replace_all is true'" "$(out override)"
check "and the user's file is the new list alone" "[ \"\$(cat '${admin_file}')\" = \"\$(bare two)\" ]" "$(cat "${admin_file}" 2>&1)"

# 5. With an empty journal, a list that keeps a key on file is written
# exactly: the pinned key, comment stripped, and the other key gone.
reset
admin_has "$(cat "${work}/one.pub")" "$(cat "${work}/two.pub")"
run keep "$(json "$(bare one)")"
check "with an empty journal, a list keeping a key on file passes" "[ \"\$(rc keep)\" -eq 0 ]" "$(out keep)"
check "and the user's file is exactly the list" "[ \"\$(cat '${admin_file}')\" = \"\$(bare one)\" ]" "$(cat "${admin_file}" 2>&1)"
check "and the file is the user's, mode 0600" "[ \"\$(stat -c '%a' '${admin_file}')\" = 600 ]"
run again "$(json "$(bare one)")"
check "a second run changes nothing" "[ \"\$(rc again)\" -eq 0 ] && grep -qE 'localhost +: ok=[0-9]+ +changed=0 ' '${work}/again.out'" "$(out again)"

# 6. With an empty journal, while the user has no key (a reinstalled
# host), root's keys are the ones on file: a list without them stops the
# run, one with them, matched by key even after options, passes.
reset
root_has "$(cat "${work}/three.pub")"
run reinstall-lockout "$(json "$(bare one)")"
check "on a reinstall, a list sharing no key with root's file fails the run" \
  "[ \"\$(rc reinstall-lockout)\" -ne 0 ] && says reinstall-lockout '${root_file}' && says reinstall-lockout \"\$(fp three)\"" "$(out reinstall-lockout)"
check "and writes no file for the user" "[ ! -e '${admin_file}' ]"
reset
root_has "no-port-forwarding,no-pty $(cat "${work}/one.pub")"
run reinstall "$(json "$(bare one)")"
check "on a reinstall, a list holding root's key passes, options and all" "[ \"\$(rc reinstall)\" -eq 0 ]" "$(out reinstall)"
check "and the user's file is the list" "[ \"\$(cat '${admin_file}')\" = \"\$(bare one)\" ]" "$(cat "${admin_file}" 2>&1)"

# 7. With no login in the journal and no key anywhere (a password login
# through the console), there is nothing to lock out.
reset
run nokeys "$(json "$(bare one)")"
check "with no login and no key on file the list is written" "[ \"\$(rc nokeys)\" -eq 0 ] && [ \"\$(cat '${admin_file}')\" = \"\$(bare one)\" ]" "$(out nokeys)"

# 8. With logins in the journal, the key of the most recent login as the
# administrative user or root decides, whatever is on file. The lines that
# must not count come after it: another user's login, a refused key, and
# VERBOSE's own "Accepted key" line.
noise=(
  "Accepted publickey for someone-else from 192.0.2.8 port 50023 ssh2: ED25519 $(fp three)"
  "Failed publickey for ${me} from 192.0.2.9 port 50024 ssh2: ED25519 $(fp three)"
  "Accepted key ED25519 $(fp three) found at ${admin_file}:1"
)
reset
admin_has "$(cat "${work}/one.pub")" "$(cat "${work}/two.pub")"
cp "${admin_file}" "${work}/one-two.before"
journal_has "$(login "${me}" one)" "$(login "${me}" two)" "${noise[@]}"
run journal-lockout "$(json "$(bare one)")"
check "a list without the key of the most recent login fails the run, though it keeps another key on file" \
  "[ \"\$(rc journal-lockout)\" -ne 0 ] && says journal-lockout 'The most recent SSH login here, as ${me}, used the key' && says journal-lockout \"\$(fp two)\"" "$(out journal-lockout)"
check "and leaves the user's file as it was" "cmp -s '${admin_file}' '${work}/one-two.before'" "$(cat "${admin_file}" 2>&1)"
run journal-lockout-check "$(json "$(bare one)")" --check
check "check mode refuses the same list" \
  "[ \"\$(rc journal-lockout-check)\" -ne 0 ] && says journal-lockout-check 'The most recent SSH login here'" "$(out journal-lockout-check)"
run journal-keep "$(json "$(bare two)")"
check "a list with the key of the most recent login passes" "[ \"\$(rc journal-keep)\" -eq 0 ]" "$(out journal-keep)"
check "and the user's file is that list" "[ \"\$(cat '${admin_file}')\" = \"\$(bare two)\" ]" "$(cat "${admin_file}" 2>&1)"

# A login as root counts too (the first run after a reinstall), and the
# journal decides even where the files would pass.
reset
admin_has "$(cat "${work}/one.pub")"
journal_has "$(login "${me}" one)" "$(login root three)"
run journal-root "$(json "$(bare one)")"
check "a most recent login as root with a key not in the list fails the run, though the list keeps the user's key" \
  "[ \"\$(rc journal-root)\" -ne 0 ] && says journal-root 'as root, used the key' && says journal-root \"\$(fp three)\"" "$(out journal-root)"
run journal-root-keep "$(json "$(bare three)")"
check "and a list with that key passes" "[ \"\$(rc journal-root-keep)\" -eq 0 ]" "$(out journal-root-keep)"

# The override lets a list without the key in use through, and says so.
reset
journal_has "$(login "${me}" one)"
run journal-override "$(json "$(bare two)")" -e hardening_admin_keys_replace_all=true
check "the override lets a list without the key in use through, and says so" \
  "[ \"\$(rc journal-override)\" -eq 0 ] && says journal-override 'the key of the most recent SSH login'" "$(out journal-override)"

# 9. A journal that cannot be read stops the run; it is not a fresh host.
reset
admin_has "$(cat "${work}/one.pub")"
run journal-unread "$(json "$(bare one)")" -e '{"hardening_ssh_login_journal_argv": ["false"]}'
check "a journal that cannot be read fails the run instead of falling back" \
  "[ \"\$(rc journal-unread)\" -ne 0 ] && says journal-unread 'cannot tell which key you log in with'" "$(out journal-unread)"

# 10. An entry shaped like a key that ssh-keygen cannot read is refused.
reset
run unreadable '["ssh-ed25519 AAAAnotbase64atall"]'
check "an entry ssh-keygen cannot read fails the run" \
  "[ \"\$(rc unreadable)\" -ne 0 ] && says unreadable 'so an entry is not a valid key' && [ ! -e '${admin_file}' ]" "$(out unreadable)"

if [ "${failed}" -gt 0 ]; then
  echo "admin-keys.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "admin-keys.test.sh: all ${passed} checks passed"
