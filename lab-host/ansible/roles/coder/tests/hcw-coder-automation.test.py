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

No root, no Docker and no network. CI runs it in the `ansible-lint (lab-host)`
job with the job's Python, which has Jinja2 and PyYAML from ansible-core; on a
workstation, bash, with Docker, from the repository root:
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo:ro" -w /repo python:3.14-slim bash -c "pip install -q jinja2 pyyaml && python3 lab-host/ansible/roles/coder/tests/hcw-coder-automation.test.py"
"""

import datetime
import http.server
import json
import os
import pathlib
import random
import re
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
HELPER = ROLE / "files" / "hcw-coder-automation.py"
UTC = datetime.timezone.utc
DAY = datetime.timedelta(days=1)
NS = 1_000_000_000
STATUS_SCOPES = ["template:read", "workspace:read", "api_key:read", "user:read"]

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


defaults = resolved(ROLE / "defaults" / "main.yml")
group_vars = yaml.safe_load((ANSIBLE / "group_vars" / "all.yml").read_text(encoding="utf-8"))
agent = resolved(ANSIBLE / "roles" / "labs_agent" / "defaults" / "main.yml",
                 extra={name: group_vars[name] for name in ("labs_agent_user", "labs_agent_home")})

config = json.loads(render("hcw-coder-automation.json.j2", defaults))
service = render("hcw-coder-automation.service.j2", defaults)
timer = render("hcw-coder-automation.timer.j2", defaults)
seed_wrapper = render("hcw-coder-automation-seed.j2", defaults)
push_template = (ROLE / "templates" / "hcw-coder-template-push.j2").read_text(encoding="utf-8")
compose = (LAB_HOST / "coder" / "docker-compose.yml").read_text(encoding="utf-8")
bootstrap = (LAB_HOST / "bootstrap.sh").read_text(encoding="utf-8")
agent_unit = (ANSIBLE / "roles" / "labs_agent" / "templates" / "hcw-labs-agent.service.j2").read_text(encoding="utf-8")
tasks = yaml.safe_load((ROLE / "tasks" / "main.yml").read_text(encoding="utf-8"))
helper_text = HELPER.read_text(encoding="utf-8")


def task_using(module, **match):
    """The coder role's first task calling a module with the given arguments, and its body."""
    for task in tasks:
        body = task.get(module)
        if isinstance(body, dict) and all(body.get(k) == v for k, v in match.items()):
            return task, body
    return None, None


check("the helper is Python 3, run isolated", helper_text.startswith("#!/usr/bin/python3 -I\n"))
try:
    # In this process, so a read-only checkout gets no __pycache__ written into it.
    compile(helper_text, str(HELPER), "exec")
    compile_error = ""
except SyntaxError as error:
    compile_error = str(error)
check("the helper compiles", not compile_error, compile_error)
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
seed_check = subprocess.run(["sh", "-n"], input=seed_wrapper, capture_output=True, text=True)
check("the seed wrapper parses and hands its arguments to the helper's seed command",
      seed_check.returncode == 0
      and seed_wrapper.rstrip().endswith(
          f'exec /usr/local/libexec/hcw-coder-automation --config {defaults["coder_automation_config_file"]} seed "$@"'),
      seed_check.stderr)
_, body = task_using("ansible.builtin.copy", src="hcw-coder-automation.py")
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
    return "".join(random.choice(string.ascii_letters + string.digits) for _ in range(length))


KNOWN_SCOPES = {"coder:all", "template:read", "workspace:read", "api_key:read", "user:read"}


