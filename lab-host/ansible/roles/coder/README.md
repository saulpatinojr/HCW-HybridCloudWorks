# coder

Coder Community edition and its PostgreSQL under Docker Compose, behind the
Caddy the `caddy` role runs (ADR 0032, decisions 2 and 4; #679, Phase 1 of
#659). The Compose file is `lab-host/coder/docker-compose.yml` in this
repository; this role puts it on the host, writes the three files it reads,
starts or stops it, adds the Caddy route and keeps a week of nightly dumps.

## What it does

1. **Fails closed** when `coder_enabled` is true and any of these holds: the
   GitHub organisation allowlist is empty (an empty
   `CODER_OAUTH2_GITHUB_ALLOWED_ORGS` lets any GitHub account in); the GitHub
   team allowlist is empty (an empty `CODER_OAUTH2_GITHUB_ALLOWED_TEAMS` lets
   every member of those organisations in), or names a team that is not
   `<organisation>/<team-slug>` with its organisation in the organisation
   allowlist, spelled the same way (Coder checks a team only inside an
   organisation the learner already passed, so any other team would let
   nobody in; `tasks/signin_policy.yml`); one of
   `vault_coder_oauth2_github_client_id`,
   `vault_coder_oauth2_github_client_secret` and
   `vault_coder_postgres_password` is unset; the password holds a character
   that would need escaping in `CODER_PG_CONNECTION_URL`; or
   `coder_max_workspaces` workspaces at 2 GiB each plus 2.5 GiB for Coder,
   PostgreSQL and the OS exceed the host's memory. The last one is what makes
   `coder_max_workspaces` a number the host is actually sized for rather than
   a comment: Coder Community does not enforce a workspace count.
2. Reads the `docker` group's id with `getent` and writes it, with the two
   `image@digest` references from `group_vars/all.yml`, to
   `/etc/hcw/coder/.env`, which Compose interpolates into the file. The
   digests live once, in `group_vars`, and the Compose file names no
   version of its own.
3. Copies `lab-host/coder/docker-compose.yml` from the repository checkout
   to `/etc/hcw/coder/docker-compose.yml`. One source, no copy under
   `files/`.
4. Writes `/etc/hcw/coder/coder.env` (GitHub OAuth client id and secret, the
   organisation and team allowlists, `CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS`, the
   PostgreSQL connection URL) and `/etc/hcw/coder/coder-postgres.env` (`POSTGRES_PASSWORD`), both
   `root:root` `0600`, with `no_log`. Two files so the database container
   never receives the OAuth secret. While disabled both are written empty:
   the Compose file marks them `required`, so `docker compose down` could
   not parse the project without them, and an empty file leaves nothing for
   a manual `up` to reuse.
5. `docker compose up -d --wait` (`community.docker.docker_compose_v2`,
   `pull: missing`, `remove_orphans`) when enabled; `docker compose down`
   with the volume kept when not. A changed `coder.env` recreates the
   `coder` container on the next run, which is how a rotated secret takes
   effect.
   A Coder with no account is never published. After a fresh install, or a
   restore that left the database empty, whoever reached it could make its
   first account, the Owner: through `/setup`, or through a GitHub sign-in,
   which Coder v2.38.0 lets through for the first account even with sign-ups
   off.
   - **Before `up`:** PostgreSQL starts first and alone, and the role counts
     Coder's accounts in it, system accounts left out. With none, or a
     database it cannot read, `tasks/unpublish.yml` removes Coder's Caddy
     route and flushes the reload handler, so Caddy drops the route before
     Coder starts.
   - **After `up`:** `tasks/first_user.yml` asks
     `http://127.0.0.1:7080/api/v2/users/first`. On a 404 it takes down any
     route left and fails, and Coder stays on the host's loopback for the
     runbook's "A Coder with no account yet".
   - **A host with accounts:** reads 1 or more and 200, and nothing changes.
6. Installs the lab launcher, `lab-host/coder/launcher/` from the repository
   checkout, in `/etc/caddy/hcw-lab-launcher` (`coder_launcher_dir`; the
   directory `root:caddy` `0750`, its four files `0640`, copied by name from
   `coder_launcher_files`). It is the page the site's panes load, and it
   opens code-server inside the pane (`lab-host/coder/README.md`, "The lab
   launcher"). Caddy serves whatever is in the directory, so anything else
   found there is removed. Caddy reads the files on every request, so a
   changed file needs no reload. The directory is removed, with everything
   in it, while disabled, so the role refuses, enabled or not, a
   `coder_launcher_dir` that is not `/etc/caddy/hcw-<name>`.
7. Renders `/etc/caddy/conf.d/10-coder.caddy` (`root:caddy` `0640`): a host
   matcher for `coder.lab.hybridcloudworks.com` and
   `*.coder.lab.hybridcloudworks.com`, `reverse_proxy 127.0.0.1:7080`, and a
   `handle_errors` that answers **503** with a sentence when the `coder`
   service is stopped, which is the everyone-at-once kill switch in ADR
   0032. Removed while disabled, so Caddy's catch-all 404 answers instead.
   Caddy is reloaded either way through this role's own handler.
   The Caddyfile's panes-only rule (owner decision 2026-09-28; the caddy
   role's README, "Panes only") covers these names like every other, so
   Coder can be reached only through panes on the site. The route adds two
   things for Coder. It removes Coder's default `frame-ancestors 'self'`
   from Coder's own `Content-Security-Policy`, because the browser enforces
   every policy it receives, and that one would keep Coder out of the
   site's panes. The rest of Coder's policy stays, and so does the
   `frame-ancestors 'none'` on Coder's OAuth2 consent page. It also lets
   `/api/v2/users/oauth2/github/callback` on `coder.lab` through at the top
   level (`lab_top_level_allowed`). GitHub cannot be framed, so sign-in has
   to run in a window of its own. That path only redirects, and the
   redirect that ends sign-in is itself a top-level visit, which lands on
   the site's labs page. And it serves the lab launcher at `/_hcw/lab/` on
   `coder.lab`, before Coder's own handle, from `coder_launcher_dir`, with a
   strict policy of its own added beside the panes-only `frame-ancestors`
   (scripts, styles, fetches and frames from `coder.lab` only, nothing
   inline) and `Cache-Control: no-store`. The launcher has no top-level
   exemption.
8. Installs `/usr/local/sbin/coder-postgres-backup` and the
   `coder-postgres-backup.service` and `.timer` units: nightly at 03:30 UTC
   (ten minutes of jitter, `Persistent=true`), `pg_dump` through `docker
   compose exec` into `/var/backups/coder/coder-<UTC timestamp>.sql.gz`
   (`root` `0700`), dumps older than seven days deleted, a `.partial` name
   until the dump completes so a failed run never looks like a backup. The
   timer runs only while enabled. While the `backups` role has written
   `/etc/hcw/backups/upload.env` (off-host backups on, LAB-9), the script
   then uploads the dump it has just written to the `host-backups` container
   as the Arc identity, and a failed upload fails the run
   (`roles/backups/README.md`). The local copies are the convenience
   `docs/architecture/labs-host.md` describes; the off-host copy is the
   backup.
9. Renders `templates/hcw-coder-template-push.j2` to
   `/usr/local/sbin/hcw-coder-template-push`, `root:root` `0750`, enabled or
   not (below). The one templated value is `coder_template_default_ttl`,
   which the role first asserts is whole hours.
10. Installs Coder automation, enabled or not ("Coder automation", below):
    `files/hcw-coder-automation.py` as
    `/usr/local/libexec/hcw-coder-automation` and the owner's
    `/usr/local/sbin/hcw-coder-automation-seed` (both `root:root` `0750`),
    its configuration `/etc/hcw/coder/automation.json` (paths and names, no
    secret), the rotation credential's directory `/etc/hcw/coder/automation`
    and the state directory `/var/lib/hcw-coder-automation` (both `root`
    `0700`), and `hcw-coder-automation.service` and `.timer`, the timer
    running daily while Coder is enabled and stopped while it is not. Then,
    while enabled and once the owner has seeded a rotation credential, it
    publishes the `hcw-lab` template with that credential when the
    template's files changed; with no credential it says how to seed one
    and carries on.

The privilege boundary is the Compose file's and the template's, not this
role's: a socket goes to the `coder-docker-proxy` service only, read-only,
on a control network the `coder` service alone shares with it; the server
reaches Docker through it over `DOCKER_HOST` and gets only the API sections
it allows (no exec, build, commit, swarm or system; since 2026-10-06,
LAB-5). Since 2026-10-07 the socket behind the proxy is not the host's: it
is the rootless daemon the `coder_sandbox` role runs as the unprivileged
user `hcw-coder-docker`, where every workspace runs. The proxy still reads
paths, not bodies, so a compromised server can still ask for a privileged
container or a bind of `/`; what it gets is privileged inside that user's
namespace and is that user on the host, not root — and
`lab-host/coder/templates/hcw-lab/template.test.mjs` asserts what a
workspace may and may not have.

## hcw-coder-template-push

```text
hcw-coder-template-push   (a Coder token on stdin)
```

The owner's line, from the workstation, is in `lab-host/README.md`,
"Publishing the template". It replaced a Coder CLI on the workstation
(`winget install Coder.Coder` reported success on 2026-09-28 and installed
nothing) and the two commands run by hand that day instead, `docker cp` of
the template into the container and the push through `docker exec`. On the
host, as root:

1. It refuses, with exit code 2 and before it reads stdin or asks Docker
   anything: a default autostop that is not whole hours; no
   `lab-host/coder/templates/hcw-lab` under the checkout (`/opt/hcw-src`,
   where `bootstrap.sh` keeps it; `HCW_SRC_DIR` overrides it for the test,
   and `sudo` resets it); a symbolic link among the files it would copy; no
   `*.tf` there; and a terminal on stdin, where a pasted token would be
   echoed.
2. It reads the first line of stdin as the token, drops a carriage return,
   a leading byte order mark and surrounding blanks, and refuses (exit 2)
   an empty one or one that is not letters and digits either side of one
   hyphen, the shape of a v2.37.3 token, without showing what it got.
3. It makes a directory with `mktemp -d /tmp/hcw-lab.XXXXXX` inside the
   `coder` container, as the container's own user, accepts only a path of
   that shape back, and removes it on every exit; a removal that fails makes
   the run fail.
4. It copies every `*.tf`, `.terraform.lock.hcl` and `README.md` there, as
   a tar stream into `docker exec -i coder tar -x`, so the files belong to
   the container's user. `template.test.mjs` and anything else in the
   directory stay out of Coder.
5. It runs one fixed script in the container with `CODER_URL` set to
   `http://127.0.0.1:7080` (Coder inside its own container) and `NO_COLOR`,
   and hands it the token on stdin with bash's builtin `printf`. The script
   reads it into `CODER_SESSION_TOKEN`, runs `coder templates push hcw-lab
   --directory <dir> --yes` and `coder templates edit hcw-lab --default-ttl
   <coder_template_default_ttl> --yes`, whose output goes to stderr as it
   happens, and then reads back `coder templates versions list hcw-lab
   --column name,active` and `coder templates list --column "name,default
   ttl"`, each line tagged, on stdout.
6. It fails (exit 1) unless exactly one version is `Active` and Coder
   reports the default autostop as `<n>h0m0s`, then prints
   `hcw-coder-template-push: published hcw-lab from <dir>. Active version:
   <name>. Default autostop: <n>h0m0s.`

The token is never an argument of a process on the host, never printed,
and never written to a file, on the host or in the container. Inside the
container it is in the environment of the one `sh` and the `coder`
commands it starts, for as long as they run, which is how Coder's CLI reads
a token. Everything the helper asks Docker is `docker exec` into `coder`;
it never pulls, starts or stops a container.

Installed enabled or not, like the backup script: with Coder disabled it
stops at step 3 and says Coder is probably not running.

### Who runs it

The owner, with a short-lived token of their own (the line above), and,
since 2026-10-08, the role itself on every `bootstrap.sh` run, with the
rotation credential the owner seeds once, whenever the template's files
changed ("Coder automation", below).

Until then this section was headed "Why the owner runs it, and bootstrap
does not", and its reason still holds: a token that can publish a template
can run any container Coder's daemon will start, so keeping one on the host
keeps that power on the host. The owner accepted that on 2026-10-08, within
these bounds. The credential belongs to `hcw-status`, a Template Admin that
never holds Owner, so it cannot manage users, change deployment settings or
act as anyone else, and the helper refuses to use it if `hcw-status` ever
holds Owner. It is a root-only file, and root on this host can already read
Coder's database and mint any token, so the file gives root nothing it
lacked; what it adds is a credential that works from off the host if it is
copied, for at most its year, and it is replaced ten months in with the old
one deleted. And what it publishes is the checkout `bootstrap.sh` runs:
`main` at a commit that passed the `coder (lab-host)` checks, among them
`template.test.mjs`.

The rest of this section is the measurement behind that reason. The template runs in Coder's provisioner, inside the `coder`
container, which reaches Docker through the socket proxy; a template version
that asks the Docker provider for a privileged container with `/` mounted
still gets one, because the proxy allows container creation and does not
read the body. Since 2026-10-07 (LAB-5) that daemon is the `coder_sandbox`
one, rootless as `hcw-coder-docker`, so such a container is that user's and
the `/` it mounts is that user's view of the host: a bad template is
contained, not refused, and it still reaches every learner's workspace.
`template.test.mjs` keeps this repository's template from doing that, but a
token pushes whatever it is given, and Coder's API answers it from anywhere
on the internet through Caddy. The narrowest token that publishes was
measured on v2.38.0 on 2026-10-19 (#1037; the table in `lab-host/README.md`,
"The status token for the site"): `coder:templates.author` plus
`organization:read` and `user:read`, the two reads the CLI resolves the
organisation through; `--allow template:<id>` can hold it to the one
template, but no scope holds it to this host. That is why the token was the
owner's, made in a pane for the one run and expiring on its own, until the
bounds above were accepted; and why the rotation credential stays unscoped
even now that the set is known: on this version a token that holds
`api_key:create` together with `user:read` (both of which renewing the
status token needs; `api_key:create` alone cannot even resolve the user,
404) mints tokens with scopes it does not hold itself, so a narrowed
credential contains nothing
against a leak, and a scope list would have to track what Coder's CLI
needs from release to release for no gain. Containment works on the
account, below.

## Coder automation

Owner approval 2026-10-08. Until then the owner renewed the site's status
token by hand once a year (`lab-host/README.md`, "The status token for the
site") and published the template by hand after every `bootstrap.sh` run
that changed it. Now the owner seeds one credential, once, and the host
does both. The owner's lines are in
[docs/runbooks/labs-host.md](../../../../docs/runbooks/labs-host.md),
"Automatic renewal".

```text
hcw-coder-automation-seed [--force]                 (the owner's token on stdin)
hcw-coder-automation run [--rotate-now] [--rotate-credential]
hcw-coder-automation push-template [--force]
```

`/usr/local/libexec/hcw-coder-automation` is `files/hcw-coder-automation.py`,
Python 3 standard library only, run isolated (`-I`) on the host's
`/usr/bin/python3`. The seed is a two-line wrapper rendered from
`templates/hcw-coder-automation-seed.j2`. Every command takes a lock under
the state directory, so the timer, a seed and a bootstrap's publish never
write the same files at once.

### The rotation credential

An unscoped Coder API token (`coder:all`, the scope Coder gives a token
created with none) belonging to `hcw-status`, a Template Admin and never an
Owner. With it the host creates and deletes `hcw-status`'s own tokens,
renews the credential itself and publishes the template, and nothing more:
it cannot manage users, change deployment settings or act as anyone else.
Measured on 2026-10-19 (#1037) and kept unscoped on purpose: the paragraph
above "Coder automation" says why a scoped set would not contain it.
The seed and every run refuse it if `hcw-status` holds Owner or is not a
Template Admin, which reading every workspace and publishing need; the seed
keeps a stored credential only while both still hold, never on its username
alone. Its lifetime is a year (that one token's: whoever holds it can mint
successors, so containment works on the account, below), which Coder allows a
Template Admin: an Owner's tokens are capped by `--max-admin-token-lifetime`
(168 hours by default), everyone else's by `--max-token-lifetime` (876,600
hours), and the cap is the user's the token is for (`getMaxTokenLifetime` in
`coderd/apikey.go`).

**Where it is stored, and why not a vault.** A root-only file,
`/etc/hcw/coder/automation/rotation-token` (`0600`, its directory `0700`),
like `coder.env` beside it. HashiCorp Vault was the first choice, had root
been able to read a secret from it unattended at timer time, and it cannot: the `vault`
role never holds a token, its root token is typed at a hidden prompt and
removed afterwards, there is no authentication method this host could use
alone, and under Shamir keys every reboot seals it until the owner unseals
it. A Vault token stored to read this one would be a root-only file too. The
Ansible vault, where this role's three secrets come from, can be read
unattended, but only with `/etc/hcw/ansible/vault-password`, a root-only file
on the same disk, so encrypting adds nothing against root; and a timer
rewriting `vault.yml` would race `hcw-vault-set` and
`Register-LabAgent.ps1`, and hand the credential to every task of every
`bootstrap.sh` run as an extra variable. The helper refuses the file unless
it is a regular file owned by root with no group or other permission bits,
and never prints, logs, reports or writes anything else holding it.

**The seed** (`hcw-coder-automation-seed`) reads the owner's token from
the first line of stdin (a byte order mark, carriage return and blanks
removed; a terminal, an empty line or anything not shaped like a token
refused with exit 2 before Coder is asked anything). If a credential is
already stored, still works and `hcw-status` is still a Template Admin and
not an Owner, it says so, with its expiry, and changes nothing unless
`--force` is given. Otherwise it checks the owner's token and
`hcw-status`'s roles, creates `hcw-status-rotation-<date>` for `hcw-status`
with the owner's token, checks that the new token is `hcw-status`, writes it
beside the file and renames it over it, reads it back, deletes the one it
replaced (`--force`), and prints one line naming the new token and its
expiry date. The replaced one's id is put on the state's deletion list, and
the state saved, before the new one is written, and it leaves the list only
once Coder confirms the deletion; until then every run deletes it. A name already in use (Coder answers 409) gets `-2`, `-3` and
so on.

### What the daily run does

`hcw-coder-automation.service`, from `hcw-coder-automation.timer` at 05:45
UTC with up to 30 minutes of jitter (`Persistent=true`), as root with
everything read-only but the credential's directory and the state
directory. Until the credential exists the unit is skipped by
`ConditionPathExists=`, not failed. Each run:

1. Reads the credential, checks it is `hcw-status`'s and that `hcw-status`
   is a Template Admin and not an Owner, and reads its expiry.
2. **Renews the credential** when it has under 60 days left (or with
   `--rotate-credential`): creates `hcw-status-rotation-<date>` with the old
   one, checks it, stores it, then deletes the old one. The old one's id is
   put on the state's deletion list, and the state saved, before the new one
   is written, so an interruption or a failed delete between the two cannot
   leave it usable and forgotten. A new one that fails before it is stored
   is deleted, or goes on the same list when Coder does not delete it (here
   or in the seed). Every run deletes what the list holds, never the
   credential in use, and fails until Coder confirms each deletion. `prune`
   touches status tokens only, so nothing else would.
3. **Renews the site's status token** when the token the site holds expires
   within 30 days or was made more than 60 days ago (or with
   `--rotate-now`): creates `hcw-status-site-<date>` with exactly
   `template:read`, `workspace:read`, `api_key:read` and `user:read` for 90
   days, checks it (`GET /api/v2/workspaces?q=status:running` must answer 200
   with a numeric `count`, and it must read its own record, which needs
   `api_key:read` and, on v2.38, `user:read`; the site checks the same two
   reads before storing it), and hands it to the site with a report. It is live only once
   the site's CLI answers `{"ok":true,"stored":true}`; the state then
   records it as the site's token and the one it replaced as the one
   before. "The token the site holds" is the one this helper last
   delivered; before its first delivery it is the newest status token not
   named `hcw-status-site-`, the one made by hand, because one of the
   helper's own that was never recorded as live never reached the site.
   When the site answers `stored: false`, or the token fails its own
   check, the new token is deleted. When the CLI fails without saying, it
   is kept, in case the site stored it, and the next run renews again.
4. **Deletes older status tokens**, once a delivered one is live: every
   token with the three read scopes and at most `user:read` beside them
   except the newest two, the
   live one, the one before it, and any younger than 48 hours (the site's
   Key Vault reference can take 24 hours to pick up a new version). The
   rotation credential and any token with other scopes are never touched.
5. **Reports** to the site, every run, with the same CLI and no token:
   `{"report":{"checkedAt","statusTokenExpiresAt","statusTokenRotatedAt","rotationTokenExpiresAt","templatePushedAt","templateVersion","templateDigest","templateSourceDigest","lastError"}}`,
   each time ISO 8601 UTC to the second, and any field it does not know
   left out: `statusTokenExpiresAt` only once a delivered token is live,
   `lastError` only when something failed, at most 300 characters of the
   helper's own words, never Coder's or the CLI's. `templateDigest` is the
   SHA-256 `push-template` recorded for its last publish (below), and
   `templateSourceDigest` the same digest of `/opt/hcw-src` as it is now,
   the commit the host converged from; the site's Health Hub raises a pair
   that differs as **Coder template published**, critical: Coder serves a
   template the host's last `bootstrap.sh` run did not publish (#1009,
   finding 8).
6. Records what it did in `/var/lib/hcw-coder-automation/state.json`
   (`root` `0600`; the live token's id and name, the template's publish,
   the last error, never a token: a token's id is the part before the dash,
   not its secret), prints one summary line, and exits 1 if any step
   failed, so the unit shows failed and its `OnFailure=` notifier raises
   the lab alert (the `hardening` role's `hcw-unit-failed@`).

A step that fails does not stop the report: a refused credential, Coder not
answering, or a CLI that failed are each in `lastError`, and in the journal.

### How the site's CLI is run

`vps-agent/bin/report-coder-automation.js`, from the agent's own checkout
(`/opt/hcw-labs-agent/vps-agent`, which has its `node_modules`;
`/opt/hcw-src` has none), as the agent's user with the agent's environment,
through `systemd-run`:

```text
systemd-run --pipe --wait --quiet --collect --service-type=exec --uid=hcw-labs-agent --gid=hcw-labs-agent
  --property=EnvironmentFile=/etc/hcw/labs-agent.env --property=WorkingDirectory=/opt/hcw-labs-agent/vps-agent
  --property=Environment=NODE_ENV=production --property=NoNewPrivileges=yes --property=PrivateTmp=yes
  --property=ProtectSystem=full --property=ProtectHome=yes --property=RuntimeMaxSec=120
  -- /usr/bin/node bin/report-coder-automation.js
```

The same user, `EnvironmentFile=` and `WorkingDirectory=` as
`hcw-labs-agent.service`. systemd reads the environment file as root, as it
does for the agent, so it stays `root` `0600` and the agent's user never
reads it; `--pipe` gives the CLI the JSON on stdin, and `--wait` returns its
exit status. `runuser` after sourcing the file was the alternative, and it
would parse a systemd `EnvironmentFile` as shell, which is not the same
syntax. `RuntimeMaxSec=` has systemd stop a CLI that hangs before the helper
gives up on it. The CLI's stderr reaches the journal with any token the
helper knows replaced by `[token]`.

The contract, which the CLI's side holds too: stdin is one JSON object with
`statusToken`, `report` or both, and nothing else (the CLI takes the agent's
id from `LABS_AGENT_ID` in the agent's environment); every time in the
report is ISO 8601 with seconds and a zone (`2026-10-08T05:45:00Z`). The CLI
sends it to the site's `POST /api/agent/reportCoderAutomation`, which this
helper never calls itself. Success is `{"ok":true,"stored":true|false}` on
stdout and exit 0; failure is one error class on stderr (`HTTP <status>`,
`INVALID_INPUT`, `INPUT_TOO_LARGE`, `MISSING_CONFIG` or
`UNEXPECTED_ANSWER`) and exit 1. The helper reads the last line of stdout,
so a log line before the answer does no harm.

### Publishing the template

`push-template`, run by this role on every `bootstrap.sh` run while Coder is
enabled, after Coder is up and before `lab_images` removes the images the
previous template versions name. It publishes every template under
`lab-host/coder/templates`: each directory with a `*.tf` file and a name
`hcw-coder-template-push` accepts, `hcw-lab` first, each passed to the helper
by name and tracked on its own. Until 2026-10-12 it published `hcw-lab`
alone, so the guided-lab templates (#1090) needed the owner's token. One
template failing does not stop the next: the task then fails naming it, and
the next run retries only that one. It keeps a SHA-256 of exactly what
`hcw-coder-template-push` copies (every `*.tf`, `.terraform.lock.hcl`,
`README.md`) and of `coder_template_default_ttl`, and publishes only when
that differs from its last successful publish, so a failed publish is
retried by the next run and an unchanged one costs nothing. It hands the
push helper the credential on stdin, as the owner's line hands it the
owner's token, records each template's digest, time and version under `templates` in its
state, and for `hcw-lab` also `templatePushedAt`, `templateVersion` and that
SHA-256 (`templateDigest`) for the report, and prints `hcw-coder-automation: published <template> with the
rotation credential; active version <name>` for each it published, which is
the task's `changed_when`. Exit 3, with a line saying to seed, when there is no
credential or Coder refuses it: the run carries on. Any other failure fails
the task. `hcw-coder-template-push` needed no change for this: it already
took "the owner's, or a Template Admin's" token, and the four commands it
runs (`templates push`, `templates edit --default-ttl`, `templates versions
list`, `templates list`) are template writes and reads, which Template Admin
has (2026-09-28 measurement in `lab-host/README.md`: unscoped Template Admin
changes a template, 200).

### Turning it off

`hcw-coder-automation revoke` (`docs/runbooks/labs-host.md`, "Stopping
it") deletes the credentials on the state's deletion list, then the stored
rotation credential, in Coder, with the credential itself, and removes the
file only once Coder confirms (204 or 404; a 401 to the deletion, just after
Coder accepted the credential, confirms nothing). It stops with the
credential still in place when either deletion
is not confirmed, because the stored credential is the only thing that can
delete the others, and a second run finishes the job. Removing the file
alone would leave an unscoped token valid in Coder for up to a year, so
`revoke` comes before any revert of this code (review of #1035). A credential
Coder no longer accepts (401: expired, or it or its user deleted) has nothing
left in Coder to delete, so `revoke` removes the file. It keeps the deletion
list and says so, since a listed credential may still be valid when only the
stored one expired: the first run after the next seed deletes them with the
new credential, or finds them gone once the user was deleted.

A leak is contained on the account, not the token: deleting `hcw-status`
deletes every API key it has, copies and successors alike (the
`delete_deleted_user_resources` trigger in Coder v2.38's schema), then
`revoke` clears the dead file and the user is made again and seeded. The
runbook's "If the rotation credential may have leaked" has the lines.

### Coder's API

Read 2026-10-08 against v2.38.0, the pinned release:
<https://coder.com/docs/reference/api/users> ("Get user tokens", "Create
token API key", "Get API key by ID", "Delete API key"),
<https://coder.com/docs/reference/api/workspaces> ("List workspaces"), and
`codersdk/apikey.go` and `coderd/apikey.go` at the `v2.38.0` tag.

| Call | Used for |
| --- | --- |
| `GET /api/v2/users/me` | Who a token is, and its roles |
| `GET /api/v2/users/hcw-status` | The seed's check of `hcw-status`'s roles, with the owner's token |
| `POST /api/v2/users/{user}/keys/tokens` | `{"token_name","lifetime","scopes"}`; 201 `{"key"}`, 409 on a name in use |
| `GET /api/v2/users/me/keys/tokens` | `hcw-status`'s tokens, expired ones left out |
| `GET /api/v2/users/me/keys/{id}` | One token's `expires_at` |
| `DELETE /api/v2/users/me/keys/{id}` | 204 |
| `GET /api/v2/workspaces?q=status:running` | The new status token's check: 200 and a numeric `count` |

`lifetime` is a Go `time.Duration`, which `encoding/json` writes as an
integer count of **nanoseconds**: 90 days is `7776000000000000`, a year
`31536000000000000`. Every call goes to `http://127.0.0.1:7080` with the
token in `Coder-Session-Token`, through no proxy and following no redirect.

## Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `coder_enabled` | required (`true` in `group_vars` since 2026-09-28) | Run or stop Coder |
| `coder_oauth2_github_allowed_orgs` | required (`[HybridCloudWorks]` in `group_vars` since 2026-09-28) | `CODER_OAUTH2_GITHUB_ALLOWED_ORGS`; non-empty while enabled |
| `coder_oauth2_github_allowed_teams` | required (`[HybridCloudWorks/lab-learners]` in `group_vars` since 2026-10-16) | `CODER_OAUTH2_GITHUB_ALLOWED_TEAMS`; non-empty while enabled, each `<organisation>/<team-slug>` in an allowed organisation |
| `coder_oauth2_github_allow_signups` | required (`false` in `group_vars` since 2026-10-16) | `CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS`; with `false` a learner's account is created by the owner before their first sign-in (`docs/runbooks/labs-host.md`, "Coder sign-in: adding and removing a learner") |
| `coder_domain` | required | `coder.lab.hybridcloudworks.com` |
| `coder_max_workspaces` | required | Capacity the host is sized for; asserted against memory |
| `coder_image`, `coder_image_tag`, `coder_image_digest` | required | Coder pin; run as `image@digest` |
| `coder_postgres_image`, `coder_postgres_image_tag`, `coder_postgres_image_digest` | required | PostgreSQL pin; run as `image@digest` |
| `coder_docker_proxy_image`, `coder_docker_proxy_image_tag`, `coder_docker_proxy_image_digest` | required | The Docker socket proxy pin (LAB-5); run as `image@digest` |
| `coder_oauth2_github_client_id` | `vault_coder_oauth2_github_client_id` or empty | OAuth app |
| `coder_oauth2_github_client_secret` | `vault_coder_oauth2_github_client_secret` or empty | OAuth app |
| `coder_postgres_password` | `vault_coder_postgres_password` or empty | Database user `coder`; RFC 3986 unreserved characters only |
| `coder_workspace_memory_mib` | `2048` | Per-workspace limit the template sets, for the capacity assertion |
| `coder_server_memory_reserve_mib` | `2560` | Coder, PostgreSQL and OS headroom in the same assertion |
| `coder_backup_keep_days`, `coder_backup_on_calendar` | `7`, `*-*-* 03:30:00` | The dump schedule |
| `coder_launcher_dir` | `/etc/caddy/hcw-lab-launcher` | Where the lab launcher's files are installed and served from |
| `coder_template_default_ttl` | `1h` | The `hcw-lab` template's default autostop, which `hcw-coder-template-push` sets after every publish; whole hours only |
| `coder_automation_status_user` | `hcw-status` | The Template Admin that owns the rotation credential and the site's status token |
| `coder_automation_on_calendar` | `*-*-* 05:45:00` | The daily automation run, with up to 30 minutes of jitter |
| `coder_automation_dir`, `coder_automation_credential_file` | `/etc/hcw/coder/automation`, `.../rotation-token` | The rotation credential, root-only |
| `coder_automation_config_file`, `coder_automation_state_dir` | `/etc/hcw/coder/automation.json`, `/var/lib/hcw-coder-automation` | The helper's configuration and its state |
| `coder_automation_agent_user`, `_group`, `_env_file`, `_app_dir` | `hcw-labs-agent`, `hcw-labs-agent`, `/etc/hcw/labs-agent.env`, `/opt/hcw-labs-agent/vps-agent` | The lab agent the site's CLI runs as; the test holds them to the `labs_agent` role's |
| `coder_automation_report_cli`, `coder_automation_report_timeout_seconds` | `bin/report-coder-automation.js`, `120` | The site's CLI, and how long it may take |

Paths, the port and the unit names are in `defaults/main.yml`;
`meta/argument_specs.yml` is the contract.

## Bumping a pin

Both digests are image **indexes**, read with `docker buildx imagetools
inspect`; the tag beside each is for humans. Bash, anywhere with Docker:

```bash
docker buildx imagetools inspect ghcr.io/coder/coder:v2.38.0 | head -3
```

```bash
docker buildx imagetools inspect postgres:18.6 | head -3
```

The `Digest:` line is the value. Cross-check it against the registry's own
`Docker-Content-Digest` for the same tag, which must print the same
`sha256:`. Bash, anywhere with `curl`:

```bash
curl -fsSI -H "Authorization: Bearer $(curl -fsS 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull' | sed -E 's/.*"token":"([^"]+)".*/\1/')" -H 'Accept: application/vnd.oci.image.index.v1+json' https://registry-1.docker.io/v2/library/postgres/manifests/18.6 | grep -i docker-content-digest
```

Coder's releases are at <https://github.com/coder/coder/releases>;
`ghcr.io/coder/coder:latest` resolved to the same digest as `v2.38.0` on
2026-10-07, the day it was pinned (the release is dated 2026-10-06); before
that, as `v2.37.3` on
2026-09-25. Coder supports PostgreSQL 13 and later (its upstream
`compose.yaml` runs 17).

## PostgreSQL

### Where it runs

Owner decision 2026-09-26: Coder's database stays a PostgreSQL container on
the lab host, the `coder-postgres` service beside Coder in this role's
Docker Compose project. Coder stores its data in PostgreSQL and nothing
else ("Postgres 13 is the minimum supported version",
<https://coder.com/docs/admin/setup>), so the engine was never the choice;
where it runs was. Two alternatives were shown and not taken:

- **Coder's built-in PostgreSQL.** With `CODER_PG_CONNECTION_URL` unset,
  Coder downloads PostgreSQL binaries from Maven when it starts and keeps
  the data in its own config root. Those binaries would sit outside the
  digest pins everything else on the host runs from (ADR 0032), and the
  data would sit inside the Coder container, where this role's nightly
  `pg_dump` of `coder-postgres` does not reach.
- **Azure Database for PostgreSQL Flexible Server, Burstable B1ms.**
  $0.01921 an hour in Central US at the retail price, about $14 a month for
  compute alone (Azure retail prices API, read 2026-09-26), plus storage.
  Every query from the VPS would also cross the internet to Azure.

### The version: 18.6

PostgreSQL moved from 16.15 to **18.6**, the newest release of the newest
major, on 2026-09-26, while the host held no Coder data, so there was
nothing to migrate: the first `up` initialises an empty 18 cluster.
`postgres:18` and `postgres:18.6` resolved to the same index
(`sha256:5a5a84b1...2da9722`), and the registry header and the Docker Hub
API agreed. The 18 image keeps the cluster in a per-major directory,
`PGDATA=/var/lib/postgresql/18/docker`, under a `VOLUME` at
`/var/lib/postgresql`, so the Compose file mounts `coder-postgres-data`
there. At the old `/var/lib/postgresql/data` the image refuses to start.

The pin cannot fall behind unnoticed. Owner instruction 2026-09-26: the
newest general release of PostgreSQL. `scripts/version-floors.json` holds
`coder_postgres_image_tag` to the newest major, no more than two minor
releases behind its newest, and `version-floors.test.mjs` fails CI on a tag
below that, or on one that is not a general release written as MAJOR.MINOR
(`18`, `19beta4`). The weekly `update-version-floors` job reads
endoflife.date's `postgresql` product, which lists a major only from its
general release. It proposes a new major once that major's `.2` exists,
and never a beta or a release candidate. When a moved floor passes the
pin, that pull request goes red on it. A new minor release is a new digest
(the lines under "Bumping a pin" above), and a new major is "The next
major" below.

What was rehearsed that day, on Docker 29.8 with the committed Compose file
unchanged, the pinned Coder v2.37.3 and postgres:18.6 digests, and
stand-ins for the three role-written files:

1. `docker compose up -d --wait`: both containers up in 27 seconds, Coder's
   migrations at 585 (`000585_chat_search_english_config`, the newest
   v2.37.3 ships) with `dirty` false, `/healthz` answering 200, and the
   cluster at `/var/lib/postgresql/18/docker` on the named volume.
2. An owner account created with `coder server create-admin-user`, then
   this role's backup script, rendered from
   `templates/coder-postgres-backup.sh.j2` with Ansible, wrote
   `coder-<UTC timestamp>.sql.gz` (pg_dump 18.6 from server 18.6).
3. That dump restored into a fresh `postgres:18.6` on a fresh volume with
   the three-line procedure in `lab-host/README.md`, "Backups and
   restore": `DROP DATABASE`, `CREATE DATABASE`, and the load with no
   error. A second `pg_dump` of the restored database matched the first
   line for line (13,615 lines each). The only difference is the random
   `\restrict` key pg_dump writes on every run.
4. Coder v2.37.3 started on the restored database: `/healthz` 200,
   `/api/v2/buildinfo` 200 reporting `v2.37.3+3a24816` and the source's
   deployment id, `/api/v2/users/first` 200 (the restored owner), the
   schema still at 585, and no error lines in its log.

### The next major

Once the host holds Coder data, a new major is a dump and a restore, and it
cannot happen by accident. The 18 image refuses to initialise while another
major's cluster sits under `/var/lib/postgresql/<major>/docker` (the check
is in its entrypoint, docker-library/postgres#1259). On 2026-09-26 that
refusal was seen on this Compose file: exit 1 and a restart loop naming
the path. So a bumped pin alone fails the play's `up --wait` and changes
nothing. In order:

1. Rehearse it as above with the new digest, across majors: dump from the
   running major, restore into the new one, start Coder on the result.
2. On the host, stop Coder, take a dump, then stop PostgreSQL, so nothing
   writes after the dump. Bash:

   ```bash
   sudo docker compose --project-directory /etc/hcw/coder stop coder && sudo systemctl start coder-postgres-backup.service && sudo docker compose --project-directory /etc/hcw/coder stop coder-postgres
   ```

3. Set the 18 cluster aside inside the volume, under a name the check
   does not match. It stays there, untouched, as the way back. Bash, still
   on the 18 image:

   ```bash
   sudo docker compose --project-directory /etc/hcw/coder run --rm --no-deps --entrypoint mv coder-postgres /var/lib/postgresql/18/docker /var/lib/postgresql/18/docker.pre-upgrade
   ```

4. Merge the pin bump and re-run `bootstrap.sh`. The new image initialises
   an empty cluster and Coder migrates it. Until the next step, the first
   allowed GitHub account to sign in would own an empty deployment, so run
   the next step straight after.
5. Restore the step-2 dump with the three lines in `lab-host/README.md`,
   "Backups and restore". They stop Coder, recreate the database from the
   newest dump and start Coder again.

To go back, stop both services, set the new cluster aside the same way,
rename `docker.pre-upgrade` back to `docker`, and revert the pin.

## Handlers

`Reload caddy for the coder route` (route file added or removed), `Reload
systemd for the coder backup units` and `Reload systemd for the coder
automation units` (unit files).

## Tests

`tests/coder-signin.test.sh` renders `templates/coder.env.j2` with
ansible-core's own template module, from `group_vars/all.yml` and this
role's defaults and vars with placeholder secrets, and runs
`tasks/signin_policy.yml` on its own in a scratch playbook. No root, no
Docker; ansible-core on `PATH`. It checks:

- `coder.env` sets `CODER_OAUTH2_GITHUB_ALLOWED_ORGS=HybridCloudWorks`,
  `CODER_OAUTH2_GITHUB_ALLOWED_TEAMS=HybridCloudWorks/lab-learners` and
  `CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS=false`, each once, and no
  `CODER_OAUTH2_GITHUB_ALLOW_EVERYONE`;
- the checks pass `group_vars`' allowlists, all three running, and check
  nothing while Coder is disabled;
- they refuse, naming the value, an empty team list, a team in an
  organisation that is not allowed (one that differs only in case too,
  because Coder compares the names exactly), a bad team beside a good one, a
  team with no organisation or a second slash, and an empty organisation
  list; a team in a second allowed organisation passes;
- every owner line in `docs/runbooks/labs-host.md` and `lab-host/README.md`
  that pipes a token into Coder's CLI strips the carriage return with
  `tr -d \\r` (one backslash reaches `tr` as a bare `r`), and the runbook's
  lines that create and suspend a learner's account are there. A copy of
  `lab-host/` without `docs/` beside it skips these.

The `ansible-lint (lab-host)` job runs it with the job's ansible-core.

`tests/hcw-coder-template-push.test.sh` renders
`templates/hcw-coder-template-push.j2` with this role's `defaults/main.yml`
(Jinja2, `trim_blocks`, undefined names fail), then runs it against a stub
`docker` that answers only the four `docker exec` shapes the helper uses,
over a scratch directory standing in for the container, and a fake `coder`
that answers as v2.37.3's CLI does. No root, no Docker. It checks:

- the helper's checkout, container and URL are the ones `bootstrap.sh` and
  `lab-host/coder/docker-compose.yml` name, its autostop is the role's, the
  role installs it `root:root` `0750` whatever `coder_enabled` is, and the
  owner's line in `lab-host/README.md` runs that path;
- a publish copies `main.tf`, the lock file and the README and not
  `template.test.mjs`, runs push, edit and the two read-backs in that order
  and nothing else, and ends with the active version and `1h0m0s`;
- the token reaches every `coder` command with a BOM, blanks and a carriage
  return removed, and is in no `docker` or `coder` argument and in no output;
- Coder's output goes to stderr, and the copy is made at a fresh path and
  removed;
- empty stdin, and a first line that is not a token (the owner's line itself
  among them), are refused before Docker is asked anything, without being
  shown;
- a token Coder refuses, a failed push or edit, no active version, a
  different autostop, no container and a copy that cannot be removed all
  fail, with the copy removed; a coloured `Active` still reads;
- every `*.tf` is copied and nothing else is, and no `*.tf`, a symbolic
  link, no checkout or an autostop that is not whole hours is refused.

The `ansible-lint (lab-host)` job in `.github/workflows/ci.yml` runs it with
the job's Python, which has Jinja2 and PyYAML from ansible-core. To run it
without a host, see `lab-host/README.md`, "Validating without a host".

`tests/hcw-coder-automation.test.py` runs `files/hcw-coder-automation.py` as
it ships against a fake Coder API on a loopback port (answering as v2.38.0
does: `<10>-<22>` tokens, `lifetime` in nanoseconds, `coder:all` for no
scope, 409 on a name in use, nine fractional digits in its times, expired
tokens left out), a fake `systemd-run` that reads the `EnvironmentFile=` and
`WorkingDirectory=` it is given, a fake site CLI and a fake
`hcw-coder-template-push`, and renders this role's templates with its
defaults. No root, no Docker, no network. It checks:

- the configuration names the `labs_agent` role's user, group, environment
  file and checkout, Coder's published port, the checkout `bootstrap.sh`
  keeps and the push helper reads, and the role's autostop; the unit has the
  failure notifier, the credential condition and its two writable paths;
  the role installs both helpers `root:root` `0750`; the runbook's seed line
  runs the installed path;
- the seed refuses a terminal, empty stdin, a line that is not a token
  (without showing it), a token Coder refuses, a missing `hcw-status`, one
  that holds Owner and one that is not a Template Admin, creating nothing;
  stores an unscoped year-long `hcw-status-rotation-<date>` made by the
  owner, `0600`; leaves a working one alone, but not once `hcw-status` holds
  Owner or loses Template Admin; and with `--force` replaces it, taking `-2`
  on a 409, and deletes the old one; a run refuses an `hcw-status` that is
  not a Template Admin;
- a new rotation credential that fails its check and that Coder will not
  delete fails the run or the seed, keeps the stored one, and is recorded by
  id; the next run deletes it and clears the record;
- a renewal, and a `seed --force`, whose predecessor Coder will not delete
  keep the new credential and list the old one, which the next run deletes;
  the credential in use is never deleted, even with its id on the list;
- a run with a ten-day-old hand-made token renews nothing and reports once,
  with no token, through `systemd-run --pipe --wait` as the agent's user;
  one older than 60 days is renewed with exactly the three read scopes and
  `user:read` for 90
  days, checked by counting workspaces, handed to the CLI and recorded as
  live, the hand-made one kept as the one before; the clean-up deletes
  older status tokens past 48 hours and keeps the live one, the one before,
  a young one, the credential and a token with other scopes; the credential
  renews itself under 60 days and on `--rotate-credential`;
- `stored: false` deletes the new token and fails the run; a failing CLI
  keeps it and fails the run, with its stderr scrubbed of the token; a
  refused or missing credential, Coder not answering and a missing agent
  environment each fail the run, and the report still goes where it can,
  with a `lastError` of at most 300 characters;
- `revoke` changes nothing without a credential; stops, keeping the
  credential, when a listed one or the credential itself is not deleted;
  and otherwise deletes the listed ones, then the credential in Coder, then
  the file; and removes the file of a credential Coder no longer accepts;
- `push-template` skips with exit 3 and the seed line without a credential
  or with a refused one, publishes with the credential on the push helper's
  stdin and the configured checkout, records the version, publishes again
  only when a copied file or the autostop changes (or with `--force`), and
  retries after a failed publish;
- an undelivered `hcw-status-site-` token is never taken for the site's;
- no token appears in anything the helper printed, its state file or any
  report.

The same job runs it with its own Python. To run it without a host, see
`lab-host/README.md`, "Validating without a host".

## Check mode

Safe. `getent` reads, the templates diff, `docker_compose_v2` reports what
`up` or `down` would do without doing it. The template publish is a
command, which check mode skips.
