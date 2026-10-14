#!/usr/bin/env bash
# Bootstrap the HCW lab host. Re-runnable: the owner runs it first as root over
# SSH on the adopted Ubuntu 26.04 LTS host (infra-lab/README.md, step 7; the
# Hostinger provider cannot attach a post-install script to a server that
# already exists), and re-runs it after a change merges to main or the vault
# changes; each run brings the host to the current main commit (HCW_REPO_REF
# below). Everything the host ends up running is declared under ansible/; this
# script only gets Ansible there.
#
# It configures only a host that was prepared for it. The first run on a host
# refuses, before it changes anything, when the host shows another workload
# (a container, a self-hosted runner, Kubernetes, a foreign /opt or listener);
# "The first-run host check" below has the checks and the way past them.
#
# The vault is optional on purpose. Without /etc/hcw/ansible/vault.yml the
# playbook still hardens the host and installs hcw-vault-set, Docker,
# node_exporter and Caddy (serving plain HTTP), then stops at the coder role:
# Coder is on, and the role will not start it without its three vault keys
# (lab-host/README.md, "First run"). With the vault, Caddy holds the wildcard
# certificate, Coder runs and the agent runs.
#
# Python. Ansible's control side (ansible-playbook, templating, the vault)
# runs on CPython from uv, not on the distribution's python3. Owner rule
# 2026-09-26: Python is on the newest release line and no more than two patch
# releases behind that line's newest (3.14.7 then, so a 3.14.5 floor), and
# Ubuntu 26.04's /usr/bin/python3 is 3.14.4 (python3.14 3.14.4, package
# python3 3.14.3), below that floor. uv comes from its GitHub release asset, checked against
# UV_SHA256 before it runs (no curl | sh), and uv checks the interpreter it
# downloads against the SHA256 it carries for that build, so the two pins
# below fix the interpreter's bytes too. The one recorded exception: modules
# still EXECUTE on the host's /usr/bin/python3 (ansible_python_interpreter in
# ansible/inventory/localhost.yml), because python3-apt, python3-debian and
# python3-docker, which the apt, deb822_repository and community.docker
# modules import, are distribution packages built for the distribution's
# Python and cannot be loaded by another interpreter.
set -euo pipefail

# Tool versions, each checked 2026-09-26. A bump is an edit here and a re-run.
# uv 0.12.19, the newest release; UV_SHA256 is the sha256sum of
# uv-x86_64-unknown-linux-gnu.tar.gz from
# https://github.com/astral-sh/uv/releases/tag/0.12.19, equal to the
# release's own .sha256 asset, and `gh attestation verify --repo astral-sh/uv`
# traces the file to that repository's release workflow.
UV_VERSION=0.12.19
UV_SHA256=23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8
# CPython 3.14.7, the newest release of the newest line. uv 0.12.19 pins its
# python-build-standalone 20260924 build by SHA256.
PYTHON_VERSION=3.14.7
# ansible-core 2.21.4, the newest GA release (2.22.0b1 is a beta); it declares
# Python 3.12 to 3.14 for the control side. The control side runs on the uv
# interpreter above on either release, so the 24.04 fallback never holds this
# pin back: it only decides which Python the modules run on (3.12.3 there,
# 3.14.4 on 26.04), and 2.21.4 ran every module on both in the 2026-09-26
# container runs. Before a future bump, check its module-side Python range
# still includes 24.04's 3.12, or drop 24.04.
ANSIBLE_CORE_VERSION=2.21.4

HCW_REPO_URL="${HCW_REPO_URL:-https://github.com/saulpatinojr/HCW-HybridCloudWorks.git}"
# Which commit the host runs: origin/main unless HCW_REPO_REF says otherwise.
# After the clone or fetch below it is resolved once to a full sha, that sha is
# checked out detached and logged, and nothing after that reads the ref again,
# so a push during the run cannot change what runs. main is protected by the
# repository ruleset (a pull request for every change, no bypass actors, and
# strict required checks that include ansible-lint (lab-host) and coder
# (lab-host)), so every commit on it has passed those checks. That is the trust
# a pinned sha here gave, without the lag: a pull request cannot pin its own
# merge commit, so a pin always named the commit before the change that moved
# it, and every lab-host change needed a second pull request to take effect.
# HCW_REPO_REF=<sha or ref> still holds a host at, or rolls it back to, any
# commit the fetch can see (lab-host/README.md, "Re-running"). The agent runs
# the same commit by default: labs_agent_repo_ref in ansible/group_vars/all.yml
# reads the playbook's own checkout.
HCW_REPO_REF="${HCW_REPO_REF:-origin/main}"
HCW_SRC_DIR="${HCW_SRC_DIR:-/opt/hcw-src}"
HCW_ANSIBLE_STATE_DIR=/etc/hcw/ansible
HCW_VAULT_FILE="${HCW_ANSIBLE_STATE_DIR}/vault.yml"
HCW_VAULT_PASSWORD_FILE="${HCW_ANSIBLE_STATE_DIR}/vault-password"

