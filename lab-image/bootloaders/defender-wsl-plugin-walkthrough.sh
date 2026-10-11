#!/usr/bin/env bash
# Bootloader for defender-wsl-plugin-walkthrough (#1083)
# Sets up the `healthcheck.exe` CLI shim, the safe DIY Linux EDR test script,
# and the 3 KQL hunting queries (`DeviceInfo`, `HostDeviceId` join, and
# `DeviceProcessEvents`) for the Defender for Endpoint WSL2 plug-in walkthrough.
set -euo pipefail

LAB_ROOT="${1:-/tmp/home/lab}"
TARGET="$LAB_ROOT/defender-wsl-plugin-walkthrough"
BIN_DIR="$HOME/.local/bin"
STATE_DIR="$HOME/.local/state/mde-wsl"
mkdir -p "$TARGET" "$BIN_DIR" "$STATE_DIR"

cat > "$BIN_DIR/healthcheck.exe" <<'HC_EOF'
#!/usr/bin/env bash
set -euo pipefail

cat <<'OUT'
Microsoft Defender for Endpoint - WSL2 Plug-in Health Check
-----------------------------------------------------------
PluginVersion          : 1.0.2604.1
PluginState            : Running
SensorHealth           : Healthy
TelemetryChannel       : Connected (Sense.exe Host Proxy)
HostDeviceName         : LAB-HOST
HostDeviceId           : 8f3b2e10-4c9a-4d7e-9b1a-7c6d5e4f3a21
WslDeviceName          : LAB-HOST-wslc
WslDeviceId            : c41a9d02-7e31-4b88-a52f-19d0e8b74c11
OnboardingState        : Onboarded (Inherited from Windows Host)
DistributionsMonitored : Ubuntu-24.04, wslc-session-vm
eBPFCollector          : Active (kernel 6.6.87.2-microsoft-standard-WSL2)
OUT
HC_EOF
chmod 0755 "$BIN_DIR/healthcheck.exe"

cat > "$TARGET/diy-edr-test.sh" <<'EDR_EOF'
#!/usr/bin/env bash
# Safe, non-destructive user-space Linux EDR test script for Microsoft Defender
# for Endpoint inside a WSL2 utility VM (#1083).
set -euo pipefail

STATE_DIR="$HOME/.local/state/mde-wsl"
mkdir -p "$STATE_DIR"
EVENT_FILE="$STATE_DIR/latest-alert.json"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "$EVENT_FILE" <<JSON
{
  "Timestamp": "$TIMESTAMP",
  "DeviceId": "c41a9d02-7e31-4b88-a52f-19d0e8b74c11",
  "DeviceName": "LAB-HOST-wslc",
  "HostDeviceId": "8f3b2e10-4c9a-4d7e-9b1a-7c6d5e4f3a21",
  "DeviceTag": "WSL2",
  "AlertId": "da638957824190812451_1083",
  "Title": "Linux EDR DIY Test Alert (MDE WSL2 Plug-in)",
  "Severity": "Informational",
  "Category": "Execution",
  "FileName": "diy-edr-test.sh",
  "FolderPath": "/tmp/home/lab/defender-wsl-plugin-walkthrough/diy-edr-test.sh",
  "ProcessCommandLine": "bash ./diy-edr-test.sh --trigger-test-marker",
  "InitiatingProcessFileName": "bash"
}
JSON

echo "[MDE-WSL2] Triggered safe user-space DIY Linux EDR test marker on LAB-HOST-wslc"
echo "[MDE-WSL2] Event recorded at: $EVENT_FILE"
cat "$EVENT_FILE"
EDR_EOF
chmod 0755 "$TARGET/diy-edr-test.sh"

cat > "$TARGET/hunting-queries.kql" <<'KQL_EOF'
// Query 1: Find all WSL2 instances in DeviceInfo
DeviceInfo
| where Timestamp > ago(7d)
| where OSPlatform == "Linux" and (AdditionalFields has "WSL2" or DeviceName endswith "-wslc")
| summarize arg_max(Timestamp, *) by DeviceId
| project Timestamp, DeviceId, DeviceName, OSPlatform, OSVersionInfo, HostDeviceId = tostring(parse_json(AdditionalFields).HostDeviceId)

// Query 2: Join each WSL2 instance back to its Windows host via HostDeviceId
let WslDevices = DeviceInfo
| where Timestamp > ago(7d)
| extend HostDeviceId = tostring(parse_json(AdditionalFields).HostDeviceId)
| where isnotempty(HostDeviceId)
| summarize arg_max(Timestamp, *) by WslDeviceId = DeviceId, WslDeviceName = DeviceName, HostDeviceId;
let HostDevices = DeviceInfo
| where Timestamp > ago(7d)
| where OSPlatform startswith "Windows"
| summarize arg_max(Timestamp, *) by HostDeviceId = DeviceId, HostDeviceName = DeviceName;
WslDevices
| join kind=inner HostDevices on HostDeviceId
| project WslDeviceName, WslDeviceId, HostDeviceName, HostDeviceId, OnboardingStatus

// Query 3: Inspect process events inside the WSL2 utility VM (DeviceProcessEvents)
DeviceProcessEvents
| where Timestamp > ago(24h)
| where DeviceName == "LAB-HOST-wslc"
| project Timestamp, DeviceName, AccountName, FileName, ProcessCommandLine, InitiatingProcessFileName
| order by Timestamp desc
KQL_EOF

cat > "$TARGET/README.md" <<'README_EOF'
# Defender for Endpoint WSL2 Plug-in Walkthrough

This workspace lets you verify the Microsoft Defender for Endpoint (MDE)
plug-in for WSL2, trigger a safe user-space Linux EDR detection marker, and
inspect the 3 Advanced Hunting KQL queries that join `LAB-HOST-wslc` back to
its Windows host (`LAB-HOST`) via `HostDeviceId`.

## Quick Commands

```bash
healthcheck.exe
./diy-edr-test.sh --trigger-test-marker
cat hunting-queries.kql
```
README_EOF

printf 'export PATH="$HOME/.local/bin:$PATH"\n' > "$HOME/.bashrc.d-hcw-lab"
if [ ! -f "$HOME/.bashrc" ] || ! grep -qs 'bashrc.d-hcw-lab' "$HOME/.bashrc"; then
  printf '. "$HOME/.bashrc.d-hcw-lab"\n' >> "$HOME/.bashrc"
fi
