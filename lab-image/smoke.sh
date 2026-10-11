#!/usr/bin/env bash
# Smoke test for the hcw-lab image. Runs INSIDE the image, with this directory
# mounted read-only at /workspace and no network:
#
#   bash:
#   docker run --rm --network none -v "$PWD/lab-image:/workspace:ro" hcw-lab-runner:dev bash /workspace/smoke.sh runner
#   docker run --rm --network none -v "$PWD/lab-image:/workspace:ro" hcw-lab:dev        bash /workspace/smoke.sh full
#
# It checks the conditions the image is built for before it checks the tools:
# that there is no network (an init that passed with network proves nothing
# about the mirror), that /workspace is read-only, and that it runs as uid
# 65534. Then each tool's version is compared with versions.env, the provider
# mirror is checked for every pinned provider in the unpacked layout, every
# builder module (each AVM_<KEY>_VERSION in versions.env: every module the
# Landing Zone Builder emits) and every child AVM_CHILD_CALLS records for it
# is present, every vendored child module is re-hashed against its pin, and
# `terraform init -backend=false` plus `terraform validate` run with no
# network against smoke/providers-only (azurerm and random) and one generated
# root per builder module, calling it by relative path with its required
# inputs. Each init must symlink its providers to the mirror and download no
# module: the job sandbox is a read-only root with a 64 MB tmpfs, so a copy
# of either would fail there (#675). Every check runs even after one fails,
# and the exit code is non-zero if any did.
set -euo pipefail

target="${1:-runner}"
case "$target" in
  runner|full) ;;
  *) echo "usage: smoke.sh [runner|full]" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
. "$here/versions.env"

fail=0
ok()   { printf 'ok:   %s\n' "$*"; }
bad()  { printf 'FAIL: %s\n' "$*"; fail=1; }
step() { printf '\n== %s\n' "$*"; }
indent() { sed 's/^/      /'; }

# expect_version <label> <needle> <command...>: the command's output must
# contain the version versions.env names, so a binary that ran but is the
# wrong build fails here rather than passing a bare "it printed something".
expect_version() {
  local label="$1" needle="$2"; shift 2
  local out
  if out="$("$@" 2>&1)"; then
    if grep -qF -- "$needle" <<<"$out"; then
      ok "$label $(head -n1 <<<"$out")"
    else
      bad "$label ran but did not report $needle:"; printf '%s\n' "$out" | indent
    fi
  else
    bad "$label failed to run:"; printf '%s\n' "$out" | indent
  fi
}

step "sandbox conditions"
if python3 -c 'import socket,sys
try:
    socket.create_connection(("registry.terraform.io", 443), timeout=3)
except OSError:
    sys.exit(1)' 2>/dev/null; then
  bad "the network is reachable; run with --network none, or the offline init below proves nothing"
else
  ok "no network"
fi
if (: > /workspace/.smoke-write-probe) 2>/dev/null; then
  rm -f /workspace/.smoke-write-probe
  bad "/workspace is writable; mount it read-only (:ro)"
else
  ok "/workspace is read-only"
fi
if [ "$(id -u)" = 65534 ]; then ok "running as uid 65534"; else bad "running as uid $(id -u), expected 65534"; fi

step "runner tools"
expect_version python3     "Python ${BASE_PYTHON_VERSION}"   python3 --version
expect_version terraform   "Terraform v${TERRAFORM_VERSION}" terraform version
expect_version kubeconform "v${KUBECONFORM_VERSION}"         kubeconform -v
expect_version helm        "Version:\"v${HELM_VERSION}\""     helm version
expect_version ansible     "core ${ANSIBLE_CORE_VERSION}"     ansible --version

