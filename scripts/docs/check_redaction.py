"""Redaction gate: nothing that should not be public reaches the repository.

Runs in .github/workflows/docs-pages.yml before `mkdocs build`, over docs/**
and the three root documents the site pulls in (README, CHANGELOG, TODO).
Also scans the optional root MEMORY.md continuation handoff, which is not
published on the docs site.

Since #1540 it also reads the code and configuration outside docs/ where a
real Azure identifier has been found or would be most likely to land: the
custom role definitions under infra/roles/ (five of them carried a real
subscription id in their assignableScopes for months, because only docs/
was ever scanned), the Terraform under infra/, the GitHub Actions
workflows, every PowerShell and shell script under scripts/ (the cutover,
rollback and lab scripts carried the API's real application id and the
tenant id as parameter defaults until the follow-up to #1540, and their
tests carried them as fixtures), the lab image's shell scripts, the lab
host's Ansible (yml, sh and j2) and the application source under
functions/src/ and frontend/src/, tests included (two frontend tests held
the real tenant and client ids). Each location is scanned when it exists;
a test fixture root without them still evaluates. The repository is public,
so an identifier in any tracked file is published, not only one on a docs
page.

Fails, naming file:line, on:

1. A hard-coded link to the retired GitHub Wiki. The Wiki is being replaced
   by this site (issue #360); a link back to it would 404 or loop once the
   pointer stubs are in place.
2. A GUID that is not recognisably made up. Tenant, subscription, client and
   resource identifiers are not secrets, but the repository keeps real values
   out of tracked files (see .gitignore's reports note and
   docs/standards/variables-and-secrets.md, which prescribes the all-zero
   form). Recognised shapes, in SYNTHETIC: the placeholder
   00000000-0000-0000-0000-0000000000NN; the browser tests' family
   e2e00000-0000-4000-8000-NNNNNNNNNNNN; a first group that is one hex digit
   repeated eight times (11111111-..., aaaaaaaa-...), which is how the test
   fixtures spell an id that names nothing; and a version-5 UUID (third
   group 5xxx), which is a hash of a name, never an Entra or Azure identity
   (those are version 4). Anything else must be in ALLOWED_GUIDS with a
   reason.
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
    # Every script under scripts/, tests included: the nested cutover, lab
    # and rollback scripts are where the real application id lived.
    (ROOT / "scripts", "**/*.ps1"),
    (ROOT / "scripts", "**/*.sh"),
    (ROOT / "lab-image", "**/*.sh"),
    (ROOT / "lab-host", "**/*.yml"),
    (ROOT / "lab-host", "**/*.yaml"),
    (ROOT / "lab-host", "**/*.sh"),
    (ROOT / "lab-host", "**/*.j2"),
    (ROOT / "functions" / "src", "**/*.js"),
    (ROOT / "frontend" / "src", "**/*.js"),
    (ROOT / "frontend" / "src", "**/*.jsx"),
]

WIKI_LINK = re.compile(r"github\.com/[^/\s)]+/[^/\s)]+/wiki(?:/|\b)")
GUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
PLACEHOLDER = re.compile(r"^00000000-0000-0000-0000-0000000000[0-9a-fA-F]{2}$")
# GUIDs that are recognisably made up or cannot be an identity, so they need
# no allow-list entry (the docstring lists each shape and why). The
# repeated-digit rule accepts a real id with a one-in-268-million first group;
# that is the price of a fixture convention a reader can see at a glance.
SYNTHETIC = re.compile(
    r"^(?:"
    r"e2e00000-0000-4000-8000-[0-9a-f]{12}"
    r"|([0-9a-f])\1{7}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}"
    r")$",
    re.IGNORECASE,
)
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
    # The browser tests' e2e00000-0000-4000-8000-... ids (client ...c11e,
    # tenant ...71d0; frontend/e2e/fixtures/stub-build-env.js, ci.yml) were
    # listed here until the follow-up to #1540 made the family a SYNTHETIC shape.
    # Azure Policy built-in definitions functions/src/lib/labs/estate.js
    # excludes from the lab estate's compliance read, each checked on
    # learn.microsoft.com (built-in policy definitions, Key Vault policy
    # reference, Defender for Cloud policy reference) on 2026-11-04.
    "f85bf3e0-d513-442e-89c3-1784ad63382b": "Azure Policy built-in definition 'System updates should be installed on your machines (powered by Update Center)' (Microsoft constant; functions/src/lib/labs/estate.js)",
    "6ba6d016-e7c3-4842-b8f2-4992ebc0d72d": "Azure Policy built-in definition 'SQL servers on machines should have vulnerability findings resolved' (Microsoft constant; functions/src/lib/labs/estate.js)",
    "a6abeaec-4d90-4a02-805f-6b26c4d3fbe9": "Azure Policy built-in definition 'Azure Key Vaults should use private link' (Microsoft constant; functions/src/lib/labs/estate.js)",
    "55615ac9-af46-4a59-874e-391cc3dfb490": "Azure Policy built-in definition 'Azure Key Vault should have firewall enabled or public network access disabled' (Microsoft constant; functions/src/lib/labs/estate.js)",
    # UUID version-5 namespaces this repository chose at random. A namespace
    # names nothing; it is the salt every markdown-draft and repository-draft
    # id is hashed with, and changing one would re-key every stored draft.
    "5d0a3a1e-6f0b-4c52-9f1e-0e2b7c3d8a41": "MARKDOWN_DRAFT_ID_NAMESPACE, the UUIDv5 namespace markdown draft ids are hashed under (functions/src/lib/cms/drafts-markdown.js)",
    "8bccdb11-a980-4071-bc3a-805c389b371b": "REPO_DRAFT_ID_NAMESPACE, the UUIDv5 namespace repository draft ids are hashed under (functions/src/lib/cms/repo-draft.js)",
    # Public by construction: names anyone can read off a public page or bucket.
    "d139c50a-8163-425c-8315-4e19cc9370ee": "Amazon Music's public listing id for the Hybrid Cloud Works podcast, part of the public URL the site links to (frontend/src/context/ProviderContext.jsx)",
    "405766b8-1f4e-4d3c-aba1-6f25333823ec": "An object name in ElevenLabs's public premade-voice preview bucket, quoted from its API reference as a test of the preview allow-list (functions/src/lib/listen-and-learn/speech/elevenlabs-voices.test.js)",
    "55e71aac-5cb7-4b3d-8241-429388160509": "An object name in ElevenLabs's public voice preview bucket, quoted from its API reference as a test of the preview allow-list (functions/src/lib/listen-and-learn/speech/elevenlabs-voices.test.js)",
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
        if not (PLACEHOLDER.match(guid) or SYNTHETIC.match(guid) or guid.lower() in ALLOWED_GUIDS)
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
            "\nReplace identifiers with 00000000-0000-0000-0000-0000000000NN (a test "
            "fixture may use a first group of one repeated digit, 11111111-...), link "
            "to the docs page instead of the Wiki, and drop local paths. A genuinely "
            "public constant goes in ALLOWED_GUIDS with its reason."
        )
        return 1
    print(f"Docs redaction gate passed ({len(files())} files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
