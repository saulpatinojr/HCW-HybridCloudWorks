#!/usr/bin/env python3
"""Tests ../files/hcw-coder-automation.py and the files the coder role renders for it.

The helper is run as it ships against stand-ins, each in this process or a
scratch directory:

- a fake Coder API on a loopback port, answering the seven calls the helper
  makes the way Coder v2.38.0 does: tokens of <10>-<22> characters, `lifetime`
  in nanoseconds, coder:all when no scope is asked for, 409 on a token name in
  use, 404 for a key read the token may not make, times with nine fractional
  digits, expired tokens left out of the list;
- a fake systemd-run that records its arguments, reads the EnvironmentFile and
  WorkingDirectory it is given and runs the command there, so the agent's
  environment file and checkout are exercised as on the host;
- a fake site CLI (vps-agent/bin/report-coder-automation.js) that records what
  it was handed and answers {"ok": true, "stored": ...}, refuses, or answers
  stored false, as the environment file tells it;
- a fake hcw-coder-template-push that records the token and checkout it got.

Then the role's templates are rendered with its defaults (Jinja2, trim_blocks,
undefined names fail) and held to what the rest of the repository says: the
agent's user, environment file and checkout, Coder's port, the checkout the
push helper reads, the failure notifier, and the owner's line in the runbook.

No root, no Docker and no network. CI runs it in the `lab-host role tests`
job with the job's Python, which has Jinja2 and PyYAML from ansible-core; on a
workstation, bash, with Docker, from the repository root:
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo:ro" -w /repo python:3.14-slim bash -c "pip install -q jinja2 pyyaml && python3 lab-host/ansible/roles/coder/tests/hcw-coder-automation.test.py"
"""

import argparse
import ast
import contextlib
import datetime
import http.server
import importlib
import io
import json
import os
import pathlib
import random
import re
import runpy
import shutil
import socket
import stat
import string
import subprocess
import sys
import tempfile
import threading
import urllib.parse

import jinja2
import yaml

HERE = pathlib.Path(__file__).resolve().parent
ROLE = HERE.parent
ANSIBLE = ROLE.parent.parent
LAB_HOST = ANSIBLE.parent
REPO = LAB_HOST.parent
# Names that recur through the checks, written once here so a rename is one edit.
HELPER_FILE = "hcw-coder-automation.py"
MAIN_YML = "main.yml"
MAIN_TF = "main.tf"
README_MD = "README.md"
STATE_JSON = "state.json"
# Coder's scopes (what a token may do): coder:all is a token with no limit.
SCOPE_ALL = "coder:all"
SCOPE_WORKSPACE_READ = "workspace:read"
SCOPE_API_KEY_READ = "api_key:read"
SCOPE_USER_READ = "user:read"
TEMPLATE_ADMIN = "Template Admin"
FORBIDDEN = "Forbidden."
# Words the helper prints, which the checks look for.
NOT_TEMPLATE_ADMIN = "not a Template Admin"
ALREADY_STORED = "already stored"
# A SHA-256 digest written as 64 lowercase hexadecimal characters.
SHA256_HEX = r"[0-9a-f]{64}"
HELPER = ROLE / "files" / HELPER_FILE
# The helper's modules (#1845), the launcher that checks them before they are
# imported, and where the role installs each.
PACKAGE_DIR = ROLE / "files" / "hcw_coder_automation"
LAUNCHER_FILE = "hcw-lab-python-launch.py"
LAUNCHER_SOURCE = ROLE / "files" / LAUNCHER_FILE
INSTALLED_LAUNCHER = "/usr/local/libexec/hcw-lab-python-launch"
LIB_DIR = "/usr/local/lib/hcw-lab/coder-automation"
UTC = datetime.timezone.utc
DAY = datetime.timedelta(days=1)
NS = 1_000_000_000
STATUS_SCOPES = ["template:read", SCOPE_WORKSPACE_READ, SCOPE_API_KEY_READ, SCOPE_USER_READ]

passed = 0
failed = 0


def check(name, condition, detail=""):
    """Record one named check: ok on stdout, or not ok and the detail on stderr."""
    global passed, failed
    if condition:
        passed += 1
        print(f"ok {passed} - {name}")
    else:
        failed += 1
        print(f"not ok - {name}", file=sys.stderr)
        if detail:
            print(f"    {detail}", file=sys.stderr)


def skip(name, why):
    """Record a check that cannot run here, and why."""
    print(f"skip - {name} ({why})")


def now():
    return datetime.datetime.now(UTC)


def today():
    return now().strftime("%Y-%m-%d")


def constants_of(text):
    """The top-level NAME = "string" assignments of a Python source, as a dict."""
    return {target.id: node.value.value for node in ast.parse(text).body if isinstance(node, ast.Assign)
            for target in node.targets if isinstance(target, ast.Name) and isinstance(node.value, ast.Constant)}


def stage_tree(top, lib_dir, package_dir):
    """Install a copy of a package under top, at lib_dir, as the role does: directories 0750, files 0640."""
    target = pathlib.Path(str(top) + lib_dir) / package_dir.name
    target.mkdir(parents=True)
    for source in package_dir.glob("*.py"):
        shutil.copyfile(source, target / source.name)
        (target / source.name).chmod(0o640)
    directory = target
    while directory != pathlib.Path(top):
        directory.chmod(0o750)
        directory = directory.parent
    return target


# The helper as the unit runs it, with one change: its run_path(LAUNCHER) is
# answered with this checkout's launcher, which then checks and imports the
# copy stage_tree installed under the scratch top, owned by this user,
# instead of the host's /usr/local/lib/hcw-lab. Everything else, the
# helper's own constants included, runs as it ships.
RUN_ENTRY = r'''
import os, runpy, sys
entry, launcher, top = sys.argv[1:4]
del sys.argv[1:4]
real_run_path = runpy.run_path
def run_path(path, *args, **kwargs):
    if path != "/usr/local/libexec/hcw-lab-python-launch":
        sys.exit(f"the helper loaded {path}, not the installed launcher")
    real_launch = real_run_path(launcher)["launch"]
    def launch(lib_dir, package, me):
        return real_launch(top + lib_dir, package, me, os.getuid(), top)
    return {"launch": launch}
runpy.run_path = run_path
real_run_path(entry, run_name="__main__")
'''


def helper_command(top):
    """The command that runs the helper as it ships, its modules staged under top (RUN_ENTRY)."""
    return [sys.executable, "-I", "-B", "-c", RUN_ENTRY, str(HELPER), str(LAUNCHER_SOURCE), str(top)]


# --- The role's files, rendered -----------------------------------------------


def jinja_env():
    """A Jinja2 environment that renders the role's templates as Ansible does."""
    # Escaping on for HTML and XML only, as Jinja2 recommends. None of the
    # role's templates is either (JSON, a shell script, systemd units), and
    # Ansible renders them unescaped, so they render here as they do on the host.
    env = jinja2.Environment(
        undefined=jinja2.StrictUndefined, trim_blocks=True, keep_trailing_newline=True,
        autoescape=jinja2.select_autoescape(default_for_string=False, default=False),
    )
    env.filters["to_json"] = json.dumps
    return env


def resolved(*files, extra=None):
    """Top-level values of YAML files, with {{ }} in them resolved against each other."""
    values = {}
    for path in files:
        values.update(yaml.safe_load(path.read_text(encoding="utf-8")) or {})
    values.update(extra or {})
    env = jinja_env()
    for _ in range(5):
        for name, value in list(values.items()):
            if isinstance(value, str) and "{{" in value:
                try:
                    values[name] = env.from_string(value).render(**values)
                except jinja2.exceptions.TemplateError:
                    # It names a value not resolved yet, or an Ansible-only
                    # construct; left as written, the next pass tries again.
                    continue
    return values


def render(template, values):
    """One of the role's templates, rendered with the given values."""
    text = (ROLE / "templates" / template).read_text(encoding="utf-8")
    return jinja_env().from_string(text).render(ansible_managed="Ansible managed", **values)


defaults = resolved(ROLE / "defaults" / MAIN_YML)
group_vars = yaml.safe_load((ANSIBLE / "group_vars" / "all.yml").read_text(encoding="utf-8"))
agent = resolved(ANSIBLE / "roles" / "labs_agent" / "defaults" / MAIN_YML,
                 extra={name: group_vars[name] for name in ("labs_agent_user", "labs_agent_home")})

config = json.loads(render("hcw-coder-automation.json.j2", defaults))
service = render("hcw-coder-automation.service.j2", defaults)
timer = render("hcw-coder-automation.timer.j2", defaults)
seed_wrapper = render("hcw-coder-automation-seed.j2", defaults)
push_template = (ROLE / "templates" / "hcw-coder-template-push.j2").read_text(encoding="utf-8")
compose = (LAB_HOST / "coder" / "docker-compose.yml").read_text(encoding="utf-8")
bootstrap = (LAB_HOST / "bootstrap.sh").read_text(encoding="utf-8")
agent_unit = (ANSIBLE / "roles" / "labs_agent" / "templates" / "hcw-labs-agent.service.j2").read_text(encoding="utf-8")
tasks = yaml.safe_load((ROLE / "tasks" / MAIN_YML).read_text(encoding="utf-8"))
helper_text = HELPER.read_text(encoding="utf-8")


def task_using(module, **match):
    """The coder role's first task calling a module with the given arguments, and its body."""
    for task in tasks:
        body = task.get(module)
        if isinstance(body, dict) and all(body.get(k) == v for k, v in match.items()):
            return task, body
    return None, None


check("the helper is Python 3, run isolated", helper_text.startswith("#!/usr/bin/python3 -I\n"))
# Since 2026-11-25 (#1845) the script is only the way in: it hands the
# launcher its constants, and the helper is the package beside it.
modules = sorted(PACKAGE_DIR.glob("*.py"))
compile_error = ""
for source in [HELPER, LAUNCHER_SOURCE, *modules]:
    try:
        # In this process, so a read-only checkout gets no __pycache__ written into it.
        compile(source.read_text(encoding="utf-8"), str(source), "exec")
    except SyntaxError as error:
        compile_error += f"{source.name}: {error}; "
