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

Coder's API (v2.38.0, the release group_vars/all.yml pins), as used here:

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
"""

import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_CONFIG = "/etc/hcw/coder/automation.json"

# The site's status token: the three scopes lab-host/README.md, "The status
# token for the site", measured as the least that answers the site's three
# calls and lets the token read its own expiry (#763), and user:read. In
# Coder v2.38 /users/me and /users/me/keys/{id} both load the user through the
# authorizing store (httpmw.ExtractUserParam), and a low-level scope grants
# only its own resource, so without user:read both answer 404: the token could
# not read its own expiry, and the site, which checks the token with those two
# reads before storing it (functions/src/lib/labs/coder-status.js), would
# refuse every renewal (review of #1030). user:read is read-only.
STATUS_SCOPES = ("template:read", "workspace:read", "api_key:read", "user:read")
STATUS_PREFIX = "hcw-status-site-"
STATUS_LIFETIME = datetime.timedelta(days=90)
# Renewed when the token the site holds expires within 30 days, or is more
# than 60 days old: a 90-day token is replaced with a month to spare, so a
# week of failed runs (the agent down, Coder down) still ends before it lapses.
STATUS_RENEW_BEFORE_EXPIRY = datetime.timedelta(days=30)
STATUS_RENEW_AFTER_AGE = datetime.timedelta(days=60)
# The clean-up keeps the newest two status tokens, the one the site holds and
# the one before it, and never deletes one younger than 48 hours: the site's
# Key Vault reference can take up to 24 hours to pick up a new version, and
# until then the site still reads with the old one.
STATUS_KEEP = 2
STATUS_MIN_AGE_TO_DELETE = datetime.timedelta(hours=48)

ROTATION_PREFIX = "hcw-status-rotation-"
ROTATION_LIFETIME = datetime.timedelta(days=365)
ROTATION_RENEW_BEFORE_EXPIRY = datetime.timedelta(days=60)

# A Coder token, <id>-<secret>, letters and digits either side of one hyphen;
# hcw-coder-template-push accepts the same shape. Looser than Coder's 10 and
# 22, so a format change there does not lock the helper out.
TOKEN = re.compile(r"^[A-Za-z0-9]{1,64}-[A-Za-z0-9]{1,64}$")
NANOSECONDS = 1_000_000_000
HTTP_TIMEOUT_SECONDS = 30
PUSH_TIMEOUT_SECONDS = 1800
LOCK_WAIT_SECONDS = 600
LAST_ERROR_MAX = 300
SKIPPED = 3

CONFIG_KEYS = {
    "coder_url": str,
    "status_user": str,
    "credential_file": str,
    "state_dir": str,
    "template_name": str,
    "template_dir": str,
    "src_dir": str,
    "template_default_ttl": str,
    "push_helper": str,
    "systemd_run": str,
    "node": str,
    "agent_user": str,
    "agent_group": str,
    "agent_env_file": str,
    "agent_app_dir": str,
    "report_cli": str,
    "report_timeout_seconds": int,
}
# The environment every program this helper starts gets, and nothing more: the
# token never travels in one, and a proxy variable cannot reach them.
CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

me = "hcw-coder-automation"
SECRETS = set()


class Failure(Exception):
    """Why a step failed, in words that hold no token."""


class Refusal(Failure):
    """Refused before anything was read from Coder or changed (exit 2)."""


class NotDelivered(Failure):
    """A new status token that certainly never reached the site."""


class DeliveryUnknown(Failure):
    """The site's CLI did not say whether it stored the token."""


def remember(token):
    """Mark a token, and its secret half, for scrubbing from every message."""
    SECRETS.add(token)
    if "-" in token:
        SECRETS.add(token.split("-", 1)[1])
    return token


def scrub(text):
    """Replace every remembered token, and its secret half, with [token]."""
    for value in sorted(SECRETS, key=len, reverse=True):
        if value:
            text = text.replace(value, "[token]")
    return text


def say(message):
    """Print a scrubbed line to stdout under this helper's name."""
    print(f"{me}: {scrub(message)}", flush=True)


def warn(message):
    """Print a scrubbed line to stderr under this helper's name."""
    print(f"{me}: {scrub(message)}", file=sys.stderr, flush=True)


def now():
    """The current UTC time, to the second."""
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def iso(moment):
    """A time as RFC 3339 UTC with seconds and a Z, the form every report field takes."""
    return moment.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day(moment):
    """A time's UTC date, YYYY-MM-DD."""
    return moment.astimezone(datetime.timezone.utc).strftime("%Y-%m-%d")


# Go writes time.Time as RFC 3339 with up to nine fractional digits, and
# Python before 3.11 reads neither those nor the Z; this reads both on the
# 3.12 of Ubuntu 24.04 and the 3.14 of 26.04 alike.
_TIME = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$")


def parse_time(text):
    """A Go RFC 3339 time from Coder as an aware UTC datetime; Failure when it is not one."""
    match = _TIME.match(text if isinstance(text, str) else "")
    if not match:
        raise Failure("Coder answered a time this helper cannot read")
    base, fraction, zone = match.groups()
    zone = "+00:00" if zone == "Z" else zone
    fraction = (fraction or "0")[:6].ljust(6, "0")
    return datetime.datetime.fromisoformat(f"{base}.{fraction}{zone}").astimezone(datetime.timezone.utc)


def key_id(token):
    """A token's public half: the id Coder knows its key by."""
    return token.split("-", 1)[0]