# uv, its interpreters and the ansible-core environment live under /opt/uv,
# outside root's home; the ansible-* commands are linked into /usr/local/bin,
# where the README's ansible-vault lines expect them.
UV_BIN=/usr/local/bin/uv
export UV_PYTHON_INSTALL_DIR=/opt/uv/python
export UV_TOOL_DIR=/opt/uv/tools
export UV_TOOL_BIN_DIR=/usr/local/bin
export UV_CACHE_DIR=/var/cache/uv
export DEBIAN_FRONTEND=noninteractive

log() {
  printf '[bootstrap] %s\n' "$*"
}

# Read before the checkout below can replace this file, so the script can tell
# whether the commit it checks out carries a different version of itself.
self_digest="$(sha256sum "${BASH_SOURCE[0]}" 2>/dev/null | cut -d ' ' -f 1 || true)"

if [ "$(id -u)" -ne 0 ]; then
  echo "bootstrap.sh must run as root" >&2
  exit 1
fi

# One run at a time (#1069). The firewall rebuild installs its reject before it
# removes the old rules, so one interrupted run stays restrictive, but two runs
# interleaved across that sequence, or across two checkouts of /opt/hcw-src,
# are not. The lock is on fd 9 and every pass proves it holds it: no marker
# lets a pass skip the lock (CodeRabbit, #1099).
#   - A pass whose fd 9 is already the lock file (same device and inode) was
#     handed over by exec from a pass that opened it, and keeps that open file
#     description: flock -n on it succeeds at once, because it holds the lock.
#   - Any other pass opens the lock file and takes the lock, waiting for a run
#     that holds it. That includes a handover from a bootstrap.sh older than
#     this block, which opened nothing, and a pass started by hand with
#     HCW_BOOTSTRAP_HANDED_OVER set.
# The play inherits fd 9 too, so the lock is held until the play and anything
# it runs have ended, even if this script is killed first. What the play
# starts for good (systemd units, containers) is started by systemd or
# containerd and does not inherit it. The kernel releases the lock when the
# last holder exits.
#
# The file lives in /run itself, which only root can write, not /run/lock,
# which anyone can. It is opened read-write (9<>), which never truncates, and
# a path that is not a regular file is refused, so a planted symlink cannot
# turn the open into a write elsewhere (CodeRabbit, #1099). /run is a tmpfs,
# so no lock survives a reboot. HCW_BOOTSTRAP_LOCK_WAIT_SECONDS is a whole
# number of seconds: 0 refuses at once when another run holds the lock, and
# the default 1800 covers a full first run.
HCW_BOOTSTRAP_LOCK=/run/hcw-bootstrap.lock
HCW_BOOTSTRAP_LOCK_WAIT_SECONDS="${HCW_BOOTSTRAP_LOCK_WAIT_SECONDS:-1800}"
if ! [[ "${HCW_BOOTSTRAP_LOCK_WAIT_SECONDS}" =~ ^[0-9]+$ ]]; then
  echo "refusing to run: HCW_BOOTSTRAP_LOCK_WAIT_SECONDS must be a whole number of seconds, not '${HCW_BOOTSTRAP_LOCK_WAIT_SECONDS}'; nothing has been changed" >&2
  exit 1
fi
if [ -L "${HCW_BOOTSTRAP_LOCK}" ] || { [ -e "${HCW_BOOTSTRAP_LOCK}" ] && [ ! -f "${HCW_BOOTSTRAP_LOCK}" ]; }; then
  echo "refusing to run: ${HCW_BOOTSTRAP_LOCK} is not a regular file; nothing has been changed" >&2
  exit 1
