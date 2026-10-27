"""Docs publication gate: nothing that should not be public reaches the site.

Runs in .github/workflows/docs-pages.yml before `mkdocs build`, over docs/**
and the three root documents the site pulls in (README, CHANGELOG, TODO), plus
the root MEMORY.md handoff note (owner request 2026-10-27, #1450). MEMORY.md is
scanned but not published: it sits in a public repository, so the same rules
apply to it, and a change to it triggers the workflow that runs this gate.
Fails, naming file:line, on:

1. A hard-coded link to the retired GitHub Wiki. The Wiki is being replaced
   by this site (issue #360); a link back to it would 404 or loop once the
   pointer stubs are in place.
2. A GUID that is not a placeholder. Tenant, subscription, client and
   resource identifiers are not secrets, but the repository keeps real values
   out of tracked files (see .gitignore's reports note and
   docs/standards/variables-and-secrets.md, which prescribes the all-zero
   form). Placeholders are 00000000-0000-0000-0000-0000000000NN; anything
   else must be in ALLOWED_GUIDS with a reason.
3. A contributor's local filesystem path (a Windows user profile), which is
   noise to every other reader and names a person.

Usage: python scripts/docs/check_redaction.py [root]
Exit codes: 0 clean, 1 findings, 2 cannot evaluate.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
SCAN_DIRS = [ROOT / "docs"]
SCAN_FILES = [ROOT / "README.md", ROOT / "CHANGELOG.md", ROOT / "TODO.md"]
# Scanned when present, never required: the handoff note is replaced at each handoff, and deleting it
# must not stop the docs site from building.
OPTIONAL_SCAN_FILES = [ROOT / "MEMORY.md"]

WIKI_LINK = re.compile(r"github\.com/[^/\s)]+/[^/\s)]+/wiki(?:/|\b)")
GUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
PLACEHOLDER = re.compile(r"^00000000-0000-0000-0000-0000000000[0-9a-fA-F]{2}$")
# A user-profile path on any of the three desktop platforms: a drive-letter
# Windows profile, a macOS /Users/<name>/, or a Linux /home/<name>/. The
# username is required to be followed by a separator so that prose such as
# "/home directory" is not a finding while "/home/runner/work/..." is.
LOCAL_PATH = re.compile(
    r"[A-Za-z]:\\Users\\[^\\\s`\"']+"
    r"|/Users/[A-Za-z0-9._-]+/"
    r"|/home/[A-Za-z0-9._-]+/"
)

# Public, first-party constants that are the same in every tenant.
ALLOWED_GUIDS = {
    "797f4846-ba00-4fd7-ba43-dac1f8f63013": "Azure Resource Manager first-party application id (Microsoft constant)",
    "04b07795-8ddb-461a-bbee-02f9e1bf7b46": "Azure CLI first-party application id (Microsoft constant)",
}


def files() -> list[Path]:
    out: list[Path] = []
    for d in SCAN_DIRS:
        if not d.is_dir():
            print(f"cannot evaluate: {d} is not a directory", file=sys.stderr)
            sys.exit(2)
        out.extend(sorted(d.rglob("*.md")))
    for f in SCAN_FILES:
        if not f.is_file():
            print(f"cannot evaluate: {f} missing", file=sys.stderr)
            sys.exit(2)
        out.append(f)
    out.extend(f for f in OPTIONAL_SCAN_FILES if f.is_file())
    return out


def line_findings(rel: str, n: int, line: str) -> list[str]:
    """Every finding on one line, each as `file:line: what`."""
    found: list[str] = []
    if WIKI_LINK.search(line):
        found.append(f"{rel}:{n}: link to the retired GitHub Wiki")
    found.extend(
        f"{rel}:{n}: non-placeholder GUID {guid}"
        for guid in GUID.findall(line)
        if not (PLACEHOLDER.match(guid) or guid.lower() in ALLOWED_GUIDS)
    )
    if LOCAL_PATH.search(line):
        found.append(f"{rel}:{n}: contributor-local filesystem path")
    return found


def scan() -> list[str]:
    """Every finding across every scanned file, in file order."""
    findings: list[str] = []
    for path in files():
        rel = path.relative_to(ROOT).as_posix()
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            findings.extend(line_findings(rel, n, line))
    return findings


def main() -> int:
    findings = scan()
    if findings:
        print("Docs redaction gate failed:")
        for f in findings:
            print(f"  {f}")
        print(
            "\nReplace identifiers with 00000000-0000-0000-0000-0000000000NN, link to the "
            "docs page instead of the Wiki, and drop local paths. A genuinely public "
            "constant goes in ALLOWED_GUIDS with its reason."
        )
        return 1
    print(f"Docs redaction gate passed ({len(files())} files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
