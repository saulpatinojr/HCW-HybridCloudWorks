"""Check a root helper's modules, then run the helper from them (#1845).

Installed as /usr/local/libexec/hcw-lab-python-launch, root:root 0640, by the
coder role and by the portainer role from this same file
(roles/portainer/vars/main.yml, portainer_launcher_source), so the two copies
cannot drift. It is not run on its own. Two root helpers load it by that
absolute path with runpy and call launch() with their own constants:

    /usr/local/libexec/hcw-coder-automation  -> /usr/local/lib/hcw-lab/coder-automation, hcw_coder_automation
    /usr/local/libexec/hcw-portainer-check   -> /usr/local/lib/hcw-lab/portainer-check, hcw_portainer_check

Each helper was one file until 2026-11-25 and is now a package of modules,
split by job so that no file is too complex to review. What root imports is
part of what root runs, so before anything is imported launch() checks, and
refuses to run with one line naming the path otherwise, that:

- every directory from / down to the helper's directory under
  /usr/local/lib/hcw-lab is a real directory (not a symbolic link), owned by
  root and writable by root only;
- that directory holds the helper's package and nothing else, so nothing
  beside it can stand in for a module of the standard library once the
  directory is first on the module path;
- the package has its __init__.py, so it is an ordinary package and not a
  namespace package, whose modules Python would also look for in
  directories this check never reads;
- every directory and file in the package is a real directory or regular
  file, owned by root and writable by root only.

Only then is that one directory put first on sys.path and the package's
cli.main() run. The directory is the helper's constant, never taken from
the environment, an argument, the working directory or a file's own
location, and the helpers run under `python3 -I`, which keeps the user's
site-packages, the PYTHON* variables and the script's own directory off the
module path. No bytecode is written, so the installed tree stays exactly
what the role copied.

This file sits in /usr/local/libexec beside the helpers, installed by the
same roles with the same owner, so it adds nothing to what systemd already
trusts when it starts a helper from that directory. The `owner` and `top`
arguments are for the tests, which install a copy of a package in a scratch
directory they own; the helpers pass neither.
"""

import importlib
import os
import stat
import sys


def unsafe(path, owner, directory):
    """Why one path is not safe for root to import from, or None.

    Safe is a real directory (or regular file), not a symbolic link, owned by
    root, or by `owner`, which only the tests set, and writable by its owner
    alone.
    """
    try:
        info = os.lstat(path)
    except OSError as error:
        return f"{path} cannot be read ({type(error).__name__})"
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        return f"{path} is not a {'directory' if directory else 'regular file'}"
    if info.st_uid not in (0, owner):
        return f"{path} is not owned by root"
    if info.st_mode & 0o022:
        return f"{path} is writable by its group or by others"
    return None


def down_to(lib_dir, top):
    """top and every directory below it on the way to lib_dir, lib_dir included."""
    paths = [top]
    for part in os.path.relpath(lib_dir, top).split(os.sep):
        paths.append(os.path.join(paths[-1], part))
    return paths


def package_entries(package):
    """The package and everything in it, as (path, is a directory), without following a link."""
    entries = [(package, True)]
    for directory, subdirectories, files in os.walk(package):
        entries += [(os.path.join(directory, name), True) for name in sorted(subdirectories)]
        entries += [(os.path.join(directory, name), False) for name in sorted(files)]
    return entries


def first_problem(entries, owner):
    """The first of (path, is a directory) that is not safe, or None."""
    return next((problem for problem in (unsafe(path, owner, directory) for path, directory in entries) if problem), None)


def trust_problem(lib_dir, package, owner=0, top="/"):
    """Why the package under lib_dir cannot be trusted, or None."""
    if os.path.relpath(lib_dir, top).startswith(os.pardir):
        return f"{lib_dir} is not under {top}"
    problem = first_problem([(path, True) for path in down_to(lib_dir, top)], owner)
    if problem:
        return problem
    if sorted(os.listdir(lib_dir)) != [package]:
        return f"{lib_dir} must hold {package} and nothing else"
    # Without __init__.py the package would be a namespace package, which
    # Python also gathers from every other directory on the path, dist-packages
    # included, none of which this check reads.
    if not os.path.isfile(os.path.join(lib_dir, package, "__init__.py")):
        return f"{os.path.join(lib_dir, package)} has no __init__.py"
    return first_problem(package_entries(os.path.join(lib_dir, package)), owner)


def launch(lib_dir, package, me, owner=0, top="/"):
    """Check the package, then run its cli.main(): 1, with one line, when it cannot be trusted."""
    sys.dont_write_bytecode = True
    problem = trust_problem(lib_dir, package, owner, top)
    if problem:
        print(f"{me}: refusing to run: {problem}; re-run bootstrap.sh to install the modules again",
              file=sys.stderr, flush=True)
        return 1
    sys.path.insert(0, lib_dir)
    # Imported only now, once the directory it comes from has been checked.
    return importlib.import_module(f"{package}.cli").main()
