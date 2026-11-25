"""The templates in the checkout: which there are, the digest of each, and what was last published."""

import hashlib
import os
import re


def template_digest(config, directory=None):
    """SHA-256 over exactly what hcw-coder-template-push publishes, and the autostop it sets.

    The same files the helper copies: every *.tf (not a dotfile), the lock
    file and the README. None when there is no template directory, which the
    helper itself then refuses. `directory` defaults to the configured
    template's, the one the daily report describes.
    """
    directory = directory or config["template_dir"]
    if not os.path.isdir(directory):
        return None
    names = sorted(name for name in os.listdir(directory) if name.endswith(".tf") and not name.startswith("."))
    names += [name for name in (".terraform.lock.hcl", "README.md") if os.path.lexists(os.path.join(directory, name))]
    digest = hashlib.sha256(f"default_ttl={config['template_default_ttl']}\0".encode())
    for name in names:
        path = os.path.join(directory, name)
        if os.path.islink(path) or not os.path.isfile(path):
            digest.update(f"{name}\0not a regular file\0".encode())
            continue
        with open(path, "rb") as handle:
            digest.update(name.encode() + b"\0" + hashlib.sha256(handle.read()).hexdigest().encode() + b"\0")
    return digest.hexdigest()


def source_digest_or_none(config):
    """template_digest of the checkout for the daily report, or None when it cannot be read.

    The report goes out either way: an unreadable checkout leaves the field
    out, and the site then says it cannot compare, rather than the whole
    report, and the status token's news with it, being lost.
    """
    try:
        return template_digest(config)
    except OSError:
        return None


# hcw-coder-template-push accepts a template name of this shape and no other.
TEMPLATE_NAME = re.compile(r"[a-z0-9-]+")


def templates_to_publish(config):
    """Every template in the checkout, as (name, directory), the configured one first.

    A directory beside the configured template (lab-host/coder/templates, the
    place hcw-coder-template-push reads a named template from) is a template
    when it holds a *.tf file and its name is one the helper accepts; a
    symbolic link is not followed. The configured template (hcw-lab) comes
    first, because the daily report and the site's drift check read it, and
    is listed even when its directory is missing, which the helper then
    refuses, as it always has. Until 2026-10-12 only that one was published,
    so the two guided-lab templates (#1090) needed the owner's token on every
    change.
    """
    primary = config["template_name"]
    root = os.path.dirname(config["template_dir"])
    found = [(primary, config["template_dir"])]
    if os.path.isdir(root):
        for name in sorted(os.listdir(root)):
            path = os.path.join(root, name)
            if name == primary or not TEMPLATE_NAME.fullmatch(name) or os.path.islink(path) or not os.path.isdir(path):
                continue
            try:
                is_template = any(entry.endswith(".tf") and not entry.startswith(".") for entry in os.listdir(path))
            except OSError:
                # Unreadable: listed, so its publish fails by name rather than
                # the template going unseen (CodeRabbit, #1100).
                is_template = True
            if is_template:
                found.append((name, path))
    return found


def published_record(config, state, name):
    """What push-template last published for this template: digest, pushedAt, version.

    Kept per template under state["templates"]. The configured template also
    keeps its three top-level fields, which the daily report carries; a state
    written before the per-template record existed is read from those.
    """
    record = dict(state.get("templates", {}).get(name, {}))
    if not record and name == config["template_name"]:
        record = {"digest": state.get("templateDigest"), "pushedAt": state.get("templatePushedAt"),
                  "version": state.get("templateVersion")}
    return record
