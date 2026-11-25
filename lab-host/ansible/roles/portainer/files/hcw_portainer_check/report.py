"""The report's fields worked out from Portainer's answers: the empty report, the edition, the licence and the counts."""

import datetime

from .common import ENVIRONMENT_NAME_MAX, iso

# Portainer labels its builds CE, BE and EE (api/portainer.go, GetEditionLabel).
# BE and EE are the one Business Edition image this host runs, and the site's
# contract knows EE and CE; anything else leaves the field out.
EDITIONS = {"EE": "EE", "BE": "EE", "CE": "CE"}


def base_report(config, started):
    """The report before Portainer is asked anything: down, nothing known."""
    return {
        "checkedAt": iso(started),
        "up": False,
        "licenseValid": None,
        "licenseExpiresAt": None,
        "environmentName": config["environment_name"][:ENVIRONMENT_NAME_MAX],
        "environmentUp": False,
        "containers": {"total": 0, "running": 0, "unhealthy": 0, "restarting": 0, "exited": 0},
        "imagesChecked": None,
        "imagesOutdated": None,
        "error": None,
    }


def edition_of(version):
    """EE or CE from /system/version's ServerEdition, or None when it is neither."""
    label = version.get("ServerEdition") if isinstance(version, dict) else None
    return EDITIONS.get(label.strip().upper()) if isinstance(label, str) else None


def licence_state(licences):
    """(licenseValid, licenseExpiresAt) from /licenses.

    Valid when any licence says so, not valid when one says so and none is
    valid, unknown (None) when Portainer says neither, which a fresh instance
    does. The expiry is the latest among the valid licences, or among all of
    them when none is valid, so the card can say when the last one ran out.
    """
    items = [item for item in licences if isinstance(item, dict)]
    flags = [item.get("valid") for item in items]
    if any(flag is True for flag in flags):
        valid = True
    elif any(flag is False for flag in flags):
        valid = False
    else:
        valid = None
    counted = [item for item in items if item.get("valid") is True] if valid else items
    expiries = [item["expiresAt"] for item in counted
                if type(item.get("expiresAt")) in (int, float) and item["expiresAt"] > 0]
    if not expiries:
        return valid, None
    try:
        expires = datetime.datetime.fromtimestamp(max(expiries), datetime.timezone.utc)
    except (OverflowError, OSError, ValueError):
        return valid, None
    return valid, iso(expires)


def container_counts(containers):
    """The counts the report carries, and the ids of the running containers (for image_status)."""
    counts = {"total": 0, "running": 0, "unhealthy": 0, "restarting": 0, "exited": 0}
    running = []
    for container in containers:
        if not isinstance(container, dict):
            continue
        counts["total"] += 1
        state = str(container.get("State") or "").lower()
        if state == "running":
            counts["running"] += 1
            if isinstance(container.get("Id"), str) and container["Id"]:
                running.append(container["Id"])
        elif state == "restarting":
            counts["restarting"] += 1
        elif state == "exited":
            counts["exited"] += 1
        if "(unhealthy)" in str(container.get("Status") or ""):
            counts["unhealthy"] += 1
    return counts, running
