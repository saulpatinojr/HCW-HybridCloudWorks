#!/usr/bin/env bash
# Bootloader for landing-zone-builder-output
set -euo pipefail

LAB_ROOT="${1:-/tmp/home/lab}"
TARGET="$LAB_ROOT/landing-zone-builder-output"
mkdir -p "$TARGET"

if [ ! -f "$TARGET/README.md" ]; then
  cat > "$TARGET/README.md" <<'README'
# Landing Zone Builder output

This folder is yours. Download the Terraform the Landing Zone Builder
produced for you on hybridcloudworks.com, upload the zip here with
File > Upload in the file explorer (or drag it in), unzip it in the
terminal, and run:

    az login --use-device-code
    terraform init
    terraform validate

`terraform init` needs the network, which this workspace has. The
provider mirror at /opt/terraform/mirror is what the offline job
runner uses; here TF_CLI_CONFIG_FILE is unset so `init` reaches the
registry for anything the mirror does not hold.
README
fi

# The builder's zip is initialised online: undo the image's mirror-only
# provider installation for this lab's shell.
mkdir -p "$HOME"
printf 'unset TF_CLI_CONFIG_FILE\n' > "$HOME/.bashrc.d-hcw-lab"
if [ ! -f "$HOME/.bashrc" ] || ! grep -qs 'bashrc.d-hcw-lab' "$HOME/.bashrc"; then
  printf '. "$HOME/.bashrc.d-hcw-lab"\n' >> "$HOME/.bashrc"
fi
