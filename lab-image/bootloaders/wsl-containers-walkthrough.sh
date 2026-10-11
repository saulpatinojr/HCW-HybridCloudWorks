#!/usr/bin/env bash
# Bootloader for wsl-containers-walkthrough (#1082)
# Sets up the interactive `wslc` CLI shim and storage/network walkthrough files
# so learners can exercise every `wslc` command (`run`, `ps`, `exec`, `stop`,
# `rm`, `images`), inspect the three storage layers (`system.vhd`, `overlayfs`,
# `virtiofs`), and compare Consommé user-mode NAT vs mirrored networking.
set -euo pipefail

LAB_ROOT="${1:-/tmp/home/lab}"
TARGET="$LAB_ROOT/wsl-containers-walkthrough"
BIN_DIR="$HOME/.local/bin"
STATE_DIR="$HOME/.local/state/wslc"
mkdir -p "$TARGET" "$BIN_DIR" "$STATE_DIR"

cat > "$BIN_DIR/wslc" <<'WSLC_EOF'
#!/usr/bin/env python3
"""Interactive wslc CLI emulator for the WSL Containers walkthrough (#1082).

Demonstrates the session-scoped utility VM lifecycle, OCI image pull/unpack
into ext4 overlayfs layers, and process isolation over the shared WSL2 kernel.
"""
import json
import os
import sys
import time
import uuid

STATE_DIR = os.path.expanduser("~/.local/state/wslc")
STATE_FILE = os.path.join(STATE_DIR, "state.json")

DEFAULT_STATE = {
    "session_vm": {
        "vm_id": "wsl2-uvm-9b4e2a10",
        "kernel": "6.6.87.2-microsoft-standard-WSL2",
        "system_vhd": "C:\\Program Files\\WSL\\system.vhd (read-only)",
        "networking": "Consommé user-mode NAT (172.24.0.0/20)",
    },
    "images": [
        {
            "repository": "docker.io/hybridcloudworks/hcw-lab",
            "tag": "latest",
            "image_id": "7cb89818525b",
            "layers": 6,
            "size": "484MB",
        },
        {
            "repository": "mcr.microsoft.com/azurelinux/base/core",
            "tag": "3.0",
            "image_id": "4e1d9a8c3b20",
            "layers": 2,
            "size": "42.8MB",
        },
        {
            "repository": "docker.io/library/alpine",
            "tag": "3.24",
            "image_id": "a606584aa9aa",
            "layers": 1,
            "size": "7.8MB",
        },
    ],
    "containers": [],
}


def load_state():
    os.makedirs(STATE_DIR, exist_ok=True)
    if not os.path.exists(STATE_FILE):
        save_state(DEFAULT_STATE)
    with open(STATE_FILE, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)


def ensure_image(state, image_ref):
    repo, _, tag = image_ref.partition(":")
    if not tag:
        tag = "latest"
    for img in state["images"]:
        if img["repository"].endswith(repo) and img["tag"] == tag:
            return img
    new_img = {
        "repository": repo,
        "tag": tag,
        "image_id": uuid.uuid4().hex[:12],
        "layers": 3,
        "size": "64.0MB",
    }
    state["images"].append(new_img)
    return new_img


def cmd_images(state):
    print(f"{'REPOSITORY':<44} {'TAG':<10} {'IMAGE ID':<14} {'LAYERS':<8} {'SIZE'}")
    for img in state["images"]:
        print(
            f"{img['repository']:<44} {img['tag']:<10} {img['image_id']:<14} "
            f"{img['layers']:<8} {img['size']}"
        )


def cmd_ps(state, show_all=False):
    vm = state["session_vm"]
    print(f"# Session Utility VM: {vm['vm_id']} ({vm['kernel']})")
    print(
        f"{'CONTAINER ID':<14} {'IMAGE':<42} {'STATUS':<18} {'MOUNT LAYER':<24} {'NAME'}"
    )
    for c in state["containers"]:
        if not show_all and c["status"] != "Running":
            continue
        print(
            f"{c['id']:<14} {c['image']:<42} {c['status']:<18} "
            f"{c['mount']:<24} {c['name']}"
        )