def role_names(user):
    """The site-wide role names Coder lists for a user."""
    return {role.get("name") for role in (user.get("roles") or []) if isinstance(role, dict)}


def scopes_of(key):
    """A key's scopes as a set, from scopes or the older single scope field."""
    scopes = key.get("scopes") or []
    if not scopes and key.get("scope"):
        scopes = [key["scope"]]
    return set(scopes)


# The scopes every status token carries; user:read is the only one allowed
# beside them. The site accepts exactly this shape before storing a token
# (functions/src/lib/labs/coder-status.js), so the helper recognises the
# site's kind by the same rule: a token of hcw-status with only some of
# these scopes, say workspace:read and user:read, is someone else's and
# is never renewed against or cleaned up (review of #1030).
REQUIRED_STATUS_SCOPES = frozenset(("template:read", "workspace:read", "api_key:read"))


def is_status_key(key):
    """The site's kind: the three read scopes, and user:read at most beside them."""
    scopes = scopes_of(key)
    return REQUIRED_STATUS_SCOPES <= scopes <= set(STATUS_SCOPES)


def created(key):
    """When Coder made a key."""
    return parse_time(key.get("created_at"))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # urllib would follow a redirect and send the token header with it.
    # Coder on the loopback never redirects an API call; refuse it if it does.
    def redirect_request(self, *args, **kwargs):
        """Refuse every redirect, so the token header never follows one."""
        return None


class Coder:
    """Coder's REST API on the host's loopback, never through a proxy."""

    def __init__(self, url):
        """A client for the Coder at url, with no proxy and no redirects."""
        self.url = url.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)

    def call(self, method, path, token, body=None):
        """(HTTP status, parsed JSON or None). Raises Failure only when Coder did not answer."""
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self.url + path, data=data, method=method)
        request.add_header("Coder-Session-Token", token)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, b""
            error.close()
        except (urllib.error.URLError, OSError) as error:
            reason = getattr(error, "reason", error)
            raise Failure(f"Coder did not answer at {self.url} ({type(reason).__name__})") from None
        if not 200 <= status < 300 or not raw:
            return status, None
        try:
            return status, json.loads(raw)
        except ValueError:
            raise Failure(f"Coder's answer to {method} {path.split('?')[0]} is not JSON") from None


# --- Files ------------------------------------------------------------------