check("the helper, the launcher and every module compile", not compile_error, compile_error)
entry_constants = constants_of(helper_text)
check("the helper hands the installed launcher the module directory and package the role installs, and nothing else",
      entry_constants == {"LAUNCHER": INSTALLED_LAUNCHER, "LIB_DIR": LIB_DIR, "PACKAGE": PACKAGE_DIR.name}
      and helper_text.rstrip().endswith(
          'sys.exit(runpy.run_path(LAUNCHER)["launch"](LIB_DIR, PACKAGE, "hcw-coder-automation"))'),
      json.dumps(entry_constants))
dirs_task, body = task_using("ansible.builtin.file", path="{{ item }}", state="directory")
package_path = f"{LIB_DIR}/{PACKAGE_DIR.name}"
check("the role makes every directory down to the package root:root 0750",
      body is not None and (body["owner"], body["group"], body["mode"]) == ("root", "root", "0750")
      and dirs_task.get("loop") == ["/usr/local/lib/hcw-lab", LIB_DIR, package_path], str(dirs_task))
modules_task, body = task_using("ansible.builtin.copy", src=f"{PACKAGE_DIR.name}/{{{{ item }}}}")
role_vars = yaml.safe_load((ROLE / "vars" / MAIN_YML).read_text(encoding="utf-8"))
check("the role installs every module, and only those, root:root 0640 in the package's directory",
      body is not None and (body["dest"], body["owner"], body["group"], body["mode"])
      == (f"{package_path}/{{{{ item }}}}", "root", "root", "0640")
      and modules_task.get("loop") == "{{ coder_automation_modules }}"
      and role_vars["coder_automation_modules"] == [module.name for module in modules],
      json.dumps(role_vars.get("coder_automation_modules")))
launcher_task, body = task_using("ansible.builtin.copy", src=LAUNCHER_FILE)
check("the role installs the launcher where the helper loads it, root:root 0640",
      body is not None and (body["dest"], body["owner"], body["group"], body["mode"])
      == (INSTALLED_LAUNCHER, "root", "root", "0640"), str(body))
find_task, body = task_using("ansible.builtin.find", paths=package_path)
check("the role finds every *.py that is not a listed module, and any __pycache__, in the installed package",
      body is not None and body.get("patterns") == ["*.py", "__pycache__"]
      and body.get("excludes") == "{{ coder_automation_modules }}" and body.get("file_type") == "any"
      and body.get("hidden") is True and find_task.get("register") == "coder_automation_stale_modules", str(find_task))
# The role has another find-and-remove pair (the lab launcher's files), so
# this one is found by what it loops over.
remove_task = next((task for task in tasks
                    if task.get("loop") == "{{ coder_automation_stale_modules.files | default([]) }}"), None)
body = (remove_task or {}).get("ansible.builtin.file")
check("and removes what it found",
      isinstance(body, dict) and body == {"path": "{{ item.path }}", "state": "absent"}, str(remove_task))
helper_task, _ = task_using("ansible.builtin.copy", src=HELPER_FILE)
order = [task.get("name") for task in tasks]
steps = (dirs_task, modules_task, find_task, remove_task, launcher_task, helper_task)
check("the modules go in, unlisted files go out, then the launcher, all before the helper that loads them",
      None not in steps and [order.index(task["name"]) for task in steps] == sorted(order.index(task["name"]) for task in steps),
      str(order))
check("the rendered configuration names Coder on the port the Compose file publishes on the loopback",
      config["coder_url"] == f"http://127.0.0.1:{defaults['coder_http_port']}"
      and f'"127.0.0.1:{defaults["coder_http_port"]}:7080"' in compose, config["coder_url"])
check("the configuration names the agent's user and group (group_vars, labs_agent defaults)",
      config["agent_user"] == group_vars["labs_agent_user"] and config["agent_group"] == agent["labs_agent_group"],
      f"{config['agent_user']}:{config['agent_group']}")
check("the configuration names the agent's EnvironmentFile, and the agent's unit reads the same one",
      config["agent_env_file"] == agent["labs_agent_env_file"] and "EnvironmentFile={{ labs_agent_env_file }}" in agent_unit,
      config["agent_env_file"])
check("the CLI runs from the agent's own checkout, which has its node_modules, with the agent's node",
      config["agent_app_dir"] == agent["labs_agent_app_dir"] and config["node"] == "/usr/bin/node"
      and "ExecStart=/usr/bin/node index.js" in agent_unit and "WorkingDirectory={{ labs_agent_app_dir }}" in agent_unit,
      config["agent_app_dir"])
check("the CLI is vps-agent/bin/report-coder-automation.js", config["report_cli"] == "bin/report-coder-automation.js")
check("the push helper and the checkout are the ones the role installs and bootstrap.sh keeps",
      config["push_helper"] == "/usr/local/sbin/hcw-coder-template-push"
      and config["src_dir"] == "/opt/hcw-src"
      and 'HCW_SRC_DIR="${HCW_SRC_DIR:-/opt/hcw-src}"' in bootstrap
      and 'src="${HCW_SRC_DIR:-/opt/hcw-src}"' in push_template
      and config["template_dir"] == "/opt/hcw-src/lab-host/coder/templates/hcw-lab"
      and 'template_dir="${src}/lab-host/coder/templates/${name}"' in push_template and "\nname=hcw-lab\n" in push_template)
check("the configuration carries the role's default autostop, so a changed autostop publishes again",
      config["template_default_ttl"] == defaults["coder_template_default_ttl"])
check("the rotation credential is a file in a directory of its own under /etc/hcw/coder",
      config["credential_file"] == "/etc/hcw/coder/automation/rotation-token"
      and os.path.dirname(config["credential_file"]) == defaults["coder_automation_dir"])
check("the service runs the helper's run command with the rendered configuration",
      f"ExecStart=/usr/local/libexec/hcw-coder-automation --config {defaults['coder_automation_config_file']} run\n" in service)
check("the service names the hardening role's failure notifier",
      "\nOnFailure=hcw-unit-failed@%n.service\n" in service
      and (ANSIBLE / "roles" / "hardening" / "templates" / "hcw-unit-failed@.service.j2").is_file())
check("the service is skipped, not failed, until the credential exists",
      f"\nConditionPathExists={config['credential_file']}\n" in service)
check("the service may write only the credential's directory and its own state",
      f"\nReadWritePaths={defaults['coder_automation_dir']} {defaults['coder_automation_state_dir']}\n" in service
      and "\nProtectSystem=strict\n" in service and "\nType=oneshot\n" in service)
check("the timer runs the service daily, catching up after a day off",
      "\nUnit=hcw-coder-automation.service\n" in timer and "\nPersistent=true\n" in timer
      and f"\nOnCalendar={defaults['coder_automation_on_calendar']}\n" in timer)
# sh by its full path, found on PATH once, so the check never runs a program
# picked up from the working directory; a host without sh stops here, saying so.
SH = shutil.which("sh")
if SH is None:
    sys.exit("hcw-coder-automation.test.py: no sh on PATH, which the seed wrapper's syntax check needs")
seed_check = subprocess.run([SH, "-n"], input=seed_wrapper, capture_output=True, text=True)  # nosec B603 - sh -n only parses
check("the seed wrapper parses and hands its arguments to the helper's seed command",
      seed_check.returncode == 0
      and seed_wrapper.rstrip().endswith(
          f'exec /usr/local/libexec/hcw-coder-automation --config {defaults["coder_automation_config_file"]} seed "$@"'),
      seed_check.stderr)
_, body = task_using("ansible.builtin.copy", src=HELPER_FILE)
check("the role installs the helper as /usr/local/libexec/hcw-coder-automation, root:root 0750",
      body is not None and (body["dest"], body["owner"], body["group"], body["mode"])
      == ("/usr/local/libexec/hcw-coder-automation", "root", "root", "0750"), str(body))
_, body = task_using("ansible.builtin.template", src="hcw-coder-automation-seed.j2")
check("the role installs the seed as /usr/local/sbin/hcw-coder-automation-seed, root:root 0750",
      body is not None and (body["dest"], body["owner"], body["group"], body["mode"])
      == ("/usr/local/sbin/hcw-coder-automation-seed", "root", "root", "0750"), str(body))
push_task, body = task_using("ansible.builtin.command")
check("the role publishes with the helper's push-template command, skipping (exit 3) rather than failing",
      body is not None and body["argv"][0] == "/usr/local/libexec/hcw-coder-automation"
      and body["argv"][-1] == "push-template" and push_task.get("failed_when") == "coder_automation_push.rc not in [0, 3]",
      str(body))
runbook = REPO / "docs" / "runbooks" / "labs-host.md"
if runbook.is_file():
    text = runbook.read_text(encoding="utf-8")
    check("the owner's seed line in docs/runbooks/labs-host.md runs the installed path",
          '$t | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-coder-automation-seed"' in text)
else:
    skip("the owner's seed line in docs/runbooks/labs-host.md", "no docs/ beside lab-host/")


# --- The fake Coder ----------------------------------------------------------------


def go_time(moment):
    """A time as Coder's JSON carries it: Go's RFC 3339 with nanoseconds and a Z."""
    # Go's RFC 3339 with nanoseconds, which Python's fromisoformat cannot read before 3.11.
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond:06d}321Z"


def random_text(length):
    """Random letters and digits, the alphabet of Coder's key ids and secrets."""
    # random, not secrets: these are made-up values for a fake server, and
    # nothing about them needs to be unpredictable.
    return "".join(random.choice(string.ascii_letters + string.digits) for _ in range(length))  # nosec B311 - test data, not security


