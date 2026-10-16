# Incident playbook — Lab host compromise

**What this is for:** the Hostinger lab host (`hcw-lab` / `lab.hybridcloudworks.com`) exhibits signs of unauthorized root access, container escape, backdoor installation, abnormal egress, or host firewall tampering.

**Doctrine:** **Assume compromise.** Do not attempt in-place remediation on an untrusted system. Isolate the machine immediately, revoke all identities and certificates granted to it, and rebuild from clean repository state.

---

## 1. Immediate isolation (Containment)

Act within 5 minutes to prevent lateral movement to connected services or Azure Arc.

### A. Network isolation
In Hostinger hPanel:
1. Open **VPS Management** -> `hcw-lab`.
2. Under **Firewall**, activate emergency restriction: block all incoming traffic, or stop the VPS instance.

If SSH is still accessible:
```bash
# Emergency iptables lockdown (allow only current SSH IP if needed, otherwise drop all)
sudo iptables -P INPUT DROP
sudo iptables -P FORWARD DROP
```

### B. Terminate workloads and runtime
```bash
# Force stop all containers
sudo docker stop $(sudo docker ps -q)
# Stop Docker and Coder services
sudo systemctl stop docker coder hcw-agent
```

---

## 2. Invalidate host credentials and identities

Ensure credentials formerly resident on the host cannot authenticate against the estate:

### A. Disconnect Azure Arc
Remove the Arc machine registration so the compromised host cannot leverage its managed identity:

```bash
az connectedmachine delete \
  --resource-group "rg-lab-hybrid-prod-cus" \
  --name "hcw-lab" \
  --yes
```

### B. Rotate Coder GitHub OAuth secret
1. Go to GitHub -> Settings -> Developer settings -> OAuth Apps -> **HCW Coder**.
2. Click **Generate a new client secret**.
3. Delete the old client secret.

### C. Revoke Labs Agent certificate
The agent client certificate `/etc/hcw/labs-agent.pem` used for reporting to the site is revoked:
1. Note the certificate thumbprint:
   ```bash
   openssl x509 -in /etc/hcw/labs-agent.pem -noout -fingerprint -sha256
   ```
2. Remove any trusted mapping in Key Vault / App configuration.

### D. Seal and re-initialize HashiCorp Vault
If Vault on the lab host was unsealed:
```bash
vault operator seal
```
Assume Vault data and unseal keys are compromised. The clean rebuild will re-initialize Vault with fresh keys.

---

## 3. Clean rebuild from scratch

Follow [Labs host](labs-host.md) instructions for a verified installation:

1. **Reinstall clean OS image:**
   - In Hostinger hPanel, trigger an OS Reinstall with **Ubuntu 24.04 LTS (64-bit)**.
   - Set a new strong root password and update the SSH port if necessary.

2. **Execute verified bootstrap:**
   On a trusted local desktop, pull the latest verified `main` branch:
   ```bash
   git clone https://github.com/saulpatinojr/HCW-HybridCloudWorks.git
   cd HCW-HybridCloudWorks
   ```
   Deploy the lab host configuration:
   ```bash
   # Execute bootstrap from repository commit
   ssh root@<LAB_HOST_IP> "bash -s" < lab-host/bootstrap.sh
   ```

3. **Re-onboard to Azure Arc:**
   Follow `docs/runbooks/labs-host.md` (§ "Azure Arc onboarding"):
   - Generate a temporary onboard service principal script in Azure Portal.
   - Run the onboard script on the rebuilt host.

4. **Re-establish desktop access:**
   Run `scripts/lab/Connect-Lab.ps1` from administrator desktops to issue fresh client SSH keys:
   ```powershell
   ./scripts/lab/Connect-Lab.ps1
   ```

---

## 4. Post-rebuild verification

1. **Verify user privilege separation (LAB-5):**
   Ensure Coder workspaces and user containers run unprivileged without Docker socket exposure:
   ```bash
   docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
   ```
2. **Audit Linux baseline security:**
   Run the compliance script to confirm sysctl, sshd, and UFW restrictions:
   ```powershell
   ./scripts/lab/audit-linux-baseline.ps1
   ```
3. **Verify audit logging:**
   Check that `auth` and `authpriv` syslog lines are arriving at the Azure Log Analytics workspace `rg-hcw-prod-mgmt-cus`.
