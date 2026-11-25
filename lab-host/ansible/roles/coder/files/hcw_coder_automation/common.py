"""What every part of hcw-coder-automation shares: the settings, the scrub, the messages, the times and the failures.

The design is in the docstring of /usr/local/libexec/hcw-coder-automation
(files/hcw-coder-automation.py in the coder role).
"""

import collections
import datetime
import re
import sys

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
# What every message calls the token this helper keeps on disk to do its work.
ROTATION_CREDENTIAL = "the rotation credential"
ROTATION_LIFETIME = datetime.timedelta(days=365)
ROTATION_RENEW_BEFORE_EXPIRY = datetime.timedelta(days=60)

# The two kinds of token this helper makes: the name it starts from (the day
# is added after it), how long it lasts, its scopes (None is unscoped) and
# what messages call it.
TokenKind = collections.namedtuple("TokenKind", "prefix lifetime scopes what")
STATUS_KIND = TokenKind(STATUS_PREFIX, STATUS_LIFETIME, STATUS_SCOPES, "status token")
ROTATION_KIND = TokenKind(ROTATION_PREFIX, ROTATION_LIFETIME, None, "rotation credential")

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
# Coder's "who am I" call: it answers with the user a token belongs to, or
# 401 when Coder no longer accepts the token.
USERS_ME = "/api/v2/users/me"


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


class Context:
    """What the steps of one run or seed share: the Coder client, the settings, the state and when it started."""

    def __init__(self, coder, config, state, started):
        self.coder = coder
        self.config = config
        self.state = state
        self.started = started


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


def clip(errors):
    """The errors as one scrubbed line of at most LAST_ERROR_MAX characters, for lastError."""
    text = scrub("; ".join(errors))
    return text if len(text) <= LAST_ERROR_MAX else text[: LAST_ERROR_MAX - 3] + "..."
