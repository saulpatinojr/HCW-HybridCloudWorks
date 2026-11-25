"""The reads of Portainer that fill the report, in the order a run makes them."""

import time
import urllib.parse

from .common import VERSION_MAX, Failure
from .report import container_counts, edition_of, licence_state

# Portainer asks the registry for an image's digest the first time it is
# asked about it, so the per-image reads share one budget: containers it does
# not get to are left unchecked, and imagesChecked says how many it did. With
# the five reads before them, the CLI's RuntimeMaxSec and 30 s of grace, the
# whole run fits the unit's TimeoutStartSec of six minutes with margin.
IMAGE_STATUS_TIMEOUT_SECONDS = 15
IMAGE_STATUS_BUDGET_SECONDS = 90
# A Portainer that has just started may not have looked at its environments
# yet, so a working one can read down for a moment: after a host reboot, and
# after the role restarts Portainer onto a new Docker socket (#1328). The
# environment read is repeated at this interval for up to the configured
# environment_wait_seconds while the environment reads down; a refusal, a
# missing environment or a malformed answer is not waited for.
ENVIRONMENT_POLL_SECONDS = 2


def image_status(portainer, token, environment_id, running):
    """(imagesChecked, imagesOutdated) over the running containers, within the budget.

    Checked means Portainer gave a verdict, updated or outdated; processing,
    skipped and error are not verdicts, and a read that fails or times out
    is left out the same way rather than failing the run.
    """
    deadline = time.monotonic() + IMAGE_STATUS_BUDGET_SECONDS
    checked = outdated = 0
    for container_id in running:
        if time.monotonic() >= deadline:
            break
        path = f"/docker/{environment_id}/containers/{urllib.parse.quote(container_id, safe='')}/image_status"
        try:
            status, body = portainer.get(path, token, timeout=IMAGE_STATUS_TIMEOUT_SECONDS)
        except Failure:
            continue
        verdict = body.get("Status") if status == 200 and isinstance(body, dict) else None
        if not isinstance(verdict, str) or verdict.lower() not in ("updated", "outdated"):
            continue
        checked += 1
        if verdict.lower() == "outdated":
            outdated += 1
    return checked, outdated


def refused(status):
    """The failure a 401 means: the token is no longer one Portainer accepts."""
    return Failure(
        f"Portainer refused the token (HTTP {status}): it was revoked or replaced. Set "
        "vault_portainer_api_token again (lab-host/README.md, \"Portainer\") and re-run bootstrap.sh"
    )


def read_status(portainer, token, report):
    """GET /system/status: Portainer is up, and its version when it gives a usable one. Failure otherwise."""
    status, body = portainer.get("/system/status", token)
    if status != 200 or not isinstance(body, dict):
        raise Failure(f"GET /system/status answered HTTP {status}")
    report["up"] = True
    version = body.get("Version")
    if isinstance(version, str):
        # The site accepts a version's characters only (letters, digits, dot,
        # plus, hyphen; host-checks.js VERSION_SHAPE): anything else is dropped
        # rather than refused, so an odd build string never costs the report.
        version = "".join(c for c in version.strip() if c.isalnum() or c in ".+-")[:VERSION_MAX]
        if version and version[0].isalnum():
            report["version"] = version


def read_edition(portainer, token, report, notes):
    """GET /system/version: the edition, and True when an update is available. A note when it cannot be read."""
    status, body = portainer.get("/system/version", token)
    if status == 401:
        raise refused(status)
    if status != 200 or not isinstance(body, dict):
        notes.append(f"GET /system/version answered HTTP {status}; the edition is left out")
        return False
    edition = edition_of(body)
    if edition:
        report["edition"] = edition
    return body.get("UpdateAvailable") is True


def read_licence(portainer, token, report, notes):
    """GET /licenses: whether the licence is valid and when it expires. A note when it cannot be read."""
    status, body = portainer.get("/licenses", token)
    if status == 401:
        raise refused(status)
    if status == 200 and isinstance(body, list):
        report["licenseValid"], report["licenseExpiresAt"] = licence_state(body)
    else:
        notes.append(f"GET /licenses answered HTTP {status}; the licence is reported as unknown")


def find_environment(portainer, token, name):
    """The environment named `name` from GET /endpoints, and its numeric Id. Failure when there is none."""
    status, body = portainer.get("/endpoints", token)
    if status == 401:
        raise refused(status)
    if status != 200 or not isinstance(body, list):
        raise Failure(f"GET /endpoints answered HTTP {status}")
    environment = next((item for item in body if isinstance(item, dict) and item.get("Name") == name), None)
    if environment is None:
        raise Failure(f"Portainer lists no environment named {name} among its {len(body)}")
    identifier = environment.get("Id")
    if type(identifier) is not int:
        raise Failure(f"the environment {name} has no numeric Id")
    return environment, identifier


def inspect(portainer, token, config, report):
    """Fill the report from Portainer; returns (notes, update available).

    Raises Failure at the first read the report cannot do without. A read it
    can do without (the edition, the licence) leaves its fields unknown and
    a note for the journal instead.
    """
    notes = []
    read_status(portainer, token, report)
    update_available = read_edition(portainer, token, report, notes)
    read_licence(portainer, token, report, notes)

    name = config["environment_name"]
    deadline = time.monotonic() + config["environment_wait_seconds"]
    while True:
        environment, identifier = find_environment(portainer, token, name)
        report["environmentUp"] = environment.get("Status") == 1
        if report["environmentUp"] or time.monotonic() + ENVIRONMENT_POLL_SECONDS > deadline:
            break
        time.sleep(ENVIRONMENT_POLL_SECONDS)
    if not report["environmentUp"]:
        raise Failure(f"the environment {name} is down (Portainer Status {environment.get('Status')})")

    status, body = portainer.get(f"/endpoints/{identifier}/docker/containers/json?all=true", token)
    if status == 401:
        raise refused(status)
    if status != 200 or not isinstance(body, list):
        raise Failure(f"GET /endpoints/{identifier}/docker/containers/json answered HTTP {status}")
    report["containers"], running = container_counts(body)
    report["imagesChecked"], report["imagesOutdated"] = image_status(portainer, token, identifier, running)
    return notes, update_available