step "provider mirror (unpacked layout)"
mirror=/opt/terraform/mirror/registry.terraform.io
for entry in \
  "hashicorp/azurerm ${PROVIDER_AZURERM_VERSION}" \
  "hashicorp/azurerm ${PROVIDER_AZURERM_V4_VERSION}" \
  "azure/azapi ${PROVIDER_AZAPI_VERSION}" \
  "azure/alz ${PROVIDER_ALZ_VERSION}" \
  "hashicorp/random ${PROVIDER_RANDOM_VERSION}" \
  "azure/modtm ${PROVIDER_MODTM_VERSION}" \
  "hashicorp/time ${PROVIDER_TIME_VERSION}"; do
  provider="${entry% *}"; version="${entry#* }"
  dir="$mirror/$provider/$version/linux_amd64"
  if [ -d "$dir" ] && [ -n "$(find "$dir" -maxdepth 1 -type f -name "terraform-provider-${provider#*/}_v${version}*" -perm -u+x | head -n1)" ]; then
    ok "$provider $version"
  else
    bad "$provider $version is missing from the mirror at $dir"
  fi
done
zips="$(find /opt/terraform/mirror -name '*.zip' | wc -l)"
if [ "$zips" -eq 0 ]; then ok "no packed archives left in the mirror"; else bad "$zips zip(s) still in the mirror; init would extract them onto the tmpfs"; fi

# init_validate <label> <root dir>: init without a backend, then validate,
# both with the root's own data dir. A passing init must have symlinked every
# provider to the mirror (no copy) and downloaded no module (every source
# resolved to a directory that already exists).
init_validate() {
  local label="$1" root="$2" out data
  data="$root/.terraform"
  if out="$(cd "$root" && TF_DATA_DIR="$data" terraform init -backend=false -input=false -no-color 2>&1)"; then
    ok "terraform init -backend=false ($label)"
    grep -E '^- (Installing|Using) ' <<<"$out" | indent || true
  else
    bad "terraform init -backend=false ($label):"; printf '%s\n' "$out" | indent
    return
  fi
  # .terraform/providers/registry.terraform.io/<ns>/<name>/<version>/linux_amd64
  # is the symlink; a real directory at that depth is an extracted copy.
  local copied linked
  copied="$( (find "$data/providers" -mindepth 5 -maxdepth 5 -type d 2>/dev/null || true) | wc -l)"
  linked="$( (find "$data/providers" -mindepth 5 -maxdepth 5 -type l 2>/dev/null || true) | wc -l)"
  if [ "$copied" -eq 0 ] && [ "$linked" -gt 0 ]; then
    ok "every provider is a symlink to the mirror ($label, $linked linked)"
  else
    bad "$copied provider director(y/ies) copied instead of symlinked, $linked linked ($label):"
    (find "$data/providers" -mindepth 5 -maxdepth 5 2>/dev/null || true) | indent
  fi
  local downloaded
  downloaded="$( (find "$data/modules" -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true) | wc -l)"
  if [ "$downloaded" -eq 0 ]; then
    ok "no module was downloaded or copied ($label)"
  else
    bad "$downloaded module director(y/ies) under .terraform/modules ($label):"
    (find "$data/modules" -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true) | indent
  fi
  if out="$(cd "$root" && TF_DATA_DIR="$data" terraform validate -no-color 2>&1)"; then
    ok "terraform validate ($label)"
  else
    bad "terraform validate ($label):"; printf '%s\n' "$out" | indent
  fi
}

step "terraform init and validate with no network"
work=/tmp/run/smoke
rm -rf "$work" && mkdir -p "$work/providers-only" && cp -R "$here/smoke/providers-only/." "$work/providers-only/"
init_validate providers-only "$work/providers-only"

step "vendored AVM modules"
# The builder modules, read the way the Dockerfile's fetch stage reads them:
# every AVM_<KEY>_VERSION line in versions.env, which
# scripts/lab-image-avm-vendoring.test.mjs holds equal to the modules the
# Landing Zone Builder emits (frontend/src/lib/landingZone/avmVersions.js).
builders=()
while read -r key; do
  [ -n "$key" ] || continue
  version_var="AVM_${key}_VERSION"
  builders+=("avm-$(tr 'A-Z_' 'a-z-' <<<"$key")@${!version_var}")
done < <(sed -n 's/^AVM_\([A-Z0-9_]*\)_VERSION=.*$/\1/p' "$here/versions.env")
for builder in "${builders[@]}"; do
  if [ -f "/opt/avm/${builder}/main.tf" ]; then
    ok "/opt/avm/${builder} (builder module)"
  else
    bad "/opt/avm/${builder}/main.tf is missing: the builder emits it and the image must carry it"
  fi
done
if [ "${#builders[@]}" -gt 0 ]; then ok "${#builders[@]} builder modules vendored"; else bad "versions.env names no AVM_<KEY>_VERSION builder module"; fi

# Every child each builder module's tree calls, as AVM_CHILD_CALLS records it,
# is present, and every builder module has a record: this is the offline
# half of the build's own check that the record matches what Terraform
# resolved, so an image that lost a directory fails here, not in a job.
declare -A recorded=()
calls=0 missing=0
while read -r builder child; do
  [ -n "$builder" ] || continue
  recorded["$builder"]=$(( ${recorded["$builder"]:-0} + ${child:+1} + 0 ))
  [ -n "${child:-}" ] || continue
  calls=$((calls + 1))
  if [ ! -d "/opt/avm/$child" ]; then
    missing=$((missing + 1))
    bad "$builder calls $child, which is not vendored at /opt/avm/$child"
  fi
done < <(printf '%s\n' "$AVM_CHILD_CALLS" | sed '/^[[:space:]]*$/d')
if [ "$missing" -eq 0 ]; then ok "all $calls recorded calls resolve to a vendored directory"; fi
for builder in "${builders[@]}"; do
  if [ -n "${recorded[$builder]:-}" ]; then
    ok "$builder: ${recorded[$builder]} registry module(s) in its tree, recorded in AVM_CHILD_CALLS"
  else
    bad "$builder has no line in AVM_CHILD_CALLS"
  fi
done

# Every child vendor-avm.sh pinned is present and still hashes to its pin
# (the same coreutils pipeline versions.env documents), and nothing in
# /opt/avm still names a registry module in a file Terraform would load.
children=0
while read -r child pin; do
  [ -n "$child" ] || continue
  children=$((children + 1))
  dir="/opt/avm/$child"
  if [ ! -d "$dir" ]; then
    bad "pinned child $child is not vendored"
    continue
  fi
  actual="$(cd "$dir" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
  if [ "$actual" = "$pin" ]; then ok "$child matches its pin"; else bad "$child hashes $actual, versions.env pins $pin"; fi
done < <(printf '%s\n' "$AVM_CHILD_MODULES" | sed '/^[[:space:]]*$/d')
if [ "$children" -gt 0 ]; then ok "$children vendored child modules pinned"; else bad "AVM_CHILD_MODULES is empty"; fi
# One generated root per builder module, calling it by a RELATIVE path (an
# absolute path is a file:// source Terraform copies onto the tmpfs) with the
# inputs it requires and nothing else. "no module was downloaded" on each is
# the proof that no registry source survived the rewrite: a grep for
# `source = "Azure/..."` would also match the worked example in avm-ptn-alz's
# variables.tf, which Terraform never loads as a module block. A builder
# module with no inputs listed below gets a root with none, so a new one that
# requires an input fails `validate` loudly rather than being skipped.
builder_inputs() {
  case "$1" in
    avm-ptn-alz)
      printf '%s\n' 'architecture_name  = "alz"' 'location           = "centralus"' 'parent_resource_id = "root"' ;;
    avm-ptn-alz-management)
      printf '%s\n' 'location                = "centralus"' 'resource_group_name     = "rg-alz-management"' 'automation_account_name = "aa-alz-management"' ;;
    avm-res-network-virtualnetwork)
      printf '%s\n' 'location  = "centralus"' 'parent_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-smoke"' ;;
  esac
}
avm_root() {
  local builder="$1" root="$work/$1" rel
  mkdir -p "$root"
  rel="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "/opt/avm/${builder}" "$root")"
  {
    printf 'module "m" {\n  source = "%s"\n' "$rel"
    builder_inputs "${builder%@*}" | sed 's/^/  /'
    printf '}\n'
  } > "$root/main.tf"
  init_validate "${builder%@*}" "$root"
}
for builder in "${builders[@]}"; do
  avm_root "$builder"
