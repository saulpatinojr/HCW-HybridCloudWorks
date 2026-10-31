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
# releases behind that line's newest (3.14.7 that day, so a 3.14.5 floor), and
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

# Tool versions. A bump is an edit here and a re-run.
# uv 0.13.6 (released 2026-10-26), the newest release and the first whose
# built-in list of interpreters has CPython 3.15.2 (0.12.19 stopped at
# 3.15.0rc2, 0.13.5 at 3.15.1). UV_SHA256 is the release's own
# uv-x86_64-unknown-linux-gnu.tar.gz.sha256 asset, read on 2026-10-31 from
# Astral's download mirror (releases.astral.sh/github/uv/releases/download/),
# which served the same value for 0.12.19 as the line this replaced, and
# equal to the sha256sum of the tarball downloaded there. Not checked that
# day: `gh attestation verify --repo astral-sh/uv`, which traces the file to
# that repository's release workflow; run it before this leaves draft.
UV_VERSION=0.13.6
UV_SHA256=f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645
# CPython 3.15.2, the newest release of the newest line. uv 0.13.6 pins its
# python-build-standalone 20261026 build by SHA256.
PYTHON_VERSION=3.15.2
# cosign, for SLSA build provenance attestation verification of add-on
# images before pull (#1069). COSIGN_SHA256 is the sha256sum of cosign-linux-amd64
# from the release page of COSIGN_VERSION, https://github.com/sigstore/cosign/releases,
# equal to that release's cosign_checksums.txt entry. The weekly pin bump
# (scripts/lab-pins-upstream.mjs --bump host) moves both lines, and the same
# release in cosign_version and cosign_checksum of ansible/group_vars/all.yml,
# together. These comments name no version, so a bump cannot leave them behind.
COSIGN_VERSION=3.1.4
COSIGN_SHA256=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa
# ansible-core is not pinned here. Its release, the SHA256 of its wheel and
# the hash of every wheel it depends on are the ANSIBLE_CORE_VERSION,
# ANSIBLE_CORE_SHA256 and ANSIBLE_CORE_DEPS lines of lab-image/versions.env,
# the lines the lab image is built from; the block after the checkout below
# reads them from the commit the host is about to run, so a bump is an edit
# there and a re-run, with no copy here to drift (LAB-13, #959). The control
# side runs on the uv interpreter above on either Ubuntu release, so the
# 24.04 fallback never holds that pin back: it only decides which Python the
# modules run on (3.12.3 there, 3.14.4 on 26.04). Before a bump to a new
# ansible-core line, check its module-side Python range still includes
# 24.04's 3.12, or drop 24.04.

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
# where the README's ansible-vault lines expect them. HCW_ANSIBLE_VENV is a
# symlink to the environment in use, one of the generations under
# HCW_ANSIBLE_GENERATIONS (the block after the checkout says how it moves).
# hcw-vault-set (ansible/roles/vault_tools), installed as HCW_VAULT_HELPER,
# runs its Python through that link, and that role's test holds the two paths
# equal. UV_TOOL_DIR is where an earlier bootstrap.sh kept ansible-core as a
# uv tool, named here only so this script can retire it once nothing runs it.
UV_BIN=/usr/local/bin/uv
COSIGN_BIN=/usr/local/bin/cosign
HCW_ANSIBLE_VENV=/opt/uv/ansible-core
HCW_ANSIBLE_GENERATIONS=/opt/uv/ansible-core-generations
HCW_VAULT_HELPER=/usr/local/sbin/hcw-vault-set
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