KNOWN_SCOPES = {SCOPE_ALL, "template:read", SCOPE_WORKSPACE_READ, SCOPE_API_KEY_READ, SCOPE_USER_READ}
# The messages the fake Coder answers with, as Coder words them.
SIGNED_OUT = "You are signed out or your session has expired."
ROUTE_NOT_FOUND = "Route not found."
RESOURCE_NOT_FOUND = "Resource not found"
INTERNAL_ERROR = "Internal error."


def is_owner(user):
    """True when the user holds Coder's Owner role."""
    return "owner" in {role["name"] for role in user["roles"]}


class FakeCoder:
    def __init__(self):
        self.lock = threading.Lock()
        self.users = {
            "u-owner": {"id": "u-owner", "username": "owner-gh", "status": "active",
                        "roles": [{"name": "owner", "display_name": "Owner", "organization_id": ""}]},
            "u-status": {"id": "u-status", "username": "hcw-status", "status": "dormant",
                         "roles": [{"name": "template-admin", "display_name": TEMPLATE_ADMIN, "organization_id": ""}]},
        }
        self.keys = {}
        self.posts = []
        self.deleted = []
        self.workspace_tokens = []
        self.tokens = set()
        # Token names whose own-record read, or whose deletion, answers 500,
        # and whose deletion answers 401.
        self.fail_reads = set()
        self.fail_deletes = set()
        self.unauthorized_deletes = set()

    def issue(self, user_id, name, scopes, created=None, expires=None):
        """Make a key for a user and return its token."""
        moment = now()
        identifier, secret = random_text(10), random_text(22)
        created = created or moment
        self.keys[identifier] = {
            "id": identifier, "secret": secret, "user_id": user_id, "token_name": name, "scopes": list(scopes),
            "created_at": created, "expires_at": expires or created + 7 * DAY,
        }
        token = f"{identifier}-{secret}"
        self.tokens.add(token)
        return token

    def key_of(self, token):
        """The key a token belongs to, or None."""
        return self.keys.get(token.split("-", 1)[0])

    def by_name(self, name):
        """Every key with this token name."""
        return [key for key in self.keys.values() if key["token_name"] == name]

    def key_json(self, key):
        """A key as Coder's API returns it."""
        return {
            "id": key["id"], "user_id": key["user_id"], "last_used": "0001-01-01T00:00:00Z",
            "expires_at": go_time(key["expires_at"]), "created_at": go_time(key["created_at"]),
            "updated_at": go_time(key["created_at"]), "login_type": "token",
            "scope": "all" if SCOPE_ALL in key["scopes"] else "", "scopes": key["scopes"],
            "token_name": key["token_name"],
            "lifetime_seconds": int((key["expires_at"] - key["created_at"]).total_seconds()),
        }

    def authenticate(self, header):
        """The key a Coder-Session-Token header names, when it is valid and unexpired."""
        identifier, _, secret = (header or "").partition("-")
        key = self.keys.get(identifier)
        if key is None or key["secret"] != secret or key["expires_at"] <= now():
            return None
        return key

    def resolve(self, reference, caller):
        """The user a path names: me, an id or a username."""
        if reference == "me":
            return caller
        return next((user for user in self.users.values() if reference in (user["id"], user["username"])), None)


class Handler(http.server.BaseHTTPRequestHandler):
    fake = None

    def log_message(self, *args):
        # Left empty on purpose: the base class prints every request to stderr,
        # which would bury the test's own ok / not ok lines.
        pass

    def send(self, status, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        """Serve the part of Coder's API the helper uses, with Coder's status codes and permissions."""
        fake = self.fake
        url = urllib.parse.urlsplit(self.path)
        parts = url.path.strip("/").split("/")
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        with fake.lock:
            key = fake.authenticate(self.headers.get("Coder-Session-Token"))
            if key is None:
                return self.send(401, {"message": SIGNED_OUT})
            caller = fake.users[key["user_id"]]
            if parts == ["api", "v2", "workspaces"] and method == "GET":
                return self.serve_workspaces(key, url)
            if parts[:3] != ["api", "v2", "users"] or len(parts) < 4:
                return self.send(404, {"message": ROUTE_NOT_FOUND})
            return self.serve_user(method, parts, body, key, caller)

    def serve_workspaces(self, key, url):
        """GET /api/v2/workspaces: one running workspace, for a token that may read workspaces."""
        if not (SCOPE_ALL in key["scopes"] or SCOPE_WORKSPACE_READ in key["scopes"]):
            return self.send(403, {"message": FORBIDDEN})
        self.fake.workspace_tokens.append((key["token_name"], urllib.parse.parse_qs(url.query).get("q")))
        return self.send(200, {"workspaces": [], "count": 1})

    def serve_user(self, method, parts, body, key, caller):
        """/api/v2/users/{user}[/...]: the user's record, its list of tokens, or one of its keys."""
        target = self.fake.resolve(parts[3], caller)
        if target is None:
            return self.send(404, {"message": "Resource not found or you do not have access to this resource"})
        unscoped = SCOPE_ALL in key["scopes"]
        owner = is_owner(caller)
        mine = target["id"] == caller["id"]
        manages = unscoped and (mine or owner)
        rest = parts[4:]
        if rest == [] and method == "GET":
            return self.send(200, target) if manages else self.send(403, {})
        # Any other method on .../keys/tokens, once allowed, falls through to
        # the single-key route below, which finds no key named "tokens" (404).
        if rest == ["keys", "tokens"] and (not manages or method in ("GET", "POST")):
            return self.serve_tokens(method, body, caller, target, manages)
        if len(rest) == 2 and rest[0] == "keys":
            return self.serve_key(method, rest[1], key, target, mine, owner)
        return self.send(404, {"message": ROUTE_NOT_FOUND})

    def serve_tokens(self, method, body, caller, target, allowed):
        """GET or POST .../keys/tokens, for a caller allowed to manage the user's keys."""
        if not allowed:
            return self.send(403, {"message": FORBIDDEN})
        if method == "GET":
            return self.list_tokens(target)
        return self.create_token(body, caller, target)

    def list_tokens(self, target):
        """GET .../keys/tokens: the user's unexpired keys."""
        listed = [self.fake.key_json(k) for k in self.fake.keys.values()
                  if k["user_id"] == target["id"] and k["expires_at"] > now()]
        return self.send(200, listed)

    def create_token(self, body, caller, target):
        """POST .../keys/tokens: a new key, refused as Coder refuses a bad lifetime, scope or name."""
        fake = self.fake
        fake.posts.append({"user": target["username"], "by": caller["username"], "body": body})
        lifetime = body.get("lifetime")
        longest = (168 if is_owner(target) else 876600) * 3600 * NS
        if type(lifetime) is not int or lifetime <= 0 or lifetime > longest:
            return self.send(400, {"message": "Failed to validate create API key request."})
        scopes = body.get("scopes") or [SCOPE_ALL]
        if not set(scopes) <= KNOWN_SCOPES:
            return self.send(400, {"message": "invalid scope"})
        name = body.get("token_name")
        if any(k["user_id"] == target["id"] and k["token_name"] == name for k in fake.keys.values()):
            return self.send(409, {"message": f"A token with name {name!r} already exists."})
        moment = now()
        token = fake.issue(target["id"], name, scopes, moment, moment + datetime.timedelta(seconds=lifetime / NS))
        return self.send(201, {"key": token})

    def serve_key(self, method, identifier, key, target, mine, owner):
        """GET or DELETE .../keys/{id}: one of the user's keys."""
        fake = self.fake
        unscoped = SCOPE_ALL in key["scopes"]
        found = fake.keys.get(identifier)
        if found is None or found["user_id"] != target["id"]:
            return self.send(404, {"message": RESOURCE_NOT_FOUND})
        if method == "GET":
            if found["token_name"] in fake.fail_reads:
                return self.send(500, {"message": INTERNAL_ERROR})
            if (mine and (unscoped or {SCOPE_API_KEY_READ, SCOPE_USER_READ} <= set(key["scopes"]))) or (owner and unscoped):
                return self.send(200, fake.key_json(found))
            return self.send(404, {"message": RESOURCE_NOT_FOUND})
        if method == "DELETE":
            return self.delete_key(found, unscoped and (mine or owner))
        return self.send(404, {"message": ROUTE_NOT_FOUND})

    def delete_key(self, found, allowed):
        """DELETE .../keys/{id}, or the failure a test planted for that key's name."""
        fake = self.fake
        if not allowed:
            return self.send(403, {"message": FORBIDDEN})
        if found["token_name"] in fake.fail_deletes:
            return self.send(500, {"message": INTERNAL_ERROR})
        if found["token_name"] in fake.unauthorized_deletes:
            return self.send(401, {"message": SIGNED_OUT})
        fake.deleted.append(found["token_name"])
        del fake.keys[found["id"]]
        return self.send(204)


# --- A world: the fake Coder, the fakes on disk and a configuration ---------------

SYSTEMD_RUN = r'''#!@PYTHON@
import json, os, subprocess, sys
args = sys.argv[1:]
with open("@LOG@", "a", encoding="utf-8") as handle:
    handle.write(json.dumps(args) + "\n")
if "--" not in args or "--pipe" not in args or "--wait" not in args:
    print("fake systemd-run: --pipe, --wait and -- are required", file=sys.stderr)
    sys.exit(99)
split = args.index("--")
properties = {}
for option in args[:split]:
    if option.startswith("--property="):
        name, _, value = option[len("--property="):].partition("=")
        properties.setdefault(name, []).append(value)
env = {"PATH": os.environ.get("PATH", "")}
try:
    with open(properties["EnvironmentFile"][0], encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                name, _, value = line.partition("=")
                env[name] = value
except FileNotFoundError:
    print("Failed to load environment files", file=sys.stderr)
    sys.exit(1)
for assignment in properties.get("Environment", []):
    name, _, value = assignment.partition("=")
    env[name] = value
sys.exit(subprocess.run(args[split + 1:], cwd=properties["WorkingDirectory"][0], env=env).returncode)
'''

SITE_CLI = r'''#!@PYTHON@
import json, os, sys
payload = json.loads(sys.stdin.read())
mode = os.environ.get("FAKE_CLI_MODE", "")
with open("@LOG@", "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"payload": payload, "cwd": os.getcwd(), "mode": mode,
                             "node_env": os.environ.get("NODE_ENV")}) + "\n")
# The CLI's contract: one object with statusToken and/or report, nothing else.
if not isinstance(payload, dict) or not payload or set(payload) - {"statusToken", "report"}:
    print("INVALID_INPUT", file=sys.stderr)
    sys.exit(1)
if mode == "fail":
    # A CLI that leaks: the helper must scrub this before it reaches the journal.
    print("report-coder-automation: the site refused " + payload.get("statusToken", "the report"), file=sys.stderr)
    sys.exit(1)
if mode == "not-stored":
    print(json.dumps({"ok": True, "stored": False}))
    sys.exit(0)
print("report-coder-automation: a log line before the answer")
print(json.dumps({"ok": True, "stored": "statusToken" in payload}))
'''

PUSH_HELPER = r'''#!@PYTHON@
import json, os, sys
token = sys.stdin.readline().strip()
mode = open("@MODE@").read().strip() if os.path.exists("@MODE@") else ""
name = sys.argv[1] if len(sys.argv) > 1 else "hcw-lab"
with open("@LOG@", "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"token": token, "src": os.environ.get("HCW_SRC_DIR"), "argv": sys.argv[1:]}) + "\n")
if mode in ("fail", "fail:" + name):
    print(f"hcw-coder-template-push: publishing {name} failed; Coder's message is above", file=sys.stderr)
    sys.exit(1)
count = sum(1 for _ in open("@LOG@", encoding="utf-8"))
src = os.environ["HCW_SRC_DIR"]
print(f"hcw-coder-template-push: copying main.tf from {src} to /tmp/{name}.abc in the coder container")
print("Updated version at now!", file=sys.stderr)
print(f"hcw-coder-template-push: published {name} from {src}/lab-host/coder/templates/{name}. Active version: brave_turing{count}. Default autostop: 1h0m0s.")
'''


def write_fake(path, text, **values):
    """Write an executable fake, its @NAME@ placeholders filled in."""
    for name, value in values.items():
        text = text.replace(f"@{name}@", value)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.replace("@PYTHON@", sys.executable), encoding="utf-8")
    path.chmod(0o755)


