#!/usr/bin/env bash
# Bootloader for ansible-syntax-check-walkthrough
set -euo pipefail

LAB_ROOT="${1:-/tmp/home/lab}"
LAB_SOURCE="lab-host/ansible"
REPO_URL="${HCW_REPO_URL:-https://github.com/saulpatinojr/HCW-HybridCloudWorks.git}"
REPO_REF="${HCW_REPO_REF:-main}"

if [ ! -d "$LAB_ROOT/$LAB_SOURCE" ]; then
  if [ "${HCW_BOOT_OFFLINE:-0}" = "1" ]; then
    mkdir -p "$LAB_ROOT/$LAB_SOURCE"
    cat > "$LAB_ROOT/$LAB_SOURCE/site.yml" <<'YAML'
---
- name: Verify lab host baseline
  hosts: localhost
  connection: local
  gather_facts: false
  tasks:
    - name: Assert baseline variables
      ansible.builtin.assert:
        that:
          - true
YAML
  else
    TMP_CHECKOUT="$(mktemp -d)"
    trap 'rm -rf "$TMP_CHECKOUT"' EXIT
    git -C "$TMP_CHECKOUT" init --quiet
    git -C "$TMP_CHECKOUT" remote add origin "$REPO_URL"
    git -C "$TMP_CHECKOUT" sparse-checkout init --cone
    git -C "$TMP_CHECKOUT" sparse-checkout set "$LAB_SOURCE"
    git -C "$TMP_CHECKOUT" fetch --quiet --depth 1 --filter=blob:none origin "$REPO_REF"
    git -C "$TMP_CHECKOUT" checkout --quiet FETCH_HEAD
    mkdir -p "$LAB_ROOT/$LAB_SOURCE"
    cp -R "$TMP_CHECKOUT/$LAB_SOURCE/." "$LAB_ROOT/$LAB_SOURCE/"
  fi
fi
