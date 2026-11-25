"""The rotation credential: renewing it, and deleting the ones it replaced or that were never stored."""

from .coder_api import check_identity, create_token, delete_key, own_key
from .common import ROTATION_KIND, Failure, day, iso, key_id, parse_time, say
from .storage import save_state, store_credential

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


def discard_new_credential(context, token, owner_ref, new, name):
    """Delete a new rotation credential that failed before it was stored.

    Returns what became of it, for the error. When Coder does not delete it,
    its id goes on the list for the next run.
    """
    identifier = key_id(new)
    try:
        gone = delete_key(context.coder, token, owner_ref, identifier)
    except Failure:
        gone = False
    if gone:
        return f"the new rotation credential {name} was deleted"
    mark_for_deletion(context.state, identifier)
    return (f"deleting the new rotation credential {name} failed too; the next run deletes it, "
            f"or delete it by hand among {context.config['status_user']}'s tokens in Coder")


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


def renew_rotation(context, token):
    """A new rotation credential: create, check, store, then delete the old one.

    Returns (new token, its expiry, a failure to delete the old one or None).
    """
    coder, config, state = context.coder, context.config, context.state
    user = config["status_user"]
    new, name = create_token(context, token, "me", ROTATION_KIND)
    try:
        check_identity(coder, new, user, f"the new rotation credential {name}")
        expires = parse_time(own_key(coder, new, key_id(new), f"the new rotation credential {name}").get("expires_at"))
        mark_for_deletion(state, key_id(token))
        save_state(config, state)
        store_credential(config["credential_file"], new)
    except Failure as error:
        outcome = discard_new_credential(context, token, "me", new, name)
        raise Failure(f"{error}; {outcome}") from None
    state["rotationTokenExpiresAt"] = iso(expires)
    say(f"stored a new rotation credential, {name}; it expires on {day(expires)}")
    if retire(coder, new, state, key_id(token)):
        return new, expires, None
    return new, expires, "the new rotation credential is stored, but Coder did not delete the previous one; the next run deletes it"