done

# The three capability commands (bin/), each against the payload it would
# receive from the agent, with HCW_WORKSPACE pointing at the fixture instead
# of /workspace (which is this directory) and HCW_RUN_DIR under /tmp/run. The
# fixture calls each builder module once by registry source
# (scripts/lab-image-avm-vendoring.test.mjs holds it to that), so every block
# must be rewritten and none left for a registry the job cannot reach.
step "capability commands with no network"
tfv="$work/terraform-validate"
if out="$(HCW_WORKSPACE="$here/smoke/terraform-validate-payload" HCW_RUN_DIR="$tfv" hcw-terraform-validate 2>&1)"; then
  rewrote="$(grep -c '^  rewrote ' <<<"$out" || true)"
  left="$(grep -c '^  left ' <<<"$out" || true)"
  if grep -q 'Success! The configuration is valid.' <<<"$out" && [ "$rewrote" -eq "${#builders[@]}" ] && [ "$left" -eq 0 ]; then
    ok "hcw-terraform-validate rewrote ${rewrote} registry sources, one per builder module, and validated the builder-shaped payload"
    grep '^  rewrote ' <<<"$out" | indent
  else
    bad "hcw-terraform-validate exited 0 but did not report ${#builders[@]} rewrites, no module left and a valid configuration:"; printf '%s\n' "$out" | indent
  fi
else
  bad "hcw-terraform-validate (builder-shaped payload):"; printf '%s\n' "$out" | indent
