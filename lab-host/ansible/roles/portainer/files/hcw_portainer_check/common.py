"""What every part of hcw-portainer-check shares: the settings, the scrub, the messages and the failures.

The configuration and the credential are read here too. The design is in
the docstring of /usr/local/libexec/hcw-portainer-check
(files/hcw-portainer-check in the portainer role).
"""

import datetime
import json
import os
import sys

DEFAULT_CONFIG = "/etc/hcw/portainer/check.json"
CREDENTIAL_NAME = "api-token"


# The site's limits for the report's strings (functions/src/lib/labs/host-checks.js).
VERSION_MAX = 32
ENVIRONMENT_NAME_MAX = 64
ERROR_MAX = 300


CONFIG_KEYS = {
    "portainer_url": str,
    "environment_name": str,
    "systemd_run": str,
    "node": str,
    "agent_user": str,
    "agent_group": str,
    "agent_env_file": str,
    "agent_app_dir": str,
    "report_cli": str,
    "report_timeout_seconds": int,
    "environment_wait_seconds": int,
}


me = "hcw-portainer-check"
SECRETS = set()


class Failure(Exception):
    """Why a step failed, in words that hold no token."""


class Unreachable(Failure):
    """Portainer did not answer at all."""


class NotDelivered(Failure):
    """A report that certainly never reached the site."""


class DeliveryUnknown(Failure):
    """The site's CLI ran and did not answer ok."""


def remember(token):
    """Mark the token for scrubbing from every message."""
    SECRETS.add(token)
    return token


def scrub(text):
    """Replace the remembered token, wherever it appears, with [token]."""
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


def clip(errors):
    """The errors as one scrubbed line of at most ERROR_MAX characters, for the report.

    One line, with no control character: the site refuses a report whose
    error carries a line break or a control character (host-checks.js), so
    each is folded to a space before the length is cut.
    """
    text = scrub("; ".join(errors))
    text = "".join(" " if (ord(c) < 32 or ord(c) == 127) else c for c in text)
    return text if len(text) <= ERROR_MAX else text[: ERROR_MAX - 3] + "..."


def load_config(path):
    """The JSON configuration the role writes, refused when a key is missing or of the wrong type."""
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


def read_credential():
    """The token systemd handed this run, from $CREDENTIALS_DIRECTORY/api-token and nowhere else.

    No mode check: the directory is the unit's own, made by systemd for this
    run and root-only; the file the credential is copied from is the role's,
    root 0600 in a root 0700 directory.
    """
    directory = os.environ.get("CREDENTIALS_DIRECTORY")
    if not directory:
        raise Failure(
            "no $CREDENTIALS_DIRECTORY: run this through hcw-portainer-check.service, whose "
            f"LoadCredential= hands it the token as {CREDENTIAL_NAME}; it is read from nowhere else"
        )
    path = os.path.join(directory, CREDENTIAL_NAME)
    try:
        with open(path, encoding="utf-8") as handle:
            token = handle.read().strip()
    except OSError as error:
        raise Failure(
            f"cannot read the credential {CREDENTIAL_NAME} ({type(error).__name__}); the unit's "
            "LoadCredential= should have placed it"
        ) from None
    if not token or any(character.isspace() for character in token):
        raise Failure(
            f"the credential {CREDENTIAL_NAME} is empty or holds whitespace; set vault_portainer_api_token "
            "again (lab-host/README.md, \"Portainer\")"
        )
    return remember(token)
