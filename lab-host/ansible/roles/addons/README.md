# addons

The tool add-ons on the lab host (ADR 0035; the HCW AddOn Integration
Standard, `docs/standards/addon-integration-standard.md`): independently
built tools the site shows in a sandboxed pane at `/tools/<id>`. Each is one
hardened container from a digest-pinned image, published on the host's
loopback only, served by Caddy on its own one-label lab name
(`<id>.lab.hybridcloudworks.com`), and reached by a visitor only inside the
site's pane. One generic role, one `addons[]` row per tool in
`group_vars/all.yml`; the first row is `migration`.

Docker Compose on this host stays Coder's (ADR 0032). These are single
containers the role runs directly, the way the `portainer` role runs its
one; ADR 0035 decision 8 records them as the second permitted workload kind.

## What it does

1. **Fails closed** unless the publish address is `127.0.0.1` (fixed in
   `vars/main.yml`; Docker's iptables rules for a published port come before
   ufw's), every row has an integer port of its own between 1024 and 65535
   and an id of lowercase letters, digits and hyphens, every digest is
   empty or `sha256:` plus 64 hex characters, every deployed row carries
   `attestation_identity_regexp` to authenticate its image before pull (#1069),
   and every `secret_env` value of an enabled row names a vault key that is
   set. A missing key fails the run with the one `hcw-vault-set` line that
   sets it, by name.
2. For every enabled row with a digest, while `addons_enabled` is true:
   verifies the image's SLSA build provenance attestation against Sigstore's
   public trust root with `cosign verify-attestation` using
   `addons_attestation_type` (`slsaprovenance1`),
   `addons_attestation_oidc_issuer` (`https://token.actions.githubusercontent.com`)
   and the row's `attestation_identity_regexp` (failing closed on mismatch or
   unreachable transparency log; #1069), pulls `image@image_digest` and runs
   `hcw-addon-<id>` with
   `127.0.0.1:<port>:8080`, `read_only`, `/tmp` on tmpfs, `cap_drop ALL`,
   `no-new-privileges`, the row's `memory` and `pids_limit`, one CPU,
   `restart unless-stopped`, json-file logs capped at `addons_log_max_size`,
   no volume and no mount of any kind (compared strictly, so a container
   reused with one is recreated), no socket, on the add-ons' own bridge
   network `hcw-addons` (inter-container communication off, subnet
   `172.29.0.0/24`), under the daemon's user-namespace remap (no
   `userns_mode: host`), the image's own `HEALTHCHECK`; the environment is the row's `env` plus each `secret_env`
   key read from the vault variable it names (`no_log`, and `env` compared
   strictly so a removed key is removed). Then waits for
   `http://127.0.0.1:<port>/api/health` to answer 200 (not in check mode).
3. A row whose `image_digest` is **empty** is not deployed: its release is
   not published yet. The run says so and continues; any container left
   from an earlier digest is removed, and the route below is rendered all
   the same with a direct 503 carrying the site's sentence (never a proxy
   to a port nothing of ours holds), so the site's status proxy reads the
   add-on as unreachable, which is the truth until the digest is written in.
4. Egress. Before anything is pulled, the role creates the network and
   writes its egress policy into the `DOCKER-USER` chain, the one chain
   Docker consults before its own accept rules (ufw's come after Docker's
   and never see container traffic): established flows return; a new flow
   from the subnet may open TCP 443 to the human-verification endpoint's
   published ranges (`addons_egress_cidrs`, with the date they were read)
   and nothing else; everything else from the subnet is rejected. The same
   rules are written as a block in `/etc/ufw/after.rules`, which ufw
   restores at boot before Docker starts, so they hold across a reboot
   without a ufw reload (a reload would flush the rules Docker holds for
   its running containers). Each run first removes every live rule carrying
   the role's comment and rebuilds the set, so a range or port dropped from
   the defaults is dropped from the chain in the same run. The subnet is
   never less restricted than the policy meanwhile:
   `files/hcw-addons-egress-clear` (installed in `/usr/local/libexec`) puts
   a reject for the whole subnet at the top of the chain, commented
   `… rebuilding`, in the same iptables-restore transaction that deletes the
   old rules by their full specification (never by position). The new rules
   go above it, and it is lifted only after the last one. A run that stops
   in between leaves that reject, so the add-ons have no egress until the
   next run completes. It is tested against real iptables
   (`tests/hcw-addons-egress-clear.test.sh`). Loopback publishing bounds what reaches an
   add-on; this bounds where an add-on holding a visitor's upload can send
   it. Read it on the host with `sudo iptables -L DOCKER-USER -n --line-numbers`.