def free_port():
    """An unused TCP port on the loopback."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class World:
    def __init__(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="hcw-coder-automation."))
        self.fake = FakeCoder()
        handler = type("BoundHandler", (Handler,), {"fake": self.fake})
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.owner_token = self.fake.issue("u-owner", "hcw-setup", [SCOPE_ALL])
        self.outputs = []
        self.automation = self.root / "etc" / "automation"
        self.automation.mkdir(parents=True, mode=0o700)
        self.state_dir = self.root / "state"
        self.app = self.root / "agent" / "vps-agent"
        self.env_file = self.root / "labs-agent.env"
        self.cli_log = self.root / "cli.jsonl"
        self.run_log = self.root / "systemd-run.jsonl"
        self.push_log = self.root / "push.jsonl"
        self.push_mode = self.root / "push-mode"
        self.src = self.root / "src"
        self.template = self.src / "lab-host" / "coder" / "templates" / "hcw-lab"
        self.template.mkdir(parents=True)
        (self.template / MAIN_TF).write_text('resource "x" "y" {}\n', encoding="utf-8")
        (self.template / ".terraform.lock.hcl").write_text("# lock\n", encoding="utf-8")
        (self.template / README_MD).write_text("# hcw-lab\n", encoding="utf-8")
        (self.template / "template.test.mjs").write_text("// not published\n", encoding="utf-8")
        write_fake(self.root / "bin" / "systemd-run", SYSTEMD_RUN, LOG=str(self.run_log))
        write_fake(self.app / "bin" / "report-coder-automation.js", SITE_CLI, LOG=str(self.cli_log))
        write_fake(self.root / "bin" / "hcw-coder-template-push", PUSH_HELPER, LOG=str(self.push_log), MODE=str(self.push_mode))
        self.cli_mode("stored")
        self.config = dict(config)
        self.config.update(
            coder_url=f"http://127.0.0.1:{self.server.server_address[1]}",
            credential_file=str(self.automation / "rotation-token"),
            state_dir=str(self.state_dir),
            template_dir=str(self.template),
            src_dir=str(self.src),
            push_helper=str(self.root / "bin" / "hcw-coder-template-push"),
            systemd_run=str(self.root / "bin" / "systemd-run"),
            node=sys.executable,
            agent_env_file=str(self.env_file),
            agent_app_dir=str(self.app),
            report_timeout_seconds=20,
        )
        self.config_file = self.root / "automation.json"
        stage_tree(self.root, LIB_DIR, PACKAGE_DIR)
        self.write_config()

    def write_config(self, **changes):
        """Write the helper's configuration, with changes."""
        self.config.update(changes)
        self.config_file.write_text(json.dumps(self.config), encoding="utf-8")

    def cli_mode(self, mode):
        """Set how the fake site CLI answers: stored, not-stored or fail."""
        self.env_file.write_text(f"# a stand-in for /etc/hcw/labs-agent.env\nLABS_AGENT_ID=vps-test\nFAKE_CLI_MODE={mode}\n",
                                 encoding="utf-8")

    def helper(self, *args, stdin=b""):
        """Run the helper with arguments and stdin, keeping its output for the leak check."""
        completed = subprocess.run([*helper_command(self.root), "--config", str(self.config_file), *args],
                                   input=stdin, capture_output=True, timeout=120)
        result = subprocess.CompletedProcess(completed.args, completed.returncode,
                                             completed.stdout.decode("utf-8", "replace"),
                                             completed.stderr.decode("utf-8", "replace"))
        self.outputs.append(result.stdout + result.stderr)
        return result

    def seed(self, *args):
        """Run the seed with the owner's token on stdin."""
        return self.helper("seed", *args, stdin=(self.owner_token + "\n").encode())

    def credential(self):
        """The stored rotation credential, or None."""
        path = pathlib.Path(self.config["credential_file"])
        return path.read_text(encoding="utf-8").strip() if path.exists() else None

    def state(self):
        """The helper's state file, parsed, or an empty dict."""
        path = self.state_dir / STATE_JSON
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def lines(self, path):
        """A JSON-lines file, parsed."""
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def cli_calls(self):
        """Every call the fake site CLI received."""
        return self.lines(self.cli_log)

    def status_key(self, name, created_days_ago, expires_in_days, scopes=STATUS_SCOPES):
        """Make a status token of hcw-status, created and expiring relative to now."""
        moment = now()
        return self.fake.issue("u-status", name, scopes, moment - created_days_ago * DAY, moment + expires_in_days * DAY)

    def leaks(self):
        """Every place a token must never be: what the helper printed, its state, the reports."""
        places = list(self.outputs)
        if (self.state_dir / STATE_JSON).exists():
            places.append((self.state_dir / STATE_JSON).read_text(encoding="utf-8"))
        for call in self.cli_calls():
            places.append(json.dumps(call["payload"].get("report", {})))
        found = []
        for token in self.fake.tokens:
            secret = token.split("-", 1)[1]
            found += [token[:12] + "..." for place in places if secret in place]
        return found

    def close(self):
        """Stop the fake Coder and remove the world's files."""
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.root, ignore_errors=True)


# --- seed ------------------------------------------------------------------------

world = World()
master, slave = os.openpty()
completed = subprocess.run([*helper_command(world.root), "--config", str(world.config_file), "seed"],
                           stdin=slave, capture_output=True, text=True, timeout=60)
os.close(master)
os.close(slave)
check("seed refuses a terminal on stdin, where a pasted token would be echoed (exit 2)",
      completed.returncode == 2 and "not read from a terminal" in completed.stderr, completed.stderr)
result = world.helper("seed", stdin=b"")
check("seed refuses empty stdin (exit 2)", result.returncode == 2 and "was empty" in result.stderr, result.stderr)
line = b'$t | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-coder-automation-seed"\n'
result = world.helper("seed", stdin=line)
check("seed refuses a first line that is not a token, without showing it (exit 2)",
      result.returncode == 2 and "not a Coder token" in result.stderr and "ssh hcw-lab" not in result.stdout + result.stderr,
      result.stderr)
# A well-formed token Coder never issued, built here so no token-shaped
# literal sits in the source for a secret scanner to flag.
unknown_token = "-".join(("q" * 10, "r" * 22))
result = world.helper("seed", stdin=(unknown_token + "\n").encode())
check("seed fails on a token Coder refuses, and creates nothing",
      result.returncode == 1 and "refused the token on stdin" in result.stderr and not world.fake.posts
      and world.credential() is None, result.stderr)
check("a refused seed leaves no rotation credential", not os.path.exists(world.config["credential_file"]))

world.fake.users["u-status"]["roles"] = [{"name": "owner", "display_name": "Owner", "organization_id": ""}]
result = world.seed()
check("seed refuses an hcw-status that holds Owner (least privilege)",
      result.returncode == 1 and "holds the Owner role" in result.stderr and not world.fake.posts, result.stderr)
world.fake.users["u-status"]["roles"] = []
result = world.seed()
check("seed refuses an hcw-status that is not a Template Admin",
      result.returncode == 1 and NOT_TEMPLATE_ADMIN in result.stderr and not world.fake.posts, result.stderr)
status_user = world.fake.users.pop("u-status")
result = world.seed()
check("seed refuses when there is no hcw-status user", result.returncode == 1 and "has no user hcw-status" in result.stderr,
      result.stderr)
world.fake.users["u-status"] = status_user
world.fake.users["u-status"]["roles"] = [{"name": "template-admin", "display_name": TEMPLATE_ADMIN, "organization_id": ""}]