if ! "${COSIGN_BIN}" version 2>/dev/null | grep -q "${COSIGN_VERSION}"; then
  log "installing cosign ${COSIGN_VERSION} from its GitHub release, SHA256-verified"
  cosign_tmp="$(mktemp -d)"
  trap 'rm -rf "${cosign_tmp}"' EXIT
  cosign_binary=cosign-linux-amd64
  curl -fsSL --proto '=https' --tlsv1.2 -o "${cosign_tmp}/${cosign_binary}" \
    "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/${cosign_binary}"
  if [ "$(sha256sum "${cosign_tmp}/${cosign_binary}" | cut -d ' ' -f 1)" != "${COSIGN_SHA256}" ]; then
    echo "refusing to install cosign: ${cosign_binary} does not match COSIGN_SHA256" >&2
    exit 1
  fi
  install -m 0755 -o root -g root "${cosign_tmp}/${cosign_binary}" "${COSIGN_BIN}"
  rm -rf "${cosign_tmp}"
  trap - EXIT
fi

log "installing CPython ${PYTHON_VERSION} with uv"
"${UV_BIN}" python install --no-bin "${PYTHON_VERSION}"

# Check mode and narrowed runs are parsed early so a check run can execute
# from a temporary worktree without moving the host's applied checkout (#950).
hcw_check_mode=
hcw_partial=
for arg in "$@"; do
  case "${arg}" in
    --check | -C) hcw_check_mode=1 ;;
    # -t* covers both `-t addons` and the attached form `-taddons`.
    --tags | --tags=* | -t* | --skip-tags | --skip-tags=*) hcw_partial=1 ;;
  esac
done

hcw_worktree_dir=
hcw_effective_src="${HCW_SRC_DIR}"
hcw_cleanup() {
  if [ -n "${hcw_ansible_requirements:-}" ] && [ -f "${hcw_ansible_requirements}" ]; then
    rm -f "${hcw_ansible_requirements}"
  fi
  if [ -n "${hcw_worktree_dir:-}" ] && [ -d "${hcw_worktree_dir}" ]; then
    log "removing temporary worktree ${hcw_worktree_dir}"
    git -C "${HCW_SRC_DIR}" worktree remove --force "${hcw_worktree_dir}" 2>/dev/null || rm -rf -- "${hcw_worktree_dir}"
  fi
}
trap hcw_cleanup EXIT

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
if [ -n "${hcw_check_mode}" ]; then
  hcw_worktree_dir="$(mktemp -d /run/hcw-bootstrap-worktree.XXXXXX 2>/dev/null || mktemp -d /tmp/hcw-bootstrap-worktree.XXXXXX)"
  log "running check mode in temporary worktree ${hcw_worktree_dir} at ${hcw_repo_sha} (leaving ${HCW_SRC_DIR} alone)"
  git -C "${HCW_SRC_DIR}" worktree add --quiet --detach "${hcw_worktree_dir}" "${hcw_repo_sha}"
  hcw_effective_src="${hcw_worktree_dir}"
else
  log "checking out ${HCW_REPO_REF} at ${hcw_repo_sha}"
  git -C "${HCW_SRC_DIR}" checkout --quiet --detach "${hcw_repo_sha}"
fi

# The pins at the top of this file are part of the commit too. When the commit
# just checked out carries a different bootstrap.sh (a uv or Python bump, say),
# hand over to it rather than run the rest of the old one, so a change to this
# file takes effect on the run that fetches it and not one run later.
# ansible-core's pins need no handover: they are in lab-image/versions.env,
# which the block below reads from this checkout. HCW_REPO_REF is passed on as
# the resolved sha, so the second pass checks out the same commit, and
# HCW_BOOTSTRAP_HANDED_OVER stops it handing over again. Check runs skip handover
# because they inspect the host from a temporary worktree and do not upgrade
# the host runtime (#950).
hcw_checked_out_script="${hcw_effective_src}/lab-host/bootstrap.sh"
if [ -z "${HCW_BOOTSTRAP_HANDED_OVER:-}" ] && [ -f "${hcw_checked_out_script}" ] \
  && [ "$(sha256sum "${hcw_checked_out_script}" | cut -d ' ' -f 1)" != "${self_digest}" ]; then
  if [ -z "${hcw_check_mode}" ]; then
  if ! grep -q '^HCW_ANSIBLE_VENV=' "${hcw_checked_out_script}" \
    && [ "$(readlink "${UV_TOOL_BIN_DIR}/ansible-playbook" || true)" = "${HCW_ANSIBLE_VENV}/bin/ansible-playbook" ]; then
    log "${hcw_repo_sha}'s bootstrap.sh installs ansible-core as a uv tool; removing ${UV_TOOL_BIN_DIR}/ansible-playbook so that it does"
    rm -f "${UV_TOOL_BIN_DIR}/ansible-playbook"
  fi
  log "${hcw_repo_sha} carries a different bootstrap.sh; handing over to it"
  HCW_BOOTSTRAP_HANDED_OVER=1 HCW_REPO_REF="${hcw_repo_sha}" exec bash "${hcw_checked_out_script}" "$@"
  else
    log "check mode: skipping handover to checked-out bootstrap.sh"
  fi