class FakeCoder:
    def __init__(self):
        self.lock = threading.Lock()
        self.users = {
            "u-owner": {"id": "u-owner", "username": "owner-gh", "status": "active",
                        "roles": [{"name": "owner", "display_name": "Owner", "organization_id": ""}]},
            "u-status": {"id": "u-status", "username": "hcw-status", "status": "dormant",
                         "roles": [{"name": "template-admin", "display_name": "Template Admin", "organization_id": ""}]},
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
            "scope": "all" if "coder:all" in key["scopes"] else "", "scopes": key["scopes"],
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
                return self.send(401, {"message": "You are signed out or your session has expired."})
            caller = fake.users[key["user_id"]]
            unscoped = "coder:all" in key["scopes"]
            owner = "owner" in {role["name"] for role in caller["roles"]}
            if parts == ["api", "v2", "workspaces"] and method == "GET":
                if not (unscoped or "workspace:read" in key["scopes"]):
                    return self.send(403, {"message": "Forbidden."})
                fake.workspace_tokens.append((key["token_name"], urllib.parse.parse_qs(url.query).get("q")))
                return self.send(200, {"workspaces": [], "count": 1})
            if parts[:3] != ["api", "v2", "users"] or len(parts) < 4:
                return self.send(404, {"message": "Route not found."})
            target = fake.resolve(parts[3], caller)
            if target is None:
                return self.send(404, {"message": "Resource not found or you do not have access to this resource"})
            mine = target["id"] == caller["id"]
            rest = parts[4:]
            if rest == [] and method == "GET":
                return self.send(200, target) if unscoped and (mine or owner) else self.send(403, {})
            if rest == ["keys", "tokens"]:
                if not (unscoped and (mine or owner)):
                    return self.send(403, {"message": "Forbidden."})
                if method == "GET":
                    listed = [fake.key_json(k) for k in fake.keys.values()
                              if k["user_id"] == target["id"] and k["expires_at"] > now()]
                    return self.send(200, listed)
                if method == "POST":
                    fake.posts.append({"user": target["username"], "by": caller["username"], "body": body})
                    lifetime = body.get("lifetime")
                    target_owner = "owner" in {role["name"] for role in target["roles"]}
                    longest = (168 if target_owner else 876600) * 3600 * NS
                    if type(lifetime) is not int or lifetime <= 0 or lifetime > longest:
                        return self.send(400, {"message": "Failed to validate create API key request."})
                    scopes = body.get("scopes") or ["coder:all"]
                    if not set(scopes) <= KNOWN_SCOPES:
                        return self.send(400, {"message": "invalid scope"})
                    name = body.get("token_name")
                    if any(k["user_id"] == target["id"] and k["token_name"] == name for k in fake.keys.values()):
                        return self.send(409, {"message": f"A token with name {name!r} already exists."})
                    moment = now()
                    token = fake.issue(target["id"], name, scopes, moment, moment + datetime.timedelta(seconds=lifetime / NS))
                    return self.send(201, {"key": token})
            if len(rest) == 2 and rest[0] == "keys":
                found = fake.keys.get(rest[1])
                if found is None or found["user_id"] != target["id"]:
                    return self.send(404, {"message": "Resource not found"})
                if method == "GET":
                    if found["token_name"] in fake.fail_reads:
                        return self.send(500, {"message": "Internal error."})
                    if (mine and (unscoped or {"api_key:read", "user:read"} <= set(key["scopes"]))) or (owner and unscoped):
                        return self.send(200, fake.key_json(found))
                    return self.send(404, {"message": "Resource not found"})
                if method == "DELETE":
                    if not (unscoped and (mine or owner)):
                        return self.send(403, {"message": "Forbidden."})
                    if found["token_name"] in fake.fail_deletes:
                        return self.send(500, {"message": "Internal error."})
                    if found["token_name"] in fake.unauthorized_deletes:
                        return self.send(401, {"message": "You are signed out or your session has expired."})
                    fake.deleted.append(found["token_name"])
                    del fake.keys[found["id"]]
                    return self.send(204)
            return self.send(404, {"message": "Route not found."})


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
        self.owner_token = self.fake.issue("u-owner", "hcw-setup", ["coder:all"])
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
        (self.template / "main.tf").write_text('resource "x" "y" {}\n', encoding="utf-8")
        (self.template / ".terraform.lock.hcl").write_text("# lock\n", encoding="utf-8")
        (self.template / "README.md").write_text("# hcw-lab\n", encoding="utf-8")
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
        completed = subprocess.run([sys.executable, "-I", str(HELPER), "--config", str(self.config_file), *args],
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
        path = self.state_dir / "state.json"
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
        if (self.state_dir / "state.json").exists():
            places.append((self.state_dir / "state.json").read_text(encoding="utf-8"))
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
completed = subprocess.run([sys.executable, "-I", str(HELPER), "--config", str(world.config_file), "seed"],
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
      result.returncode == 1 and "not a Template Admin" in result.stderr and not world.fake.posts, result.stderr)
status_user = world.fake.users.pop("u-status")
result = world.seed()
check("seed refuses when there is no hcw-status user", result.returncode == 1 and "has no user hcw-status" in result.stderr,
      result.stderr)
world.fake.users["u-status"] = status_user
world.fake.users["u-status"]["roles"] = [{"name": "template-admin", "display_name": "Template Admin", "organization_id": ""}]

# A BOM, blanks and a carriage return, as a Windows pipe can deliver them.
result = world.helper("seed", stdin=b"\xef\xbb\xbf  " + world.owner_token.encode() + b" \r\n")
expiry = (now() + 365 * DAY).strftime("%Y-%m-%d")
check("seed stores a rotation credential and prints one line naming its expiry",
      result.returncode == 0 and result.stdout.count("\n") == 1 and f"expires on {expiry}" in result.stdout,
      result.stdout + result.stderr)
token = world.credential()
key = world.fake.key_of(token or "-")
check("the credential is an unscoped (coder:all) token of hcw-status",
      key is not None and key["user_id"] == "u-status" and key["scopes"] == ["coder:all"], str(key))
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
      result.returncode == 0 and "already stored" in result.stdout and len(world.fake.posts) == posts
      and world.credential() == token, result.stdout + result.stderr)
template_admin = [{"name": "template-admin", "display_name": "Template Admin", "organization_id": ""}]
world.fake.users["u-status"]["roles"] = template_admin + [{"name": "owner", "display_name": "Owner", "organization_id": ""}]
result = world.seed()
check("a second seed does not keep a stored credential once hcw-status holds Owner, and creates nothing",
      result.returncode == 1 and "already stored" not in result.stdout and "holds the Owner role" in result.stderr
      and len(world.fake.posts) == posts and world.credential() == token, result.stdout + result.stderr)
world.fake.users["u-status"]["roles"] = []
result = world.seed()
check("nor once hcw-status is no longer a Template Admin",
      result.returncode == 1 and "already stored" not in result.stdout and "not a Template Admin" in result.stderr
      and len(world.fake.posts) == posts and world.credential() == token, result.stdout + result.stderr)
result = world.helper("run")
check("and a run refuses the credential of an hcw-status that is not a Template Admin, creating nothing",
      result.returncode == 1 and "not a Template Admin" in result.stderr and len(world.fake.posts) == posts,
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
      "templateDigest" not in report and re.fullmatch(r"[0-9a-f]{64}", report.get("templateSourceDigest", "")),
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
other = world.status_key("someone-elses-kind", created_days_ago=200, expires_in_days=100, scopes=["workspace:read", "user:read"])
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
      and world.fake.key_of(renewed)["scopes"] == ["coder:all"], result.stdout + result.stderr)
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
      and re.fullmatch(r"[0-9a-f]{64}", state.get("templateDigest", "")), json.dumps(state))