# A BOM, blanks and a carriage return, as a Windows pipe can deliver them.
result = world.helper("seed", stdin=b"\xef\xbb\xbf  " + world.owner_token.encode() + b" \r\n")
expiry = (now() + 365 * DAY).strftime("%Y-%m-%d")
check("seed stores a rotation credential and prints one line naming its expiry",
      result.returncode == 0 and result.stdout.count("\n") == 1 and f"expires on {expiry}" in result.stdout,
      result.stdout + result.stderr)
token = world.credential()
key = world.fake.key_of(token or "-")
check("the credential is an unscoped (coder:all) token of hcw-status",
      key is not None and key["user_id"] == "u-status" and key["scopes"] == [SCOPE_ALL], str(key))
post = world.fake.posts[-1] if world.fake.posts else {}
check("it is created by the owner for hcw-status, named hcw-status-rotation-<date>, for 365 days in nanoseconds",
      post.get("user") == "hcw-status" and post.get("by") == "owner-gh"
      and post.get("body") == {"lifetime": 365 * 86400 * NS, "token_name": f"hcw-status-rotation-{today()}"},
      json.dumps(post))
mode = stat.S_IMODE(os.stat(world.config["credential_file"]).st_mode)
check("the credential file is 0600 and its directory 0700",
      mode == 0o600 and stat.S_IMODE(os.stat(world.automation).st_mode) == 0o700, oct(mode))
check("the state records the credential's expiry and no token",
      world.state().get("rotationTokenExpiresAt", "").startswith(expiry), json.dumps(world.state()))
posts = len(world.fake.posts)
result = world.seed()
check("a second seed finds the working credential and changes nothing",
      result.returncode == 0 and ALREADY_STORED in result.stdout and len(world.fake.posts) == posts
      and world.credential() == token, result.stdout + result.stderr)
template_admin = [{"name": "template-admin", "display_name": TEMPLATE_ADMIN, "organization_id": ""}]
world.fake.users["u-status"]["roles"] = template_admin + [{"name": "owner", "display_name": "Owner", "organization_id": ""}]
result = world.seed()
check("a second seed does not keep a stored credential once hcw-status holds Owner, and creates nothing",
      result.returncode == 1 and ALREADY_STORED not in result.stdout and "holds the Owner role" in result.stderr
      and len(world.fake.posts) == posts and world.credential() == token, result.stdout + result.stderr)
world.fake.users["u-status"]["roles"] = []
result = world.seed()
check("nor once hcw-status is no longer a Template Admin",
      result.returncode == 1 and ALREADY_STORED not in result.stdout and NOT_TEMPLATE_ADMIN in result.stderr
      and len(world.fake.posts) == posts and world.credential() == token, result.stdout + result.stderr)
result = world.helper("run")
check("and a run refuses the credential of an hcw-status that is not a Template Admin, creating nothing",
      result.returncode == 1 and NOT_TEMPLATE_ADMIN in result.stderr and len(world.fake.posts) == posts,
      result.stdout + result.stderr)
world.fake.users["u-status"]["roles"] = template_admin
result = world.seed("--force")
replacement = world.credential()
check("seed --force replaces it, taking the next name when the first is in use (409)",
      result.returncode == 0 and replacement != token and world.fake.posts[-1]["body"]["token_name"]
      == f"hcw-status-rotation-{today()}-2", result.stdout + result.stderr)
check("and deletes the one it replaced",
      world.fake.key_of(token) is None and "The previous one is deleted." in result.stdout, result.stdout)
os.chmod(world.config["credential_file"], 0o644)
result = world.helper("run")
check("a credential file others can read is refused, and not read",
      result.returncode == 1 and "refusing" in result.stderr, result.stderr)
os.chmod(world.config["credential_file"], 0o600)

# --- run: the first day, with the hand-made token the site holds today --------------

hand_made = world.status_key("frosty_hopper4", created_days_ago=10, expires_in_days=355)
world.fake.posts.clear()
before = len(world.cli_calls())
result = world.helper("run")
check("a run with a ten-day-old token renews nothing and succeeds",
      result.returncode == 0 and not world.fake.posts and "made by hand" in result.stdout, result.stdout + result.stderr)
calls = world.cli_calls()[before:]
check("it reports once, without a status token", len(calls) == 1 and "statusToken" not in calls[0]["payload"],
      json.dumps(calls))
report = calls[0]["payload"]["report"] if calls else {}
check("the report says when it checked, when the rotation credential expires and the checkout's template digest, and nothing it does not know",
      set(report) == {"checkedAt", "rotationTokenExpiresAt", "templateSourceDigest"}, json.dumps(report))
check("the report's times are UTC, to the second",
      all(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value)
          for key, value in report.items() if key != "templateSourceDigest"), json.dumps(report))
check("and no published digest before anything was published, so the site cannot mistake the checkout's for one",
      "templateDigest" not in report and re.fullmatch(SHA256_HEX, report.get("templateSourceDigest", "")),
      json.dumps(report))
argv = world.lines(world.run_log)[-1] if world.run_log.exists() else []
check("the CLI runs as the agent's user and group, with its environment file and checkout",
      f"--uid={config['agent_user']}" in argv and f"--gid={config['agent_group']}" in argv
      and f"--property=EnvironmentFile={world.env_file}" in argv
      and f"--property=WorkingDirectory={world.app}" in argv, json.dumps(argv))
check("through systemd-run --pipe --wait, with the CLI after --",
      argv[:3] == ["--pipe", "--wait", "--quiet"] and argv[-3:] == ["--", sys.executable, "bin/report-coder-automation.js"],
      json.dumps(argv))
check("the CLI saw the agent's environment and NODE_ENV=production, and ran in the agent's checkout",
      calls and calls[0]["mode"] == "stored" and calls[0]["node_env"] == "production" and calls[0]["cwd"] == str(world.app),
      json.dumps(calls))

# --- run: renewal when the token is older than 60 days ---------------------------------

world.fake.keys[hand_made.split("-")[0]]["created_at"] = now() - 61 * DAY
before = len(world.cli_calls())
result = world.helper("run")
new = world.fake.by_name(f"hcw-status-site-{today()}")
check("a token older than 60 days is renewed", result.returncode == 0 and len(new) == 1, result.stdout + result.stderr)
post = world.fake.posts[-1] if world.fake.posts else {}
check("the new token has exactly the three read scopes, user:read and 90 days in nanoseconds",
      post.get("user") == "hcw-status" and post.get("by") == "hcw-status"
      and post.get("body") == {"lifetime": 90 * 86400 * NS, "scopes": STATUS_SCOPES, "token_name": f"hcw-status-site-{today()}"},
      json.dumps(post))
check("it is checked by counting running workspaces with it",
      (f"hcw-status-site-{today()}", ["status:running"]) in world.fake.workspace_tokens, str(world.fake.workspace_tokens))
calls = world.cli_calls()[before:]
delivered = calls[0]["payload"] if calls else {}
new_token = next((t for t in world.fake.tokens if new and t.startswith(new[0]["id"] + "-")), None)
check("the site's CLI is handed the new token with a report", delivered.get("statusToken") == new_token
      and delivered.get("report", {}).get("statusTokenExpiresAt", "").startswith((now() + 90 * DAY).strftime("%Y-%m-%d")),
      json.dumps({k: v for k, v in delivered.items() if k != "statusToken"}))
check("and then the day's report, without a token, saying when it rotated",
      len(calls) == 2 and "statusToken" not in calls[1]["payload"]
      and calls[1]["payload"]["report"].get("statusTokenRotatedAt", "").startswith(today()), json.dumps(len(calls)))
state = world.state()
check("the new token is recorded as live, and the hand-made one as the one before it",
      new and state.get("statusTokenId") == new[0]["id"] and state.get("previousStatusTokenId") == hand_made.split("-")[0],
      json.dumps(state))
check("the hand-made token is kept, because the site may read with it for 24 hours yet",
      world.fake.key_of(hand_made) is not None)
result = world.helper("run")
check("the next run renews nothing", result.returncode == 0 and len(world.fake.by_name(f"hcw-status-site-{today()}-2")) == 0
      and f"status token hcw-status-site-{today()}" in result.stdout, result.stdout + result.stderr)

# --- run: the clean-up ----------------------------------------------------------------

older = world.status_key("hcw-status-site-2026-05-01", created_days_ago=80, expires_in_days=10)
oldest = world.status_key("eager_lovelace7", created_days_ago=100, expires_in_days=200)
young = world.status_key("hcw-status-site-young", created_days_ago=0.04, expires_in_days=90)
other = world.status_key("someone-elses-kind", created_days_ago=200, expires_in_days=100, scopes=[SCOPE_WORKSPACE_READ, SCOPE_USER_READ])
result = world.helper("run")
check("older status tokens past 48 hours are deleted", result.returncode == 0
      and world.fake.key_of(older) is None and world.fake.key_of(oldest) is None, result.stdout + result.stderr)
check("the live token, the one before it and one younger than 48 hours are kept",
      world.fake.key_of(new_token) is not None and world.fake.key_of(hand_made) is not None and world.fake.key_of(young) is not None)
check("a token with other scopes, and the rotation credential, are never touched",
      world.fake.key_of(other) is not None and world.fake.key_of(world.credential()) is not None)
world.fake.keys.pop(young.split("-")[0])

# --- run: the rotation credential renews itself under 60 days ------------------------------

credential = world.credential()
world.fake.key_of(credential)["expires_at"] = now() + 59 * DAY
result = world.helper("run")
renewed = world.credential()
check("a rotation credential with under 60 days left is replaced, and the old one deleted",
      result.returncode == 0 and renewed != credential and world.fake.key_of(credential) is None
      and world.fake.key_of(renewed)["scopes"] == [SCOPE_ALL], result.stdout + result.stderr)
