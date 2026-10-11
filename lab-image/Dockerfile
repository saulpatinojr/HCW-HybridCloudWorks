# hcw-lab: the image the lab pages, the Coder template, the vps-agent runner
# and the sandbox recipe all pull (issue #658, Phase 1 in #674).
#
# Two final targets:
#
#   runner  terraform, kubeconform, helm, ansible-core, a Terraform provider
#           filesystem mirror at /opt/terraform/mirror, and every Azure
#           Verified Module the Landing Zone Builder emits plus every
#           registry module those call, at /opt/avm/<name>@<version>. Runs as
#           uid 65534 with /workspace mounted read-only, and `terraform init`
#           needs no network for any provider in the mirror or any vendored
#           module.
#   full    runner plus Azure CLI, kubectl, git, curl, jq and the three
#           packages code-server needs. CMD is bash.
#
# Every version and checksum comes from versions.env, sourced at the top of
# each RUN; nothing is downloaded without a SHA256 check. The base image is
# the official python:3.14.7-slim-trixie (CPython 3.14.7 on Debian 13
# trixie), pinned by index digest on every FROM below; versions.env says why
# every stage uses it. The tag beside the digest is documentation (Docker
# resolves the digest and ignores the tag); the publish workflow checks that
# every FROM that is not an earlier stage is exactly BASE_IMAGE@BASE_DIGEST
# from versions.env, so the two cannot drift and no FROM can be unpinned.
#
# Build:   docker build --target runner -t hcw-lab-runner:dev lab-image
#          docker build --target full   -t hcw-lab:dev        lab-image
# Verify:  see smoke.sh (mount lab-image at /workspace read-only, no network).

# ---------------------------------------------------------------------------
# fetch: download and verify every artefact. Nothing from this stage ships
# except what later stages COPY out of /out. The base already carries
# ca-certificates and python3 with pip.
# ---------------------------------------------------------------------------
FROM python:3.14.7-slim-trixie@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d AS fetch

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY versions.env /build/versions.env

# Kubernetes JSON schemas for kubeconform (#675): one directory of
# yannh/kubernetes-json-schema at a pinned commit, fetched as a sparse,
# blobless checkout (the repository holds every Kubernetes release and is
# far too large to take whole), then hashed with the same pipeline
# versions.env documents for the vendored modules and compared with the pin.
RUN set -eu; . /build/versions.env; \
    mkdir -p /build/schemas /out/kubeconform/schemas; \
    cd /build/schemas; \
    git init -q; \
    git remote add origin https://github.com/yannh/kubernetes-json-schema.git; \
    git config core.sparseCheckout true; \
    git sparse-checkout set --no-cone "/${KUBERNETES_JSON_SCHEMA_DIR}/"; \
    git fetch -q --depth 1 --filter=blob:none origin "${KUBERNETES_JSON_SCHEMA_COMMIT}"; \
    git checkout -q FETCH_HEAD; \
    actual="$(cd "${KUBERNETES_JSON_SCHEMA_DIR}" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"; \
    echo "kubernetes-json-schema ${KUBERNETES_JSON_SCHEMA_DIR}: ${actual}"; \
    test "${actual}" = "${KUBERNETES_JSON_SCHEMA_SHA256}"; \
    mv "${KUBERNETES_JSON_SCHEMA_DIR}" "/out/kubeconform/schemas/${KUBERNETES_JSON_SCHEMA_DIR}"; \
    cd /build && rm -rf /build/schemas

