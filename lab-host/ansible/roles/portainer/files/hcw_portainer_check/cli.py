"""Read Portainer on the lab host and report it to the site's Health Hub.

The command line and the run. /usr/local/libexec/hcw-portainer-check calls
main() once it has checked these modules; its docstring has the design.
"""

import argparse
import os

from .api import Portainer
from .common import (
    DEFAULT_CONFIG,
    Failure,
    clip,
    load_config,
    me,
    now,
    read_credential,
    say,
    warn,
)
from .delivery import deliver
from .reads import inspect
from .report import base_report


def summary(report, update_available, delivered, failed):
    """The one journal line: what was seen, in counts and dates, and whether the site has it."""
    parts = []
    if report["up"]:
        head = f"Portainer {report.get('version', 'of unknown version')}"
        if report.get("edition"):
            head += f" {report['edition']}"
        parts.append(head + " up")
    else:
        parts.append("Portainer is not answering")
    name = report["environmentName"]
    if report["environmentUp"]:
        counts = report["containers"]
        parts.append(
            f"environment {name} up with {counts['total']} containers ({counts['running']} running, "
            f"{counts['unhealthy']} unhealthy, {counts['restarting']} restarting, {counts['exited']} exited)"
        )
        parts.append(f"{report['imagesChecked']} images checked, {report['imagesOutdated']} outdated")
    elif report["up"]:
        parts.append(f"environment {name} down or not found")
    if report["licenseValid"] is True:
        parts.append(f"licence valid to {report['licenseExpiresAt'][:10]}" if report["licenseExpiresAt"] else "licence valid")
    elif report["licenseValid"] is False:
        parts.append(f"licence not valid (expired {report['licenseExpiresAt'][:10]})" if report["licenseExpiresAt"] else "licence not valid")
    if update_available:
        parts.append("a Portainer update is available")
    parts.append("reported to the site" if delivered else "the report did not reach the site")
    return f"{'failed' if failed else 'checked'}: " + "; ".join(parts)


def run(config):
    """One run: read the credential, read Portainer, deliver the report, say what was seen. 0 or 1."""
    portainer = Portainer(config["portainer_url"])
    token = read_credential()
    started = now()
    report = base_report(config, started)
    errors, notes, update_available = [], [], False
    try:
        notes, update_available = inspect(portainer, token, config, report)
    except Failure as error:
        errors.append(str(error))
    report["error"] = clip(errors) if errors else None
    delivered = False
    try:
        deliver(config, report)
        delivered = True
    except Failure as error:
        errors.append(f"the report did not reach the site: {error}")
    for note in notes:
        warn(note)
    for error in errors:
        warn(error)
    say(summary(report, update_available, delivered, bool(errors)))
    return 1 if errors else 0


def main(argv=None):
    """Parse the command line and run once: 1 for a failure."""
    parser = argparse.ArgumentParser(prog=me, description=__doc__.splitlines()[0])
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        return run(load_config(args.config))
    except Failure as failure:
        warn(str(failure))
        return 1