fi

# ansible-core, every wheel checked against its SHA256 (LAB-13, #959). The
# pins are the ANSIBLE_CORE_VERSION, ANSIBLE_CORE_SHA256 and ANSIBLE_CORE_DEPS
# lines of lab-image/versions.env in the commit just checked out, read as
# data and never sourced, so an edit to that file can change these pins but
# cannot run anything here as root (CodeRabbit, #1189). Each value must be
# written as the file and the weekly bumper write it today: the version and
# hash unquoted, the DEPS block between an `ANSIBLE_CORE_DEPS='` line and a
# lone `'`; any other spelling yields no pins and the run refuses. Every line
# of the result must then be one pinned, hashed wheel, so nothing in the file
# can reach uv as an option (`--index-url` is a valid requirements line). The
# requirements file is written exactly as lab-image/Dockerfile's fetch stage
# writes it: one `name==version --hash=sha256:<hex>` line for ansible-core and
# one for every wheel it depends on. `uv pip install --require-hashes`
# refuses a wheel whose SHA256 differs and any dependency the resolver
# reaches that the file does not list
# (https://docs.astral.sh/uv/reference/cli/#uv-pip-install--require-hashes),
# and `--only-binary :all:` means nothing is built from source. It replaces
# `uv tool install`, which takes no hashes, so the SHA256 an earlier
# bootstrap.sh printed beside it verified nothing.
#
# The environment is a venv on the uv interpreter above, one generation per
# build: a directory under HCW_ANSIBLE_GENERATIONS whose name starts with its
# ansible-core release, its Python and the first twelve hex digits of its
# requirements file's SHA256 (the pins prefix), so a dependency bump and a
# Python bump each start a new prefix, and ends with the build's UTC time and
# a random tag, so no build ever reuses a directory. HCW_ANSIBLE_VENV is a
# symlink to the generation in use, and the four commands and hcw-vault-set
# reach ansible-core only through it.
#
# A generation is complete when its copy of the requirements file, written
# last, matches and its ansible-playbook reports the pinned release and
# Python. The run uses the generation in use when it is a complete build of
# these pins, or else any other complete build of them (a switch back after a
# rollback), and only when there is none builds a new one beside it: installed,
# checked with `uv pip check`, counted (it holds exactly as many packages as
# the file has lines, the fetch stage's check), and asked for its release and
# Python. Only then is the link switched, by renaming a new link over it, which
# is atomic, so a download, hash or check failure stops the run with every
# command and the helper still on the generation they were using, even when
# that one is a build of these pins that has stopped passing (CodeRabbit,
# #1189): it may still serve the helper, and the failure may be passing. A
# venv's commands name its directory in their first line, so a build cannot be
# made elsewhere and moved into place; it gets a directory of its own instead.
#
# Nothing the link points to is removed before the link has moved off it.
# After the switch, the generation switched away from is removed when it was a
# build of the same pins, which the new build replaces, and otherwise kept
# until the next switch, so holding a host back with HCW_REPO_REF to the
# commit that pinned it switches back without a download; any older one is
# removed then. Before a build, the other builds of these pins, none of which
# is complete, are removed, except the one in use.
hcw_ansible_requirements="$(mktemp)"
trap 'rm -f "${hcw_ansible_requirements}"' EXIT
# hcw_read_ansible_pins FILE: set the three ANSIBLE_CORE_* variables from
# FILE's lines as text, never evaluating it; fails when no complete DEPS
# block is there.
hcw_read_ansible_pins() {
  local line in_deps=0 saw_deps=0
  ANSIBLE_CORE_VERSION='' ANSIBLE_CORE_SHA256='' ANSIBLE_CORE_DEPS=''
  while IFS= read -r line || [ -n "${line}" ]; do
    if [ "${in_deps}" = 1 ]; then
      # A requirement starts lower-case; an assignment here means the block
      # was never closed and the next variable's lines would be read as pins.
      case "${line}" in [A-Z]*=*) return 1 ;; esac
      if [ "${line}" = "'" ]; then
        in_deps=0
        saw_deps=1
      else
        ANSIBLE_CORE_DEPS="${ANSIBLE_CORE_DEPS}${line}
