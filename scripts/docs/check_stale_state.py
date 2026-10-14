"""Docs publication gate: a page may not say a live thing is still planned.

Runs in .github/workflows/docs-pages.yml beside check_redaction.py, before
`mkdocs build`. The 2026-10-06 estate assessment (PLAT-9, #969) found the lab
architecture page saying "State: planned" after the host had run for a week,
and the restore runbook's header saying "not yet armed" a month after the
export armed. An operator reads those lines and acts on them, so each pattern
below fails the build once the dated live record it contradicts exists in the
repository; the record is named beside the pattern.

The patterns match the STATEMENT, not a mention of it: a page may say that a
heading used to read "not yet armed" (history is kept, by this repository's
rule), so each pattern is anchored to the form the stale line took, a bold
state line or a heading. A new entry is a file, a pattern and the record that
makes it stale.

Usage: python scripts/docs/check_stale_state.py [root]
Exit codes: 0 clean, 1 findings, 2 cannot evaluate.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]

# (file, pattern on one line, the dated record that makes a match stale)
STALE = [
    (
        "docs/architecture/labs-host.md",
        re.compile(r"^\*\*State: planned", re.IGNORECASE),
        "the page's State line has read live since #1009 (2026-10-08); the host has converged since 2026-09-26",
    ),
    (
        "docs/architecture/labs-host.md",
        # The sentence as the page stated it, at the start of its State line;
        # a later mention of it ("the page once said ...") is history, not the
        # statement (review on #1175).
        re.compile(r"^\*\*State: planned\.\*\* Nothing on this page is provisioned", re.IGNORECASE),
        "the host has run since 2026-09-26 (#1009)",
    ),
    (
        "docs/runbooks/cosmos-restore.md",
        re.compile(r"^#+ .*not yet armed", re.IGNORECASE),
        "the export armed on 2026-09-09 (ADR 0028) and the first drill ran on 2026-10-13 (#1103)",
    ),
    (
        "docs/runbooks/alerting-and-support.md",
        re.compile(r"^#+ .*delivery is unproven", re.IGNORECASE),
        "delivery was proven on 2026-08-30 and the heading rewritten by PLAT-4 (#1051)",
    ),
]


def main() -> int:
    '''Scan each page for its stale pattern, print every finding, and return the exit code.'''
    findings: list[str] = []
    for relative, pattern, record in STALE:
        path = ROOT / relative
        if not path.is_file():
            print(f"cannot evaluate: {relative} is missing", file=sys.stderr)
            return 2
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if pattern.search(line):
                findings.append(f"{relative}:{number}: matches {pattern.pattern!r}, but {record}")
    for finding in findings:
        print(finding)
    if findings:
        print(
            f"{len(findings)} stale state line(s); correct the page or, if the record is wrong, this check",
            file=sys.stderr,
        )
        return 1
    print("no stale state lines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
