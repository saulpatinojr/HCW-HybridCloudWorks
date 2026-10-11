import React, { useState } from 'react';
import { ShieldCheck, Server, AlertTriangle, Terminal, Play, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const HEALTHCHECK_FIELDS = [
  { key: 'PluginStatus', value: 'Running' },
  { key: 'PluginVersion', value: '1.0.2604.1' },
  { key: 'EngineVersion', value: '101.24082.0004' },
  { key: 'OrgId', value: '00000000-0000-0000-0000-000000000000' },
  { key: 'HostDeviceId', value: '8f3b2e10-4c9a-4d7e-9b1a-7c6d5e4f3a21' },
  { key: 'HostDeviceName', value: 'LAB-HOST' },
  { key: 'WslDeviceName', value: 'LAB-HOST-wslc' },
  { key: 'ActiveDistributions', value: 'Ubuntu-24.04 (WSL2)' },
  { key: 'SensorHealth', value: 'Healthy' },
  { key: 'TelemetryChannel', value: 'Connected' },
];

const INVENTORY_DEVICES = [
  {
    deviceName: 'LAB-HOST',
    deviceId: '8f3b2e10-4c9a-4d7e-9b1a-7c6d5e4f3a21',
    osPlatform: 'Windows11',
    onboardingStatus: 'Onboarded',
    healthState: 'Active',
    tags: ['Workstation', 'Hybrid-Host'],
  },
  {
    deviceName: 'LAB-HOST-wslc',
    deviceId: 'c41d9a72-8b3e-4f10-a52c-1e9b8d7c6f54',
    osPlatform: 'Linux',
    onboardingStatus: 'Can be onboarded (WSL2 Plug-in)',
    healthState: 'Active',
    tags: ['WSL2'],
  },
];

const KQL_PRESETS = [
  {
    id: 'device-info',
    label: '1. List WSL2 instances in DeviceInfo',
    shell: 'KQL',
    query: `DeviceInfo
| where Timestamp > ago(7d)
| where OSPlatform == "Linux" and (AdditionalFields has "WSL2" or isnotempty(HostDeviceId))
| summarize arg_max(Timestamp, *) by DeviceId
| project Timestamp, DeviceName, DeviceId, HostDeviceId, OSPlatform, OSDistribution, OnboardingStatus`,
    rows: [
      {
        Timestamp: '2026-10-11T06:00:12Z',
        DeviceName: 'LAB-HOST-wslc',
        DeviceId: 'c41d9a72-8b3e-4f10-a52c-1e9b8d7c6f54',
        HostDeviceId: '8f3b2e10-4c9a-4d7e-9b1a-7c6d5e4f3a21',
        OSPlatform: 'Linux',
        OSDistribution: 'Ubuntu 24.04 LTS',
        OnboardingStatus: 'Onboarded via WSL2 Plug-in',
      },
    ],
  },
  {
    id: 'host-join',
    label: '2. Join WSL2 instance to Windows 11 host via HostDeviceId',
    shell: 'KQL',
    query: `DeviceInfo
| where Timestamp > ago(7d) and OSPlatform == "Linux" and isnotempty(HostDeviceId)
| summarize arg_max(Timestamp, *) by DeviceId, HostDeviceId
| join kind=inner (
    DeviceInfo
    | where Timestamp > ago(7d) and OSPlatform startswith "Windows"
    | summarize arg_max(Timestamp, *) by HostDeviceId = DeviceId
    | project HostDeviceId, HostDeviceName = DeviceName, HostOS = OSPlatform
) on HostDeviceId
| project WslDeviceName = DeviceName, WslDeviceId = DeviceId, HostDeviceName, HostDeviceId, HostOS`,
    rows: [
      {
        WslDeviceName: 'LAB-HOST-wslc',
        WslDeviceId: 'c41d9a72-8b3e-4f10-a52c-1e9b8d7c6f54',
        HostDeviceName: 'LAB-HOST',
        HostDeviceId: '8f3b2e10-4c9a-4d7e-9b1a-7c6d5e4f3a21',
        HostOS: 'Windows11',
      },
    ],
  },
  {
    id: 'process-events',
    label: '3. Inspect DeviceProcessEvents across WSL2 instances',
    shell: 'KQL',
    query: `let WslDeviceIds = DeviceInfo
| where Timestamp > ago(7d) and OSPlatform == "Linux" and isnotempty(HostDeviceId)
| distinct DeviceId;
DeviceProcessEvents
| where Timestamp > ago(24h)
| where DeviceId in (WslDeviceIds)
| where ProcessCommandLine has "diy-edr-test.sh" or FileName in ("bash", "curl", "python3")
| project Timestamp, DeviceName, AccountName, FileName, ProcessCommandLine, InitiatingProcessFileName
| order by Timestamp desc`,
    rows: [
      {
        Timestamp: '2026-10-11T06:00:08Z',
        DeviceName: 'LAB-HOST-wslc',
        AccountName: 'labuser',
        FileName: 'bash',
        ProcessCommandLine: '/bin/bash /usr/local/bin/diy-edr-test.sh --trigger-test-marker',
        InitiatingProcessFileName: 'bash',
      },
      {
        Timestamp: '2026-10-11T05:58:41Z',
        DeviceName: 'LAB-HOST-wslc',
        AccountName: 'labuser',
        FileName: 'python3',
        ProcessCommandLine: 'python3 -m http.server 8080 --bind 127.0.0.1',
        InitiatingProcessFileName: 'bash',
      },
    ],
  },
];

export default function DefenderWslSimulator() {
  const [activePanel, setActivePanel] = useState('healthcheck');
  const [edrTriggered, setEdrTriggered] = useState(false);
  const [selectedQueryId, setSelectedQueryId] = useState(KQL_PRESETS[0].id);

  const selectedPreset =
    KQL_PRESETS.find((preset) => preset.id === selectedQueryId) || KQL_PRESETS[0];

  return (
    <section
      data-testid="defender-wsl-simulator"
      aria-label="Defender for Endpoint WSL2 Portal & Hunting Simulator"
      className="rounded-xl border border-slate-800 bg-slate-900/70 p-6 space-y-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-cyan-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
              Interactive Defender Portal &amp; Hunting Simulator
            </span>
          </div>
          <h2 className="text-lg font-semibold text-white">
            Inspect WSL2 Plug-in Health, Device Inventory, and KQL Telemetry
          </h2>
          <p className="text-sm text-slate-300">
            Verify the Windows host plug-in output, inspect the paired{' '}
            <code className="text-cyan-300">LAB-HOST</code> and{' '}
            <code className="text-cyan-300">LAB-HOST-wslc</code> records, trigger the safe DIY Linux
            EDR test marker, and run the three Advanced Hunting KQL queries right in your browser.
          </p>
        </div>
        <Badge className="bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
          SensorHealth: Healthy
        </Badge>
      </div>

      <div
        role="tablist"
        aria-label="Simulator views"
        className="flex flex-wrap gap-2 border-b border-slate-800 pb-3"
      >
        {[
          { id: 'healthcheck', label: '1. healthcheck.exe Verifier' },
          { id: 'inventory', label: '2. Device Inventory (WSL2 Tag)' },
          { id: 'edr-test', label: '3. DIY Linux EDR Test Alert' },
          { id: 'hunting', label: '4. Advanced Hunting KQL' },
        ].map((tab) => {
          const isSelected = activePanel === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              data-testid={`defender-sim-tab-${tab.id}`}
              onClick={() => setActivePanel(tab.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isSelected
                  ? 'bg-cyan-500 text-slate-950 font-semibold'
                  : 'bg-slate-950/80 text-slate-300 border border-slate-800 hover:border-slate-700'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activePanel === 'healthcheck' && (
        <div data-testid="defender-sim-panel-healthcheck" className="space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>PowerShell — Windows 11 host verification command</span>
            <Badge variant="outline" className="border-slate-700 text-slate-300">
              PowerShell
            </Badge>
          </div>
          <pre className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-cyan-300 overflow-x-auto">
            <code>{`& "C:\\Program Files\\Microsoft Defender for Endpoint Plug-in for WSL\\tools\\healthcheck.exe"`}</code>
          </pre>
          <div className="grid gap-2 sm:grid-cols-2">
            {HEALTHCHECK_FIELDS.map((field) => (
              <div
                key={field.key}
                className="flex items-center justify-between rounded-lg border border-slate-800/90 bg-slate-950/60 px-3 py-2 text-xs"
              >
                <span className="font-mono text-slate-400">{field.key}</span>
                <span className="font-mono font-medium text-emerald-300">{field.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activePanel === 'inventory' && (
        <div data-testid="defender-sim-panel-inventory" className="space-y-3">
          <p className="text-xs text-slate-300">
            In the Microsoft Defender portal under <strong>Assets &gt; Devices</strong>, the Linux
            distribution appears as its own machine entry named{' '}
            <code className="text-cyan-300">&lt;HostName&gt;-wslc</code> tagged with{' '}
            <code className="text-cyan-300">WSL2</code> and linked to the parent Windows 11 device
            via <code className="text-cyan-300">HostDeviceId</code>.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {INVENTORY_DEVICES.map((device) => (
              <div
                key={device.deviceId}
                data-testid={`defender-device-${device.deviceName}`}
                className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-cyan-400" />
                    <span className="font-mono text-sm font-semibold text-white">
                      {device.deviceName}
                    </span>
                  </div>
                  <Badge className="bg-emerald-500/10 text-emerald-300 border-emerald-500/30 text-xs">
                    {device.healthState}
                  </Badge>
                </div>
                <div className="text-xs text-slate-400 space-y-1">
                  <div>
                    <span className="text-slate-500">DeviceId: </span>
                    <span className="font-mono text-slate-300">{device.deviceId}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">OS Platform: </span>
                    <span className="text-slate-200">{device.osPlatform}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Onboarding: </span>
                    <span className="text-slate-200">{device.onboardingStatus}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {device.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="outline"
                      className="border-cyan-500/40 bg-cyan-500/10 text-cyan-300 text-xs"
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activePanel === 'edr-test' && (
        <div data-testid="defender-sim-panel-edr-test" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-cyan-400" />
                <span className="text-xs font-semibold text-white">
                  bash — Run the safe DIY Linux EDR detection marker inside WSL2
                </span>
              </div>
              <p className="text-xs text-slate-300">
                Execute <code className="text-cyan-300">diy-edr-test.sh --trigger-test-marker</code>{' '}
                inside the Ubuntu WSL2 distribution to emit a benign test process event captured by
                the kernel sensor.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              data-testid="trigger-edr-test-btn"
              onClick={() => setEdrTriggered(true)}
              className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold"
            >
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Run DIY Linux EDR Test
            </Button>
          </div>

          <pre className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-200 overflow-x-auto">
            <code>{`bash -lc "~/mde-wsl-lab/diy-edr-test.sh --trigger-test-marker"`}</code>
          </pre>

          {edrTriggered ? (
            <div
              data-testid="edr-alert-banner"
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-amber-300 font-semibold text-sm">
                  <AlertTriangle className="h-4 w-4" />
                  <span>Informational Alert: Linux EDR DIY Test Alert (MDE WSL2 Plug-in)</span>
                </div>
                <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-xs">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Telemetry Verified
                </Badge>
              </div>
              <p className="text-xs text-slate-200">
                Device: <code className="text-cyan-300">LAB-HOST-wslc</code> (linked to{' '}
                <code className="text-cyan-300">LAB-HOST</code>) • Command line:{' '}
                <code className="text-cyan-300">
                  /bin/bash /usr/local/bin/diy-edr-test.sh --trigger-test-marker
                </code>
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              Click <strong>Run DIY Linux EDR Test</strong> above to simulate the test script and
              surface the resulting Defender alert.
            </p>
          )}
        </div>
      )}

      {activePanel === 'hunting' && (
        <div data-testid="defender-sim-panel-hunting" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {KQL_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-testid={`kql-preset-${preset.id}`}
                onClick={() => setSelectedQueryId(preset.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  selectedPreset.id === preset.id
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-slate-200'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <pre
            data-testid="kql-query-display"
            className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-cyan-300 overflow-x-auto"
          >
            <code>{selectedPreset.query}</code>
          </pre>

          <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/80">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="border-b border-slate-800 bg-slate-900/90 text-slate-400">
                <tr>
                  {Object.keys(selectedPreset.rows[0]).map((col) => (
                    <th key={col} className="px-3 py-2 font-mono font-medium">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {selectedPreset.rows.map((row, idx) => (
                  <tr key={idx} data-testid="kql-result-row">
                    {Object.values(row).map((val, colIdx) => (
                      <td key={colIdx} className="px-3 py-2 font-mono text-slate-200">
                        {val}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