check("the new one is hcw-status's own, unscoped, for 365 days",
      world.fake.posts[-1]["by"] == "hcw-status" and world.fake.posts[-1]["body"]["lifetime"] == 365 * 86400 * NS
      and "scopes" not in world.fake.posts[-1]["body"], json.dumps(world.fake.posts[-1]))
check("and its expiry is what the state and the report now say",
      world.state()["rotationTokenExpiresAt"].startswith((now() + 365 * DAY).strftime("%Y-%m-%d"))
      and world.cli_calls()[-1]["payload"]["report"]["rotationTokenExpiresAt"] == world.state()["rotationTokenExpiresAt"])
result = world.helper("run", "--rotate-credential")
check("--rotate-credential renews it on demand", result.returncode == 0 and world.credential() != renewed,
      result.stdout + result.stderr)

# --- run: a site that does not store the token, and one that fails --------------------------

live = world.state()["statusTokenId"]
world.cli_mode("not-stored")
result = world.helper("run", "--rotate-now")
check("when the site answers stored false, the run fails and the new token is deleted",
      result.returncode == 1 and world.fake.deleted[-1] == f"hcw-status-site-{today()}-2"
      and world.state()["statusTokenId"] == live, result.stdout + result.stderr)
report = world.cli_calls()[-1]["payload"]["report"]
check("the report carries a content-free lastError, under 300 characters",
      "did not store" in report.get("lastError", "") and len(report["lastError"]) <= 300, json.dumps(report))
world.cli_mode("fail")
result = world.helper("run", "--rotate-now")
check("when the CLI fails, the run fails and the new token is kept in case the site stored it",
      result.returncode == 1 and world.fake.by_name(f"hcw-status-site-{today()}-2")
      and "was kept in case the site stored it" in result.stderr and world.state()["statusTokenId"] == live,
      result.stderr)
check("the CLI's own error reaches the journal, with the token scrubbed out",
      "site CLI: report-coder-automation: the site refused [token]" in result.stderr, result.stderr)
check("a report the site never got fails the run too", "the report did not reach the site" in result.stderr, result.stderr)
world.cli_mode("stored")
check("the state keeps the last error for a person to read", "the site's CLI exited with 1" in world.state().get("lastError", ""))
result = world.helper("run")
check("a run that succeeds clears it", result.returncode == 0 and "lastError" not in world.state(), result.stderr)

# --- run: failures that stop it early -------------------------------------------------------

world.fake.keys.pop(world.credential().split("-")[0])
before = len(world.cli_calls())
result = world.helper("run")
calls = world.cli_calls()[before:]
check("a rotation credential Coder refuses fails the run and says to seed again",
      result.returncode == 1 and "hcw-coder-automation-seed --force" in result.stderr, result.stderr)
check("and the site still gets a report saying so",
      len(calls) == 1 and "seed --force" in calls[0]["payload"]["report"].get("lastError", ""), json.dumps(calls))
os.unlink(world.config["credential_file"])
result = world.helper("run")
check("no rotation credential at all fails a run started by hand", result.returncode == 1
      and "no rotation credential" in result.stderr, result.stderr)
world.seed()
world.write_config(coder_url=f"http://127.0.0.1:{free_port()}")
result = world.helper("run")
check("Coder not answering fails the run, and the report still goes",
      result.returncode == 1 and "did not answer" in result.stderr
      and "did not answer" in world.cli_calls()[-1]["payload"]["report"].get("lastError", ""), result.stderr)
world.write_config(coder_url=f"http://127.0.0.1:{world.server.server_address[1]}")
world.env_file.rename(world.root / "labs-agent.env.away")
result = world.helper("run")
check("a lab agent with no environment file fails the run", result.returncode == 1
      and "the lab agent is not configured" in result.stderr, result.stderr)
(world.root / "labs-agent.env.away").rename(world.env_file)

# --- push-template --------------------------------------------------------------------------

os.unlink(world.config["credential_file"])
result = world.helper("push-template")
check("with no rotation credential, push-template skips (exit 3) and says how to seed",
      result.returncode == 3 and "hcw-coder-automation-seed" in result.stdout and not world.push_log.exists(),
      result.stdout + result.stderr)
world.seed()
credential = world.credential()
result = world.helper("push-template")
pushes = world.lines(world.push_log)
check("with one, it publishes through hcw-coder-template-push, by name, the credential on its stdin",
      result.returncode == 0 and len(pushes) == 1 and pushes[0]["token"] == credential
      and pushes[0]["argv"] == ["hcw-lab"],
      result.stdout + result.stderr)
check("from the configured checkout", pushes and pushes[0]["src"] == str(world.src))
check("and says it published, which is the role's changed_when",
      "hcw-coder-automation: published hcw-lab with the rotation credential; active version brave_turing1" in result.stdout,
      result.stdout)
state = world.state()
check("the state records when, which version and what was published",
      state.get("templateVersion") == "brave_turing1" and state.get("templatePushedAt", "").startswith(today())
      and re.fullmatch(SHA256_HEX, state.get("templateDigest", "")), json.dumps(state))
result = world.helper("push-template")
check("an unchanged template is not published again", result.returncode == 0 and "nothing was published" in result.stdout
      and len(world.lines(world.push_log)) == 1, result.stdout)
(world.template / "template.test.mjs").write_text("// changed, still not published\n", encoding="utf-8")
result = world.helper("push-template")
check("a change to a file the push does not copy publishes nothing", len(world.lines(world.push_log)) == 1, result.stdout)
(world.template / MAIN_TF).write_text('resource "x" "z" {}\n', encoding="utf-8")
result = world.helper("push-template")
check("a changed main.tf publishes again", result.returncode == 0 and len(world.lines(world.push_log)) == 2, result.stdout)
world.write_config(template_default_ttl="2h")
result = world.helper("push-template")
check("a changed default autostop publishes again", len(world.lines(world.push_log)) == 3, result.stdout)
result = world.helper("push-template", "--force")
check("--force publishes an unchanged template", len(world.lines(world.push_log)) == 4, result.stdout)
world.push_mode.write_text("fail", encoding="utf-8")
(world.template / README_MD).write_text("# hcw-lab, changed\n", encoding="utf-8")
result = world.helper("push-template")
check("a failed publish fails (exit 1), with the push helper's message passed on",
      result.returncode == 1 and "publishing hcw-lab failed" in result.stderr, result.stderr)
world.push_mode.write_text("", encoding="utf-8")
result = world.helper("push-template")
check("and the next run publishes what the failed one did not", result.returncode == 0
      and len(world.lines(world.push_log)) == 6, result.stdout)
result = world.helper("run")
report = world.cli_calls()[-1]["payload"]["report"]
check("the daily report carries the template's publish time and version",
      result.returncode == 0 and report.get("templateVersion") == "brave_turing6"
      and report.get("templatePushedAt", "").startswith(today()),
      json.dumps(report) + result.stderr)
check("and the published template's digest beside the checkout's, equal straight after a publish (#1009)",
      re.fullmatch(SHA256_HEX, report.get("templateDigest", ""))
      and report.get("templateDigest") == world.state().get("templateDigest")
      and report.get("templateSourceDigest") == report.get("templateDigest"),
      json.dumps(report))
(world.template / MAIN_TF).write_text('resource "x" "never-published" {}\n', encoding="utf-8")
result = world.helper("run")
report = world.cli_calls()[-1]["payload"]["report"]
check("a checkout that moved on without a publish reports a source digest the published one does not match",
      result.returncode == 0 and re.fullmatch(SHA256_HEX, report.get("templateSourceDigest", ""))
      and report.get("templateSourceDigest") != report.get("templateDigest")
      and report.get("templateDigest") == world.state().get("templateDigest"),
      json.dumps(report) + result.stderr)
result = world.helper("push-template")
check("and the next publish brings the two back together",
      result.returncode == 0 and len(world.lines(world.push_log)) == 7, result.stdout + result.stderr)

# Every template in the checkout, not hcw-lab alone (2026-10-12). Before, the
# two guided-lab templates (#1090) needed the owner's token on every change.
templates = world.template.parent
guided = templates / "na-guided-lab"
guided.mkdir()
(guided / MAIN_TF).write_text('resource "x" "guided" {}\n', encoding="utf-8")
(templates / "notes-only").mkdir()
(templates / "notes-only" / README_MD).write_text("# not a template\n", encoding="utf-8")
(templates / "Bad_Name").mkdir()
(templates / "Bad_Name" / MAIN_TF).write_text('resource "x" "y" {}\n', encoding="utf-8")
before = len(world.lines(world.push_log))
result = world.helper("push-template")
pushes = world.lines(world.push_log)[before:]
check("a second template in the checkout is published too, by its own name, with the same credential",
      result.returncode == 0 and [push["argv"] for push in pushes] == [["na-guided-lab"]]
      and pushes[0]["token"] == world.credential()
      and "published na-guided-lab with the rotation credential" in result.stdout
      and "hcw-lab is unchanged" in result.stdout,
      result.stdout + result.stderr)
check("a directory with no *.tf, or a name the push helper would refuse, is not published",
      not any(push["argv"] in (["notes-only"], ["Bad_Name"]) for push in world.lines(world.push_log)))
state = world.state()
check("each template is recorded on its own, and hcw-lab keeps the fields the daily report reads",
      str(state.get("templates", {}).get("na-guided-lab", {}).get("version", "")).startswith("brave_turing")
      and state["templates"]["hcw-lab"]["digest"] == state.get("templateDigest")
      and state["templates"]["na-guided-lab"]["digest"] != state.get("templateDigest"),
      json.dumps(state))
result = world.helper("push-template")
check("an unchanged second template is not published again",
      result.returncode == 0 and len(world.lines(world.push_log)) == before + 1, result.stdout)