# Tool binaries. `sha256sum -c` exits non-zero on a mismatch, and `set -e`
# turns that into a failed build rather than an unverified binary.
RUN set -eu; . /build/versions.env; \
    mkdir -p /out/bin; \
    curl --proto '=https' --tlsv1.2 -fsSLo terraform.zip \
      "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip"; \
    echo "${TERRAFORM_SHA256}  terraform.zip" | sha256sum -c -; \
    unzip -q terraform.zip terraform -d /out/bin; \
    curl --proto '=https' --tlsv1.2 -fsSLo kubeconform.tgz \
      "https://github.com/yannh/kubeconform/releases/download/v${KUBECONFORM_VERSION}/kubeconform-linux-amd64.tar.gz"; \
    echo "${KUBECONFORM_SHA256}  kubeconform.tgz" | sha256sum -c -; \
    tar -xzf kubeconform.tgz -C /out/bin kubeconform; \
    curl --proto '=https' --tlsv1.2 -fsSLo helm.tgz \
      "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz"; \
    echo "${HELM_SHA256}  helm.tgz" | sha256sum -c -; \
    tar -xzf helm.tgz -C /build linux-amd64/helm; \
    mv /build/linux-amd64/helm /out/bin/helm; \
    chmod 0755 /out/bin/*; \
    rm -rf /build/terraform.zip /build/kubeconform.tgz /build/helm.tgz /build/linux-amd64

# ansible-core and every wheel it depends on, in pip's hash-checking mode:
# the requirements file is ansible-core's line plus ANSIBLE_CORE_DEPS, each
# `name==version --hash=sha256:...`. --require-hashes fails on a sum that
# differs and on any dependency the resolver reaches that is not in the file,
# and --only-binary=:all: means nothing is built from source. The runner
# installs from exactly these files, with the same file, offline.
RUN set -eu; . /build/versions.env; \
    mkdir -p /out/wheels; \
    { \
      printf 'ansible-core==%s --hash=sha256:%s\n' "${ANSIBLE_CORE_VERSION}" "${ANSIBLE_CORE_SHA256}"; \
      printf '%s\n' "${ANSIBLE_CORE_DEPS}" | sed '/^[[:space:]]*$/d'; \
    } > /out/wheels/requirements.txt; \
    python3 -m pip download --disable-pip-version-check --no-cache-dir \
      --only-binary=:all: --require-hashes --dest /out/wheels -r /out/wheels/requirements.txt; \
    test "$(find /out/wheels -name '*.whl' | wc -l)" -eq "$(wc -l < /out/wheels/requirements.txt)"

# The builder modules: every Azure Verified Module the Landing Zone Builder
# emits (ADR 0032 decision 5), vendored from the release source tarball of
# each repository into /opt/avm/<name>@<version>, where <name> is the
# registry module name (Azure/<name>/azurerm), so hcw-terraform-validate maps
# `source = "Azure/avm-ptn-alz/azurerm"` plus a version to that directory
# mechanically. The list is not written here: it is every `AVM_<KEY>_VERSION`
# line in versions.env, <KEY> being the name upper-cased with `-` as `_`,
# each with its `AVM_<KEY>_SHA256` beside it, and
# scripts/lab-image-avm-vendoring.test.mjs holds those lines equal to
# frontend/src/lib/landingZone/avmVersions.js. A version with no sum fails
# here, and a sum that does not match fails at `sha256sum -c`.
RUN set -eu; . /build/versions.env; \
    vendor() { \
      name="$1"; version="$2"; sum="$3"; \
      curl --proto '=https' --tlsv1.2 -fsSLo "${name}.tgz" \
        "https://github.com/Azure/terraform-azurerm-${name}/archive/refs/tags/v${version}.tar.gz"; \
      echo "${sum}  ${name}.tgz" | sha256sum -c -; \
      mkdir -p "/out/avm/${name}@${version}"; \
      tar -xzf "${name}.tgz" -C "/out/avm/${name}@${version}" --strip-components=1; \
      rm -f "${name}.tgz"; \
    }; \
    keys="$(sed -n 's/^AVM_\([A-Z0-9_]*\)_VERSION=.*$/\1/p' /build/versions.env)"; \
    test -n "${keys}"; \
    for key in ${keys}; do \
      eval "version=\${AVM_${key}_VERSION}; sum=\${AVM_${key}_SHA256:-}"; \
      if [ -z "${sum}" ]; then echo "versions.env: AVM_${key}_VERSION has no AVM_${key}_SHA256 beside it" >&2; exit 1; fi; \
      vendor "avm-$(printf '%s' "${key}" | tr 'A-Z_' 'a-z-')" "${version}" "${sum}"; \
    done; \
    ls /out/avm

# ---------------------------------------------------------------------------
# vendor: the builder modules' registry children, vendored beside them and
# their `source` lines rewritten to relative local paths, so every builder
# module inits with no network (#675). vendor-avm.sh explains the mechanism;
# the short version is that Terraform has no module mirror, so the only way a
# module that calls registry modules inits offline is for the vendored copy
# to call local copies instead. Every child is pinned by tree hash in
# versions.env (AVM_CHILD_MODULES), what each builder module calls is recorded
# there too (AVM_CHILD_CALLS), and the script fails the build on a mismatch,
# an unpinned child, an unused pin or a call the record does not match. git
# (installed in fetch) is what Terraform uses to fetch registry modules; the
# base image's python3 does the JSON and the rewrite. The runner copies
# /out/avm out of this stage and nothing else.
#
# AVM_PRINT_PINS=1 prints both blocks instead of checking them, for a bump:
#   docker build --target vendor --build-arg AVM_PRINT_PINS=1 --progress=plain lab-image
# ---------------------------------------------------------------------------
FROM fetch AS vendor

COPY vendor-avm.sh /build/vendor-avm.sh
ARG AVM_PRINT_PINS=
RUN set -eu; . /build/versions.env; \
    export AVM_CHILD_MODULES AVM_CHILD_CALLS; \
    AVM_PRINT_PINS="${AVM_PRINT_PINS}" AVM_ROOT=/out/avm TERRAFORM=/out/bin/terraform SCRATCH=/build/get \
      bash /build/vendor-avm.sh

# ---------------------------------------------------------------------------
# mirror: build the provider filesystem mirror with the terraform binary
# verified above. `terraform providers mirror` writes the packed layout
# (registry.terraform.io/<namespace>/<name>/<version>.json plus the zip); the
# zips are checked against the sums in versions.env, so the mirror is pinned
# by content and not only by version, and are then UNPACKED into the
# directory layout (<namespace>/<name>/<version>/linux_amd64/<binary>) and
# deleted.
#
# Unpacked, because of how `terraform init` consumes each layout (#675).
# From a packed mirror it extracts the provider into .terraform/providers,
# a 225 MB copy of azurerm per job; from an unpacked mirror it symlinks
# .terraform/providers/<...>/linux_amd64 to the mirror directory and copies
# nothing (measured: a 40 KB .terraform). The job sandbox is a read-only root
# with a 64 MB tmpfs, so the packed layout could not init any azurerm
# configuration there at all. The cost is on-disk size, not pull size: the
# binaries are 931 MB unpacked against 191 MB zipped, but the image layer is
# compressed in transit either way.
#
# Two mirror roots because a required_providers block holds one constraint
# per provider and azurerm is mirrored at both 4.x and 5.x; the second run
# merges into the same index.json.
# ---------------------------------------------------------------------------
FROM fetch AS mirror

RUN set -eu; . /build/versions.env; \
    mkdir -p /build/mirror-current /build/mirror-v4 /out/mirror; \
    { \
      echo 'terraform {'; \
      echo '  required_providers {'; \
      echo "    azurerm = { source = \"hashicorp/azurerm\", version = \"= ${PROVIDER_AZURERM_VERSION}\" }"; \
      echo "    azapi   = { source = \"azure/azapi\",       version = \"= ${PROVIDER_AZAPI_VERSION}\" }"; \
      echo "    alz     = { source = \"azure/alz\",         version = \"= ${PROVIDER_ALZ_VERSION}\" }"; \
      echo "    random  = { source = \"hashicorp/random\",  version = \"= ${PROVIDER_RANDOM_VERSION}\" }"; \
      echo "    modtm   = { source = \"azure/modtm\",       version = \"= ${PROVIDER_MODTM_VERSION}\" }"; \
      echo "    time    = { source = \"hashicorp/time\",    version = \"= ${PROVIDER_TIME_VERSION}\" }"; \
      echo '  }'; \
      echo '}'; \
    } > /build/mirror-current/main.tf; \
    { \
      echo 'terraform {'; \
      echo '  required_providers {'; \
      echo "    azurerm = { source = \"hashicorp/azurerm\", version = \"= ${PROVIDER_AZURERM_V4_VERSION}\" }"; \
      echo '  }'; \
      echo '}'; \
    } > /build/mirror-v4/main.tf; \
    /out/bin/terraform -chdir=/build/mirror-current providers mirror -platform=linux_amd64 /out/mirror; \
    /out/bin/terraform -chdir=/build/mirror-v4 providers mirror -platform=linux_amd64 /out/mirror; \
    check() { echo "$2  /out/mirror/registry.terraform.io/$1" | sha256sum -c -; }; \
    check "hashicorp/azurerm/terraform-provider-azurerm_${PROVIDER_AZURERM_VERSION}_linux_amd64.zip" "${PROVIDER_AZURERM_SHA256}"; \
    check "hashicorp/azurerm/terraform-provider-azurerm_${PROVIDER_AZURERM_V4_VERSION}_linux_amd64.zip" "${PROVIDER_AZURERM_V4_SHA256}"; \
    check "azure/azapi/terraform-provider-azapi_${PROVIDER_AZAPI_VERSION}_linux_amd64.zip" "${PROVIDER_AZAPI_SHA256}"; \
    check "azure/alz/terraform-provider-alz_${PROVIDER_ALZ_VERSION}_linux_amd64.zip" "${PROVIDER_ALZ_SHA256}"; \
    check "hashicorp/random/terraform-provider-random_${PROVIDER_RANDOM_VERSION}_linux_amd64.zip" "${PROVIDER_RANDOM_SHA256}"; \
    check "azure/modtm/terraform-provider-modtm_${PROVIDER_MODTM_VERSION}_linux_amd64.zip" "${PROVIDER_MODTM_SHA256}"; \
    check "hashicorp/time/terraform-provider-time_${PROVIDER_TIME_VERSION}_linux_amd64.zip" "${PROVIDER_TIME_SHA256}"; \
    unpack() { \
      zip="/out/mirror/registry.terraform.io/$1/terraform-provider-${1#*/}_${2}_linux_amd64.zip"; \
      dir="/out/mirror/registry.terraform.io/$1/$2/linux_amd64"; \
      mkdir -p "$dir"; unzip -q "$zip" -d "$dir"; chmod 0755 "$dir"/*; rm -f "$zip"; \
    }; \
    unpack hashicorp/azurerm "${PROVIDER_AZURERM_VERSION}"; \
    unpack hashicorp/azurerm "${PROVIDER_AZURERM_V4_VERSION}"; \
    unpack azure/azapi "${PROVIDER_AZAPI_VERSION}"; \
    unpack azure/alz "${PROVIDER_ALZ_VERSION}"; \
    unpack hashicorp/random "${PROVIDER_RANDOM_VERSION}"; \
    unpack azure/modtm "${PROVIDER_MODTM_VERSION}"; \
    unpack hashicorp/time "${PROVIDER_TIME_VERSION}"; \
    find /out/mirror -name '*.json' -delete; \
    test "$(find /out/mirror -name '*.zip' | wc -l)" -eq 0

# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------
FROM python:3.14.7-slim-trixie@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d AS runner

# No apt layer: the base already carries python3 (3.14.7, at /usr/local/bin,
# with ensurepip for the venv below), ca-certificates, bash and coreutils,
# which is everything the runner needs. ansible-core's dependencies come from
# the hash-pinned wheels the fetch stage verified, not from Debian packages,
# because Debian's python3-* packages are built for trixie's own python3.13.
COPY --from=fetch /out/bin/ /usr/local/bin/
# The fixed commands behind the vps-agent capabilities that run in this image
# (hcw-terraform-validate, hcw-helm-template, hcw-kubeconform): each is one
# argv entry in vps-agent/lib/capabilities.js, and what it does lives here,
# where smoke.sh exercises it against a payload with no network.
COPY --chmod=0755 bin/ /usr/local/bin/
# hcw-terraform-validate's constraint and rewrite modules (lib/); the script
# puts this directory on sys.path itself, so no PYTHONPATH is set image-wide.
# Modes set explicitly and separately: COPY --chmod applies one mode to the
# directory as well as the files, and 0644 on the directory made it
# untraversable for uid 65534 (measured in #675: ModuleNotFoundError).
COPY lib/ /usr/local/lib/hcw/
RUN chmod 0755 /usr/local/lib/hcw && chmod 0644 /usr/local/lib/hcw/*.py \
 && test "$(ls -A /usr/local/lib/hcw | grep -vc '\.py$')" -eq 0
COPY --from=vendor /out/avm/ /opt/avm/
COPY --from=fetch /out/kubeconform/ /opt/kubeconform/
COPY --from=mirror /out/mirror/ /opt/terraform/mirror/

# ansible-core into its own venv from the verified wheels only: `--no-index
# --find-links` so pip cannot reach an index, and the fetch stage's
# requirements file with `--require-hashes`, so every wheel is checked a
# second time and the resolver cannot pull in anything unlisted. `pip check`
# proves the set is consistent. pip is then removed from the venv and from
# the base image's Python: the image carries no pip command, and what runs
# is exactly what versions.env names. The wheels are bind-mounted from the
# fetch stage for this one RUN rather than copied in, so they leave no layer
# behind (a COPY and a later rm kept 8.6 MB of them in the image).
RUN --mount=type=bind,from=fetch,source=/out/wheels,target=/tmp/wheels \
    python3 -m venv /opt/ansible \
 && /opt/ansible/bin/pip install --disable-pip-version-check --no-cache-dir \
      --no-index --find-links /tmp/wheels --require-hashes -r /tmp/wheels/requirements.txt \
 && /opt/ansible/bin/pip check \
 && /opt/ansible/bin/pip uninstall -y pip \
 && python3 -m pip uninstall -y --root-user-action=ignore pip \
 && ln -s /opt/ansible/bin/ansible* /usr/local/bin/ \
 && test -z "$(command -v pip pip3 || true)"

# Provider installation is mirror-only, deliberately: `terraform init` under
# --network none must fail loudly on a provider that is not mirrored, never
# hang on a registry it cannot reach, and the same config online must not
# pick a newer version from the registry than the one the image carries.
# TF_CLI_CONFIG_FILE=/dev/null restores registry installation for a session.
RUN mkdir -p /etc/terraform /workspace /tmp/home /tmp/run \
 && chown 65534:65534 /tmp/home /tmp/run \
 && printf '%s\n' \
      'provider_installation {' \
      '  filesystem_mirror {' \
      '    path    = "/opt/terraform/mirror"' \
      '    include = ["registry.terraform.io/*/*"]' \
      '  }' \
      '}' > /etc/terraform/terraformrc

