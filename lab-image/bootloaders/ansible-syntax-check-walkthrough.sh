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
  elif [ ! -d "$LAB_ROOT/.git" ]; then
    git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$REPO_REF" "$REPO_URL" "$LAB_ROOT"
    git -C "$LAB_ROOT" sparse-checkout set "$LAB_SOURCE"
  fi
fi
