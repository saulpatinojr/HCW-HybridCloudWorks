"""Keep the site's Coder status token renewed, publish the template, and report.

The command line. /usr/local/libexec/hcw-coder-automation calls main() once
it has checked these modules; its docstring has the design.
"""

import argparse
import os

from . import common
from .common import DEFAULT_CONFIG, Failure, Refusal, warn
from .daily import run
from .publish import push_template
from .revoke import revoke
from .seed import seed
from .storage import load_config

COMMANDS = {"seed": seed, "run": run, "push-template": push_template, "revoke": revoke}


def main(argv=None):
    """Parse the command line and run one command: 2 for a refusal, 1 for a failure.

    A command that returns nothing (seed, revoke) succeeded, which is exit 0;
    run and push-template return their own exit code.
    """
    parser = argparse.ArgumentParser(prog="hcw-coder-automation", description=__doc__.splitlines()[0])
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("seed", help="store the rotation credential (the owner's token on stdin)")
    command.add_argument("--force", action="store_true", help="replace a working rotation credential")
    command = commands.add_parser("run", help="renew what is due and report to the site")
    command.add_argument("--rotate-now", action="store_true", help="renew the site's status token now")
    command.add_argument("--rotate-credential", action="store_true", help="renew the rotation credential now")
    command = commands.add_parser("push-template", help="publish each template whose files changed")
    command.add_argument("--force", action="store_true", help="publish even when nothing changed")
    commands.add_parser("revoke", help="turn it off: delete the rotation credential in Coder, then the file")
    args = parser.parse_args(argv)
    if args.command == "seed":
        common.me = "hcw-coder-automation-seed"
    os.umask(0o077)
    try:
        code = COMMANDS[args.command](load_config(args.config), args)
    except Refusal as refusal:
        warn(str(refusal))
        return 2
    except Failure as failure:
        warn(str(failure))
        return 1
    return 0 if code is None else code