def cmd_run(state, args):
    detach = "-d" in args or "--detach" in args
    name = None
    bind_mount = None
    filtered = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("-d", "--detach", "-i", "-t", "-it"):
            i += 1
            continue
        if arg == "--name" and i + 1 < len(args):
            name = args[i + 1]
            i += 2
            continue
        if arg in ("-v", "--volume") and i + 1 < len(args):
            bind_mount = args[i + 1]
            i += 2
            continue
        filtered.append(arg)
        i += 1

    if not filtered:
        print("usage: wslc run [-d] [--name NAME] [-v HOST:CONTAINER] IMAGE [COMMAND...]", file=sys.stderr)
        sys.exit(2)

    image_ref = filtered[0]
    command = filtered[1:] or ["/bin/sh"]
    img = ensure_image(state, image_ref)
    cid = uuid.uuid4().hex[:12]
    cname = name or f"wslc-{cid[:6]}"
    mount_desc = "overlayfs+virtiofs(9p)" if bind_mount else "overlayfs(ext4)"

    container = {
        "id": cid,
        "name": cname,
        "image": f"{img['repository']}:{img['tag']}",
        "command": " ".join(command),
        "status": "Running",
        "mount": mount_desc,
        "bind_mount": bind_mount or "",
        "created_at": int(time.time()),
    }
    state["containers"].append(container)
    save_state(state)

    vm = state["session_vm"]
    print(f"[wslc] Attached to session utility VM {vm['vm_id']}")
    print(f"[wslc] Mounted {img['layers']} OCI layers via ext4 overlayfs ({mount_desc})")
    if bind_mount:
        print(f"[wslc] Exposed Windows DrvFs/virtiofs mount {bind_mount}")
    if detach:
        print(cid)
    else:
        print(f"[wslc] Started container {cname} ({cid}) running: {' '.join(command)}")


def cmd_exec(state, args):
    if len(args) < 2:
        print("usage: wslc exec CONTAINER COMMAND [ARG...]", file=sys.stderr)
        sys.exit(2)
    target = args[0]
    cmd = args[1:]
    found = next(
        (c for c in state["containers"] if c["id"].startswith(target) or c["name"] == target),
        None,
    )
    if not found:
        print(f"wslc: container '{target}' not found", file=sys.stderr)
        sys.exit(1)
    if found["status"] != "Running":
        print(f"wslc: container '{target}' is not running", file=sys.stderr)
        sys.exit(1)
    joined = " ".join(cmd)
    if "uname" in joined:
        print(f"Linux {found['id']} {state['session_vm']['kernel']} x86_64 GNU/Linux")
    elif "mount" in joined or "df" in joined:
        print("overlay on / type overlay (rw,relatime,lowerdir=/mnt/wslg/oci/lower,upperdir=/mnt/wslg/oci/upper,workdir=/mnt/wslg/oci/work)")
        print("/dev/sda on /mnt/wslg/system-distro type ext4 (ro,relatime) [system.vhd]")
        if found.get("bind_mount"):
            print(f"drvfs on {found['bind_mount'].split(':')[-1]} type 9p (rw,dirsync,aname=drvfs;path=C:\\workspace;symlinkroot=/mnt/)")
    else:
        print(f"[wslc exec {found['name']}] Executed: {joined}")


def cmd_stop(state, args):
    if not args:
        print("usage: wslc stop CONTAINER", file=sys.stderr)
        sys.exit(2)
    target = args[0]
    for c in state["containers"]:
        if c["id"].startswith(target) or c["name"] == target:
            c["status"] = "Exited (0)"
            save_state(state)
            print(c["name"])
            return
    print(f"wslc: container '{target}' not found", file=sys.stderr)
    sys.exit(1)


def cmd_rm(state, args):
    if not args:
        print("usage: wslc rm CONTAINER", file=sys.stderr)
        sys.exit(2)
    target = args[0]
    before = len(state["containers"])
    state["containers"] = [
        c for c in state["containers"] if not (c["id"].startswith(target) or c["name"] == target)
    ]
    if len(state["containers"]) == before:
        print(f"wslc: container '{target}' not found", file=sys.stderr)
        sys.exit(1)
    save_state(state)
    print(target)