# /workspace is mounted read-only, so everything the tools write goes under
# /tmp: Terraform's data dir, the tools' home directories, Ansible's temp.
# TF_PLUGIN_CACHE_DIR is intentionally unset (a cache under /tmp would only
# duplicate the mirror). CHECKPOINT_DISABLE stops Terraform's version check
# call, which is the one network request `terraform init` would otherwise
# still make.
#
# TMPDIR=/tmp/run, because in the job sandbox /tmp/run is the ONLY writable
# path (vps-agent mounts a tmpfs there on a read-only root). A Terraform
# provider is a go-plugin subprocess that listens on a Unix socket in TMPDIR
# before it says anything on stdout; with TMPDIR on the read-only root every
# provider died silently and `terraform validate` reported "Failed to read
# any lines from plugin's stdout" for all six (measured in #675, after init
# had succeeded). Outside the sandbox /tmp/run exists in the image, so the
# setting is harmless there.
ENV TF_CLI_CONFIG_FILE=/etc/terraform/terraformrc \
    TF_DATA_DIR=/tmp/run/.terraform \
    TF_IN_AUTOMATION=1 \
    CHECKPOINT_DISABLE=1 \
    TMPDIR=/tmp/run \
    HOME=/tmp/home \
    ANSIBLE_LOCAL_TEMP=/tmp/run/ansible \
    HELM_CACHE_HOME=/tmp/run/helm/cache \
    HELM_CONFIG_HOME=/tmp/run/helm/config \
    HELM_DATA_HOME=/tmp/run/helm/data

