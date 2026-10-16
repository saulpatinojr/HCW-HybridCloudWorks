# lab-host/coder

Coder Community edition on the lab host: the Compose file, the `hcw-lab`
workspace template and the test that holds both to the boundary ADR 0032
draws (#679, Phase 1 of #659). The Ansible `coder` role in `../ansible`
deploys the Compose file, and the template is published from the host with
`/usr/local/sbin/hcw-coder-template-push`, which that role installs.
Operating procedures — enabling, first sign-in, publishing the template, the
kill switches, rotation, backups — are in [`../README.md`](../README.md)
under "Coder".

## Files

| File | What it is |
| --- | --- |
| `docker-compose.yml` | `coder` and `coder-postgres`, the only two Compose services on the host. Images are interpolated from a role-written `.env` so the digests live once, in `../ansible/group_vars/all.yml`. Every `CODER_*` name is checked against <https://coder.com/docs/reference/cli/server> (comment at the top) |
| `compose-config-check.sh` | Proves the Compose file parses without the host: stand-ins for the three role-written files in a temporary directory, then `docker compose config`. Prints the two service names on success |
| `templates/hcw-lab/main.tf` | The workspace template: Coder's Docker starter adapted to uid 65534, one CPU, 2 GiB, no socket, no host path, no capabilities, a per-workspace volume and a per-workspace bridge network, `code-server` on `*.coder.lab` with the editor's User settings (below), a tmpfs for the cloud CLIs' sign-ins and a precondition that refuses a start while another of the learner's workspaces runs ("Running workspaces and sign-ins", below). Providers and the module are pinned; `.terraform.lock.hcl` is committed. `templates/amo-guided-lab` and `templates/na-guided-lab` are the add-ons' guided labs, with the same boundary, tmpfs and precondition |
| `templates/hcw-lab/README.md` | Shown to learners on the template's page in Coder |
| `templates/hcw-lab/template.test.mjs` | The hardening test (`node --test`). Fails when any service mounts or names the host's Docker socket, the proxy mounts anything but the `coder_sandbox` daemon's socket directory (LAB-5), anything is `privileged`, the workspace maps a host path, joins the Compose network or does not run as 65534, or when workspace apps could be served by path on the dashboard's origin (`CODER_DISABLE_PATH_APPS` not `"true"`, or an app that is not a subdomain app). Also pins the editor's User settings and the two versions they were checked against, and, in every template, the sign-in tmpfs, the variables that point the cloud CLIs into it, the running-workspace precondition and the read it counts from (#954). Never published: `hcw-coder-template-push` copies only `*.tf`, the lock file and the README |
| `package.json` | `npm test` runs `node --test`; no dependencies, no lockfile |
| `launcher/` | The lab launcher: `index.html`, `main.js`, `launcher.js` and `launcher.css`, static, with no build step and no third-party code. The `coder` role installs them and Caddy serves them at `https://coder.lab.hybridcloudworks.com/_hcw/lab/` (below). `scripts/lab-host-launcher.test.mjs` tests the logic in `launcher.js` with a mocked Coder, the files and the route |

## The lab launcher

The site's panes load this, not a Coder page (owner decision 2026-09-28:
the lab is reached only through panes on the site). Coder's dashboard opens
code-server in a new window or tab, `open_in` has no same-frame value, and
the panes-only rule turns a new window into the labs page, so the editor
could never open in a pane from the dashboard. The launcher, on the
dashboard's own name so it has the learner's session and Coder's API:

1. Takes `?lab=<id>` and maps it, through `LAB_WORKSPACES`, to the learner's
   workspace for that lab: `lab-lzb`, `lab-tfv` or `lab-asc`. Anything else
   gets `There's no lab at this address.` The names are the site
   catalogue's `workspaceName`s, and tests on both sides fail when they
   differ. At most 16 characters, because code-server's address,
   `code-server--<workspace>--<owner>`, is one DNS label of 63 and a Coder
   username can be 32.
2. `GET /api/v2/users/me`. A 401 says to use **Sign in with GitHub** above
   the pane, which is the site's button. Otherwise its `username`,
   lowercased and held to Coder's rule for a name, is the owner in
   code-server's name below.
3. `GET /api/v2/users/me/workspace/<name>`. None yet: first `GET
   /api/v2/organizations/default/templates/hcw-lab`, once, the read Coder's
   create page makes first (`default` is Coder's name for the default
   organization). A 404 there, which Coder answers both for a template it
   does not have and for one the learner cannot read, or a deprecated
   template, ends it with `Lab workspaces aren't available right now.`, and
   Coder's page is never loaded: loaded, it shows Coder's own red `Resource
   not found or you do not have access to this resource` box with a stack
   trace, as it did on 2026-09-28 before the template was published. With
   the template there: Coder's own create page,
   `/templates/hcw-lab/workspace?mode=auto&name=<name>&param.lab=<id>`,
   in a frame of the same origin, where the learner confirms Coder's
   dialog. Stopped or cancelled: it starts the workspace itself, once a
   visit, with `POST /api/v2/workspaces/<id>/builds` and the CSRF token
   read from Coder's own page (#911); when Coder refuses, Coder's own
   workspace page, `/@me/<name>`, where Start is. Failed: that page, with
   Retry, unless the failure is the running-workspace limit's (next step).
   It never creates a workspace itself.

   A failed start: `GET /api/v2/workspacebuilds/<build>/logs`, once per
   build. When an error line carries the template's `Stop your other lab
   first: <name>.` and `<name>` is a Coder workspace name, it reads
   `/api/v2/users/me/workspace/<name>`. While that workspace is starting or
   running, the pane says `Only one of your lab workspaces runs at a time,
   and <name> is running. Stop it on the page below, and this lab starts.`
   and frames `/@me/<name>`, where Stop is. Once it is not, it starts this
   lab's workspace itself, once a visit, the same call as above.
4. Waits, from one second between reads up to five, until the latest build
   is running, the agent is connected and ready, and the `code-server`
   app's `health` is `healthy`. Ten minutes, or six failed reads in a row,
   end it with `Lab workspaces aren't available right now.`
5. Checks `subdomain_name`, lowercased, against
   `^code-server--[a-z0-9-]+--[a-z0-9-]+$` and 63 characters, and requires
   it to be exactly `code-server--<workspace>--<username>`, so the pane can
   only ever open the learner's own editor for this lab. Then
   `location.replace('https://' + name + '.coder.lab.hybridcloudworks.com/')`.
   The suffix is a constant. code-server stays on its own name, away from
   Coder's API.
6. Posts its state to the site, `{ type: 'hcw-lab', state }`, once to
   `https://hybridcloudworks.com` and once to
   `https://www.hybridcloudworks.com`; the browser delivers the one that
   matches the page holding the pane.

Text reaches the page only through `textContent`, never from the query
string. Caddy sends it with `default-src 'none'`, scripts, styles, fetches
and frames from `coder.lab` only, `base-uri 'none'` and `form-action
'none'`, beside the panes-only `frame-ancestors`, and `Cache-Control:
no-store`. It has no top-level exemption.

## Running workspaces and sign-ins

Owner decision 2026-10-16 (#954), in all three templates, and checked by
`templates/hcw-lab/template.test.mjs` in each:

- **One running workspace per learner.** `data "http" "owner_workspaces"`
  reads `http://127.0.0.1:7080/api/v2/workspaces?q=owner:me` on a start
  build only (its `count` needs `start_count` and the owner's session
  token, which a template import does not have), from inside the `coder`
  container where the provisioner runs Terraform, and fails the build
  unless Coder answers 200. A precondition on the workspace container then
  refuses the start while another of the owner's workspaces has a start
  queued, under way or done (`pending`, `starting`, `running`), with
  `Only one lab workspace can run at a time. Stop your other lab first:
  <name>.` Checked at plan, so a refused start creates nothing. The limit
  is `local.max_running_workspaces`, 1.
- **Sign-ins in memory.** A tmpfs at `/tmp/cloud-creds`, mounted
  `rw,nosuid,nodev,noexec,size=64m,uid=65534,gid=65534,mode=0700` through
  the container's `tmpfs` map (a `mounts` block's tmpfs options take no uid), and the
  agent's environment points `AZURE_CONFIG_DIR`, `AWS_CONFIG_FILE`,
  `AWS_SHARED_CREDENTIALS_FILE` and `CLOUDSDK_CONFIG` into it. A sign-in is
  never written to the home volume and ends when the workspace stops. Two
  limits, by design: `az` keeps its extensions and the Bicep binary in its
  configuration directory too, so they would be installed into a
  `noexec` tmpfs and gone at the next stop (no lab uses them); and the
  AWS CLI keeps its single sign-on and role caches under `~/.aws` whatever
  the variables say (the image ships no AWS CLI).

Measured 2026-10-16 with `terraform plan -json`, run as Coder's
provisioner runs it, for each template against a stand-in for Coder's API:
another workspace running, starting or with a start queued is refused, one
stopped, stopping, with a stop queued or with a failed start is not, the
learner's own workspace never counts, a 401 or a 500 fails the start, and
an import (no token) and a stop build never call the API.

## The editor's settings

`module "code-server"` in `templates/hcw-lab/main.tf` passes four User
settings through the module's `settings` input (module 1.6.0), which merges
them into `~/.local/share/code-server/User/settings.json` before
code-server starts, on every start. Each name was checked against VS Code
1.140.0, the release code-server 4.140.0 carries:

| Setting | Why |
| --- | --- |
| `security.workspace.trust.enabled: false` | The first workspace opened in Restricted Mode (2026-09-28), and extensions and tasks waited for the learner to trust the folder. The folder is this repository's, in a disposable, isolated workspace, so trust guards nothing here |
| `chat.disableAIFeatures: true` | Hides VS Code's built-in AI features, the Chat panel ("Build with Agent") with them, which opened on the right and asked for a sign-in the site does not offer |
| `workbench.startupEditor: "readme"` | The lab folder's README first. The Landing Zone Builder lab's startup script writes one; the other two lab folders have none today, and VS Code shows its Welcome page there instead |
| `telemetry.telemetryLevel: "off"` | No usage data from a learner's editor |

A workspace picks them up from the template version it is built from, so
one built before they were published gets them once it is updated (Coder's
**Update and start…**).

## The boundary, in one paragraph

Three processes may drive the Docker daemon on the host and nothing else: the
Coder **server** container, which has `/var/run/docker.sock` because that is
how Coder's documented Docker install creates workspaces, `vps-agent`, and,
when the owner turns it on, Portainer, which only the owner reaches, through
an SSH tunnel to the loopback (ADR 0032, amendment of 2026-09-26).
A **workspace** is a container the server creates from the template with
`user = "65534:65534"`, `privileged = false`, every capability dropped,
`no-new-privileges`, hard memory and CPU limits, one named volume at
`/tmp/home` and its own `coder-ws-<id>` bridge network with no route to the
Compose network. Its one app, code-server, is served on a name of its own
under `*.coder.lab`, and path-based apps are off (`CODER_DISABLE_PATH_APPS`,
2026-09-28), so no workspace's JavaScript runs on the dashboard's origin,
where it could call the Coder API as the learner. Whoever controls the
server controls the daemon; a learner inside a workspace controls 2 GiB of
`nobody`. Its cloud CLIs sign in to a 64 MiB tmpfs, never to the volume,
and a learner has one workspace starting or running at a time (#954).
The test is what keeps those sentences true when either file changes.

## Community edition caps

Written down so nobody rediscovers them (#659):

- **One platform integration.** Understood to mean external auth for git
  providers, not the GitHub OAuth login; #682's live check confirms which.
- **Five concurrent AI agents.** Not used by this template.
- Autostop requirement, dormancy and failure cleanup are Premium; the
  one-hour default TTL is Community and is set with `coder templates edit`,
  which `hcw-coder-template-push` runs after every publish.
- No enforced workspace count. `coder_max_workspaces` in `group_vars` is the
  number the host is sized for and the role asserts it against the host's
  memory; it is not a Coder setting. Per learner, the templates enforce
  one running workspace themselves (#954): Community has no quota for it.
- No user without a sign-in. In v2.37.3, `--login-type none` needs a
  service account, and service accounts are Premium (the server answers
  `Service Accounts is a Premium feature`; measured 2026-09-28). The site's
  status token therefore belongs to a GitHub user that no GitHub account can
  become ([`../README.md`](../README.md), "The status token for the site").

## Checking without the host

From the repository root. PowerShell:

```powershell
node --test "lab-host/coder/**/*.test.mjs"
```

```powershell
terraform -chdir=lab-host/coder/templates fmt -recursive -check -diff
```

```powershell
foreach ($t in 'hcw-lab', 'amo-guided-lab', 'na-guided-lab') { terraform -chdir="lab-host/coder/templates/$t" init -backend=false; terraform -chdir="lab-host/coder/templates/$t" validate }
```

The Compose check is bash (Git Bash), because it is a shell script:

```bash
bash lab-host/coder/compose-config-check.sh
```

Success: `node --test` reports `pass 28`, `fail 0`; `fmt` prints nothing;
each `validate` prints `Success! The configuration is valid.`; the compose
check prints `coder-postgres` and `coder` (dependency order). The
`coder (lab-host)` job in `.github/workflows/ci.yml` runs the same on
every change under `lab-host/coder/`.

A `terraform plan` also works offline and shows the rendered startup
script, because the `coder_*` data sources fall back to defaults with no
server. PowerShell:

```powershell
terraform -chdir=lab-host/coder/templates/hcw-lab plan -refresh=false
```

## Updating

| Change | Where | Then |
| --- | --- | --- |
| Coder or PostgreSQL version | `coder_image_*`, `coder_postgres_image_*` in `../ansible/group_vars/all.yml` (`../ansible/roles/coder/README.md` shows the `imagetools inspect` lines) | Merge, then re-run `bootstrap.sh` on the host, which checks out the merged `main`. A new PostgreSQL major is a dump and a restore, not a pin bump alone: `../ansible/roles/coder/README.md`, "The next major" |
| Workspace image | `image_tag` and `image_digest` in `templates/hcw-lab/main.tf`, from the `publish-lab-image.yml` job summary | Merge, re-run `bootstrap.sh`, then publish with `hcw-coder-template-push` (`../README.md`, "Publishing the template") |
| Providers or the `code-server` module | `required_providers` and `module "code-server"` in `main.tf`, then `terraform init -upgrade` to refresh `.terraform.lock.hcl`. A new module or code-server version means checking the editor settings against it ("The editor's settings", above); `template.test.mjs` pins both versions so the bump says so | The same: merge, `bootstrap.sh`, publish |
| The editor's settings | `settings` in `module "code-server"` in `main.tf`, and the list in `template.test.mjs` | The same: merge, `bootstrap.sh`, publish |
| A new lab | `local.labs` in `main.tf` and the matching `option` and `validation` regex; the catalogue in `frontend/src/data/labs/catalogue.js` (#681) | The same: merge, `bootstrap.sh`, publish |
| Workspace limits | `memory_mib`, `cpu_quota` in `main.tf`; `coder_workspace_memory_mib` in the role's defaults if the memory changes, so the capacity assertion stays true | The same: merge, `bootstrap.sh`, publish |
| Running workspaces and sign-ins (#954) | `max_running_workspaces` and `cloud_creds_dir` in the `locals` block each template opens with "Sign-ins in memory", the same in all three; the launcher's `LIMIT_REFUSAL` if the precondition's wording changes, which `template.test.mjs` holds to it | The same: merge, `bootstrap.sh`, which publishes every template that changed |
| The one-hour autostop | `coder_template_default_ttl` in `../ansible/roles/coder/defaults/main.yml`, whole hours | Merge, `bootstrap.sh` (it renders the helper), then publish |

Every one of those is caught by `template.test.mjs` if it loosens the
boundary, which is the point of running it in CI.