"
      fi
      continue
    fi
    case "${line}" in
      ANSIBLE_CORE_VERSION=*) ANSIBLE_CORE_VERSION="${line#ANSIBLE_CORE_VERSION=}" ;;
      ANSIBLE_CORE_SHA256=*) ANSIBLE_CORE_SHA256="${line#ANSIBLE_CORE_SHA256=}" ;;
      "ANSIBLE_CORE_DEPS='") in_deps=1 ;;
    esac
  done <"$1"
  [ "${saw_deps}" = 1 ] && [ "${in_deps}" = 0 ]
}
(
  if ! hcw_read_ansible_pins "${HCW_SRC_DIR}/lab-image/versions.env"; then
    echo "refusing to run: lab-image/versions.env at ${hcw_repo_sha} has no complete ANSIBLE_CORE_DEPS block" >&2
    exit 1
  fi
  printf 'ansible-core==%s --hash=sha256:%s\n' "${ANSIBLE_CORE_VERSION}" "${ANSIBLE_CORE_SHA256}"
  printf '%s\n' "${ANSIBLE_CORE_DEPS}" | sed '/^[[:space:]]*$/d'
) >"${hcw_ansible_requirements}"
# The release is part of a directory name below, so it may hold only what a
# version does: no slash, no space.
hcw_ansible_core_version="$(sed -n 's/^ansible-core==\([0-9][0-9A-Za-z.+!]*\) --hash=sha256:[0-9a-f]\{64\}$/\1/p' "${hcw_ansible_requirements}")"
if [ -z "${hcw_ansible_core_version}" ]; then
  echo "refusing to run: lab-image/versions.env at ${hcw_repo_sha} names no ansible-core version with a SHA256" >&2
  exit 1
elif grep -qvE '^[a-z0-9][a-z0-9._-]*==[0-9][0-9A-Za-z.+!]* --hash=sha256:[0-9a-f]{64}$' "${hcw_ansible_requirements}"; then
  echo "refusing to run: lab-image/versions.env at ${hcw_repo_sha} has an ansible-core requirement that is not one pinned, hashed wheel (name==version --hash=sha256:<64 hex>)" >&2
  exit 1
fi
hcw_ansible_lines="$(wc -l <"${hcw_ansible_requirements}")"
hcw_ansible_prefix="${HCW_ANSIBLE_GENERATIONS}/${hcw_ansible_core_version}-py${PYTHON_VERSION}-$(sha256sum "${hcw_ansible_requirements}" | cut -c 1-12)"
hcw_ansible_in_use="$(readlink "${HCW_ANSIBLE_VENV}" || true)"

# True when a generation's ansible-playbook runs and reports this ansible-core
# release on this Python. The output is read once, so grep never closes the
# pipe on a command still writing to it.
hcw_ansible_answers() {
  local hcw_version_output
  hcw_version_output="$("$1/bin/ansible-playbook" --version 2>/dev/null)" || return 1
  grep -qF "[core ${hcw_ansible_core_version}]" <<<"${hcw_version_output}" \
    && grep -qF "python version = ${PYTHON_VERSION} (" <<<"${hcw_version_output}"
}