# A CLI image has no service to probe; NONE says so explicitly rather than
# leaving the instruction absent for a scanner to report.
HEALTHCHECK NONE

USER 65534:65534
WORKDIR /workspace
CMD ["terraform", "version"]

# ---------------------------------------------------------------------------
# full: runner plus the interactive tooling. Azure CLI from Microsoft's apt
# repository at a pinned package version. The suite is bookworm, on a trixie
# base, because packages.microsoft.com publishes no trixie suite and
# Microsoft's install page says to use the latest Debian suite when there is
# no package for the distribution (AZURE_CLI_SUITE in versions.env has the
# evidence). The signing key is verified by SHA256 before apt trusts it;
# trixie's apt 3.0 reads an ASCII-armoured key named in Signed-By directly,
# so no gnupg is installed. The source is written in the deb822 form
# Microsoft's page documents. kubectl by version and sum.
# ---------------------------------------------------------------------------
FROM runner AS full

USER root
COPY versions.env /tmp/versions.env
RUN set -eu; . /tmp/versions.env; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl git jq libatomic1 procps; \
    mkdir -p /etc/apt/keyrings; \
    curl --proto '=https' --tlsv1.2 -fsSLo /etc/apt/keyrings/microsoft.asc https://packages.microsoft.com/keys/microsoft.asc; \
    echo "${MICROSOFT_APT_KEY_SHA256}  /etc/apt/keyrings/microsoft.asc" | sha256sum -c -; \
    printf '%s\n' \
      'Types: deb' \
      'URIs: https://packages.microsoft.com/repos/azure-cli/' \
      "Suites: ${AZURE_CLI_SUITE}" \
      'Components: main' \
      'Architectures: amd64' \
      'Signed-By: /etc/apt/keyrings/microsoft.asc' > /etc/apt/sources.list.d/azure-cli.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends "azure-cli=${AZURE_CLI_VERSION}-1~${AZURE_CLI_SUITE}"; \
    curl --proto '=https' --tlsv1.2 -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl"; \
    echo "${KUBECTL_SHA256}  /usr/local/bin/kubectl" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/kubectl; \
    rm -rf /var/lib/apt/lists/* /tmp/versions.env