fi
if out="$(HCW_WORKSPACE="$here/smoke/helm-payload" hcw-helm-template 2>&1)"; then
  if grep -q '^kind: Deployment' <<<"$out" && grep -q 'name: hcw-hcw-smoke' <<<"$out"; then
    ok "hcw-helm-template rendered smoke/helm-payload/hcw-smoke"
  else
    bad "hcw-helm-template exited 0 without the expected Deployment:"; printf '%s\n' "$out" | indent
  fi
else
  bad "hcw-helm-template:"; printf '%s\n' "$out" | indent
fi
if out="$(HCW_WORKSPACE="$here/smoke/kubeconform-payload/valid" hcw-kubeconform 2>&1)"; then
  if grep -q 'Valid: 2, Invalid: 0, Errors: 0' <<<"$out"; then ok "hcw-kubeconform accepts the valid manifests"; else bad "hcw-kubeconform summary unexpected:"; printf '%s\n' "$out" | indent; fi
else
  bad "hcw-kubeconform (valid):"; printf '%s\n' "$out" | indent
fi
if out="$(HCW_WORKSPACE="$here/smoke/kubeconform-payload/invalid" hcw-kubeconform 2>&1)"; then
  bad "hcw-kubeconform accepted an invalid manifest:"; printf '%s\n' "$out" | indent
else
  if grep -q "'replicaz' not allowed" <<<"$out"; then ok "hcw-kubeconform rejects the unknown field under -strict"; else bad "hcw-kubeconform failed for another reason:"; printf '%s\n' "$out" | indent; fi
fi
schemas="$(find /opt/kubeconform/schemas -mindepth 1 -maxdepth 1 -type d -name "${KUBERNETES_JSON_SCHEMA_DIR}" | wc -l)"
if [ "$schemas" -eq 1 ]; then ok "/opt/kubeconform/schemas/${KUBERNETES_JSON_SCHEMA_DIR}"; else bad "/opt/kubeconform/schemas/${KUBERNETES_JSON_SCHEMA_DIR} is missing"; fi

if [ "$target" = full ]; then
  step "full tools"
  expect_version az      "\"azure-cli\": \"${AZURE_CLI_VERSION}\""     az version --output json
  expect_version kubectl "Client Version: v${KUBECTL_VERSION}"          kubectl version --client
  expect_version git     "git version"                                   git --version
  expect_version jq      "jq-"                                           jq --version
  expect_version curl    "curl "                                         curl --version
  for pkg in ca-certificates libatomic1 procps; do
    if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
      ok "code-server prerequisite $pkg"
    else
      bad "code-server prerequisite $pkg is not installed"
    fi
  done
  # Coder runs the startup script, code-server and the terminal through the
  # user's passwd shell (#693); uid 65534 must therefore have one, and a home
  # it can write to. The runner target keeps nologin and is not checked here.
  entry="$(getent passwd 65534 || true)"
  case "$entry" in
    *:/bin/bash) ok "uid 65534 has /bin/bash as its shell ($entry)" ;;
    *) bad "uid 65534's passwd shell is not /bin/bash: ${entry:-no entry}" ;;
  esac
  case "$entry" in
    *:/tmp/home:*) ok "uid 65534's home is /tmp/home" ;;
    *) bad "uid 65534's home is not /tmp/home: ${entry:-no entry}" ;;
  esac
  if [ "$HOME" = /tmp/home ] && (: > /tmp/home/.smoke-write-probe) 2>/dev/null; then
    rm -f /tmp/home/.smoke-write-probe
    ok "HOME=/tmp/home exists and is writable"
  else
    bad "HOME is '$HOME' or /tmp/home is not writable"
  fi

  step "per-lab bootloaders"
  boot_root="/tmp/home/smoke-boot"
  rm -rf "$boot_root"
  for lab_id in \
    landing-zone-builder-output \
    terraform-validate-walkthrough \
    ansible-syntax-check-walkthrough \
    wsl-containers-walkthrough \
    defender-wsl-plugin-walkthrough; do
    if [ -x "/usr/local/libexec/hcw-boot/${lab_id}.sh" ] && HCW_BOOT_OFFLINE=1 /usr/local/libexec/hcw-boot/hcw-boot "$lab_id" "$boot_root"; then
      ok "hcw-boot $lab_id"
    else
      bad "hcw-boot $lab_id failed"
    fi
  done
  rm -rf "$boot_root"
fi

printf '\n'
if [ "$fail" -ne 0 ]; then
  echo "smoke: FAILED ($target)"
  exit 1
fi
echo "smoke: passed ($target)"