fi
# Only this run's user (root, above) may own or read the file: flock works on a
# read-only descriptor, so a file anyone could open would let any local user
# hold the lock and stall every run. Created under umask 077 and set to 0600
# on every open; never unlinked, so every run locks the same inode.
if [ -e "${HCW_BOOTSTRAP_LOCK}" ] && [ "$(stat -c '%u' "${HCW_BOOTSTRAP_LOCK}")" != "$(id -u)" ]; then
  echo "refusing to run: ${HCW_BOOTSTRAP_LOCK} belongs to another user; nothing has been changed" >&2
  exit 1
fi
hcw_lock_id="$(stat -c '%d:%i' "${HCW_BOOTSTRAP_LOCK}" 2>/dev/null || true)"
if [ -z "${hcw_lock_id}" ] || [ "$(stat -L -c '%d:%i' "/proc/$$/fd/9" 2>/dev/null || true)" != "${hcw_lock_id}" ]; then
  hcw_umask="$(umask)"
  umask 077
  exec 9<>"${HCW_BOOTSTRAP_LOCK}"
  umask "${hcw_umask}"
  chmod 0600 "${HCW_BOOTSTRAP_LOCK}"
fi
if ! flock -n 9; then
  log "another bootstrap.sh run holds ${HCW_BOOTSTRAP_LOCK}; waiting up to ${HCW_BOOTSTRAP_LOCK_WAIT_SECONDS} s for it to finish"
  if ! flock -w "${HCW_BOOTSTRAP_LOCK_WAIT_SECONDS}" 9; then
    echo "refusing to run: another bootstrap.sh run still holds ${HCW_BOOTSTRAP_LOCK} after ${HCW_BOOTSTRAP_LOCK_WAIT_SECONDS} s; nothing has been changed" >&2
    echo "the processes holding it: sudo fuser -v ${HCW_BOOTSTRAP_LOCK}" >&2
    exit 1
  fi
fi

# 26.04 LTS is the target (owner decision 2026-09-26: the VPS runs it). 24.04
# LTS is accepted as a fallback and says so; anything else stops here. site.yml
# checks the same two releases (lab_host_ubuntu_releases in group_vars/all.yml),
# because the roles' per-release pins exist for these two and no others.
# shellcheck source=/dev/null
os_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
# shellcheck source=/dev/null
os_version="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
case "${os_id} ${os_version}" in
  "ubuntu 26.04") ;;
  "ubuntu 24.04")
    log "Ubuntu 24.04 is accepted, but the lab host's target is Ubuntu 26.04 LTS"
    ;;
  *)
    echo "bootstrap.sh is written for Ubuntu 26.04 LTS (and accepts 24.04 LTS); this host is not either" >&2
    grep '^PRETTY_NAME=' /etc/os-release >&2
    exit 1
    ;;
esac

# The uv asset, and every Docker, Arc and Node.js pin, is amd64.
if [ "$(uname -m)" != "x86_64" ]; then
  echo "bootstrap.sh is written for an x86_64 host and this one is $(uname -m)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# The first-run host check. Never configure a host that was not prepared for
# this repository.
#
# On 2026-09-26 the first run on the lab VPS met a host that had never been
# reinstalled: two self-hosted GitHub Actions runners, Portainer, an nginx site
# on :80, k3s, Vault and a July install of the old agent in
# /opt/hcw-labs-agent. Before failing at the agent's checkout it upgraded and
# restarted Docker (killing a running Dependabot job), enabled ufw and rewrote
# sshd's configuration. So a host this script has never accepted is examined
# first, before this script changes anything, and a host that shows another
# workload is refused, with what was found and the two ways on: reinstall, or
# HCW_ADOPT_NONEMPTY_HOST=1 to accept it knowingly.
#
# The first run that passes (or is told to adopt the host) writes
# HCW_HOST_MARKER before its first change, and every run that finishes adds
# its commit and time. While the marker exists the check is skipped, so a
# re-run is never judged on this repository's own work: a first run that fails
# half-way has already installed Docker, Caddy and uv, and the host was
# accepted before any of that. Delete the marker only to make the next run
# check again.
#
# Each check names a thing this repository never creates on a host it has not
# accepted, and each would have caught the 2026-09-26 host:
#
#   - any Docker container, running or stopped: the Docker role upgrades and
#     restarts the daemon, and a restart starts every stopped container whose
#     restart policy is `always`, so a stopped one is as much in the way;
#   - an installed actions.runner.* systemd unit (a self-hosted runner, which
#     ADR 0025 and ADR 0032 reject on this public repository's hosts);
#   - Kubernetes: a k3s, k0s, rke2, kubelet or microk8s unit, or k3s's and
#     kubeadm's own directories (ADR 0032: no Kubernetes on this host);
#   - labs_agent_home, or the repository checkout, holding anything but a
#     checkout of this repository;
#   - anything else under /opt, where the old agent, the runners and vendor
#     installs live and where a fresh Ubuntu has nothing;
#   - a TCP listener other than sshd's port 22 and systemd-resolved's
#     127.0.0.53 and 127.0.0.54 port 53 (the old host's nginx held :80).
#
# docs/runbooks/labs-host.md, "Reinstalling the host", is the procedure the
# refusal points at.
# ---------------------------------------------------------------------------
HCW_HOST_MARKER=/etc/hcw/bootstrap-host-accepted
HCW_ADOPT_NONEMPTY_HOST="${HCW_ADOPT_NONEMPTY_HOST:-}"
hcw_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# A top-level scalar from group_vars/all.yml beside this script, or the
# fallback when the script runs from outside a checkout. Text, not YAML: the
# two keys read here are plain `key: value` lines.
group_var() {
  local file="${hcw_script_dir}/ansible/group_vars/all.yml" value=""
  if [ -f "${file}" ]; then
    value="$(sed -n "s/^$1:[[:space:]]*//p" "${file}" | head -n 1 | tr -d "\"'")"
  fi
  printf '%s' "${value:-$2}"
}

