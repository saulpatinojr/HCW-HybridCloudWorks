"""
Everything that talks to git or to lizard. The only module here with side
effects, which is what makes the judgement in compare.py testable without
either of them.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

from model import EXCLUDED_PARTS, TEST_MARKERS, Func, lizard, supported_extensions


def git_program() -> str:
    """
    git's full path, found on PATH (git.exe on Windows).

    Found by name once per call rather than written in, because git lives in a
    different place on a runner, a Linux host and Windows. On Linux and macOS
    this means a git in the working directory is never the one run; on Windows
    shutil.which looks in the current folder first, so there it gives no such
    guarantee.
    """
    program = shutil.which("git")
    if program is None:
        raise RuntimeError("git is not on PATH; install git, or add it to PATH, and run this again")
    return program


def git(*args: str) -> str:
    """One git command, as stripped stdout. Raises on a non-zero exit."""
    result = subprocess.run(
        [git_program(), *args], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def analysable(path: str, include_tests: bool = False) -> bool:
    if any(part in EXCLUDED_PARTS for part in Path(path).parts):
        return False
    if not include_tests and any(marker in f"/{path}" for marker in TEST_MARKERS):
        return False
    return Path(path).suffix.lstrip(".").lower() in supported_extensions()


def changed_paths(base: str, include_tests: bool) -> tuple[list[str], list[str]]:
    """
    The diff's analysable paths, as (head_paths, base_paths).

    `-M` so a rename is one R entry rather than a delete and an add; its old
    path goes into the base side so the moved functions are found there.

    Three dots, not two: compare against the merge base, so commits that landed
    on `main` after this branch started are not read as this branch's work.
    """
    raw = git("diff", "--name-status", "-M", "--diff-filter=ACMRD", f"{base}...HEAD")
    head_paths: list[str] = []
    base_paths: list[str] = []
    for line in raw.splitlines():
        head_path, base_path = sides_of(line)
        if head_path:
            head_paths.append(head_path)
        if base_path:
            base_paths.append(base_path)
    return (
        sorted({p for p in head_paths if analysable(p, include_tests)}),
        sorted({p for p in base_paths if analysable(p, include_tests)}),
    )


def sides_of(line: str) -> tuple[str, str]:
    """
    One `--name-status` line as the (head, base) paths it contributes.

    An empty string means the line contributes nothing to that side: an added
    file has no base, a deleted file has no head, and a rename has a different
    path on each.
    """
    fields = line.split("\t")
    if len(fields) < 2:
        return ("", "")
    status, path = fields[0], fields[1]
    if status.startswith("R") and len(fields) >= 3:
        return (fields[2], path)
    if status.startswith("D"):
        return ("", path)
    if status.startswith("A"):
        return (path, "")
    return (path, path)  # M, C


# ── measurement ──────────────────────────────────────────────────────────────


def measure(real_path: Path, reported_as: str) -> list[Func]:
    """Lizard one file. `reported_as` is the repository path used as the key."""
    try:
        info = lizard.analyze_file(str(real_path))
    except Exception as err:  # a parse failure must not be silent
        print(f"  ! could not analyse {reported_as}: {err}", file=sys.stderr)
        return []
    seen: dict[str, int] = defaultdict(int)
    functions = []
    for fn in sorted(info.function_list, key=lambda f: f.start_line):
        ordinal = seen[fn.name]
        seen[fn.name] += 1
        functions.append(
            Func(
                path=reported_as,
                name=fn.name,
                ordinal=ordinal,
                complexity=fn.cyclomatic_complexity,
                line=fn.start_line,
                nloc=fn.nloc,
            )
        )
    return functions


def measure_head(paths: list[str], root: Path) -> dict[tuple[str, str, int], Func]:
    out = {}
    for path in paths:
        full = root / path
        if not full.is_file():
            continue
        for fn in measure(full, path):
            out[fn.key] = fn
    return out


def measure_base(
    paths: list[str], base_sha: str, root: Path
) -> dict[tuple[str, str, int], Func]:
    """
    Measure the base revision by writing each file out of the object database.

    `git show <sha>:<path>` rather than a second checkout: the working tree must
    not move under a job that may be doing other things, and a worktree add
    costs a full checkout to read a handful of files.

    Bytes, not text. A source file with a lone surrogate or a non-UTF-8 byte
    would otherwise raise here and be reported as "could not analyse", turning a
    base-side read error into a phantom NEW function on the head side.
    """
    out: dict[tuple[str, str, int], Func] = {}
    program = git_program()
    with tempfile.TemporaryDirectory(prefix="complexity-base-") as tmp:
        tmpdir = Path(tmp)
        for path in paths:
            blob = subprocess.run(
                [program, "show", f"{base_sha}:{path}"],
                capture_output=True,
                check=False,
                cwd=root,
            )
            if blob.returncode != 0:
                continue  # absent at the base: genuinely a new file
            staged = tmpdir / path
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(blob.stdout)
            for fn in measure(staged, path):
                out[fn.key] = fn
    return out


# ── comparison ───────────────────────────────────────────────────────────────
