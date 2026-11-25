"""Coder's REST API on the host's loopback, and the calls this helper makes with it."""

import json
import urllib.error
import urllib.request

from .common import (
    HTTP_TIMEOUT_SECONDS,
    NANOSECONDS,
    TOKEN,
    USERS_ME,
    Failure,
    day,
    remember,
    role_names,
)


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
        # OSError covers urllib's URLError too (it is a kind of OSError): no
        # connection, a refused port, a timeout.
        except OSError as error:
            reason = getattr(error, "reason", error)
            raise Failure(f"Coder did not answer at {self.url} ({type(reason).__name__})") from None
        if not 200 <= status < 300 or not raw:
            return status, None
        try:
            return status, json.loads(raw)
        except ValueError:
            raise Failure(f"Coder's answer to {method} {path.split('?')[0]} is not JSON") from None


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
    status, who = coder.call("GET", USERS_ME, token)
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


def create_token(context, token, user, kind):
    """POST a new token of this kind, named for the day the run started; a name already in use (409) gets -2, -3 and so on."""
    base_name = f"{kind.prefix}{day(context.started)}"
    body = {"lifetime": int(kind.lifetime.total_seconds()) * NANOSECONDS}
    if kind.scopes:
        body["scopes"] = list(kind.scopes)
    for attempt in range(1, 10):
        name = base_name if attempt == 1 else f"{base_name}-{attempt}"
        body["token_name"] = name
        status, answer = context.coder.call("POST", f"/api/v2/users/{user}/keys/tokens", token, body)
        if status == 409:
            continue
        if status != 201 or not isinstance(answer, dict) or not TOKEN.match(str(answer.get("key", ""))):
            raise Failure(f"Coder refused to create the {kind.what} {name} (HTTP {status})")
        return remember(answer["key"]), name
    raise Failure(f"every name from {base_name} to {base_name}-9 is already a token of {user}")


def delete_key(coder, token, user, identifier):
    """True when the key is gone (deleted now, or already)."""
    status, _ = coder.call("DELETE", f"/api/v2/users/{user}/keys/{identifier}", token)
    return status in (204, 404)
