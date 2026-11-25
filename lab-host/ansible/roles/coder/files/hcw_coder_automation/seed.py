"""The owner's one-time step: the rotation credential made from the owner's token on stdin."""

import sys

from .coder_api import Coder, check_identity, create_token, identity_problem, own_key
from .common import (
    ROTATION_CREDENTIAL,
    ROTATION_KIND,
    TOKEN,
    USERS_ME,
    Context,
    Failure,
    Refusal,
    day,
    iso,
    key_id,
    now,
    parse_time,
    remember,
    role_names,
    say,
)
from .rotation import discard_new_credential, mark_for_deletion, retire
from .storage import load_state, locked, read_credential, save_state, store_credential


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


def stored_credential_kept(coder, existing, user, force):
    """True when the stored rotation credential still works and is kept (no --force); says which either way."""
    status, who = coder.call("GET", USERS_ME, existing)
    if status != 200 or not isinstance(who, dict):
        problem = f"it no longer works (Coder answered HTTP {status})"
    else:
        problem = identity_problem(who, user, "it")
    if problem is None and not force:
        expires = parse_time(own_key(coder, existing, key_id(existing), ROTATION_CREDENTIAL).get("expires_at"))
        say(
            f"a working rotation credential for {user} is already stored (it expires on {day(expires)}); "
            "nothing was changed. --force replaces it"
        )
        return True
    if problem is not None:
        say(f"the stored rotation credential cannot be kept: {problem}; checking the token on stdin to replace it")
    return False


def check_seed_token(coder, owner, user):
    """Refuse the owner's token on stdin when Coder refuses it, or when `user` cannot hold the credential."""
    status, who = coder.call("GET", USERS_ME, owner)
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


def store_seeded_credential(coder, config, state, owner, existing):
    """Make a rotation credential with the owner's token, check and store it, retire the old one.

    Returns (its name, its expiry, a sentence about the previous one or "").
    """
    user = config["status_user"]
    context = Context(coder, config, state, now())
    new, name = create_token(context, owner, user, ROTATION_KIND)
    replacing = existing is not None and existing != new
    try:
        check_identity(coder, new, user, f"the new rotation credential {name}")
        expires = parse_time(own_key(coder, new, key_id(new), f"the new rotation credential {name}").get("expires_at"))
        if replacing:
            mark_for_deletion(state, key_id(existing))
            save_state(config, state)
        store_credential(config["credential_file"], new)
    except Failure as error:
        outcome = discard_new_credential(context, owner, user, new, name)
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
    return name, expires, note


def seed(config, args):
    """Store the rotation credential from the owner's token on stdin.

    Returns nothing, which main() turns into exit 0; any problem is a Failure
    or Refusal instead.
    """
    owner = read_stdin_token()
    coder = Coder(config["coder_url"])
    user = config["status_user"]
    with locked(config):
        state = load_state(config)
        existing = read_credential(config["credential_file"])
        if existing is not None and stored_credential_kept(coder, existing, user, args.force):
            return
        check_seed_token(coder, owner, user)
        name, expires, note = store_seeded_credential(coder, config, state, owner, existing)
    say(f"stored the rotation credential {name} for {user}; it expires on {day(expires)}.{note}")
