"""The site's status token: renewing it when it is due, handing it to the site, and deleting old ones."""

from .coder_api import create_token, delete_key
from .common import (
    STATUS_KEEP,
    STATUS_KIND,
    STATUS_MIN_AGE_TO_DELETE,
    STATUS_PREFIX,
    STATUS_RENEW_AFTER_AGE,
    STATUS_RENEW_BEFORE_EXPIRY,
    Failure,
    NotDelivered,
    created,
    day,
    is_status_key,
    iso,
    key_id,
    parse_time,
    say,
)
from .delivery import deliver, report_fields


def renew_status(context, token, previous_id):
    """A new status token: create, check, hand to the site, and record it as live."""
    coder, config, state, started = context.coder, context.config, context.state, context.started
    new, name = create_token(context, token, "me", STATUS_KIND)
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


def renew_status_if_due(context, token, keys, force):
    """Renew when the token the site holds is due. True when a new one went live."""
    config, state, started = context.config, context.state, context.started
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
    renew_status(context, token, reference["id"] if reference else None)
    return True


def prune(coder, token, keys, state, started):
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