# True when a generation is a complete build of these pins: its copy of the
# requirements file matches, and it answers.
hcw_ansible_complete() {
  cmp -s "${hcw_ansible_requirements}" "$1/hcw-requirements.txt" && hcw_ansible_answers "$1"
}

# The four commands are linked through HCW_ANSIBLE_VENV, not to a generation,
# so switching that one link moves all of them at once.
hcw_link_ansible_commands() {
  local hcw_ansible_command
  for hcw_ansible_command in ansible ansible-playbook ansible-galaxy ansible-vault; do
    ln -sfn "${HCW_ANSIBLE_VENV}/bin/${hcw_ansible_command}" "${UV_TOOL_BIN_DIR}/${hcw_ansible_command}"
  done
}

hcw_ansible_generation=
if [[ "${hcw_ansible_in_use}" == "${hcw_ansible_prefix}"* ]] && hcw_ansible_complete "${hcw_ansible_in_use}"; then
  hcw_ansible_generation="${hcw_ansible_in_use}"
else
  for hcw_ansible_candidate in "${hcw_ansible_prefix}"*; do
    if [ "${hcw_ansible_candidate}" != "${hcw_ansible_in_use}" ] && hcw_ansible_complete "${hcw_ansible_candidate}"; then
      hcw_ansible_generation="${hcw_ansible_candidate}"
      break
    fi
  done
fi

if [ -z "${hcw_ansible_generation}" ]; then
  if [[ "${hcw_ansible_in_use}" == "${hcw_ansible_prefix}"* ]]; then
    log "${hcw_ansible_in_use} is a build of these pins that no longer passes its checks; it stays in use until a new build passes"
  fi
  for hcw_ansible_candidate in "${hcw_ansible_prefix}"*; do
    [ "${hcw_ansible_candidate}" = "${hcw_ansible_in_use}" ] || rm -rf -- "${hcw_ansible_candidate}"
  done
  install -d -m 0755 -o root -g root "${HCW_ANSIBLE_GENERATIONS}"
  # mktemp picks a name nothing has, and uv makes the venv there itself.
  hcw_ansible_generation="$(mktemp -d "${hcw_ansible_prefix}-$(date -u +%Y%m%dT%H%M%SZ)-XXXX")"
  rmdir -- "${hcw_ansible_generation}"
  hcw_ansible_python="${hcw_ansible_generation}/bin/python"
  hcw_ansible_record="${hcw_ansible_generation}/hcw-requirements.txt"
  log "installing ansible-core ${hcw_ansible_core_version} and the $((hcw_ansible_lines - 1)) wheels it depends on into ${hcw_ansible_generation} on CPython ${PYTHON_VERSION}, each checked against its SHA256 in lab-image/versions.env; ${HCW_ANSIBLE_VENV} moves to it only once it passes"
  "${UV_BIN}" venv --managed-python --python "${PYTHON_VERSION}" "${hcw_ansible_generation}"
  "${UV_BIN}" pip install --python "${hcw_ansible_python}" --require-hashes --only-binary :all: -r "${hcw_ansible_requirements}"
  "${UV_BIN}" pip check --python "${hcw_ansible_python}"
  hcw_ansible_installed="$("${UV_BIN}" pip freeze --python "${hcw_ansible_python}" | wc -l)"
  if [ "${hcw_ansible_installed}" -ne "${hcw_ansible_lines}" ]; then
    echo "refusing to run: ${hcw_ansible_generation} holds ${hcw_ansible_installed} packages, and lab-image/versions.env lists ${hcw_ansible_lines}; ${HCW_ANSIBLE_VENV} still points to ${hcw_ansible_in_use:-nothing}" >&2
    exit 1
  fi
  if ! hcw_ansible_answers "${hcw_ansible_generation}"; then
    echo "refusing to run: ${hcw_ansible_generation}/bin/ansible-playbook does not report ansible-core ${hcw_ansible_core_version} on CPython ${PYTHON_VERSION}; ${HCW_ANSIBLE_VENV} still points to ${hcw_ansible_in_use:-nothing}" >&2
    exit 1
  fi
  install -m 0644 -o root -g root "${hcw_ansible_requirements}" "${hcw_ansible_record}"