(guided / MAIN_TF).write_text('resource "x" "guided-2" {}\n', encoding="utf-8")
(world.template / MAIN_TF).write_text('resource "x" "lab-2" {}\n', encoding="utf-8")
world.push_mode.write_text("fail:hcw-lab", encoding="utf-8")
result = world.helper("push-template")
pushes = world.lines(world.push_log)[before + 1:]
check("one template failing does not stop the next; the run fails (exit 1) naming the one that failed",
      result.returncode == 1 and [push["argv"] for push in pushes] == [["hcw-lab"], ["na-guided-lab"]]
      and "published na-guided-lab" in result.stdout
      and "publishing hcw-lab failed" in result.stderr and "hcw-lab not published" in result.stderr,
      result.stdout + result.stderr)
world.push_mode.write_text("", encoding="utf-8")
result = world.helper("push-template")
pushes = world.lines(world.push_log)[before + 3:]
check("and the next run publishes only the one that failed",
      result.returncode == 0 and [push["argv"] for push in pushes] == [["hcw-lab"]], result.stdout + result.stderr)
legacy = world.state()
legacy.pop("templates")
(world.state_dir / STATE_JSON).write_text(json.dumps(legacy), encoding="utf-8")
result = world.helper("push-template")
pushes = world.lines(world.push_log)[before + 4:]
check("a state from before the per-template record still knows hcw-lab was published, and publishes only the new one",
      result.returncode == 0 and [push["argv"] for push in pushes] == [["na-guided-lab"]]
      and "hcw-lab is unchanged" in result.stdout,
      result.stdout + result.stderr)
for leftover in ("notes-only", "Bad_Name"):
    shutil.rmtree(templates / leftover)

# A template whose files cannot be read is that template's failure, not the
# run's: the helper, loaded in this process, with the read made to fail. As
# root, which the container runs as, no file mode can make a read fail, so
# the read itself is replaced (CodeRabbit, #1100). publish_one and the
# template_digest it calls are the publish module's since #1845, so that is
# the name replaced. No bytecode beside the modules: the role ships files/
# as it is.
sys.dont_write_bytecode = True
sys.path.insert(0, str(PACKAGE_DIR.parent))
automation = importlib.import_module(f"{PACKAGE_DIR.name}.publish")


def unreadable(config, directory=None):
    raise PermissionError(13, "Permission denied", directory)


automation.template_digest = unreadable
try:
    automation.publish_one(world.config, argparse.Namespace(force=False), "token", {}, ("na-guided-lab", str(guided)))
    outcome = "no error"
except automation.Failure as failure:
    outcome = f"Failure: {failure}"
except OSError as error:
    outcome = f"OSError escaped: {error}"
check("a template that cannot be read fails as that template (a Failure), so push-template still tries the next",
      outcome.startswith("Failure: ") and "could not be read (PermissionError)" in outcome, outcome)

world.fake.keys.pop(world.credential().split("-")[0])
result = world.helper("push-template")
check("a rotation credential Coder refuses skips the publish (exit 3) and says to seed again",
      result.returncode == 3 and "seed --force" in result.stdout, result.stdout)

REPORT_FIELDS = {"checkedAt", "statusTokenExpiresAt", "statusTokenRotatedAt", "rotationTokenExpiresAt",
                 "templatePushedAt", "templateVersion", "templateDigest", "templateSourceDigest", "lastError"}
DIGESTS = {"templateDigest", "templateSourceDigest"}
TIMES = REPORT_FIELDS - {"templateVersion", "lastError"} - DIGESTS
payloads = [call["payload"] for call in world.cli_calls()]
bad = [p for p in payloads
       if set(p) - {"statusToken", "report"} or set(p.get("report", {})) - REPORT_FIELDS
       or any(not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", p["report"][field])
              for field in TIMES & set(p.get("report", {})))
       or any(not re.fullmatch(SHA256_HEX, p["report"][field]) for field in DIGESTS & set(p.get("report", {})))]
check(f"all {len(payloads)} payloads hold only statusToken and report, the nine report fields, times with seconds and a zone, and hex digests",
      payloads and not bad, json.dumps(bad[:1]))
leaks = world.leaks()
check("no token is in anything the helper printed, its state, or any report", not leaks, ", ".join(leaks))
check("the state file is 0600", stat.S_IMODE(os.stat(world.state_dir / STATE_JSON).st_mode) == 0o600)
world.close()

# --- A first run whose renewal never reached the site -------------------------------------

world = World()
world.seed()
hand_made = world.status_key("frosty_hopper4", created_days_ago=61, expires_in_days=300)
undelivered = world.status_key(f"hcw-status-site-{today()}", created_days_ago=0.1, expires_in_days=90)
result = world.helper("run")
check("one of this helper's tokens that never went live is not mistaken for the site's",
      result.returncode == 0 and world.state().get("previousStatusTokenId") == hand_made.split("-")[0]
      and world.fake.by_name(f"hcw-status-site-{today()}-2"), result.stdout + result.stderr)
check("and nothing is deleted while it is younger than 48 hours", world.fake.key_of(undelivered) is not None)
leaks = world.leaks()
check("no token leaks here either", not leaks, ", ".join(leaks))
world.close()

# --- A new rotation credential that fails and that Coder will not delete -------------------

world = World()
world.seed()
first = world.credential()
world.status_key("frosty_hopper4", created_days_ago=1, expires_in_days=300)
second_name = f"hcw-status-rotation-{today()}-2"
world.fake.fail_reads.add(second_name)
world.fake.fail_deletes.add(second_name)
result = world.helper("run", "--rotate-credential")
orphan = world.fake.by_name(second_name)
check("a new rotation credential that fails its check, and that Coder will not delete, fails the run and says so",
      result.returncode == 1 and f"deleting the new rotation credential {second_name} failed too" in result.stderr
      and world.credential() == first, result.stdout + result.stderr)
check("its id is kept in the state for the next run",
      len(orphan) == 1 and world.state().get("discardedRotationIds") == [orphan[0]["id"]], json.dumps(world.state()))
world.fake.fail_reads.clear()
world.fake.fail_deletes.clear()
result = world.helper("run")
check("the next run deletes it and clears the record",
      result.returncode == 0 and not world.fake.by_name(second_name) and "discardedRotationIds" not in world.state()
      and "never stored" in result.stdout and world.credential() == first, result.stdout + result.stderr)
world.fake.fail_reads.add(second_name)
world.fake.fail_deletes.add(second_name)
result = world.seed("--force")
orphan = world.fake.by_name(second_name)
check("seed --force records a new credential that fails and cannot be deleted, and keeps the stored one",
      result.returncode == 1 and "failed too" in result.stderr and world.credential() == first and len(orphan) == 1
      and world.state().get("discardedRotationIds") == [orphan[0]["id"]], result.stdout + result.stderr)
world.fake.fail_reads.clear()
world.fake.fail_deletes.clear()
result = world.helper("run")
check("and the next run deletes that one too",
      result.returncode == 0 and not world.fake.by_name(second_name) and "discardedRotationIds" not in world.state(),
      result.stdout + result.stderr)
leaks = world.leaks()
check("no token leaks from a discarded credential", not leaks, ", ".join(leaks))
world.close()

# --- A replaced rotation credential that Coder will not delete ----------------------------

world = World()
world.seed()
first = world.credential()
first_key = dict(world.fake.key_of(first))
world.status_key("frosty_hopper4", created_days_ago=1, expires_in_days=300)
world.fake.fail_deletes.add(first_key["token_name"])
result = world.helper("run", "--rotate-credential")
second = world.credential()
check("a renewal whose predecessor Coder will not delete keeps the new credential and fails, saying the next run deletes it",
      result.returncode == 1 and second != first and "the next run deletes it" in result.stderr
      and world.fake.key_of(first) is not None, result.stdout + result.stderr)
check("the predecessor's id is on the list in the state",
      world.state().get("discardedRotationIds") == [first_key["id"]], json.dumps(world.state()))
world.fake.fail_deletes.clear()
result = world.helper("run")
check("the next run deletes the predecessor and clears the list",
      result.returncode == 0 and world.fake.key_of(first) is None and "discardedRotationIds" not in world.state(),
      result.stdout + result.stderr)
second_key = dict(world.fake.key_of(second))
world.fake.fail_deletes.add(second_key["token_name"])
result = world.seed("--force")
third = world.credential()
check("seed --force whose predecessor Coder will not delete stores the new one and lists the old",
      result.returncode == 0 and third != second and "the next run deletes it" in result.stdout
      and world.state().get("discardedRotationIds") == [second_key["id"]], result.stdout + result.stderr)
world.fake.fail_deletes.clear()
result = world.helper("run")
check("and the next run deletes it",
      result.returncode == 0 and world.fake.key_of(second) is None and "discardedRotationIds" not in world.state(),
      result.stdout + result.stderr)
planted = world.state()
planted["discardedRotationIds"] = [world.fake.key_of(third)["id"]]
(world.state_dir / STATE_JSON).write_text(json.dumps(planted), encoding="utf-8")
result = world.helper("run")
check("the credential in use is never deleted, even with its id on the list",
      result.returncode == 0 and world.fake.key_of(third) is not None and world.credential() == third
      and "discardedRotationIds" not in world.state(), result.stdout + result.stderr)
leaks = world.leaks()
check("no token leaks from a replaced credential", not leaks, ", ".join(leaks))
world.close()

# --- revoke: turning it off -------------------------------------------------------------

world = World()
result = world.helper("revoke")
check("revoke with no credential changes nothing", result.returncode == 0 and "nothing was changed" in result.stdout,
      result.stdout + result.stderr)
world.seed()
credential = world.credential()
credential_name = world.fake.key_of(credential)["token_name"]
leftover = world.fake.issue("u-status", f"hcw-status-rotation-{today()}-9", [SCOPE_ALL])
planted = world.state()
planted["discardedRotationIds"] = [leftover.split("-")[0]]
(world.state_dir / STATE_JSON).write_text(json.dumps(planted), encoding="utf-8")
world.fake.fail_deletes.add(f"hcw-status-rotation-{today()}-9")
result = world.helper("revoke")
check("revoke stops, keeping the credential, when a listed one cannot be deleted",
      result.returncode == 1 and "kept so that this can run again" in result.stderr and world.credential() == credential
      and world.fake.key_of(credential) is not None and world.fake.key_of(leftover) is not None,
      result.stdout + result.stderr)