4. Renders `/etc/caddy/conf.d/20-addons.caddy` with one route per enabled
   row: `@addon_<id> host <id>.lab…`, `reverse_proxy 127.0.0.1:<port>`, a
   `vars @addon_<id> lab_direct_visit_redirect https://hybridcloudworks.com/tools/<id>`
   that sends a top-level visit to the add-on's own page on the site
   (overriding the Caddyfile's labs-page default; `../caddy/README.md`,
   "Panes only"), and a `handle_errors` that answers 503 with
   `addons_unavailable_response` while the container is stopped. Nothing of
   an add-on is let through at the top level (`lab_top_level_allowed`). The
   route is removed while no row is enabled.
5. Removes the container of every row that is not enabled, or every row
   while `addons_enabled` is false. Nothing of an add-on persists on the
   host: no volume, so a removed container leaves nothing behind.

The end-of-run `privilege_checks` role reads every deployed container and
fails the run unless it is read-only, has every capability dropped, is not
privileged, has no bind mount, publishes on `127.0.0.1` only and is not in
the host's user namespace.

## What a pane shows

The 503 body is the one thing from this role a visitor can read, inside the
site's pane, and it is exactly the site's own sentence for the same state
(`ADDON_UNAVAILABLE_SENTENCE` in `frontend/src/pages/tools/AddOnPanePage.jsx`):
`scripts/lab-host-visitor-copy.test.mjs` holds the two to each other and to
naming no tool, host or setting. `scripts/lab-host-addons-route.test.mjs`
holds the rendered route to its shape, and
`../caddy/tests/caddy-adapt.test.sh` has the pinned Caddy adapt the whole
rendered configuration and checks the `vars` ordering the redirect relies on.

## The environment contract

`env` is the add-on's own documented contract (for the migration add-on,
`HCW-MigrateOrchestrator_AddOn/docs/deployment/lab-host.md`), rendered as
strings. Two values are derived rather than typed so the policy the add-on
sends and the one Caddy sends agree: `<PREFIX>_FRAME_ANCESTORS` is
`caddy_frame_ancestors` joined, and `<PREFIX>_SITE_ORIGINS` is the same list
without `'self'`. `<PREFIX>_TRUST_PROXY=1` because Caddy sets
`X-Forwarded-For` and nothing else can reach the loopback port. The
human-verification site key is public (the add-on publishes it in
`/api/health`); its secret is `secret_env`, from the vault key
`vault_addon_<id>_turnstile_secret`, and never in this file.

## Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `addons_enabled` | required (`true` in `group_vars`) | Run or remove every add-on |
| `addons` | required | One row per add-on: `id`, `enabled`, `image`, `image_tag`, `image_digest`, `attestation_identity_regexp`, `port`, `memory`, `pids_limit`, `env`, `secret_env` |
| `addons_unavailable_response` | `This tool isn't available right now.` | The 503 body; the site's sentence ("What a pane shows") |
| `addons_caddy_sites_dir`, `addons_caddy_group` | `/etc/caddy/conf.d`, `caddy` | The caddy role's paths |
| `addons_caddy_route_file` | `<sites dir>/20-addons.caddy` | Where the route is rendered |
| `addons_wait_retries`, `addons_wait_delay` | `30`, `2` | The health wait after a start |
| `addons_log_max_size` | `10m` | json-file log cap per container |
| `addons_cosign_bin` | `/usr/local/bin/cosign` | Cosign binary path for attestation verification |
| `addons_attestation_type` | `slsaprovenance1` | Predicate type for SLSA provenance verification |
| `addons_attestation_oidc_issuer` | `https://token.actions.githubusercontent.com` | Expected OIDC issuer in code-signing cert |

`addons_publish_address` (`127.0.0.1`) and `addons_container_port` (`8080`)
are in `vars/main.yml` and are not knobs. `meta/argument_specs.yml` is the
contract.

## Bumping a pin

An add-on release is a tag `v*` in its repository whose `publish-images`
workflow pushes `docker.io/hybridcloudworks/<image>:<version>` and prints
the image index digest in its run summary. The website pins that digest and
the version in the row (`image_digest`, `image_tag`), merges, and the owner
runs `bootstrap.sh`; the role pulls by digest and recreates the container.
Rollback is the previous digest in the same row and another run. The digest
can also be read from the registry; PowerShell or bash, anywhere with Docker:

```powershell
docker buildx imagetools inspect docker.io/hybridcloudworks/img-mo-lab-addon:v0.3.0
```

The `Digest:` line is the value for `addons[].image_digest` of the
`migration` row in `group_vars/all.yml`.

Nothing moves these pins on its own: `scripts/lab-pins-upstream.mjs` has no
publisher newest to compare them with, and `scripts/version-floors.test.mjs`
reads none of the kinds here (`image_tag` on an `addons[]` row is not one it
checks), so `lab-host/README.md`, "Bumping a pin", lists them as hand-moved.

## Kill switches

Three, each one line: `enabled: false` on the row removes that container
(the route then answers 503 with the sentence); `addons_enabled: false`
removes every add-on and the route; and on the site, unsetting the
`ADDON_<ID>_URL` app setting closes the pane without touching the host.

## Check mode

Safe: the assertions and the template run; the pull, the container and the
health wait are skipped or reported.
