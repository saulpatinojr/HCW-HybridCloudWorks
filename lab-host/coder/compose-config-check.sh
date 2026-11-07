#!/usr/bin/env bash
# Prove lab-host/coder/docker-compose.yml parses without the lab host.
#
# The Compose file reads three files the Ansible role writes on the host and
# refuses to interpolate without them (`${VAR:?...}` and `required: true`).
# This script copies the Compose file and the proxy's docker-proxy.haproxy.cfg
# (which the role copies beside it on the host) into a temporary directory
# beside empty stand-ins for those files and runs `docker compose config`, so
# the check needs Docker and nothing from /etc/hcw. Used by the coder-template job in
# .github/workflows/ci.yml and by lab-host/README.md.
#
# Success prints the resolved configuration's service names, one per line:
#   coder
#   coder-docker-proxy
#   coder-postgres
# and exits 0. Any parse or interpolation error exits non-zero with Compose's
# own message.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$here/docker-compose.yml" "$work/docker-compose.yml"
cp "$here/docker-proxy.haproxy.cfg" "$work/docker-proxy.haproxy.cfg"
: > "$work/coder.env"
: > "$work/coder-postgres.env"
# The proxy's label is the allowlist's sha256, as the coder role writes it.
config_sha256="$(sha256sum "$here/docker-proxy.haproxy.cfg" | cut -d' ' -f1)"
printf 'CODER_IMAGE=%s\nCODER_POSTGRES_IMAGE=%s\nCODER_DOCKER_PROXY_IMAGE=%s\nCODER_DOCKER_PROXY_CONFIG_SHA256=%s\n' \
  'ghcr.io/coder/coder@sha256:0000000000000000000000000000000000000000000000000000000000000000' \
  'postgres@sha256:0000000000000000000000000000000000000000000000000000000000000000' \
  'haproxy@sha256:0000000000000000000000000000000000000000000000000000000000000000' \
  "$config_sha256" > "$work/.env"

docker compose --project-directory "$work" -f "$work/docker-compose.yml" config --quiet
docker compose --project-directory "$work" -f "$work/docker-compose.yml" config --services