fi
rm -f "${hcw_ansible_requirements}"
trap - EXIT
if [ -n "${hcw_worktree_dir:-}" ]; then
  trap hcw_cleanup EXIT
fi

if [ "${hcw_ansible_in_use}" != "${hcw_ansible_generation}" ]; then
  # A venv built in place at HCW_ANSIBLE_VENV, as this change's first
  # revision did, goes first: rename cannot put a link over a directory.
  if [ -d "${HCW_ANSIBLE_VENV}" ] && [ ! -L "${HCW_ANSIBLE_VENV}" ]; then
    rm -rf -- "${HCW_ANSIBLE_VENV}"
  fi
  ln -sfn "${hcw_ansible_generation}" "${HCW_ANSIBLE_VENV}.next"
  mv -T "${HCW_ANSIBLE_VENV}.next" "${HCW_ANSIBLE_VENV}"
  # Only now, with the link off it, may the generation it pointed to go.
  if [[ "${hcw_ansible_in_use}" == "${hcw_ansible_prefix}"* ]]; then
    log "switched ${HCW_ANSIBLE_VENV} to ${hcw_ansible_generation}"
    log "removing ${hcw_ansible_in_use}, the build of these pins it replaces"
    rm -rf -- "${hcw_ansible_in_use}"
  else
    log "switched ${HCW_ANSIBLE_VENV} to ${hcw_ansible_generation}${hcw_ansible_in_use:+, keeping ${hcw_ansible_in_use} until the next switch}"
    for hcw_ansible_old in "${HCW_ANSIBLE_GENERATIONS}"/*; do
      case "${hcw_ansible_old}" in
        "${hcw_ansible_generation}" | "${hcw_ansible_in_use}") ;;
        *) rm -rf -- "${hcw_ansible_old}" ;;
      esac
    done
  fi
fi
hcw_link_ansible_commands
"${UV_TOOL_BIN_DIR}/ansible-playbook" --version | sed -n '1p;/python version/p'

cd "${hcw_effective_src}/lab-host/ansible"

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

# The uv tool an earlier bootstrap.sh installed ansible-core as, without
# hashes, is retired only once the installed hcw-vault-set no longer runs its
# Python. The play installs that helper, so until a play has put in the one
# that runs HCW_ANSIBLE_VENV's Python, the old one still needs the uv tool: a
# check run, a run whose --tags leave out vault_tools, or a play that stopped
# before that role has not replaced it (CodeRabbit, #1189). The test is the
# installed file, not how this run was invoked, so whichever run converges the
# helper is the one that retires the tool. `uv tool uninstall` removes the
# commands its receipt names, and those include the four now linked through
# HCW_ANSIBLE_VENV, so they are linked again straight after.
if [ -e "${UV_TOOL_DIR}/ansible-core" ] && ! grep -qF "${UV_TOOL_DIR}/ansible-core/" "${HCW_VAULT_HELPER}" 2>/dev/null; then
  log "removing the ansible-core uv tool an earlier bootstrap.sh installed under ${UV_TOOL_DIR}: ${HCW_VAULT_HELPER} no longer runs its Python"
  if ! "${UV_BIN}" tool uninstall ansible-core; then
    log "could not remove the ansible-core uv tool under ${UV_TOOL_DIR}; the next run tries again"
  fi
  hcw_link_ansible_commands
fi

# The play finished (set -e ends the script on a failed one). Record which
# commit the host now runs in the host-check marker, unless this was a check
# run, which changed nothing the marker should claim, or a run narrowed with
# --tags / --skip-tags, which converged one area and not the host (the play's
# own commit record skips those the same way).
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

if [ -n "${hcw_worktree_dir:-}" ]; then
  hcw_cleanup
  trap - EXIT
fi