def main():
    state = load_state()
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print("Usage: wslc <command> [args...]  (Simulated Linux container emulator for Windows wslc.exe)")
        print("\nDocumented Windows wslc.exe Commands (and Emulator Shorthands):")
        print("  image ls       (alias: images) List OCI images unpacked in the shared ext4 layer store")
        print("  container ps   (alias: ps)     List WSL containers sharing the session utility VM (-a for all)")
        print("  run            (or container run)  Create and start an OCI container inside the session WSL2 utility VM")
        print("  exec           (or container exec) Execute a command inside a running WSL container namespace")
        print("  stop           (or container stop) Stop a running WSL container")
        print("  rm             (or container rm)   Remove a stopped WSL container and its writable overlay layer")
        sys.exit(0)

    sub = sys.argv[1]
    rest = sys.argv[2:]
    if sub == "image" and rest[:1] in (["ls"], ["list"]):
        cmd_images(state)
    elif sub == "container" and rest:
        csub = rest[0]
        crest = rest[1:]
        if csub in ("ps", "ls", "list"):
            cmd_ps(state, show_all=("-a" in crest or "--all" in crest))
        elif csub == "run":
            cmd_run(state, crest)
        elif csub == "exec":
            cmd_exec(state, crest)
        elif csub == "stop":
            cmd_stop(state, crest)
        elif csub == "rm":
            cmd_rm(state, crest)
        else:
            print(f"wslc: unknown container subcommand '{csub}'", file=sys.stderr)
            sys.exit(2)
    elif sub == "images":
        cmd_images(state)
    elif sub == "ps":
        cmd_ps(state, show_all=("-a" in rest or "--all" in rest))
    elif sub == "run":
        cmd_run(state, rest)
    elif sub == "exec":
        cmd_exec(state, rest)
    elif sub == "stop":
        cmd_stop(state, rest)
    elif sub == "rm":
        cmd_rm(state, rest)
    else:
        print(f"wslc: unknown command '{sub}'", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
WSLC_EOF
chmod 0755 "$BIN_DIR/wslc"

cat > "$TARGET/inspect-layers.sh" <<'LAYERS_EOF'
#!/usr/bin/env bash
set -euo pipefail

cat <<'REPORT'
=== WSL Containers Storage Stack ===
1. Read-only Base Layer:     C:\Program Files\WSL\system.vhd (mounted ro at /mnt/wslg/system-distro)
2. OCI Overlayfs Layers:     /var/lib/wslc/overlay2/<layer-id>/diff (shared across session containers)
3. Windows Host Bind Mounts: virtiofs / 9p (DrvFs protocol over VMBus, symlinkroot=/mnt/c)

=== WSL Containers Networking Modes ===
- Default:  Consommé user-mode NAT (hypervisor-free TCP/UDP proxy + DNS forwarder on 172.24.0.0/20)
- Optional: networkingMode=mirrored (mirrors Windows host interfaces, loopback, and VPN routes into the utility VM)
REPORT
LAYERS_EOF
chmod 0755 "$TARGET/inspect-layers.sh"

cat > "$TARGET/README.md" <<'README_EOF'
# WSL Containers Walkthrough (`wslc` Emulator)

This Linux container workspace includes an interactive `wslc` CLI emulator so
you can test the WSL Containers lifecycle, storage stack, and networking model
step by step. Both the documented Windows `wslc.exe` subcommands (`wslc image ls`,
`wslc container ps`) and short aliases (`wslc images`, `wslc ps`) are supported.

## Quick Commands (Documented Windows `wslc.exe` Forms)

```bash
wslc image ls
wslc run -d --name agent-sandbox -v C:\workspace:/workspace docker.io/hybridcloudworks/hcw-lab:latest
wslc container ps
wslc exec agent-sandbox uname -a
wslc exec agent-sandbox mount
./inspect-layers.sh
wslc stop agent-sandbox
wslc rm agent-sandbox
```
README_EOF

printf 'export PATH="$HOME/.local/bin:$PATH"\n' > "$HOME/.bashrc.d-hcw-lab"
if [ ! -f "$HOME/.bashrc" ] || ! grep -qs 'bashrc.d-hcw-lab' "$HOME/.bashrc"; then
  printf '. "$HOME/.bashrc.d-hcw-lab"\n' >> "$HOME/.bashrc"
fi