labs_agent_home="$(group_var labs_agent_home /opt/hcw-labs-agent)"
labs_agent_repo_url="$(group_var labs_agent_repo_url "${HCW_REPO_URL}")"

# A URL without a trailing slash or .git, so the two spellings of one
# repository compare equal.
normalise_url() {
  printf '%s' "$1" | sed -e 's#/*$##' -e 's#\.git$##'
}

# The origin URL recorded in a checkout's .git/config, read without git
# (a fresh host may not have it yet). Prints nothing for a directory that is
# not a checkout.
checkout_origin() {
  [ -f "$1/.git/config" ] || return 0
  awk '/^\[remote "origin"\]/ { origin = 1; next }
       /^\[/ { origin = 0 }
       origin && $1 == "url" { sub(/^[^=]*=[[:space:]]*/, ""); print; exit }' "$1/.git/config"
}

# True when a directory is a checkout of this repository, under either URL
# this script knows it by (HCW_REPO_URL for the playbook, labs_agent_repo_url
# for the agent).
is_this_repository() {
  local origin
  origin="$(normalise_url "$(checkout_origin "$1")")"
  [ -n "${origin}" ] || return 1
  [ "${origin}" = "$(normalise_url "${HCW_REPO_URL}")" ] || [ "${origin}" = "$(normalise_url "${labs_agent_repo_url}")" ]
}

# One line per sign of another workload. Prints nothing on an empty host.
find_other_workloads() {
  local line unit state path entry

  if command -v docker >/dev/null 2>&1 && timeout 30 docker info >/dev/null 2>&1; then
    while IFS= read -r line; do
      [ -n "${line}" ] && printf 'Docker container %s\n' "${line}"
    done < <(timeout 30 docker ps --all --format '{{.Names}} ({{.Image}}, {{.Status}})')
  elif [ -d /var/lib/docker/containers ] && [ -n "$(ls -A /var/lib/docker/containers 2>/dev/null)" ]; then
    printf '%s container directories under /var/lib/docker/containers, and the Docker daemon is not answering\n' \
      "$(find /var/lib/docker/containers -mindepth 1 -maxdepth 1 -type d | wc -l)"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    while read -r unit state _; do
      [ -n "${unit}" ] && printf 'systemd unit %s (%s): a GitHub Actions self-hosted runner\n' "${unit}" "${state}"
    done < <(systemctl list-unit-files --no-legend --plain 'actions.runner.*' 2>/dev/null)
    while read -r unit state _; do
      [ -n "${unit}" ] && printf 'systemd unit %s (%s): Kubernetes\n' "${unit}" "${state}"
    done < <(systemctl list-unit-files --no-legend --plain 'k3s*' 'k0s*' 'rke2*' 'kubelet.service' 'snap.microk8s.*' 2>/dev/null)
  fi
  for path in /usr/local/bin/k3s /etc/rancher /var/lib/rancher /etc/kubernetes /var/lib/kubelet; do
    [ -e "${path}" ] && printf '%s exists: Kubernetes\n' "${path}"
  done

  # The checkout this script runs from, and the agent's, may exist already:
  # infra-lab/README.md step 7 clones the repository to HCW_SRC_DIR before it
  # runs this script. Either is fine when it is this repository, and a finding
  # when it is anything else (the old agent's July install, on 2026-09-26).
  for path in "${HCW_SRC_DIR}" "${labs_agent_home}"; do
    if [ -e "${path}" ] && ! is_this_repository "${path}"; then
      printf '%s exists and is not a checkout of %s\n' "${path}" "${HCW_REPO_URL}"
    fi
  done
  # Everything else under /opt. /opt/uv is this script's own (uv, its Python
  # and the ansible-core environment), present before the check only when an
  # older bootstrap.sh, which had no check, hands over to this one.
  for entry in /opt/* /opt/.[!.]*; do
    [ -e "${entry}" ] || continue
    case "${entry}" in
      "${HCW_SRC_DIR}" | "${labs_agent_home}" | /opt/uv) continue ;;
    esac
    printf '%s: not created by this repository\n' "${entry}"
  done

  if command -v ss >/dev/null 2>&1; then
    while read -r _ _ _ address _ process; do
      case "${address}" in
        *:22 | 127.0.0.53:53 | 127.0.0.53%*:53 | 127.0.0.54:53) continue ;;
      esac
      # users:(("nginx",pid=812,fd=6),...) -> nginx
      process="$(printf '%s' "${process}" | sed -n 's/^users:(("\([^"]*\)".*/\1/p')"
      printf 'TCP listener on %s (%s)\n' "${address}" "${process:-process not shown}"
    done < <(ss -Hltnp 2>/dev/null)
  fi
  return 0
}

if [ -f "${HCW_HOST_MARKER}" ]; then
  log "host check: skipped; ${HCW_HOST_MARKER} records that this host was accepted ($(sed -n 's/^accepted_as=//p' "${HCW_HOST_MARKER}") on $(sed -n 's/^accepted_on=//p' "${HCW_HOST_MARKER}"))"
else
  log "host check: this host has not run bootstrap.sh before; looking for other workloads first"
  hcw_findings="$(find_other_workloads)"
  if [ -n "${hcw_findings}" ] && [ "${HCW_ADOPT_NONEMPTY_HOST}" != "1" ]; then
    {
      echo "[bootstrap] refusing to configure this host: it shows signs of other workloads, and bootstrap.sh has never run here (no ${HCW_HOST_MARKER})."
      echo "[bootstrap] found:"
      printf '%s\n' "${hcw_findings}" | sed 's/^/[bootstrap]   - /'
      echo "[bootstrap] nothing has been changed. A run would move Docker to its pinned version and restart it, enable ufw with only TCP 22, 80 and 443 open, and replace sshd's login settings, whatever the workloads above need."
      echo "[bootstrap] either reinstall the server with Ubuntu 26.04 LTS and run this again (docs/runbooks/labs-host.md, \"Reinstalling the host\"),"
      echo "[bootstrap] or, only if every item above is meant to stay and may be disrupted, accept the host knowingly:"
      echo "[bootstrap]   HCW_ADOPT_NONEMPTY_HOST=1 ${hcw_script_dir}/bootstrap.sh"
    } >&2
    exit 3
  fi
  hcw_accepted_as=empty
  if [ -n "${hcw_findings}" ]; then
    hcw_accepted_as=adopted
    log "host check: HCW_ADOPT_NONEMPTY_HOST=1, so adopting a host that shows other workloads:"
    printf '%s\n' "${hcw_findings}" | sed 's/^/[bootstrap]   - /'
  else
    log "host check: no other workloads found"
  fi
  install -d -m 0755 -o root -g root "$(dirname "${HCW_HOST_MARKER}")"
  {
    echo "# Written by lab-host/bootstrap.sh (docs/runbooks/labs-host.md, \"The first-run host check\")."
    echo "# While this file exists, bootstrap.sh does not check the host for other workloads again;"
    echo "# delete it only to make the next run check again."
    echo "accepted_on=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "accepted_as=${hcw_accepted_as}"
    if [ -n "${hcw_findings}" ]; then
      printf '%s\n' "${hcw_findings}" | sed 's/^/adopted_with=/'
    fi
  } >"${HCW_HOST_MARKER}.tmp"
  chmod 0644 "${HCW_HOST_MARKER}.tmp"
  mv "${HCW_HOST_MARKER}.tmp" "${HCW_HOST_MARKER}"
  log "host check: recorded in ${HCW_HOST_MARKER}"
fi

log "installing prerequisites"
# A freshly booted host runs unattended-upgrades within minutes and holds the
# dpkg lock while it does; wait for it (the playbook's apt tasks use the same
# fifteen minutes) rather than failing on the first boot.
apt-get -o DPkg::Lock::Timeout=900 update -q
apt-get -o DPkg::Lock::Timeout=900 install -y -q --no-install-recommends git python3 python3-apt ca-certificates curl sudo

if ! "${UV_BIN}" --version 2>/dev/null | grep -qx "uv ${UV_VERSION}\( .*\)\?"; then
  log "installing uv ${UV_VERSION} from its GitHub release, SHA256-verified"
  uv_tmp="$(mktemp -d)"
  trap 'rm -rf "${uv_tmp}"' EXIT
  uv_archive=uv-x86_64-unknown-linux-gnu.tar.gz
  curl -fsSL --proto '=https' --tlsv1.2 -o "${uv_tmp}/${uv_archive}" \
    "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uv_archive}"
  if [ "$(sha256sum "${uv_tmp}/${uv_archive}" | cut -d ' ' -f 1)" != "${UV_SHA256}" ]; then
    echo "refusing to install uv: ${uv_archive} does not match UV_SHA256" >&2
    exit 1
  fi
  tar -xzf "${uv_tmp}/${uv_archive}" -C "${uv_tmp}"
  install -m 0755 -o root -g root "${uv_tmp}/uv-x86_64-unknown-linux-gnu/uv" "${UV_BIN}"
  rm -rf "${uv_tmp}"
  trap - EXIT
fi

log "installing CPython ${PYTHON_VERSION} with uv"
"${UV_BIN}" python install --no-bin "${PYTHON_VERSION}"

# Reinstalled when either pin moves, so a Python bump rebuilds the environment
# rather than leaving ansible-core on the interpreter before it.
if ! "${UV_TOOL_BIN_DIR}/ansible-playbook" --version 2>/dev/null | grep -q "core ${ANSIBLE_CORE_VERSION}]" \
  || ! "${UV_TOOL_BIN_DIR}/ansible-playbook" --version 2>/dev/null | grep -qF "python version = ${PYTHON_VERSION} ("; then
  log "installing ansible-core ${ANSIBLE_CORE_VERSION} on CPython ${PYTHON_VERSION} with uv"
  "${UV_BIN}" tool install --force --managed-python --python "${PYTHON_VERSION}" "ansible-core==${ANSIBLE_CORE_VERSION}"
fi
"${UV_TOOL_BIN_DIR}/ansible-playbook" --version | sed -n '1p;/python version/p'

if [ -d "${HCW_SRC_DIR}/.git" ]; then
  # A checkout keeps the origin it was cloned from. One made before the
  # repository moved to saulpatinojr (2026-10-07) still names the old
  # organisation, which answers only through GitHub's redirect, and changing
  # HCW_REPO_URL alone never repointed it while the log line printed the new
  # URL as if it had (#1009). So the origin is set to HCW_REPO_URL when the two
  # differ, and the line names the origin the fetch really uses.
  hcw_current_origin="$(git -C "${HCW_SRC_DIR}" remote get-url origin 2>/dev/null || true)"
  if [ "$(normalise_url "${hcw_current_origin}")" != "$(normalise_url "${HCW_REPO_URL}")" ]; then
    log "repointing origin of ${HCW_SRC_DIR} from ${hcw_current_origin:-nothing} to ${HCW_REPO_URL}"
    if [ -n "${hcw_current_origin}" ]; then
      git -C "${HCW_SRC_DIR}" remote set-url origin "${HCW_REPO_URL}"
    else
      git -C "${HCW_SRC_DIR}" remote add origin "${HCW_REPO_URL}"
    fi
  fi
  log "fetching $(git -C "${HCW_SRC_DIR}" remote get-url origin)"
  git -C "${HCW_SRC_DIR}" fetch --quiet origin
else
  log "cloning ${HCW_REPO_URL} into ${HCW_SRC_DIR}"
  git clone --quiet "${HCW_REPO_URL}" "${HCW_SRC_DIR}"
fi
if ! hcw_repo_sha="$(git -C "${HCW_SRC_DIR}" rev-parse --verify --quiet "${HCW_REPO_REF}^{commit}")"; then
  echo "refusing to run: HCW_REPO_REF=${HCW_REPO_REF} does not name a commit in ${HCW_SRC_DIR} after the fetch" >&2
  exit 1
fi
log "checking out ${HCW_REPO_REF} at ${hcw_repo_sha}"
git -C "${HCW_SRC_DIR}" checkout --quiet --detach "${hcw_repo_sha}"

# The pins at the top of this file are part of the commit too. When the commit
# just checked out carries a different bootstrap.sh (a uv, Python or
# ansible-core bump, say), hand over to it rather than run the rest of the old
# one, so a change to this file takes effect on the run that fetches it and not
# one run later. HCW_REPO_REF is passed on as the resolved sha, so the second
# pass checks out the same commit, and HCW_BOOTSTRAP_HANDED_OVER stops it
# handing over again.
hcw_checked_out_script="${HCW_SRC_DIR}/lab-host/bootstrap.sh"
if [ -z "${HCW_BOOTSTRAP_HANDED_OVER:-}" ] && [ -f "${hcw_checked_out_script}" ] \
  && [ "$(sha256sum "${hcw_checked_out_script}" | cut -d ' ' -f 1)" != "${self_digest}" ]; then
  log "${hcw_repo_sha} carries a different bootstrap.sh; handing over to it"
  HCW_BOOTSTRAP_HANDED_OVER=1 HCW_REPO_REF="${hcw_repo_sha}" exec bash "${hcw_checked_out_script}" "$@"
fi

cd "${HCW_SRC_DIR}/lab-host/ansible"

log "installing collections from requirements.yml"
"${UV_TOOL_BIN_DIR}/ansible-galaxy" collection install -r requirements.yml

extra_args=()
if [ -f "${HCW_VAULT_FILE}" ] && [ -f "${HCW_VAULT_PASSWORD_FILE}" ]; then
  log "using the vault at ${HCW_VAULT_FILE}"
  extra_args+=(--vault-password-file "${HCW_VAULT_PASSWORD_FILE}" -e "@${HCW_VAULT_FILE}")
elif [ -f "${HCW_VAULT_FILE}" ] || [ -f "${HCW_VAULT_PASSWORD_FILE}" ]; then
  echo "refusing to run: one of ${HCW_VAULT_FILE} and ${HCW_VAULT_PASSWORD_FILE} exists and the other does not" >&2
  echo "a half-present vault would be treated as no vault, turning TLS off and stopping the agent; restore the missing file or remove both" >&2
  exit 1
else
  log "no vault at ${HCW_VAULT_FILE}: Caddy answers 503 over plain HTTP and the agent stays stopped until one exists"
fi

log "running site.yml from ${hcw_repo_sha} against localhost"
# The play inherits fd 9, so the lock outlives this script if it is killed
# while the play runs (the block after the root check says why).
"${UV_TOOL_BIN_DIR}/ansible-playbook" -i inventory/localhost.yml site.yml "${extra_args[@]}" "$@"

# The play finished (set -e ends the script on a failed one). Record which
# commit the host now runs in the host-check marker, unless this was a check
# run, which changed nothing the marker should claim, or a run narrowed with
# --tags / --skip-tags, which converged one area and not the host (the play's
# own commit record skips those the same way).
hcw_check_mode=
hcw_partial=
for arg in "$@"; do
  case "${arg}" in
    --check | -C) hcw_check_mode=1 ;;
    --tags | --tags=* | -t | --skip-tags | --skip-tags=*) hcw_partial=1 ;;
  esac
done
if [ -n "${hcw_partial}" ] && [ -z "${hcw_check_mode}" ]; then
  log "a run narrowed with --tags or --skip-tags is not recorded as a completed run; the next full run is"
fi
if [ -z "${hcw_check_mode}" ] && [ -z "${hcw_partial}" ]; then
  {
    grep -v '^completed_' "${HCW_HOST_MARKER}" || true
    echo "completed_on=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "completed_commit=${hcw_repo_sha}"
  } >"${HCW_HOST_MARKER}.tmp"
  chmod 0644 "${HCW_HOST_MARKER}.tmp"
  mv "${HCW_HOST_MARKER}.tmp" "${HCW_HOST_MARKER}"
  log "recorded ${hcw_repo_sha} as the last completed run in ${HCW_HOST_MARKER}"
fi