result = world.helper("push-template")
check("an unchanged template is not published again", result.returncode == 0 and "nothing was published" in result.stdout
      and len(world.lines(world.push_log)) == 1, result.stdout)
(world.template / "template.test.mjs").write_text("// changed, still not published\n", encoding="utf-8")
result = world.helper("push-template")
check("a change to a file the push does not copy publishes nothing", len(world.lines(world.push_log)) == 1, result.stdout)
(world.template / "main.tf").write_text('resource "x" "z" {}\n', encoding="utf-8")
result = world.helper("push-template")
check("a changed main.tf publishes again", result.returncode == 0 and len(world.lines(world.push_log)) == 2, result.stdout)
world.write_config(template_default_ttl="2h")
result = world.helper("push-template")
check("a changed default autostop publishes again", len(world.lines(world.push_log)) == 3, result.stdout)
result = world.helper("push-template", "--force")
check("--force publishes an unchanged template", len(world.lines(world.push_log)) == 4, result.stdout)
world.push_mode.write_text("fail", encoding="utf-8")
(world.template / "README.md").write_text("# hcw-lab, changed\n", encoding="utf-8")
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
      re.fullmatch(r"[0-9a-f]{64}", report.get("templateDigest", ""))
      and report.get("templateDigest") == world.state().get("templateDigest")
      and report.get("templateSourceDigest") == report.get("templateDigest"),
      json.dumps(report))
(world.template / "main.tf").write_text('resource "x" "never-published" {}\n', encoding="utf-8")
result = world.helper("run")
report = world.cli_calls()[-1]["payload"]["report"]
check("a checkout that moved on without a publish reports a source digest the published one does not match",
      result.returncode == 0 and re.fullmatch(r"[0-9a-f]{64}", report.get("templateSourceDigest", ""))
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
(guided / "main.tf").write_text('resource "x" "guided" {}\n', encoding="utf-8")
(templates / "notes-only").mkdir()
(templates / "notes-only" / "README.md").write_text("# not a template\n", encoding="utf-8")
(templates / "Bad_Name").mkdir()
(templates / "Bad_Name" / "main.tf").write_text('resource "x" "y" {}\n', encoding="utf-8")
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
(guided / "main.tf").write_text('resource "x" "guided-2" {}\n', encoding="utf-8")
(world.template / "main.tf").write_text('resource "x" "lab-2" {}\n', encoding="utf-8")
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
(world.state_dir / "state.json").write_text(json.dumps(legacy), encoding="utf-8")
result = world.helper("push-template")
pushes = world.lines(world.push_log)[before + 4:]
check("a state from before the per-template record still knows hcw-lab was published, and publishes only the new one",
      result.returncode == 0 and [push["argv"] for push in pushes] == [["na-guided-lab"]]
      and "hcw-lab is unchanged" in result.stdout,
      result.stdout + result.stderr)
for leftover in ("notes-only", "Bad_Name"):
    shutil.rmtree(templates / leftover)
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
       or any(not re.fullmatch(r"[0-9a-f]{64}", p["report"][field]) for field in DIGESTS & set(p.get("report", {})))]
check(f"all {len(payloads)} payloads hold only statusToken and report, the nine report fields, times with seconds and a zone, and hex digests",
      payloads and not bad, json.dumps(bad[:1]))
leaks = world.leaks()
check("no token is in anything the helper printed, its state, or any report", not leaks, ", ".join(leaks))
check("the state file is 0600", stat.S_IMODE(os.stat(world.state_dir / "state.json").st_mode) == 0o600)
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
(world.state_dir / "state.json").write_text(json.dumps(planted), encoding="utf-8")
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
leftover = world.fake.issue("u-status", f"hcw-status-rotation-{today()}-9", ["coder:all"])
planted = world.state()
planted["discardedRotationIds"] = [leftover.split("-")[0]]
(world.state_dir / "state.json").write_text(json.dumps(planted), encoding="utf-8")
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
(world.state_dir / "state.json").write_text(json.dumps(planted), encoding="utf-8")
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

print(f"hcw-coder-automation.test.py: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
