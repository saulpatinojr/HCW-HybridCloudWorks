"""revoke: turn the automation off, deleting the rotation credential in Coder before the file."""

import os

from .coder_api import Coder
from .common import USERS_ME, Failure, key_id, say, warn
from .rotation import DISCARDED, retry_discards
from .storage import load_state, locked, read_credential, save_state


def revoke(config, args):
    """Turn the automation off: delete the rotation credential in Coder, then the file.

    Returns nothing, which main() turns into exit 0; any problem is a Failure.
    """
    coder = Coder(config["coder_url"])
    path = config["credential_file"]
    with locked(config):
        state = load_state(config)
        token = read_credential(path)
        if token is None:
            say("there is no rotation credential to revoke; nothing was changed")
            return
        # 401: Coder no longer accepts it (it expired, or it or its user was
        # deleted, as the runbook's leak containment does), so nothing is
        # left in Coder for it to delete: only the file goes.
        status, _ = coder.call("GET", USERS_ME, token)
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