# Per-lab bootloaders invoked by the Coder workspace startup script (or
# directly via `hcw-boot <lab-id>` in a local container).
COPY bootloaders/ /usr/local/libexec/hcw-boot/
RUN chmod 0755 /usr/local/libexec/hcw-boot /usr/local/libexec/hcw-boot/hcw-boot /usr/local/libexec/hcw-boot/*.sh \
 && ln -sf /usr/local/libexec/hcw-boot/hcw-boot /usr/local/bin/hcw-boot

# uid 65534 is Debian's `nobody`, whose passwd entry has /usr/sbin/nologin
# and a home of /nonexistent. That is right for the runner, where nothing
# ever opens a shell, and wrong for this target: Coder's agent runs the
# workspace startup script, code-server and the terminal through the user's
# passwd shell, so on the first published image all three failed (#693).
# The shell becomes bash and the home the /tmp/home the runner stage already
# creates for uid 65534 and that HOME already points at. The runner target
# is untouched: it keeps nologin.
RUN usermod -s /bin/bash -d /tmp/home nobody \
 && test "$(getent passwd 65534 | cut -d: -f6,7)" = "/tmp/home:/bin/bash" \
 && printf '%s\n' \
      '[automount]' \
      'enabled=false' \
      '' \
      '[user]' \
      'default=nobody' \
      > /etc/wsl.conf

USER 65534:65534
WORKDIR /workspace
CMD ["bash"]

