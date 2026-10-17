# arc

Onboards the lab host to Azure Arc (ADR 0032 decision 3, #663): the Azure
Connected Machine agent from Microsoft's apt repository at a pinned version,
connected to `rg-lab-hybrid-prod-cus` by a service principal that holds only
**Azure Connected Machine Onboarding** on that group (`infra/lab-hybrid.tf`).
It runs straight after `hardening` in `site.yml`, because the agent needs
nothing the later roles install and the host should appear in Azure even when
a later role fails.

Off until the host says otherwise: `arc_enabled` in `group_vars/all.yml` reads
the local fact `/etc/ansible/facts.d/hcw_arc.fact` and is true only when that
file is JSON whose `enabled` is `true`. Nothing in the repository sets it;
`scripts/lab/Register-LabArc.ps1 -Connect` writes it once the onboarding
grant is applied and the credential is in the vault, so a rebuilt host, which
has no such file, never stops at this role's fail-closed check on its first
run. The owner's procedure, two runs of that script with one `hcw-azure` run
between them, is
[docs/runbooks/labs-host.md](../../../../docs/runbooks/labs-host.md), "Arc
onboarding".

## What it does

With `arc_enabled: false`, nothing. It does not install the agent, and it
does not disconnect a machine that is already connected: disconnecting
deletes the Azure resource, so it is a runbook step, never the side effect of
a switch.

With `arc_enabled: true`:

1. Asserts no `arc_tags` name or value contains a comma, an equals sign or a
   space, because `azcmagent` takes them as `Name=Value,Name=Value`.
2. Fetches the key that signs the running release's Microsoft repository to
   `/etc/apt/keyrings/microsoft.asc`, refusing it unless its SHA256 matches
   `arc_apt_key_checksum` (the key is the root of trust for the version pin),
   and adds `https://packages.microsoft.com/ubuntu/<version>/prod`, suite
   `<codename>`, as a deb822 source with `Signed-By`. Microsoft signs the two
   repositories with different keys, so both the key and its checksum are
   chosen by codename:

   | Release | Repository | Key | Fingerprint |
   | --- | --- | --- | --- |
   | 26.04 `resolute` | `https://packages.microsoft.com/ubuntu/26.04/prod` | `microsoft-2025.asc` | `AA86F75E427A19DD33346403EE4D7792F748182B` |
   | 24.04 `noble` | `https://packages.microsoft.com/ubuntu/24.04/prod` | `microsoft.asc` | `BC528686B50D79E339D3721CEB3E94ADBE1229CF` |

   <https://packages.microsoft.com/keys/README> is Microsoft's account of
   why: repositories created since spring 2025 are signed with the newer
   key. `microsoft.asc` cannot verify the 26.04 repository's `InRelease`
   at all.
3. Installs `azcmagent` at `arc_agent_version` and holds it, the same pattern
   as the `docker` role; `allow_change_held_packages` lets a pin bump move it.
   The package drops `/etc/cron.d/azcmagent_autoupgrade`, which does nothing
   unless automatic upgrade is enabled, and this role never enables it: the
   version moves when the pin moves.
4. Reads `azcmagent show --json`. When `status` is `Connected` it stops
   there, and the vault values are not needed, which is what lets the
   runbook delete the secret after onboarding (ADR 0032: the credential is
   never on the host after onboarding).
5. Otherwise it fails closed unless all four `vault_arc_*` values are
   present and the application, tenant and subscription ids are GUIDs, then
   writes them with the target group, region, resource name and tags into a
   root-only `0600` temporary file and runs `azcmagent connect --config
   <file>`. The secret is never on a command line, where it would sit in the
   process table; the file is deleted in an `always:` whether connect
   succeeds or not. Microsoft recommends `--config` over
   `--service-principal-secret` for exactly this reason.
6. Reads `azcmagent show --json` again and fails unless it reports
   `Connected`. The success line reads `Connected to Azure Arc as
   arcs-lab-hybrid-prod-cus-01 in rg-lab-hybrid-prod-cus.`
7. Locks the agent down (estate review 2026-10-06, LAB-6; ADR 0032,
   amendments of 2026-10-06 and 2026-10-07): the extension allowlist is
   `arc_extensions_allowlist` alone (the Azure Monitor Agent), and guest
   configuration is off. Incoming connections through Arc are on for port
   22 alone (`incomingconnections.enabled true`,
   `incomingconnections.ports 22`) while `arc_incoming_ssh_enabled` is true,
   its default since #953 (LAB-7; ADR 0032, amendment of 2026-10-16): that
   is Azure Arc SSH, the owner's way to sshd once port 22 is closed to the
   internet, and sshd still asks for the pinned key. False puts LAB-6's
   state back, incoming connections off and no port listed. Each setting is
   read with `azcmagent config get` and written with `config set` only when
   it differs, so a second run reports nothing changed; then all three are
   read back, and the run fails closed unless the allowlist is still the
   Azure Monitor Agent alone and port 22 is the only port admitted. In
   check mode, which the nightly drift check (`hcw-playbook-drift`) runs,
   the settings are read all the same and any difference is reported as one
   changed task, which that check counts as drift, without stopping the
   check of the roles after this one.
   These settings live on the host and cannot be changed from Azure, which
   is the point: a Contributor on the resource group can no longer push an
   extension or a Run Command, and a custom machine configuration policy
   cannot rewrite them. Read back on the host with `sudo
   /opt/azcmagent/bin/azcmagent config list`.

What it does **not** do: install the Azure Monitor Agent, or associate the
data collection rule. Both are Azure-side operations on the machine resource,
which exists only after step 5, and the onboarding role cannot install an
extension. `Register-LabArc.ps1 -Connect` does both once the machine is
Connected, and then deletes the credential from Entra and the vault.

## Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `arc_enabled` | required (`group_vars`: the host's `hcw_arc` local fact, false without it) | Onboard the host |
| `arc_agent_version` | required | apt version of `azcmagent`, four-part |
| `arc_apt_key_checksum` | required | `sha256:<hex>` the fetched key must match; `group_vars` picks it from `arc_apt_key_checksums` by codename |
| `arc_resource_group` | required | `rg-lab-hybrid-prod-cus` |
| `arc_location` | required | `centralus` |
| `arc_resource_name` | required | `arcs-lab-hybrid-prod-cus-01`; fixed, because it cannot change without a disconnect |
| `arc_tags` | required | Tags on the machine resource; `infra/`'s tag set with `managedBy: ansible` |
| `arc_apt_key_urls` | `resolute`: `microsoft-2025.asc`, `noble`: `microsoft.asc` | Codename to signing key source |
| `arc_apt_key_url` | the running release's entry of `arc_apt_key_urls` | Signing key source |
| `arc_apt_key_path` | `/etc/apt/keyrings/microsoft.asc` | Signing key location, whichever key it is; `get_url` replaces a file whose checksum does not match |
| `arc_apt_repository_url` | `https://packages.microsoft.com/ubuntu/<running version>/prod` | Repository base |
| `arc_azcmagent_path` | `/opt/azcmagent/bin/azcmagent` | The CLI |
| `arc_cloud` | `AzureCloud` | Azure cloud |
| `arc_service_principal_id` | `vault_arc_service_principal_id` | Application (client) id of the onboarding principal |
| `arc_service_principal_secret` | `vault_arc_service_principal_secret` | Its client secret |
| `arc_tenant_id` | `vault_arc_tenant_id` | Entra tenant id |
| `arc_subscription_id` | `vault_arc_subscription_id` | Application subscription id |
| `arc_extensions_allowlist` | `Microsoft.Azure.Monitor/AzureMonitorLinuxAgent` | The extensions the agent may install (LAB-6) |
| `arc_incoming_ssh_enabled` | `true` | Azure Arc SSH: incoming connections on, port 22 alone (#953). False turns incoming connections off and clears the port |

To bump the agent, read the versions the repository offers and change
`arc_agent_version` in `group_vars/all.yml`. It is one pin because
Microsoft publishes the same version string to both releases' repositories
(1.68.03532.1399 was the newest in each on 2026-09-26); check both before
moving it. Bash, from anywhere with network access; the last line each
prints is the newest, 26.04 first:

```bash
curl -s https://packages.microsoft.com/ubuntu/26.04/prod/dists/resolute/main/binary-amd64/Packages | awk '/^Package: azcmagent$/{p=1} p&&/^Version:/{print $2; p=0}' | sort -V | tail -3
```

```bash
curl -s https://packages.microsoft.com/ubuntu/24.04/prod/dists/noble/main/binary-amd64/Packages | awk '/^Package: azcmagent$/{p=1} p&&/^Version:/{print $2; p=0}' | sort -V | tail -3
```

The key checksums, bash; the first is the `resolute` entry of
`arc_apt_key_checksums`, the second the `noble` entry:

```bash
curl -sL https://packages.microsoft.com/keys/microsoft-2025.asc | sha256sum
```

```bash
curl -sL https://packages.microsoft.com/keys/microsoft.asc | sha256sum
```

Microsoft Learn lists Ubuntu 26.04 as supported for Arc-enabled servers on
x86-64 (not Arm64), and Ubuntu 26.04 LTS as supported by the Azure Monitor
Agent, both read 2026-09-26:
<https://learn.microsoft.com/azure/azure-arc/servers/prerequisites#supported-operating-systems>
and
<https://learn.microsoft.com/azure/azure-monitor/agents/azure-monitor-agent-supported-operating-systems>.

Microsoft supports agent versions released in the last year, so a pin older
than that is a finding.

## Handlers

None. The agent's services are started by its package and by `connect`.

## Check mode

Safe. The status read runs in check mode because it is read-only; connect
and the temporary file are skipped. Step 7's reads of the agent's settings
run in check mode too, and a difference is reported as one changed task,
which the nightly drift check (`hcw-playbook-drift`) counts as drift. Its
writes, and the read-back and fail-closed check after them, are skipped.

## Validated

On 2026-09-26, against a systemd Ubuntu 26.04 container (and again on
24.04): the role fetched `microsoft-2025.asc` on 26.04 and `microsoft.asc` on
24.04, each matching its pinned checksum; apt accepted the 26.04
repository's `InRelease` with the 2025 key; `azcmagent 1.68.03532.1399`
installed and held on both; `azcmagent show --json` returned
`Disconnected`; the role failed closed on the missing vault values; and a
second run reported every install task unchanged (`changed=0`).

On 2026-09-25, against a systemd Ubuntu 24.04 container: the key checksum
matched, `azcmagent 1.68.03532.1399` installed and held, a second run
reported the install tasks unchanged, `azcmagent show --json` returned
`Disconnected`, the role failed closed with the vault absent, and with
placeholder GUIDs `connect` read the `--config` file (it named the tenant
from it in the error) and the file was gone afterwards.
