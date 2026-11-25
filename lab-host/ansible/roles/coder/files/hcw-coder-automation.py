#!/usr/bin/python3 -I
"""Keep the site's Coder status token renewed, publish the template, and report.

Installed by the coder role as /usr/local/libexec/hcw-coder-automation,
root:root 0750, and run four ways, each as root:

    hcw-coder-automation [--config PATH] seed [--force]
        The owner's one-time step, through /usr/local/sbin/hcw-coder-automation-seed,
        with the owner's own short-lived Coder token on stdin. Creates the
        rotation credential and stores it.
    hcw-coder-automation [--config PATH] run [--rotate-now] [--rotate-credential]
        hcw-coder-automation.service, once a day from its timer. Renews the
        site's status token when it is due, hands it to the site, deletes the
        old ones, renews the rotation credential itself, and reports.
    hcw-coder-automation [--config PATH] push-template [--force]
        The coder role, on every bootstrap.sh run. Publishes every template
        under lab-host/coder/templates (hcw-lab first) with the rotation
        credential, each when its own files changed.
    hcw-coder-automation [--config PATH] revoke
        The owner's way to turn it off. Deletes the rotation credential, and
        any on the deletion list, in Coder before removing the file, so no
        unscoped token outlives the automation (review of #1035).

The configuration (default /etc/hcw/coder/automation.json) is rendered by the
coder role from its variables: paths, names and the agent's user, no secret.
roles/coder/README.md, "Coder automation", has the design;
docs/runbooks/labs-host.md, "Automatic renewal", has the owner's lines.

THE ROTATION CREDENTIAL is an unscoped Coder API token belonging to the
`hcw-status` user, which holds Template Admin and never Owner. Unscoped, it
can do what that role can: create hcw-status's own scoped tokens, delete its
old ones, renew itself, and publish templates. It cannot act as anyone else,
manage users or change deployment settings, which is why it is hcw-status's
and not the owner's. This helper refuses to use it if hcw-status ever holds
Owner.

It is stored as a root-only file (/etc/hcw/coder/automation/rotation-token,
0600, its directory 0700), not in a vault, because nothing on this host can
read a vault secret non-interactively at timer time any better than that:

- HashiCorp Vault (the vault role) has no authentication method this host
  can use unattended. Its root token is typed by the owner at a hidden
  prompt and removed afterwards (docs/runbooks/labs-host.md, "HashiCorp
  Vault: initialising and unsealing"), the role never holds a token, and
  under Shamir keys every reboot seals it until the owner unseals it. A Vault
  token stored on the host to read this one would be a root-only file too.
- The Ansible vault (/etc/hcw/ansible/vault.yml, written by hcw-vault-set,
  which is where the coder role's three secrets come from) can be read
  unattended, but only with /etc/hcw/ansible/vault-password, a root-only file
  on the same disk, so encrypting gains nothing against root. And a timer
  rewriting vault.yml would race the owner's hcw-vault-set and
  Register-LabAgent.ps1, which write the same file, and would hand the
  credential to every task of every bootstrap.sh run as an extra variable.

Root on this host can already read Coder's database and mint any token, so a
root-only file adds no reach to someone who has root. This helper refuses the
file unless it is a regular file owned by the user running it, with no group
or other permission bits.

THE SITE'S STATUS TOKEN is a token of hcw-status scoped to template:read,
workspace:read, api_key:read and user:read (lab-host/README.md, "The status
token for the site", has why each). It reaches the site only through the lab agent's
own CLI, vps-agent/bin/report-coder-automation.js, run as the agent's user
with the agent's environment, which stores it in the site's Key Vault as
CODER-STATUS-TOKEN. A new token is live only once that CLI answers
{"ok": true, "stored": true}.

The CLI is run with systemd-run: --uid and --gid of the agent's user, its
EnvironmentFile (root:root 0600, which systemd reads as root, so the agent's
user never needs to read it) and its WorkingDirectory, the same three lines
its unit has, with the JSON on stdin through --pipe and the exit status
propagated by --wait. The alternative, runuser after sourcing the file, would
parse a systemd EnvironmentFile as shell, which is not the same syntax, and
would make this helper the parser of the agent's configuration.

Coder's API (read on 2026-10-08 against v2.38.0; group_vars/all.yml pins the
release in use), as used here:

- GET    /api/v2/users/{user}                     the owner's view of hcw-status
- GET    /api/v2/users/me                         who a token is
- GET    /api/v2/users/me/keys/tokens             hcw-status's tokens (expired ones left out)
- POST   /api/v2/users/{user}/keys/tokens         201 {"key": "<id>-<secret>"}; 409 on a name in use
- GET    /api/v2/users/me/keys/{id}               one token's record, expires_at among it
- DELETE /api/v2/users/me/keys/{id}               204
- GET    /api/v2/workspaces?q=status:running      {"workspaces": [...], "count": n}

  https://coder.com/docs/reference/api/users ("Get user tokens", "Create
  token API key", "Get API key by ID", "Delete API key") and
  https://coder.com/docs/reference/api/workspaces ("List workspaces"), read
  2026-10-08. The request body is codersdk.CreateTokenRequest
  (codersdk/apikey.go at v2.38.0): token_name, scopes, and `lifetime`, a Go
  time.Duration, which encoding/json writes as an integer count of
  NANOSECONDS, so 90 days is 7776000000000000. With no scopes the server
  gives the token coder:all (coderd/apikey.go, postToken), which is what the
  rotation credential is. The lifetime is checked against the TARGET user's
  maximum: --max-admin-token-lifetime (168h by default) for an Owner, and
  --max-token-lifetime (876600h) for everyone else, Template Admin included
  (coderd/apikey.go, getMaxTokenLifetime; https://coder.com/docs/reference/cli/server).
  A token is <10-character id>-<22-character secret> (coderd/apikey/apikey.go),
  and the id, the part before the dash, is not secret: it is how a token's own
  record is read.

Nothing this helper prints, logs, reports or writes to its state file holds a
token. Its messages are fixed words, HTTP statuses, user and token names and
dates, and every message is scrubbed of the tokens this process has seen
before it goes anywhere. Exit status: 0 done, 1 failed (the unit then shows
failed, and its OnFailure= notifier raises the lab alert), 2 refused before
anything changed (seed), 3 skipped because there is no working rotation
credential yet (push-template).

THE MODULES. This file is only the way in. The helper itself is the package
hcw_coder_automation, split out of this file by job (the settings and scrub,
Coder's API, the files, the delivery to the site, the rotation credential,
the status token, and one module per command) on 2026-11-25 so that no file
is too complex to review (#1845). The coder role installs it as
/usr/local/lib/hcw-lab/coder-automation/hcw_coder_automation/, every
directory root:root 0755 and every file root:root 0644, and installs
/usr/local/libexec/hcw-lab-python-launch from this role's
files/hcw-lab-python-launch.py. That file checks, before anything is
imported, that every directory from / down to the package and every file in
it is owned by root and writable by root only, with no symbolic link and
nothing else beside the package, and refuses to run with one line naming the
path otherwise; only then does it put that one directory first on the module
path and run the package's cli.main(). Its docstring has the reasons. The
paths are constants here, the same ones the role's tasks name, never taken
from the environment, an argument, the working directory or this file's own
location.
"""

import runpy
import sys

# Constants on purpose: see "THE MODULES" above.
LAUNCHER = "/usr/local/libexec/hcw-lab-python-launch"
LIB_DIR = "/usr/local/lib/hcw-lab/coder-automation"
PACKAGE = "hcw_coder_automation"

if __name__ == "__main__":
    sys.exit(runpy.run_path(LAUNCHER)["launch"](LIB_DIR, PACKAGE, "hcw-coder-automation"))
