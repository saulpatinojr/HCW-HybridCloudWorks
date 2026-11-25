"""push-template: publish each template whose files or autostop changed, with the rotation credential."""

import re
import subprocess
import sys

from .coder_api import Coder, check_identity
from .common import (
    CHILD_PATH,
    PUSH_TIMEOUT_SECONDS,
    ROTATION_CREDENTIAL,
    SKIPPED,
    USERS_ME,
    Failure,
    iso,
    now,
    say,
    scrub,
    warn,
)
from .storage import load_state, locked, read_credential, save_state
from .template_source import published_record, template_digest, templates_to_publish


def publish_one(config, args, token, state, template):
    """Publish one template when its files or autostop changed, and record it. A Failure on error.

    Every error is a Failure, reading the template's files included, so
    push_template's per-template handling sees it and the next template is
    still tried (CodeRabbit, #1100). `template` is a (name, directory) pair
    from templates_to_publish.
    """
    name, directory = template
    try:
        digest = template_digest(config, directory)
    except OSError as error:
        raise Failure(f"{directory} could not be read ({type(error).__name__})") from None
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
        status, _ = coder.call("GET", USERS_ME, token)
        if status == 401:
            say(
                f"{names} not published by this run: Coder refused the rotation credential (HTTP 401). "
                "Run hcw-coder-automation-seed --force (docs/runbooks/labs-host.md, \"Automatic renewal\")"
            )
            return SKIPPED
        check_identity(coder, token, user, ROTATION_CREDENTIAL)
        state = load_state(config)
        failed = []
        for name, directory in templates:
            try:
                publish_one(config, args, token, state, (name, directory))
            except Failure as error:
                warn(f"publishing {name} failed: {error}")
                failed.append(name)
    if failed:
        raise Failure(f"{', '.join(failed)} not published; the next bootstrap.sh run tries again")
    return 0
