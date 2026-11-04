"""Redaction gate: nothing that should not be public reaches the repository.

Runs in .github/workflows/docs-pages.yml before `mkdocs build`, over docs/**
and the three root documents the site pulls in (README, CHANGELOG, TODO).
Also scans the optional root MEMORY.md continuation handoff, which is not
published on the docs site.

Since #1540 it also reads the files outside docs/ where a real Azure
identifier has been found or would be most likely to land: the custom role
definitions under infra/roles/ (five of them carried a real subscription id
in their assignableScopes for months, because only docs/ was ever scanned),
the Terraform under infra/, the GitHub Actions workflows, and the top-level
operator scripts under scripts/. Each of those locations is scanned when it
exists; a test fixture root without them still evaluates. The repository is
public, so an identifier in any tracked file is published, not only one on
a docs page.

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
# A handoff can contain operational context; keep its public-repository redaction
# checks even though MkDocs does not publish it (#1450). Older fixture roots
# without a handoff retain the three required documentation files.
if (ROOT / "MEMORY.md").exists():
    SCAN_FILES.append(ROOT / "MEMORY.md")
# Code and configuration outside docs/ (#1540), as (directory, glob) pairs.
# A pair is skipped when its directory is absent so that the fixture roots
# the tests build (docs/ plus the three root documents) still evaluate; in
# the real repository every one of these directories exists.
SCAN_GLOBS: list[tuple[Path, str]] = [
    (ROOT / "infra" / "roles", "*.json"),
    (ROOT / "infra", "**/*.tf"),
    (ROOT / "infra", "**/*.tfvars*"),
    (ROOT / ".github" / "workflows", "*.yml"),
    (ROOT / ".github" / "workflows", "*.yaml"),
    (ROOT / "scripts", "*.ps1"),
    (ROOT / "scripts", "*.sh"),
]

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

# Public constants that are the same in every tenant, or values that are
# already public by construction. Keys are lower case. The Microsoft ones are
# on learn.microsoft.com (Azure built-in roles; Azure Policy built-in
# definitions), which is where each was checked before it was added.
ALLOWED_GUIDS = {
    "797f4846-ba00-4fd7-ba43-dac1f8f63013": "Azure Resource Manager first-party application id (Microsoft constant)",
    "04b07795-8ddb-461a-bbee-02f9e1bf7b46": "Azure CLI first-party application id (Microsoft constant)",
    "ba92f5b4-2d11-453d-a403-e96b0029c9fe": "Storage Blob Data Contributor built-in role id (Microsoft constant; infra/lab-hybrid-backups.tf)",
    "e147488a-f6f5-4113-8e2d-b22465e65bf6": "Key Vault Crypto Service Encryption User built-in role id (Microsoft constant; infra/lab-hybrid.tf)",
    "b64e21ea-ac4e-4cdf-9dc9-5b892992bee7": "Azure Connected Machine Onboarding built-in role id (Microsoft constant; scripts/lab/Register-LabArc.ps1)",
    "fc9b3da7-8347-4380-8e70-0a0361d8dedd": "Azure Policy built-in definition 'Linux machines should meet requirements for the Azure compute security baseline' (Microsoft constant; infra/lab-hybrid.tf)",
    "dfee1d68-95f7-4a8f-9c0e-7ebe61112472": "Cloudflare custom-hostname ownership token for go.hybridcloudworks.com: the content of a public DNS TXT record, readable by anyone who queries the name (infra/frontend.tf)",
    "e2e00000-0000-4000-8000-00000000c11e": "Synthetic Entra client id the browser tests build with; it spells 'e2e' and 'client' and names nothing (frontend/e2e/fixtures/stub-build-env.js, .github/workflows/ci.yml)",
    "e2e00000-0000-4000-8000-0000000071d0": "Synthetic Entra tenant id the browser tests build with; it spells 'e2e' and 'tenant' and names nothing (frontend/e2e/fixtures/stub-build-env.js, .github/workflows/ci.yml)",
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
    for d, pattern in SCAN_GLOBS:
        if d.is_dir():
            out.extend(p for p in sorted(d.glob(pattern)) if p.is_file())
    return out


def line_findings(rel: str, n: int, line: str, prose: bool = True) -> list[str]:
    """Every finding on one line, each as `file:line: what`.

    The Wiki-link and local-path rules are about published prose, so they
    apply only to the documentation set (`prose=True`). Code and configuration
    get the GUID rule alone: a workflow legitimately tests `/home/agent/...`
    inside a container, which the local-path rule would otherwise flag.
    """
    found: list[str] = []
    if prose and WIKI_LINK.search(line):
        found.append(f"{rel}:{n}: link to the retired GitHub Wiki")
    found.extend(
        f"{rel}:{n}: non-placeholder GUID {guid}"
        for guid in GUID.findall(line)
        if not (PLACEHOLDER.match(guid) or guid.lower() in ALLOWED_GUIDS)
    )
    if prose and LOCAL_PATH.search(line):
        found.append(f"{rel}:{n}: contributor-local filesystem path")
    return found


def scan() -> list[str]:
    """Every finding across every scanned file, in file order."""
    findings: list[str] = []
    for path in files():
        rel = path.relative_to(ROOT).as_posix()
        prose = path.suffix == ".md"
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            findings.extend(line_findings(rel, n, line, prose))
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
