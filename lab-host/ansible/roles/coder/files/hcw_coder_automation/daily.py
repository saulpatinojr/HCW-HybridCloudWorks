"""The timer's run: check the rotation credential, renew what is due, delete what is old, report."""

from .coder_api import Coder, check_identity, list_tokens, own_key
from .common import (
    ROTATION_CREDENTIAL,
    ROTATION_RENEW_BEFORE_EXPIRY,
    Context,
    Failure,
    clip,
    day,
    iso,
    key_id,
    now,
    parse_time,
    say,
    warn,
)
from .delivery import deliver, report_fields
from .rotation import renew_rotation, retry_discards
from .status import prune, renew_status_if_due
from .storage import load_state, locked, read_credential, save_state
from .template_source import source_digest_or_none


def usable_rotation_credential(context, args, errors):
    """The stored rotation credential, checked and renewed when due, or None when it cannot be used.

    A problem that still leaves a working credential (its renewal failed, or
    the old one was not deleted) is added to `errors` and the run goes on.
    """
    coder, config, state = context.coder, context.config, context.state
    try:
        token = read_credential(config["credential_file"])
        if token is None:
            raise Failure(
                f"no rotation credential at {config['credential_file']}; run hcw-coder-automation-seed "
                "once (docs/runbooks/labs-host.md, \"Automatic renewal\")"
            )
        check_identity(coder, token, config["status_user"], ROTATION_CREDENTIAL)
        expires = parse_time(own_key(coder, token, key_id(token), ROTATION_CREDENTIAL).get("expires_at"))
        state["rotationTokenExpiresAt"] = iso(expires)
        if args.rotate_credential or expires - context.started < ROTATION_RENEW_BEFORE_EXPIRY:
            say(f"renewing the rotation credential, which expires on {day(expires)}")
            try:
                token, expires, problem = renew_rotation(context, token)
                if problem:
                    errors.append(problem)
            except Failure as error:
                errors.append(f"renewing the rotation credential failed: {error}")
    except Failure as error:
        errors.append(str(error))
        return None
    return token


def tidy_status_tokens(context, token, rotate_now, errors):
    """With a working rotation credential: finish listed deletions, renew the site's token when due, prune.

    Each failure is added to `errors`; the first step's failure does not stop the second.
    """
    coder, user = context.coder, context.config["status_user"]
    try:
        retry_discards(coder, token, context.state)
    except Failure as error:
        errors.append(str(error))
    try:
        keys = list_tokens(coder, token, user)
        if renew_status_if_due(context, token, keys, rotate_now):
            keys = list_tokens(coder, token, user)
        prune(coder, token, keys, context.state, context.started)
    except Failure as error:
        errors.append(str(error))


def run(config, args):
    """The timer's run: check the credential, renew what is due, delete what is listed or old, report. 0 or 1."""
    coder = Coder(config["coder_url"])
    errors = []
    with locked(config):
        state = load_state(config)
        started = now()
        context = Context(coder, config, state, started)
        token = usable_rotation_credential(context, args, errors)
        if token is not None:
            tidy_status_tokens(context, token, args.rotate_now, errors)
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