def write_atomic(path, text):
    """Write beside the file and rename over it: the old file or the new, never half."""
    directory = os.path.dirname(path) or "."
    temporary = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.tmp")
    try:
        if os.path.lexists(temporary):
            os.unlink(temporary)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def read_credential(path):
    """The stored rotation credential, or None when there is none."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise Failure(
            f"refusing {path}: it must be a regular file owned by root with mode 0600; "
            "nothing was read from it"
        )
    with open(path, encoding="utf-8") as handle:
        token = handle.read().strip()
    if not TOKEN.match(token):
        raise Failure(f"{path} does not hold a Coder token; run hcw-coder-automation-seed --force")
    return remember(token)


def store_credential(path, token):
    """Write the rotation credential root-only and atomically, then read it back."""
    write_atomic(path, token + "\n")
    if read_credential(path) != token:
        raise Failure(f"the rotation credential written to {path} did not read back the same")


def state_path(config):
    """Where the state file lives."""
    return os.path.join(config["state_dir"], "state.json")


def load_state(config):
    """The saved state, or an empty one when the file is missing or not a JSON object."""
    try:
        with open(state_path(config), encoding="utf-8") as handle:
            state = json.load(handle)
    except FileNotFoundError:
        return {}
    except ValueError:
        warn(f"{state_path(config)} is not JSON; starting from an empty state")
        return {}
    return state if isinstance(state, dict) else {}


def save_state(config, state):
    """Save the state atomically, leaving out empty values; it never holds a token."""
    kept = {name: value for name, value in sorted(state.items()) if value is not None}
    write_atomic(state_path(config), json.dumps(kept, indent=2) + "\n")


@contextlib.contextmanager
def locked(config):
    """One run at a time: the timer, a seed and a bootstrap's push all write the same files."""
    os.makedirs(config["state_dir"], mode=0o700, exist_ok=True)
    descriptor = os.open(os.path.join(config["state_dir"], "lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise Failure("another hcw-coder-automation run held its lock for ten minutes") from None
                time.sleep(1)
        yield
    finally:
        os.close(descriptor)


def load_config(path):
    """The JSON configuration bootstrap.sh writes, refused when a key is missing or of the wrong type."""
    try:
        with open(path, encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError) as error:
        raise Failure(f"cannot read the configuration {path} ({type(error).__name__}); re-run bootstrap.sh") from None
    if not isinstance(config, dict):
        raise Failure(f"the configuration {path} is not a JSON object")
    for name, kind in CONFIG_KEYS.items():
        if not isinstance(config.get(name), kind) or isinstance(config.get(name), bool):
            raise Failure(f"the configuration {path} has no {kind.__name__} {name}; re-run bootstrap.sh")
    return config


# --- Coder ------------------------------------------------------------------


def identity_problem(who, user, what):
    """Why the user Coder describes in `who` cannot hold the rotation credential, or None.

    It must be hcw-status, a Template Admin (reading every workspace and
    publishing the template need it) and never an Owner (least privilege).
    The seed and every run apply this one rule, so a stored credential is
    never kept on its username alone (review of #1035).
    """
    if who.get("username") != user:
        return f"{what} belongs to {who.get('username')!r}, not {user}"
    roles = role_names(who)
    if "owner" in roles:
        return (f"{user} holds the Owner role, and the rotation credential is meant to carry Template Admin "
                f"only. Remove Owner from {user}")
    if "template-admin" not in roles:
        return (f"{user} is not a Template Admin, which reading every workspace and publishing the template "
                "need (lab-host/README.md, \"The status token for the site\", step 2)")
    return None


def check_identity(coder, token, user, what):
    """Refuse a token that Coder refuses, or whose user fails identity_problem."""
    status, who = coder.call("GET", "/api/v2/users/me", token)
    if status == 401:
        raise Failure(
            f"Coder refused {what} (HTTP 401): it has expired or been deleted. Run "
            "hcw-coder-automation-seed --force (docs/runbooks/labs-host.md, \"Automatic renewal\")"
        )
    if status != 200 or not isinstance(who, dict):
        raise Failure(f"Coder answered HTTP {status} when asked who {what} is")
    problem = identity_problem(who, user, what)
    if problem:
        raise Failure(f"{problem}; nothing was changed")
    return who


def own_key(coder, token, identifier, what):
    """A token's own key record (GET /api/v2/users/me/keys/{id}); Failure on anything but 200."""
    status, key = coder.call("GET", f"/api/v2/users/me/keys/{identifier}", token)
    if status != 200 or not isinstance(key, dict):
        raise Failure(f"Coder answered HTTP {status} when asked for {what}'s record")
    return key


def list_tokens(coder, token, user):
    """hcw-status's tokens, as Coder lists them to the rotation credential."""
    status, keys = coder.call("GET", "/api/v2/users/me/keys/tokens", token)
    if status != 200 or not isinstance(keys, list):
        raise Failure(f"Coder answered HTTP {status} when asked for {user}'s tokens")
    return [key for key in keys if isinstance(key, dict) and isinstance(key.get("id"), str)]


def create_token(coder, token, user, base_name, lifetime, scopes, what):
    """POST a new token; a name already in use (409) gets -2, -3 and so on."""
    body = {"lifetime": int(lifetime.total_seconds()) * NANOSECONDS}
    if scopes:
        body["scopes"] = list(scopes)
    for attempt in range(1, 10):
        name = base_name if attempt == 1 else f"{base_name}-{attempt}"
        body["token_name"] = name
        status, answer = coder.call("POST", f"/api/v2/users/{user}/keys/tokens", token, body)
        if status == 409:
            continue
        if status != 201 or not isinstance(answer, dict) or not TOKEN.match(str(answer.get("key", ""))):
            raise Failure(f"Coder refused to create the {what} {name} (HTTP {status})")
        return remember(answer["key"]), name
    raise Failure(f"every name from {base_name} to {base_name}-9 is already a token of {user}")


def delete_key(coder, token, user, identifier):
    """True when the key is gone (deleted now, or already)."""
    status, _ = coder.call("DELETE", f"/api/v2/users/{user}/keys/{identifier}", token)
    return status in (204, 404)


# Rotation credentials to delete: a new one that failed before it was stored,
# and the one a renewal or seed --force replaced. Each is a year-long unscoped
# token nothing should hold, and prune touches status tokens only, so its id
# stays here until Coder confirms the deletion, and every run works through
# the list (reviews of #1035). A predecessor goes on before the new
# credential replaces it, and the state is saved, so an interruption or a
# failed delete between the two cannot strand it. The id is a token's public
# half, like statusTokenId; the credential in use is never deleted.
DISCARDED = "discardedRotationIds"


def mark_for_deletion(state, identifier):
    """Put a rotation credential's id on the list every run deletes from."""
    state[DISCARDED] = [i for i in state.get(DISCARDED) or [] if i != identifier] + [identifier]


def retire(coder, token, state, identifier):
    """Delete a listed rotation credential of the token's user; True, and off the list, once it is gone."""
    try:
        gone = delete_key(coder, token, "me", identifier)
    except Failure:
        gone = False
    if gone:
        state[DISCARDED] = [i for i in state.get(DISCARDED) or [] if i != identifier] or None
    return gone


def discard_new_credential(coder, token, owner_ref, new, name, state, user):
    """Delete a new rotation credential that failed before it was stored.

    Returns what became of it, for the error. When Coder does not delete it,
    its id goes on the list for the next run.
    """
    identifier = key_id(new)
    try:
        gone = delete_key(coder, token, owner_ref, identifier)
    except Failure:
        gone = False
    if gone:
        return f"the new rotation credential {name} was deleted"
    mark_for_deletion(state, identifier)
    return (f"deleting the new rotation credential {name} failed too; the next run deletes it, "
            f"or delete it by hand among {user}'s tokens in Coder")


def retry_discards(coder, token, state):
    """Delete the listed rotation credentials an earlier run or seed could not, never the one in use."""
    pending = [i for i in state.get(DISCARDED) or [] if isinstance(i, str) and i != key_id(token)]
    state[DISCARDED] = pending or None
    if not pending:
        return
    left = [identifier for identifier in pending if not retire(coder, token, state, identifier)]
    if len(left) < len(pending):
        say(f"deleted {len(pending) - len(left)} rotation credential(s) an earlier run replaced or never stored")
    if left:
        raise Failure(
            f"Coder did not delete {len(left)} rotation credential(s) an earlier run replaced or never stored; "
            "the next run tries again"
        )


# --- The site's CLI ---------------------------------------------------------


def deliver(config, status_token, report):
    """Hand a report, and a new status token when there is one, to the site.

    Returns the CLI's answer, {"ok": true, "stored": true|false}. Raises
    NotDelivered when the CLI certainly never ran, DeliveryUnknown when it ran
    and did not answer ok.
    """
    if not os.path.isfile(config["agent_env_file"]):
        raise NotDelivered(
            f"the lab agent is not configured ({config['agent_env_file']} is missing), "
            "so nothing could be sent to the site"
        )
    payload = {"report": report}
    if status_token is not None:
        payload["statusToken"] = status_token
    timeout = config["report_timeout_seconds"]
    argv = [
        config["systemd_run"],
        "--pipe",
        "--wait",
        "--quiet",
        "--collect",
        "--service-type=exec",
        f"--uid={config['agent_user']}",
        f"--gid={config['agent_group']}",
        f"--property=EnvironmentFile={config['agent_env_file']}",
        f"--property=WorkingDirectory={config['agent_app_dir']}",
        "--property=Environment=NODE_ENV=production",
        "--property=NoNewPrivileges=yes",
        "--property=PrivateTmp=yes",
        "--property=ProtectSystem=full",
        "--property=ProtectHome=yes",
        # systemd stops the CLI itself before this helper gives up on it, so
        # a hung CLI never outlives the run that started it.
        f"--property=RuntimeMaxSec={timeout}",
        "--",
        config["node"],
        config["report_cli"],
    ]
    try:
        completed = subprocess.run(
            argv,
            input=(json.dumps(payload) + "\n").encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"PATH": CHILD_PATH, "LC_ALL": "C"},
            timeout=timeout + 30,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise DeliveryUnknown(f"the site's CLI did not finish within {timeout} seconds") from None
    except OSError as error:
        raise NotDelivered(f"the site's CLI could not be started ({type(error).__name__})") from None
    for line in completed.stderr.decode("utf-8", "replace").splitlines():
        if line.strip():
            print(f"{me}: site CLI: {scrub(line)}", file=sys.stderr, flush=True)
    if completed.returncode != 0:
        raise DeliveryUnknown(f"the site's CLI exited with {completed.returncode}")
    lines = [line for line in completed.stdout.decode("utf-8", "replace").splitlines() if line.strip()]
    try:
        answer = json.loads(lines[-1]) if lines else None
    except ValueError:
        answer = None
    if not isinstance(answer, dict) or answer.get("ok") is not True:
        raise DeliveryUnknown("the site's CLI did not answer {\"ok\": true}")
    return answer


def report_fields(state, checked_at, source_digest=None):
    """The report: what is known, and nothing that is not.

    templateDigest is the digest of what push-template last published (the
    state's, from template_digest at that push); templateSourceDigest is the
    same digest of the checkout as it is now, which bootstrap.sh leaves at the
    commit the host converged from. The site compares the two and raises a
    template Coder serves that is not the converged commit's, such as a
    bootstrap whose publish failed or was skipped (#1009, finding 8).
    """
    report = {"checkedAt": iso(checked_at)}
    for field in ("statusTokenExpiresAt", "statusTokenRotatedAt", "rotationTokenExpiresAt",
                  "templatePushedAt", "templateVersion", "templateDigest"):
        if state.get(field):
            report[field] = state[field]
    if source_digest:
        report["templateSourceDigest"] = source_digest
    return report


def clip(errors):
    """The errors as one scrubbed line of at most LAST_ERROR_MAX characters, for lastError."""
    text = scrub("; ".join(errors))
    return text if len(text) <= LAST_ERROR_MAX else text[: LAST_ERROR_MAX - 3] + "..."


# --- run --------------------------------------------------------------------


def renew_rotation(coder, config, token, state, started):
    """A new rotation credential: create, check, store, then delete the old one.

    Returns (new token, its expiry, a failure to delete the old one or None).
    """
    user = config["status_user"]
    new, name = create_token(coder, token, "me", f"{ROTATION_PREFIX}{day(started)}",
                             ROTATION_LIFETIME, None, "rotation credential")
    try:
        check_identity(coder, new, user, f"the new rotation credential {name}")
        expires = parse_time(own_key(coder, new, key_id(new), f"the new rotation credential {name}").get("expires_at"))
        mark_for_deletion(state, key_id(token))
        save_state(config, state)
        store_credential(config["credential_file"], new)
    except Failure as error:
        outcome = discard_new_credential(coder, token, "me", new, name, state, user)
        raise Failure(f"{error}; {outcome}") from None
    state["rotationTokenExpiresAt"] = iso(expires)
    say(f"stored a new rotation credential, {name}; it expires on {day(expires)}")
    if retire(coder, new, state, key_id(token)):
        return new, expires, None
    return new, expires, "the new rotation credential is stored, but Coder did not delete the previous one; the next run deletes it"


def renew_status(coder, config, token, state, started, previous_id):
    """A new status token: create, check, hand to the site, and record it as live."""
    new, name = create_token(coder, token, "me", f"{STATUS_PREFIX}{day(started)}",
                             STATUS_LIFETIME, STATUS_SCOPES, "status token")
    new_id = key_id(new)
    try:
        status, body = coder.call("GET", "/api/v2/workspaces?q=status:running", new)
        count = body.get("count") if isinstance(body, dict) else None
        if status != 200 or type(count) is not int:
            raise NotDelivered(f"the new status token {name} failed its check (GET /api/v2/workspaces answered HTTP {status})")
        status, own = coder.call("GET", f"/api/v2/users/me/keys/{new_id}", new)
        if status != 200 or not isinstance(own, dict):
            raise NotDelivered(f"the new status token {name} cannot read its own record (HTTP {status}), so it lacks api_key:read or user:read")
        expires = parse_time(own.get("expires_at"))
        report = report_fields(state, started)
        report.update(statusTokenExpiresAt=iso(expires), statusTokenRotatedAt=iso(started))
        answer = deliver(config, new, report)
        if answer.get("stored") is not True:
            raise NotDelivered(f"the site answered that it did not store the new status token {name}")
    except NotDelivered as error:
        gone = delete_key(coder, token, "me", new_id)
        raise Failure(f"{error}; {'it was deleted' if gone else 'deleting it failed too'}") from None
    except Failure as error:
        # The site may have stored it: keep it, so a token the site holds is
        # never deleted. The next run renews again, and the clean-up deletes
        # this one once it is neither among the newest two nor 48 hours young.
        raise Failure(f"{error}; the new status token {name} was kept in case the site stored it") from None
    state.update(
        statusTokenId=new_id,
        statusTokenName=name,
        statusTokenExpiresAt=iso(expires),
        statusTokenRotatedAt=iso(started),
        previousStatusTokenId=previous_id,
    )
    say(f"the site stored the new status token {name}; it expires on {day(expires)}")


def renew_status_if_due(coder, config, token, keys, state, started, force):
    """Renew when the token the site holds is due. True when a new one went live."""
    status_keys = [key for key in keys if is_status_key(key)]
    live_id = state.get("statusTokenId")
    if live_id:
        reference = next((key for key in status_keys if key["id"] == live_id), None)
        missing = f"the status token the site was given ({state.get('statusTokenName', 'unnamed')}) is no longer in Coder"
        if reference is not None:
            state["statusTokenExpiresAt"] = iso(parse_time(reference.get("expires_at")))
    else:
        # Before this helper has given the site a token, the site holds one
        # made by hand (lab-host/README.md, "The status token for the site"):
        # the newest that is not one of this helper's own, because one of
        # those that is not recorded as live never reached the site.
        hand_made = [key for key in status_keys if not str(key.get("token_name", "")).startswith(STATUS_PREFIX)]
        reference = max(hand_made, key=created, default=None)
        missing = f"{config['status_user']} has no status token this helper did not make itself"
    reason = None
    if force:
        reason = "a renewal was asked for (--rotate-now)"
    elif reference is None:
        reason = missing
    else:
        expires, made = parse_time(reference.get("expires_at")), created(reference)
        name = reference.get("token_name", "unnamed")
        if expires - started < STATUS_RENEW_BEFORE_EXPIRY:
            reason = f"the status token {name} expires on {day(expires)}, within 30 days"
        elif started - made > STATUS_RENEW_AFTER_AGE:
            reason = f"the status token {name} was made on {day(made)}, more than 60 days ago"
    if reason is None:
        return False
    say(f"renewing the site's status token: {reason}")
    renew_status(coder, config, token, state, started, reference["id"] if reference else None)
    return True


def prune(coder, config, token, keys, state, started):
    """Delete hcw-status's older status tokens; returns the names deleted.

    Keeps the newest two, the one the site holds and the one before it, and
    any younger than 48 hours. Does nothing until this helper has given the
    site a token that Coder still lists, because until then which token the
    site holds is not known here.
    """
    live_id = state.get("statusTokenId")
    status_keys = sorted((key for key in keys if is_status_key(key)), key=created, reverse=True)
    if not live_id or not any(key["id"] == live_id for key in status_keys):
        return []
    keep = {key["id"] for key in status_keys[:STATUS_KEEP]} | {live_id, state.get("previousStatusTokenId")}
    deleted, failed = [], []
    for key in status_keys:
        if key["id"] in keep or started - created(key) < STATUS_MIN_AGE_TO_DELETE:
            continue
        name = key.get("token_name", "unnamed")
        (deleted if delete_key(coder, token, "me", key["id"]) else failed).append(name)
    if deleted:
        say(f"deleted {len(deleted)} older status token(s): {', '.join(deleted)}")
    if failed:
        raise Failure(f"Coder did not delete the older status token(s) {', '.join(failed)}")
    return deleted


def run(config, args):
    """The timer's run: check the credential, renew what is due, delete what is listed or old, report. 0 or 1."""
    coder = Coder(config["coder_url"])
    user = config["status_user"]
    errors = []
    with locked(config):
        state = load_state(config)
        started = now()
        token = None
        try:
            token = read_credential(config["credential_file"])
            if token is None:
                raise Failure(
                    f"no rotation credential at {config['credential_file']}; run hcw-coder-automation-seed "
                    "once (docs/runbooks/labs-host.md, \"Automatic renewal\")"
                )
            check_identity(coder, token, user, "the rotation credential")
            expires = parse_time(own_key(coder, token, key_id(token), "the rotation credential").get("expires_at"))
            state["rotationTokenExpiresAt"] = iso(expires)
            if args.rotate_credential or expires - started < ROTATION_RENEW_BEFORE_EXPIRY:
                say(f"renewing the rotation credential, which expires on {day(expires)}")
                try:
                    token, expires, problem = renew_rotation(coder, config, token, state, started)
                    if problem:
                        errors.append(problem)
                except Failure as error:
                    errors.append(f"renewing the rotation credential failed: {error}")
        except Failure as error:
            errors.append(str(error))
            token = None
        if token is not None:
            try:
                retry_discards(coder, token, state)
            except Failure as error:
                errors.append(str(error))
            try:
                keys = list_tokens(coder, token, user)
                if renew_status_if_due(coder, config, token, keys, state, started, args.rotate_now):
                    keys = list_tokens(coder, token, user)
                prune(coder, config, token, keys, state, started)
            except Failure as error:
                errors.append(str(error))
        report = report_fields(state, started, source_digest_or_none(config))
        if errors:
            report["lastError"] = clip(errors)
        try:
            deliver(config, None, report)
        except Failure as error:
            errors.append(f"the report did not reach the site: {error}")
        state["lastRunAt"] = iso(started)
        state["lastError"] = clip(errors) if errors else None
        save_state(config, state)
    for error in errors:
        warn(error)
    if errors:
        return 1
    live = state.get("statusTokenName") if state.get("statusTokenId") else None
    status_part = (
        f"the site's status token {live} expires on {state['statusTokenExpiresAt'][:10]}"
        if live and state.get("statusTokenExpiresAt")
        else "the site still holds a status token made by hand"
    )
    say(f"checked: {status_part}; the rotation credential expires on {state['rotationTokenExpiresAt'][:10]}; reported to the site")
    return 0


# --- seed -------------------------------------------------------------------


def read_stdin_token():
    """The first line of stdin, without a byte order mark, carriage return or blanks."""
    if sys.stdin is None or sys.stdin.isatty():
        raise Refusal(
            "pipe the owner's Coder token in on stdin (docs/runbooks/labs-host.md, \"Automatic renewal\"); "
            "it is not read from a terminal, where it would be echoed"
        )
    text = sys.stdin.buffer.readline(4096).decode("utf-8", "replace").lstrip("﻿").strip()
    if not text:
        raise Refusal("the token on stdin was empty; nothing was changed")
    if not TOKEN.match(text):
        raise Refusal(
            "the first line on stdin is not a Coder token (letters and digits either side of one hyphen); "
            "it is not shown, and nothing was changed"
        )
    return remember(text)


def seed(config, args):
    """Store the rotation credential from the owner's token on stdin. 0, or a Failure or Refusal."""
    owner = read_stdin_token()
    coder = Coder(config["coder_url"])
    user = config["status_user"]
    path = config["credential_file"]
    with locked(config):
        state = load_state(config)
        existing = read_credential(path)
        if existing is not None:
            status, who = coder.call("GET", "/api/v2/users/me", existing)
            if status != 200 or not isinstance(who, dict):
                problem = f"it no longer works (Coder answered HTTP {status})"
            else:
                problem = identity_problem(who, user, "it")
            if problem is None and not args.force:
                expires = parse_time(own_key(coder, existing, key_id(existing), "the rotation credential").get("expires_at"))
                say(
                    f"a working rotation credential for {user} is already stored (it expires on {day(expires)}); "
                    "nothing was changed. --force replaces it"
                )
                return 0
            if problem is not None:
                say(f"the stored rotation credential cannot be kept: {problem}; checking the token on stdin to replace it")

        status, who = coder.call("GET", "/api/v2/users/me", owner)
        if status == 401:
            raise Failure(
                "Coder refused the token on stdin (HTTP 401): it has expired or been deleted. Make another "
                "in a pane (lab-host/README.md, \"The status token for the site\", step 1); nothing was changed"
            )
        if status != 200 or not isinstance(who, dict):
            raise Failure(f"Coder answered HTTP {status} when asked whose the token on stdin is; nothing was changed")
        status, target = coder.call("GET", f"/api/v2/users/{user}", owner)
        if status == 404:
            raise Failure(
                f"Coder has no user {user}; create it first (lab-host/README.md, \"The status token for the "
                "site\", step 2); nothing was changed"
            )
        if status != 200 or not isinstance(target, dict):
            raise Failure(f"Coder answered HTTP {status} when asked for the user {user}; nothing was changed")
        roles = role_names(target)
        if "owner" in roles:
            raise Failure(
                f"{user} holds the Owner role; the rotation credential is meant to carry Template Admin only. "
                f"Remove Owner from {user} and run this again; nothing was changed"
            )
        if "template-admin" not in roles:
            raise Failure(
                f"{user} is not a Template Admin, which reading every workspace and publishing the template "
                "need (lab-host/README.md, \"The status token for the site\", step 2); nothing was changed"
            )

        started = now()
        new, name = create_token(coder, owner, user, f"{ROTATION_PREFIX}{day(started)}",
                                 ROTATION_LIFETIME, None, "rotation credential")
        replacing = existing is not None and existing != new
        try:
            check_identity(coder, new, user, f"the new rotation credential {name}")
            expires = parse_time(own_key(coder, new, key_id(new), f"the new rotation credential {name}").get("expires_at"))
            if replacing:
                mark_for_deletion(state, key_id(existing))
                save_state(config, state)
            store_credential(path, new)
        except Failure as error:
            outcome = discard_new_credential(coder, owner, user, new, name, state, user)
            save_state(config, state)
            raise Failure(f"{error}; {outcome}") from None
        note = ""
        if replacing:
            if retire(coder, new, state, key_id(existing)):
                note = " The previous one is deleted."
            else:
                note = " Coder did not delete the previous one; the next run deletes it."
        state["rotationTokenExpiresAt"] = iso(expires)
        save_state(config, state)
    say(f"stored the rotation credential {name} for {user}; it expires on {day(expires)}.{note}")
    return 0


# --- push-template ----------------------------------------------------------


def template_digest(config, directory=None):
    """SHA-256 over exactly what hcw-coder-template-push publishes, and the autostop it sets.

    The same files the helper copies: every *.tf (not a dotfile), the lock
    file and the README. None when there is no template directory, which the
    helper itself then refuses. `directory` defaults to the configured
    template's, the one the daily report describes.
    """
    directory = directory or config["template_dir"]
    if not os.path.isdir(directory):
        return None
    names = sorted(name for name in os.listdir(directory) if name.endswith(".tf") and not name.startswith("."))
    names += [name for name in (".terraform.lock.hcl", "README.md") if os.path.lexists(os.path.join(directory, name))]
    digest = hashlib.sha256(f"default_ttl={config['template_default_ttl']}\0".encode())
    for name in names:
        path = os.path.join(directory, name)
        if os.path.islink(path) or not os.path.isfile(path):
            digest.update(f"{name}\0not a regular file\0".encode())
            continue
        with open(path, "rb") as handle:
            digest.update(name.encode() + b"\0" + hashlib.sha256(handle.read()).hexdigest().encode() + b"\0")
    return digest.hexdigest()


def source_digest_or_none(config):
    """template_digest of the checkout for the daily report, or None when it cannot be read.

    The report goes out either way: an unreadable checkout leaves the field
    out, and the site then says it cannot compare, rather than the whole
    report, and the status token's news with it, being lost.
    """
    try:
        return template_digest(config)
    except OSError:
        return None


# hcw-coder-template-push accepts a template name of this shape and no other.
TEMPLATE_NAME = re.compile(r"[a-z0-9-]+")


def templates_to_publish(config):
    """Every template in the checkout, as (name, directory), the configured one first.

    A directory beside the configured template (lab-host/coder/templates, the
    place hcw-coder-template-push reads a named template from) is a template
    when it holds a *.tf file and its name is one the helper accepts; a
    symbolic link is not followed. The configured template (hcw-lab) comes
    first, because the daily report and the site's drift check read it, and
    is listed even when its directory is missing, which the helper then
    refuses, as it always has. Until 2026-10-12 only that one was published,
    so the two guided-lab templates (#1090) needed the owner's token on every
    change.
    """
    primary = config["template_name"]
    root = os.path.dirname(config["template_dir"])
    found = [(primary, config["template_dir"])]
    if os.path.isdir(root):
        for name in sorted(os.listdir(root)):
            path = os.path.join(root, name)
            if name == primary or not TEMPLATE_NAME.fullmatch(name) or os.path.islink(path) or not os.path.isdir(path):
                continue
            if any(entry.endswith(".tf") and not entry.startswith(".") for entry in os.listdir(path)):
                found.append((name, path))
    return found


def published_record(config, state, name):
    """What push-template last published for this template: digest, pushedAt, version.

    Kept per template under state["templates"]. The configured template also
    keeps its three top-level fields, which the daily report carries; a state
    written before the per-template record existed is read from those.
    """
    record = dict(state.get("templates", {}).get(name, {}))
    if not record and name == config["template_name"]:
        record = {"digest": state.get("templateDigest"), "pushedAt": state.get("templatePushedAt"),
                  "version": state.get("templateVersion")}
    return record


def publish_one(config, args, token, state, name, directory):
    """Publish one template when its files or autostop changed, and record it. A Failure on error."""
    digest = template_digest(config, directory)
    record = published_record(config, state, name)
    if not args.force and digest is not None and record.get("digest") == digest:
        say(
            f"{name} is unchanged since it was published on {str(record.get('pushedAt') or '')[:10]} "
            f"(version {record.get('version') or 'unknown'}); nothing was published"
        )
        return
    try:
        completed = subprocess.run(
            [config["push_helper"], name],
            input=(token + "\n").encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"PATH": CHILD_PATH, "LC_ALL": "C", "HCW_SRC_DIR": config["src_dir"]},
            timeout=PUSH_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise Failure(f"hcw-coder-template-push did not finish within {PUSH_TIMEOUT_SECONDS} seconds") from None
    except OSError as error:
        raise Failure(f"{config['push_helper']} could not be started ({type(error).__name__})") from None
    output = completed.stdout.decode("utf-8", "replace")
    for line in output.splitlines():
        print(scrub(line), flush=True)
    for line in completed.stderr.decode("utf-8", "replace").splitlines():
        print(scrub(line), file=sys.stderr, flush=True)
    if completed.returncode != 0:
        raise Failure(f"hcw-coder-template-push exited with {completed.returncode}; its own message is above")
    found = re.search(r"Active version: (\S+)\. Default autostop:", output)
    if not found:
        raise Failure("hcw-coder-template-push succeeded but named no active version")
    pushed_at, version = iso(now()), found.group(1)
    state.setdefault("templates", {})[name] = {"digest": digest, "pushedAt": pushed_at, "version": version}
    if name == config["template_name"]:
        state.update(templatePushedAt=pushed_at, templateVersion=version, templateDigest=digest)
    save_state(config, state)
    say(f"published {name} with the rotation credential; active version {version}")


def push_template(config, args):
    """Publish every template whose files or autostop changed, each on its own. 0, 1 or SKIPPED.

    One template's failure does not stop the others: each is tried, the ones
    that published are recorded, and the run then fails naming the rest, so
    the next bootstrap.sh run retries exactly those.
    """
    coder = Coder(config["coder_url"])
    user = config["status_user"]
    templates = templates_to_publish(config)
    names = ", ".join(name for name, _ in templates)
    with locked(config):
        token = read_credential(config["credential_file"])
        if token is None:
            say(
                f"{names} not published by this run: there is no rotation credential yet. Run "
                "hcw-coder-automation-seed once (docs/runbooks/labs-host.md, \"Automatic renewal\"), and "
                "the next bootstrap.sh run publishes them; until then, publish each with hcw-coder-template-push"
            )
            return SKIPPED
        status, _ = coder.call("GET", "/api/v2/users/me", token)
        if status == 401:
            say(
                f"{names} not published by this run: Coder refused the rotation credential (HTTP 401). "
                "Run hcw-coder-automation-seed --force (docs/runbooks/labs-host.md, \"Automatic renewal\")"
            )
            return SKIPPED
        check_identity(coder, token, user, "the rotation credential")
        state = load_state(config)
        failed = []
        for name, directory in templates:
            try:
                publish_one(config, args, token, state, name, directory)
            except Failure as error:
                warn(f"publishing {name} failed: {error}")
                failed.append(name)
    if failed:
        raise Failure(f"{', '.join(failed)} not published; the next bootstrap.sh run tries again")
    return 0


# --- revoke -----------------------------------------------------------------


def revoke(config, args):
    """Turn the automation off: delete the rotation credential in Coder, then the file. 0 or a Failure."""
    coder = Coder(config["coder_url"])
    path = config["credential_file"]
    with locked(config):
        state = load_state(config)
        token = read_credential(path)
        if token is None:
            say("there is no rotation credential to revoke; nothing was changed")
            return 0
        # 401: Coder no longer accepts it (it expired, or it or its user was
        # deleted, as the runbook's leak containment does), so nothing is
        # left in Coder for it to delete: only the file goes.
        status, _ = coder.call("GET", "/api/v2/users/me", token)
        refused = status == 401
        if not refused:
            # The listed credentials first: once the stored one is gone,
            # nothing is left that could delete them.
            try:
                retry_discards(coder, token, state)
            except Failure as error:
                save_state(config, state)
                raise Failure(f"{error}; the rotation credential is kept so that this can run again") from None
            # Only a confirmed deletion: a 401 here, just after Coder accepted
            # the credential, proves nothing, and the file is all that could
            # revoke it later (CodeRabbit, #1035).
            status, _ = coder.call("DELETE", f"/api/v2/users/me/keys/{key_id(token)}", token)
            if status not in (204, 404):
                save_state(config, state)
                raise Failure(
                    f"Coder did not delete the rotation credential (HTTP {status}); it is still stored and "
                    "still valid, so run this again"
                )
        os.unlink(path)
        listed = [i for i in state.get(DISCARDED) or [] if isinstance(i, str)]
        if refused and listed:
            # A refused credential cannot delete them, and one of them may
            # still be valid (only the stored one may have expired), so they
            # stay listed: the first run after the next seed deletes them
            # with the new credential, or answers 404 once the user was
            # deleted (CodeRabbit, #1035).
            warn(
                f"{len(listed)} listed rotation credential(s) ({', '.join(listed)}) could not be deleted without "
                f"a working credential; they stay listed, and the first run after hcw-coder-automation-seed "
                f"deletes them. Deleting {config['status_user']}, as the runbook's leak containment does, "
                "removes them at once"
            )
        else:
            state[DISCARDED] = None
        state["rotationTokenExpiresAt"] = None
        save_state(config, state)
    done = ("Coder no longer accepts the rotation credential (HTTP 401), so there was nothing to delete in Coder; "
            "removed it" if refused else "revoked the rotation credential in Coder and removed it")
    say(f"{done}; the daily run is now skipped and bootstrap.sh no longer publishes. "
        "hcw-coder-automation-seed turns it back on")
    return 0


COMMANDS = {"seed": seed, "run": run, "push-template": push_template, "revoke": revoke}


def main(argv=None):
    """Parse the command line and run one command: 2 for a refusal, 1 for a failure."""
    global me
    parser = argparse.ArgumentParser(prog="hcw-coder-automation", description=__doc__.splitlines()[0])
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("seed", help="store the rotation credential (the owner's token on stdin)")
    command.add_argument("--force", action="store_true", help="replace a working rotation credential")
    command = commands.add_parser("run", help="renew what is due and report to the site")
    command.add_argument("--rotate-now", action="store_true", help="renew the site's status token now")
    command.add_argument("--rotate-credential", action="store_true", help="renew the rotation credential now")
    command = commands.add_parser("push-template", help="publish each template whose files changed")
    command.add_argument("--force", action="store_true", help="publish even when nothing changed")
    commands.add_parser("revoke", help="turn it off: delete the rotation credential in Coder, then the file")
    args = parser.parse_args(argv)
    if args.command == "seed":
        me = "hcw-coder-automation-seed"
    os.umask(0o077)
    try:
        return COMMANDS[args.command](load_config(args.config), args)
    except Refusal as refusal:
        warn(str(refusal))
        return 2
    except Failure as failure:
        warn(str(failure))
        return 1


if __name__ == "__main__":
    sys.exit(main())
