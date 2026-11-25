"""The files: the rotation credential, the state, the lock and the configuration."""

import contextlib
import fcntl
import json
import os
import stat
import time

from .common import CONFIG_KEYS, LOCK_WAIT_SECONDS, TOKEN, Failure, remember, warn


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