world.fake.fail_deletes = {credential_name}
result = world.helper("revoke")
check("revoke deletes the listed ones first, and keeps the credential and its file when Coder will not delete it",
      result.returncode == 1 and "still stored and still valid" in result.stderr and world.credential() == credential
      and world.fake.key_of(credential) is not None and world.fake.key_of(leftover) is None,
      result.stdout + result.stderr)
world.fake.fail_deletes = set()
world.fake.unauthorized_deletes = {credential_name}
result = world.helper("revoke")
check("revoke keeps the credential when its deletion answers 401 just after Coder accepted it",
      result.returncode == 1 and "HTTP 401" in result.stderr and world.credential() == credential
      and world.fake.key_of(credential) is not None, result.stdout + result.stderr)
world.fake.unauthorized_deletes = set()
result = world.helper("revoke")
check("revoke deletes the credential in Coder, then its file, and clears its expiry from the state",
      result.returncode == 0 and "revoked the rotation credential" in result.stdout and world.credential() is None
      and world.fake.key_of(credential) is None and "rotationTokenExpiresAt" not in world.state()
      and "discardedRotationIds" not in world.state(), result.stdout + result.stderr)
world.seed()
dead = world.credential()
world.fake.keys.pop(dead.split("-")[0])
planted = world.state()
planted["discardedRotationIds"] = ["gone000000"]
(world.state_dir / STATE_JSON).write_text(json.dumps(planted), encoding="utf-8")
result = world.helper("revoke")
check("revoke of a credential Coder no longer accepts removes the file, keeps the list and says so",
      result.returncode == 0 and "no longer accepts the rotation credential (HTTP 401)" in result.stdout
      and "they stay listed" in result.stderr and world.credential() is None
      and world.state().get("discardedRotationIds") == ["gone000000"], result.stdout + result.stderr)
world.seed()
result = world.helper("run")
check("and the first run after the next seed works through the kept list",
      result.returncode == 0 and "discardedRotationIds" not in world.state(), result.stdout + result.stderr)
leaks = world.leaks()
check("no token leaks from a revoke", not leaks, ", ".join(leaks))
world.close()

# --- The launcher: the modules are checked before root imports them (#1845) -------------
#
# files/hcw-lab-python-launch.py, which hcw-coder-automation and
# hcw-portainer-check both load, refuses a package root could be tricked
# into importing: a directory or file someone other than root can write, a
# symbolic link, or anything beside the package in its directory. Held here
# against a made-up package staged in a scratch directory, with this user
# standing in for root (the `owner` the tests alone pass).

launcher_text = LAUNCHER_SOURCE.read_text(encoding="utf-8")
launcher_names = {node.attr if isinstance(node, ast.Attribute) else node.id
                  for node in ast.walk(ast.parse(launcher_text)) if isinstance(node, (ast.Attribute, ast.Name))}
check("the launcher takes the module directory from its caller only: no environment, no file location, no argv",
      not launcher_names & {"environ", "getenv", "__file__", "argv", "getcwd"}
      and launcher_text.count("sys.path.insert(0, lib_dir)") == 1
      and launcher_text.index("trust_problem(lib_dir, package, owner, top)") < launcher_text.index("sys.path.insert(0, lib_dir)"))
launcher = runpy.run_path(str(LAUNCHER_SOURCE))
uid = os.getuid()
scratch = pathlib.Path(tempfile.mkdtemp(prefix="hcw-lab-python-launch."))
probe_source = scratch / "source" / "hcw_launch_probe"
probe_source.mkdir(parents=True)
(probe_source / "__init__.py").write_text("", encoding="utf-8")
(probe_source / "cli.py").write_text("def main():\n    return 7\n", encoding="utf-8")
PROBE_LIB = "/usr/local/lib/hcw-lab/probe"


def fresh_tree(name, package_source=probe_source):
    """A scratch top with the probe package staged under it as the role installs one: (top, lib_dir, package)."""
    top = scratch / name
    top.mkdir()
    package = stage_tree(top, PROBE_LIB, package_source)
    return str(top), str(top) + PROBE_LIB, package


def trust(top, lib, owner=uid, package="hcw_launch_probe"):
    """The launcher's verdict on a staged tree: None when trusted, or the reason."""
    return launcher["trust_problem"](lib, package, owner, top)


top, lib, package = fresh_tree("good")
verdict = trust(top, lib)
check("the launcher trusts a tree that is its owner's alone to write, with only the package in its directory",
      verdict is None, str(verdict))
check("and runs the package's cli.main() from it, returning its exit code",
      launcher["launch"](lib, "hcw_launch_probe", "hcw-probe", uid, top) == 7
      and sys.modules["hcw_launch_probe.cli"].__file__.startswith(lib))

top, lib, package = fresh_tree("group-writable-module")
(package / "cli.py").chmod(0o664)
verdict = trust(top, lib)
check("a module its group can write is refused, by name",
      verdict == f"{package / 'cli.py'} is writable by its group or by others", str(verdict))

top, lib, package = fresh_tree("group-writable-subfolder")
(package / "__pycache__").mkdir()
(package / "__pycache__").chmod(0o770)
verdict = trust(top, lib)
check("a folder inside the package its group can write, such as __pycache__, is refused, by name",
      verdict == f"{package / '__pycache__'} is writable by its group or by others", str(verdict))

top, lib, package = fresh_tree("no-init")
(package / "__init__.py").unlink()
verdict = trust(top, lib)
check("a package without __init__.py, which Python would treat as a namespace package, is refused",
      verdict == f"{package} has no __init__.py", str(verdict))

top, lib, package = fresh_tree("world-writable-parent")
pathlib.Path(top + "/usr/local/lib").chmod(0o777)
verdict = trust(top, lib)
check("a directory anyone can write on the way down to the package is refused, by name",
      verdict == f"{top}/usr/local/lib is writable by its group or by others", str(verdict))

top, lib, package = fresh_tree("linked-module")
(package / "cli.py").unlink()
(package / "cli.py").symlink_to(probe_source / "cli.py")
verdict = trust(top, lib)
check("a module that is a symbolic link is refused, even to a good file",
      verdict == f"{package / 'cli.py'} is not a regular file", str(verdict))

top, lib, package = fresh_tree("linked-directory")
good_top, good_lib, _ = fresh_tree("linked-directory-target")
shutil.rmtree(lib)
pathlib.Path(lib).symlink_to(good_lib)
verdict = trust(top, lib)
check("a module directory that is a symbolic link is refused, even to a good tree",
      verdict == f"{lib} is not a directory", str(verdict))

top, lib, package = fresh_tree("shadow")
(pathlib.Path(lib) / "json.py").write_text("raise SystemExit('shadowed')\n", encoding="utf-8")
pathlib.Path(lib, "json.py").chmod(0o640)
verdict = trust(top, lib)
check("anything beside the package, which would come before the standard library on the path, is refused",
      verdict == f"{lib} must hold hcw_launch_probe and nothing else", str(verdict))

top, lib, package = fresh_tree("missing-package")
verdict = trust(top, lib, package="hcw_launch_absent")
check("a directory without the package is refused", verdict == f"{lib} must hold hcw_launch_absent and nothing else",
      str(verdict))
verdict = launcher["trust_problem"](str(scratch / "elsewhere"), "hcw_launch_probe", uid, top)
check("a module directory outside the top it is checked from is refused", verdict is not None and "is not under" in verdict,
      str(verdict))

top, lib, package = fresh_tree("not-root")
if uid != 0:
    verdict = trust(top, lib, owner=0)
    check("with root as the owner, as on the host, a tree another user owns is refused",
          verdict == f"{top} is not owned by root", str(verdict))
else:
    skip("a tree another user owns is refused", "this test runs as root, so every file it makes is root's")
ancestors = [str(path) for path in reversed(pathlib.Path(lib).parents)] + [lib]
loose = next((path for path in ancestors if os.lstat(path).st_mode & 0o022
              or os.lstat(path).st_uid not in (0, uid) or stat.S_ISLNK(os.lstat(path).st_mode)), None)
if loose is not None:
    verdict = launcher["trust_problem"](lib, "hcw_launch_probe", uid)
    check("checked from / as on the host, the first loose directory above the scratch tree is refused",
          verdict is not None and verdict.startswith(loose), f"{verdict} (expected {loose})")
else:
    skip("checked from /, a loose directory above the tree is refused", "every directory above the scratch tree is tight")

refused_source = scratch / "source-refused" / "hcw_launch_refused"
refused_source.mkdir(parents=True)
(refused_source / "__init__.py").write_text("", encoding="utf-8")
(refused_source / "cli.py").write_text("def main():\n    return 7\n", encoding="utf-8")
refused_top = scratch / "refused"
refused_top.mkdir()
refused_package = stage_tree(refused_top, PROBE_LIB, refused_source)
(refused_package / "cli.py").chmod(0o666)
captured = io.StringIO()
with contextlib.redirect_stderr(captured):
    code = launcher["launch"](str(refused_top) + PROBE_LIB, "hcw_launch_refused", "hcw-probe", uid, str(refused_top))
check("a refused tree is never imported: exit 1 and one line naming the path",
      code == 1 and "hcw_launch_refused" not in sys.modules and "hcw_launch_refused.cli" not in sys.modules
      and captured.getvalue() == f"hcw-probe: refusing to run: {refused_package / 'cli.py'} is writable by its group or "
      "by others; re-run bootstrap.sh to install the modules again\n", captured.getvalue())
shutil.rmtree(scratch, ignore_errors=True)

print(f"hcw-coder-automation.test.py: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
