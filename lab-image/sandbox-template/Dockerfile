# hcw-lz-sandbox: the Docker Sandboxes template for "Run an agent against
# your landing zone" on /education/labs (issue #676, Phase 3 of #658).
#
# Docker's Claude Code sandbox template plus the two tools a Landing Zone
# Builder download needs — terraform and the Azure CLI — at the versions
# lab-image/versions.env pins, and an AGENTS.md that tells the agent what the
# folder is and what never to run. Nothing else changes: the agent user, the
# workspace, the entrypoint and the network policy are the base image's.
#
# Verified against the Docker documentation on 2026-09-25:
#   https://docs.docker.com/ai/sandboxes/                          (sbx CLI; local free, cloud pay-as-you-go)
#   https://docs.docker.com/ai/sandboxes/agents/claude-code/       (base image docker/sandbox-templates:claude-code)
#   https://docs.docker.com/ai/sandboxes/customize/kits-v2/        (custom template: FROM the agent image, USER root for
#                                                                   apt, USER agent after; run with `sbx run claude
#                                                                   --template <image>`; include the registry domain)
#   https://docs.docker.com/ai/sandboxes/customize/author/base-images/  (agent uid 1000, /home/agent, WORKDIR)
#   https://docs.docker.com/ai/sandboxes/usage/                    (load a local image: docker image save, sbx template load)
#   https://docs.docker.com/reference/cli/sbx/create/              (`sbx create [flags] AGENT [PATH...]`, -t/--template)
#   https://docs.docker.com/ai/sandboxes/cloud/                    (cloud: subscription, no host mount, expires after 1 h)
#
# The base is pinned to the image index digest the registry's
# Docker-Content-Digest header and `docker buildx imagetools inspect
# docker/sandbox-templates:claude-code` both reported on 2026-09-25, and
# recorded as SANDBOX_BASE_IMAGE / SANDBOX_BASE_DIGEST in versions.env; the
# publish workflow fails if this FROM and those two lines disagree. The tag
# beside it is documentation; Docker resolves the digest. On that date the
# image was Ubuntu 26.04.1 LTS (resolute). The index
# carries linux/amd64 and linux/arm64, but this recipe is linux/amd64 only:
# versions.env carries the amd64 checksum for terraform and the Azure CLI
# apt source says `Architectures: amd64`, the same as lab-image/Dockerfile. The
# build command therefore passes --platform (a constant --platform on the
# FROM line is a BuildKit lint warning, FromPlatformFlagConstDisallowed).
#
# The build context is lab-image/, not this directory, so that versions.env
# is read from its one home rather than copied here:
#
#   docker build --platform linux/amd64 -f lab-image/sandbox-template/Dockerfile -t hcw-lz-sandbox:v1 lab-image
#
# See README.md beside this file for the load-and-run commands.

FROM docker/sandbox-templates:claude-code@sha256:5df8839d9d0346319ddae72e1eb7690044b2f0142e34f32711f2d9c6cb1f727d

# System packages as root (base-images guidance). The base image, Ubuntu,
# already carries curl, unzip and ca-certificates; terraform is one verified
# binary, the Azure CLI is Microsoft's apt package.
#
# The Azure CLI comes from the base's own Ubuntu suite, resolute, which
# packages.microsoft.com publishes (dists/resolute carries 2.90.0-1~resolute)
# and Microsoft's install page lists as tested (Ubuntu 26.04). That is not
# the lab image's line: lab-image/Dockerfile is Debian 13 and installs the
# bookworm build (AZURE_CLI_SUITE), which on Ubuntu 26.04 would be a Debian
# package on the wrong distribution. So the suite here is the base image's
# VERSION_CODENAME from /etc/os-release, the version is AZURE_CLI_VERSION,
# the same release as the lab image, and the package is
# azure-cli=<version>-1~<codename> as Microsoft documents. Should a digest
# bump move the base to a suite Microsoft does not publish, apt-get fails
# the build on the missing version rather than installing another. The
# signing key is verified by SHA256 before apt trusts it, as in
# lab-image/Dockerfile.
#
# No Python is added. Nothing this recipe installs runs on the base's Python:
# terraform is a Go binary, the Azure CLI package runs on the interpreter it
# bundles under /opt/az, and the agent is Claude Code on Node. The python3
# and uv the base image ships (Ubuntu's 3.14.4 and uv 0.9.26 on 2026-09-25)
# are Docker's, used by nothing here, and a 3.14.7 beside them would change
# no command the recipe or AGENTS.md runs.
USER root
COPY versions.env /tmp/versions.env
RUN set -eu; . /tmp/versions.env; . /etc/os-release; \
    curl --proto '=https' --tlsv1.2 -fsSLo /tmp/terraform.zip \
      "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip"; \
    echo "${TERRAFORM_SHA256}  /tmp/terraform.zip" | sha256sum -c -; \
    unzip -q /tmp/terraform.zip terraform -d /usr/local/bin; \
    chmod 0755 /usr/local/bin/terraform; \
    mkdir -p /etc/apt/keyrings; \
    curl --proto '=https' --tlsv1.2 -fsSLo /etc/apt/keyrings/microsoft.asc https://packages.microsoft.com/keys/microsoft.asc; \
    echo "${MICROSOFT_APT_KEY_SHA256}  /etc/apt/keyrings/microsoft.asc" | sha256sum -c -; \
    printf '%s\n' \
      'Types: deb' \
      'URIs: https://packages.microsoft.com/repos/azure-cli/' \
      "Suites: ${VERSION_CODENAME}" \
      'Components: main' \
      'Architectures: amd64' \
      'Signed-By: /etc/apt/keyrings/microsoft.asc' > /etc/apt/sources.list.d/azure-cli.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends "azure-cli=${AZURE_CLI_VERSION}-1~${VERSION_CODENAME}"; \
    rm -rf /var/lib/apt/lists/* /tmp/terraform.zip /tmp/versions.env

# The agent's briefing. Claude Code reads ~/.claude/CLAUDE.md in every
# session, whichever host path the workspace is mounted at, so the same
# file is installed there; /home/agent/AGENTS.md is the copy a learner (or
# another agent) can open and read.
COPY --chown=agent:agent sandbox-template/AGENTS.md /home/agent/AGENTS.md
RUN install -o agent -g agent -m 0644 /home/agent/AGENTS.md /home/agent/.claude/CLAUDE.md

# A sandbox runs an agent session, not a service with an endpoint to probe,
# and the base image defines no healthcheck (its Config.Healthcheck was null
# on 2026-09-25), so NONE changes nothing at run time. It says so explicitly,
# as lab-image/Dockerfile does, rather than leaving the instruction absent
# for a scanner to report (checkov CKV_DOCKER_2, trivy DS-0026).
HEALTHCHECK NONE

USER agent
WORKDIR /home/agent/workspace
