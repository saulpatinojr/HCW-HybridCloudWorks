#!/usr/bin/env python3
"""Tests ../files/hcw-portainer-check and the files the portainer role renders for it (#1282).

The helper is run as it ships against stand-ins, each in this process or a
scratch directory:

- a fake Portainer on a loopback port, answering the six reads the helper
  makes the way Portainer 2.45 does: /system/status without a token, every
  other path with X-API-Key or 401, a decoy environment with Id 1 beside the
  local one with Id 3, Docker's container list with State and Status, and an
  image_status verdict per container. Every other method answers 405 and is
  recorded, which is how the test holds the helper to GET;
- a fake systemd-run that records its arguments and environment, reads the
  EnvironmentFile and WorkingDirectory it is given and runs the command
  there, so the agent's environment file and checkout are exercised as on
  the host;
- a fake site CLI (vps-agent/bin/report-host-check.js) that records what it
  was handed and answers {"ok": true}, or refuses, as the environment file
  tells it.

Then the role's templates are rendered with its defaults (Jinja2, trim_blocks,
undefined names fail) and held to what the rest of the repository says: the
agent's user, environment file and checkout (the coder role's and the
labs_agent role's), Portainer's port, the credential, the failure notifier,
the timer, and that the role never declares the vault key.

Fixtures hold no real name: RFC 5737 addresses, made-up ids, container and
image names that must appear in no output and no report, and a token made
at run time.

No root, no Docker and no network. CI runs it in the `ansible-lint (lab-host)`
job with the job's Python, which has Jinja2 and PyYAML from ansible-core; on a
workstation, bash or PowerShell, from the repository root:
  python -I lab-host/ansible/roles/portainer/tests/hcw-portainer-check.test.py
Where those two are not importable (python -I on a workstation that has them
as user-site installs), the rendered-file checks are skipped, saying so, and
the helper is still run against the stand-ins with the configuration's
documented values. On Windows the fake systemd-run is built with pip's
distlib launcher, because the helper starts it under a minimal environment
that cmd.exe cannot start in.
"""

import datetime
import http.server
import importlib.machinery
import importlib.util
import io
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
import zipfile

try:
    import jinja2
    import yaml
except ImportError:
    jinja2 = yaml = None

HERE = pathlib.Path(__file__).resolve().parent
ROLE = HERE.parent
ANSIBLE = ROLE.parent.parent
LAB_HOST = ANSIBLE.parent
REPO = LAB_HOST.parent
HELPER = ROLE / "files" / "hcw-portainer-check"
UTC = datetime.timezone.utc
DAY = datetime.timedelta(days=1)
TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
REPORT_REQUIRED = {"checkedAt", "up", "licenseValid", "licenseExpiresAt", "environmentName", "environmentUp",
                   "containers", "imagesChecked", "imagesOutdated", "error"}
REPORT_OPTIONAL = {"version", "edition"}
COUNTS = ("total", "running", "unhealthy", "restarting", "exited")
NOT_CONFIGURED = ('The Portainer check is not configured: set vault_portainer_api_token '
                  '(lab-host/README.md, "Portainer") and re-run bootstrap.sh.')
# The configuration as the role renders it with its defaults, for a run where
# the render itself cannot be checked (no Jinja2 or PyYAML). CI renders the
# real one and holds every value here to the role and the rest of the
# repository, below.
DOCUMENTED_CONFIG = {
    "portainer_url": "https://127.0.0.1:9443",
    "environment_name": "local",
    "systemd_run": "/usr/bin/systemd-run",
    "node": "/usr/bin/node",
    "agent_user": "hcw-labs-agent",
    "agent_group": "hcw-labs-agent",
    "agent_env_file": "/etc/hcw/labs-agent.env",
    "agent_app_dir": "/opt/hcw-labs-agent/vps-agent",
    "report_cli": "bin/report-host-check.js",
    "report_timeout_seconds": 60,
}

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


# --- The helper's text, and the helper in this process ------------------------------

helper_text = HELPER.read_text(encoding="utf-8")
check("the helper is Python 3, run isolated", helper_text.startswith("#!/usr/bin/python3 -I\n"))
try:
    # In this process, so a read-only checkout gets no __pycache__ written into it.
    compile(helper_text, str(HELPER), "exec")
    compile_error = ""
except SyntaxError as error:
    compile_error = str(error)
check("the helper compiles", not compile_error, compile_error)
check("the helper names GET and no other HTTP method",
      re.findall(r'method="(\w+)"', helper_text) == ["GET"]
      and not re.search(r'"(POST|PUT|PATCH|DELETE)"', helper_text))
check("the helper reads the token from $CREDENTIALS_DIRECTORY and takes no token argument",
      'os.environ.get("CREDENTIALS_DIRECTORY")' in helper_text and 'add_argument("--token' not in helper_text
      and 'add_argument("--config"' in helper_text)
workflow = REPO / ".github" / "workflows" / "ci.yml"
if workflow.is_file():
    check("CI runs this test in the ansible-lint (lab-host) job",
          "run: python roles/portainer/tests/hcw-portainer-check.test.py" in workflow.read_text(encoding="utf-8"))
else:
    skip("CI runs this test", "no .github/ beside lab-host/")
cli_source = REPO / "vps-agent" / "bin" / "report-host-check.js"
if (REPO / "vps-agent" / "bin").is_dir():
    check("the CLI the helper is configured with exists in vps-agent/bin", cli_source.is_file(), str(cli_source))
else:
    skip("the CLI the helper is configured with exists in vps-agent/bin", "no vps-agent/ beside lab-host/")

# The helper, loaded in this process, for the pure functions worth holding on
# their own: the scrub, the licence rules and the edition. The loader is named
# because the file has no .py suffix, which importlib would otherwise refuse.
# No bytecode beside the helper: the role ships files/ as it is, and a
# read-only checkout must stay clean (the compile above already proved it).
sys.dont_write_bytecode = True
module_spec = importlib.util.spec_from_file_location(
    "hcw_portainer_check", HELPER, loader=importlib.machinery.SourceFileLoader("hcw_portainer_check", str(HELPER)))
helper = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(helper)
helper.remember("ptr_example_remembered")
check("a remembered token is scrubbed from every message",
      helper.scrub("the site refused ptr_example_remembered twice ptr_example_remembered") == "the site refused [token] twice [token]")
far = int((now() + 300 * DAY).timestamp())
near = int((now() + 10 * DAY).timestamp())
check("the licence is valid when one licence says so, and its expiry is the latest valid one's",
      helper.licence_state([{"valid": False, "expiresAt": far}, {"valid": True, "expiresAt": near}])
      == (True, datetime.datetime.fromtimestamp(near, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")))
check("not valid when one says so and none is valid, with the latest expiry of all",
      helper.licence_state([{"valid": False, "expiresAt": near}, {"valid": False, "expiresAt": far}])
      == (False, datetime.datetime.fromtimestamp(far, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")))
check("unknown when Portainer says neither (valid null), when there is no licence, and no expiry when it is not a number",
      helper.licence_state([{"valid": None, "expiresAt": far}])[0] is None
      and helper.licence_state([{"valid": None, "expiresAt": far}])[1] is not None
      and helper.licence_state([]) == (None, None)
      and helper.licence_state([{"valid": True, "expiresAt": "soon"}]) == (True, None))
check("the edition is EE for EE and BE, CE for CE, and left out otherwise",
      [helper.edition_of({"ServerEdition": label}) for label in ("EE", "BE", "ce", "", "Community", None)]
      == ["EE", "EE", "CE", None, None, None])


# --- The role's files, rendered -----------------------------------------------


def jinja_env():
    """A Jinja2 environment that renders the role's templates as Ansible does."""
    # Escaping on for HTML and XML only, as Jinja2 recommends. None of the
    # role's templates is either (JSON, systemd units), and Ansible renders
    # them unescaped, so they render here as they do on the host.
    env = jinja2.Environment(
        undefined=jinja2.StrictUndefined, trim_blocks=True, keep_trailing_newline=True,
        autoescape=jinja2.select_autoescape(default_for_string=False, default=False),
    )
    env.filters["to_json"] = json.dumps
    env.filters["dirname"] = os.path.dirname
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


def names_set_in(node):
    """Every name the tasks set: vars, register and set_fact, the way hcw-vault-set reads them."""
    if isinstance(node, list):
        for item in node:
            yield from names_set_in(item)
    elif isinstance(node, dict):
        for name, value in node.items():
            if name == "vars" and isinstance(value, dict):
                yield from value
            elif name == "register" and isinstance(value, str):
                yield value
            elif name in ("set_fact", "ansible.builtin.set_fact") and isinstance(value, dict):
                yield from value
            yield from names_set_in(value)


def check_rendered_files():
    """Render the role's files with its defaults and hold them to the repository; returns the configuration."""
    defaults = resolved(ROLE / "defaults" / "main.yml", ROLE / "vars" / "main.yml")
    group_vars = yaml.safe_load((ANSIBLE / "group_vars" / "all.yml").read_text(encoding="utf-8"))
    agent = resolved(ANSIBLE / "roles" / "labs_agent" / "defaults" / "main.yml",
                     extra={name: group_vars[name] for name in ("labs_agent_user", "labs_agent_home")})
    coder = resolved(ANSIBLE / "roles" / "coder" / "defaults" / "main.yml")
    config = json.loads(render("hcw-portainer-check.json.j2", defaults))
    service = render("hcw-portainer-check.service.j2", defaults)
    timer = render("hcw-portainer-check.timer.j2", defaults)
    agent_unit = (ANSIBLE / "roles" / "labs_agent" / "templates" / "hcw-labs-agent.service.j2").read_text(encoding="utf-8")
    tasks_text = (ROLE / "tasks" / "main.yml").read_text(encoding="utf-8")
    tasks = yaml.safe_load(tasks_text)
    spec = yaml.safe_load((ROLE / "meta" / "argument_specs.yml").read_text(encoding="utf-8"))
    options = spec["argument_specs"]["main"]["options"]

    def task_using(module, **match):
        """The role's first task calling a module with the given arguments, and its body."""
        for task in tasks:
            body = task.get(module)
            if isinstance(body, dict) and all(body.get(k) == v for k, v in match.items()):
                return task, body
        return None, None

    check("the rendered configuration is the documented one", config == DOCUMENTED_CONFIG, json.dumps(config))
    check("it names Portainer on the loopback port the role publishes and waits on",
          config["portainer_url"] == f"https://127.0.0.1:{defaults['portainer_https_port']}"
          and "https://127.0.0.1:{{ portainer_https_port }}/api/system/status" in tasks_text, config["portainer_url"])
    check("it names the local environment by name, which is how the helper finds it (its Id is 3, not 1)",
          config["environment_name"] == defaults["portainer_check_environment_name"] == "local")
    check("it names the agent's user and group (group_vars, labs_agent defaults)",
          config["agent_user"] == group_vars["labs_agent_user"] and config["agent_group"] == agent["labs_agent_group"],
          f"{config['agent_user']}:{config['agent_group']}")
    check("it names the agent's EnvironmentFile, and the agent's unit reads the same one",
          config["agent_env_file"] == agent["labs_agent_env_file"] and "EnvironmentFile={{ labs_agent_env_file }}" in agent_unit,
          config["agent_env_file"])
    check("the CLI runs from the agent's own checkout, which has its node_modules, with the agent's node",
          config["agent_app_dir"] == agent["labs_agent_app_dir"] and config["node"] == "/usr/bin/node"
          and "ExecStart=/usr/bin/node index.js" in agent_unit and "WorkingDirectory={{ labs_agent_app_dir }}" in agent_unit,
          config["agent_app_dir"])
    check("the agent settings are the coder role's, value for value (roles do not read each other's variables)",
          all(defaults[f"portainer_check_agent_{name}"] == coder[f"coder_automation_agent_{name}"]
              for name in ("user", "group", "env_file", "app_dir")),
          json.dumps({name: defaults[f"portainer_check_agent_{name}"] for name in ("user", "group", "env_file", "app_dir")}))
    check("the CLI is vps-agent/bin/report-host-check.js, through /usr/bin/systemd-run, with the role's timeout",
          config["report_cli"] == "bin/report-host-check.js" and config["systemd_run"] == "/usr/bin/systemd-run"
          and config["report_timeout_seconds"] == defaults["portainer_check_report_timeout_seconds"] == 60)
    check("the service is a oneshot that runs the helper with the rendered configuration",
          "\nType=oneshot\n" in service
          and f"\nExecStart={defaults['portainer_check_script']} --config {defaults['portainer_check_config_file']}\n" in service)
    check("the service hands the token to the helper as a credential, from the root-only file",
          f"\nLoadCredential=api-token:{defaults['portainer_check_token_file']}\n" in service
          and defaults["portainer_check_token_file"] == "/etc/hcw/portainer/api-token")
    check("the service is skipped, not failed, until the token file exists",
          f"\nConditionPathExists={defaults['portainer_check_token_file']}\n" in service)
    check("the service names the hardening role's failure notifier (LAB-2)",
          "\nOnFailure=hcw-unit-failed@%n.service\n" in service
          and (ANSIBLE / "roles" / "hardening" / "templates" / "hcw-unit-failed@.service.j2").is_file())
    check("the service logs under its own name and allows six minutes",
          f"\nSyslogIdentifier={defaults['portainer_check_unit']}\n" in service and "\nTimeoutStartSec=6min\n" in service
          and defaults["portainer_check_unit"] == "hcw-portainer-check")
    check("the service runs as root (systemd-run needs it) under hcw-workspace-reach's hardening",
          "\nUser=" not in service and "\nDynamicUser=" not in service
          and all(f"\n{line}\n" in service for line in
                  ("ProtectSystem=strict", "ProtectHome=true", "PrivateTmp=true", "NoNewPrivileges=true", "UMask=0077")))
    check("and without the properties that would close systemd-run's socket or the loopback",
          not any(f"\n{name}=" in service for name in
                  ("RestrictAddressFamilies", "PrivateNetwork", "IPAddressDeny", "ProtectProc", "PrivateUsers")))
    check("the timer runs the service 5 minutes after boot and every 15 minutes, with a minute of jitter",
          f"\nUnit={defaults['portainer_check_unit']}.service\n" in timer
          and f"\nOnBootSec={defaults['portainer_check_boot_delay']}\n" in timer
          and f"\nOnUnitActiveSec={defaults['portainer_check_interval']}\n" in timer
          and "\nRandomizedDelaySec=1min\n" in timer and "\nWantedBy=timers.target\n" in timer
          and (defaults["portainer_check_boot_delay"], defaults["portainer_check_interval"]) == ("5min", "15min"))
    _, body = task_using("ansible.builtin.copy", src="hcw-portainer-check")
    check("the role installs the helper as /usr/local/libexec/hcw-portainer-check, root:root 0750",
          body is not None and (body["dest"], body["owner"], body["group"], body["mode"])
          == ("{{ portainer_check_script }}", "root", "root", "0750")
          and defaults["portainer_check_script"] == "/usr/local/libexec/hcw-portainer-check", str(body))
    token_task, body = task_using("ansible.builtin.copy", dest="{{ portainer_check_token_file }}")
    check("the role writes the token root:root 0600 from the vault key, with no_log, only while the key is set",
          body is not None and (body["owner"], body["group"], body["mode"]) == ("root", "root", "0600")
          and "lookup('ansible.builtin.vars', 'vault_portainer_api_token', default='')" in body["content"]
          and token_task.get("no_log") is True and "portainer_check_configured" in str(token_task.get("when")),
          str(token_task))
    _, body = task_using("ansible.builtin.file", path="{{ portainer_check_dir }}")
    check("the token's directory is root:root 0700",
          body is not None and (body["owner"], body["group"], body["mode"], body["state"]) == ("root", "root", "0700", "directory")
          and defaults["portainer_check_dir"] == "/etc/hcw/portainer", str(body))
    _, body = task_using("ansible.builtin.file", path="{{ portainer_check_token_file }}")
    check("the token file is removed while the key is unset", body is not None and body.get("state") == "absent", str(body))
    declared = set()
    for path in (ROLE / "defaults" / "main.yml", ROLE / "vars" / "main.yml"):
        declared |= set(yaml.safe_load(path.read_text(encoding="utf-8")) or {})
    check("the role never declares or sets vault_portainer_api_token (hcw-vault-set refuses a key the playbook defines)",
          "vault_portainer_api_token" not in declared and "vault_portainer_api_token" not in set(names_set_in(tasks))
          and "vault_portainer_api_token" not in options)
    check("the run says how to set the key, in the sentence lab-host/README.md names",
          any(task.get("ansible.builtin.debug", {}).get("msg") == NOT_CONFIGURED for task in tasks
              if isinstance(task.get("ansible.builtin.debug"), dict)))
    _, body = task_using("ansible.builtin.systemd_service", name="{{ portainer_check_unit }}.timer", enabled=True)
    check("the timer is enabled only while the check is configured",
          body is not None and body.get("state") == "started" and body.get("daemon_reload") is True)
    check("every portainer_check_* default is in the argument spec with the same value",
          all(name in options and options[name].get("default") == value
              for name, value in defaults.items() if name.startswith("portainer_check_") and name != "portainer_check_dir"),
          ", ".join(name for name in defaults if name.startswith("portainer_check_") and name not in options))
    return config


if jinja2 and yaml:
    config = check_rendered_files()
else:
    skip("the role's files, rendered and held to the repository",
         "PyYAML and Jinja2 are not importable under this Python; CI's ansible-core brings them")
    config = dict(DOCUMENTED_CONFIG)


# --- The fake Portainer -------------------------------------------------------------


def random_text(length, alphabet=string.ascii_letters + string.digits):
    return "".join(random.choice(alphabet) for _ in range(length))


def container(cid, state, status, name, image):
    """One entry of Docker's container list, as Portainer passes it through."""
    return {"Id": cid, "Names": [name], "Image": image, "ImageID": "sha256:" + random_text(64, "0123456789abcdef"),
            "State": state, "Status": status, "Created": int(now().timestamp()) - 3600}


class FakePortainer:
    def __init__(self):
        self.lock = threading.Lock()
        # A token of Portainer's shape, made here so no token-shaped literal
        # sits in the source for a secret scanner to flag.
        self.token = "ptr_" + random_text(40)
        self.version = "2.45.2"
        self.edition = "EE"
        self.update_available = False
        self.licenses = [{"id": "lic-fixture", "company": "Fixture Org", "created": int((now() - 25 * DAY).timestamp()),
                          "expiresAt": int((now() + 340 * DAY).timestamp()), "valid": True, "nodes": 3, "type": 3,
                          "productEdition": 1}]
        # The decoy has Portainer's first Id and is down; the local daemon is Id 3, up.
        self.endpoints = [
            {"Id": 1, "Name": "edge-fixture", "Type": 4, "URL": "tcp://192.0.2.10:9001", "Status": 2},
            {"Id": 3, "Name": "local", "Type": 1, "URL": "unix:///var/run/docker.sock", "Status": 1},
        ]
        self.names = ["/fixture-alpha", "/fixture-beta", "/fixture-gamma", "/fixture-delta"]
        self.images = ["registry.invalid/fixture/alpha:1", "registry.invalid/fixture/beta:2",
                       "registry.invalid/fixture/gamma:3", "registry.invalid/fixture/delta:4"]
        self.ids = [random_text(64, "0123456789abcdef") for _ in self.names]
        self.containers = {
            3: [container(self.ids[0], "running", "Up 3 days", self.names[0], self.images[0]),
                container(self.ids[1], "running", "Up 3 days (healthy)", self.names[1], self.images[1]),
                container(self.ids[2], "running", "Up 2 hours", self.names[2], self.images[2]),
                container(self.ids[3], "exited", "Exited (0) 5 days ago", self.names[3], self.images[3])],
            1: [container(random_text(64, "0123456789abcdef"), "running", "Up 9 days", "/fixture-decoy",
                          "registry.invalid/fixture/decoy:9")],
        }
        self.image_status = {cid: "updated" for cid in self.ids[:3]}
        # Every request: (method, path, query, whether it carried the token).
        self.calls = []
        self.other_methods = []
        # Paths that answer a given status instead of their body.
        self.fail = {}

    def fixture_names(self):
        """Every name and image that must appear in no output and no report."""
        found = set(self.names + self.images + ["/fixture-decoy", "registry.invalid/fixture/decoy:9", "Fixture Org"])
        return {name.lstrip("/") for name in found}


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

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def do_PATCH(self):
        self.route("PATCH")

    def route(self, method):
        """Serve the part of Portainer's API the helper reads, with Portainer's status codes."""
        fake = self.fake
        url = urllib.parse.urlsplit(self.path)
        parts = url.path.strip("/").split("/")
        query = urllib.parse.parse_qs(url.query)
        with fake.lock:
            fake.calls.append((method, url.path, dict(query), self.headers.get("X-API-Key") == fake.token))
            if method != "GET":
                fake.other_methods.append((method, url.path))
                return self.send(405, {"message": "method not allowed"})
            if url.path in fake.fail:
                return self.send(fake.fail[url.path], {"message": "fixture failure"})
            if parts == ["api", "system", "status"]:
                # Portainer answers this one to anyone; it is how the role waits for it.
                return self.send(200, {"Version": fake.version, "InstanceID": "fixture-instance"})
            if self.headers.get("X-API-Key") != fake.token:
                return self.send(401, {"message": "Invalid JWT token", "details": "unauthorized"})
            if parts == ["api", "system", "version"]:
                return self.send(200, {"ServerVersion": fake.version, "ServerEdition": fake.edition,
                                       "DatabaseVersion": fake.version, "UpdateAvailable": fake.update_available,
                                       "LatestVersion": fake.version, "Build": {"BuildNumber": "fixture"}})
            if parts == ["api", "licenses"]:
                return self.send(200, fake.licenses)
            if parts == ["api", "endpoints"]:
                return self.send(200, fake.endpoints)
            if len(parts) == 6 and parts[:2] == ["api", "endpoints"] and parts[3:] == ["docker", "containers", "json"]:
                if query.get("all") != ["true"]:
                    return self.send(400, {"message": "the helper must ask for every container"})
                try:
                    return self.send(200, fake.containers[int(parts[2])])
                except (KeyError, ValueError):
                    return self.send(404, {"message": "Unable to find an environment with the specified identifier"})
            if len(parts) == 6 and parts[:2] == ["api", "docker"] and parts[3] == "containers" and parts[5] == "image_status":
                verdict = fake.image_status.get(parts[4])
                if parts[2] != "3" or verdict is None:
                    return self.send(404, {"message": "Unable to find a container with the specified identifier"})
                return self.send(200, {"Status": verdict, "Message": ""})
            return self.send(404, {"message": "Route not found."})


# --- A world: the fake Portainer, the fakes on disk and a configuration ---------------

SYSTEMD_RUN = r'''#!@PYTHON@
import json, os, subprocess, sys
args = sys.argv[1:]
data = sys.stdin.buffer.read()
with open(@LOG@, "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"args": args, "env": sorted(os.environ), "stdin": data.decode("utf-8", "replace")}) + "\n")
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
sys.exit(subprocess.run(args[split + 1:], input=data, cwd=properties["WorkingDirectory"][0], env=env).returncode)
'''

SITE_CLI = r'''#!@PYTHON@
import json, os, sys
payload = json.loads(sys.stdin.read())
mode = os.environ.get("FAKE_CLI_MODE", "")
with open(@LOG@, "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"payload": payload, "cwd": os.getcwd(), "mode": mode,
                             "node_env": os.environ.get("NODE_ENV"), "env": sorted(os.environ)}) + "\n")
# The CLI's contract: one object with check and report, nothing else.
if not isinstance(payload, dict) or set(payload) != {"check", "report"}:
    print("INVALID_INPUT", file=sys.stderr)
    sys.exit(1)
if mode == "fail":
    print("report-host-check: HTTP_502", file=sys.stderr)
    sys.exit(1)
print("report-host-check: a log line before the answer")
print(json.dumps({"ok": True}))
'''


def windows_launcher():
    """pip's distlib launcher, which runs an appended Python archive without cmd.exe, or None."""
    try:
        from pip._vendor.distlib import scripts
    except ImportError:
        return None
    name = "t64.exe" if sys.maxsize > 2 ** 32 else "t32.exe"
    path = pathlib.Path(scripts.__file__).parent / name
    return path if path.is_file() else None


def filled(text, **values):
    """A fake's text with each @NAME@ replaced by its value as a string literal, so a Windows path's backslashes survive."""
    for name, value in values.items():
        text = text.replace(f"@{name}@", json.dumps(str(value)))
    return text.replace("@PYTHON@", sys.executable)


def write_fake(path, text, **values):
    """Write an executable fake, its @NAME@ placeholders filled in; returns its path.

    A shebang script where the kernel runs those (CI, the host); on Windows a
    launcher-built .exe, because the helper starts systemd-run under an
    environment of PATH and LC_ALL alone, which cmd.exe cannot start in and
    python.exe can.
    """
    text = filled(text, **values)
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        launcher = windows_launcher()
        if launcher is None:
            return None
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("__main__.py", text)
        path = path.with_name(path.name + ".exe")
        path.write_bytes(launcher.read_bytes() + f"#!{sys.executable}\r\n".encode("utf-8") + archive.getvalue())
        return path
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)
    return path


def free_port():
    """An unused TCP port on the loopback."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class World:
    def __init__(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="hcw-portainer-check."))
        self.fake = FakePortainer()
        handler = type("BoundHandler", (Handler,), {"fake": self.fake})
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.outputs = []
        self.app = self.root / "agent" / "vps-agent"
        self.env_file = self.root / "labs-agent.env"
        self.cli_log = self.root / "cli.jsonl"
        self.run_log = self.root / "systemd-run.jsonl"
        self.credentials = self.root / "credentials"
        self.credentials.mkdir(mode=0o700)
        self.credential(self.fake.token)
        self.systemd_run = write_fake(self.root / "bin" / "systemd-run", SYSTEMD_RUN, LOG=self.run_log)
        # The CLI is run as `<node> bin/report-host-check.js`, here Python by
        # path, so it needs no launcher anywhere.
        cli = self.app / "bin" / "report-host-check.js"
        cli.parent.mkdir(parents=True)
        cli.write_text(filled(SITE_CLI, LOG=self.cli_log), encoding="utf-8")
        self.cli_mode("ok")
        self.config = dict(config)
        self.config.update(
            portainer_url=f"http://127.0.0.1:{self.server.server_address[1]}",
            systemd_run=str(self.systemd_run or self.root / "bin" / "systemd-run"),
            node=sys.executable,
            agent_env_file=str(self.env_file),
            agent_app_dir=str(self.app),
            report_timeout_seconds=20,
        )
        self.config_file = self.root / "check.json"
        self.write_config()

    def write_config(self, **changes):
        """Write the helper's configuration, with changes."""
        self.config.update(changes)
        self.config_file.write_text(json.dumps(self.config), encoding="utf-8")

    def credential(self, token):
        """What systemd would place in the unit's credentials directory."""
        (self.credentials / "api-token").write_text(token + "\n", encoding="utf-8")

    def cli_mode(self, mode):
        """Set how the fake site CLI answers: ok or fail."""
        self.env_file.write_text(f"# a stand-in for /etc/hcw/labs-agent.env\nLABS_AGENT_ID=vps-test\nFAKE_CLI_MODE={mode}\n",
                                 encoding="utf-8")

    def helper(self, credentials=True):
        """Run the helper as the unit does, keeping its output for the leak check.

        The fake's call log is cleared first, so after a run it holds that
        run's reads and nothing else.
        """
        self.fake.calls.clear()
        env = dict(os.environ)
        env.pop("CREDENTIALS_DIRECTORY", None)
        if credentials:
            env["CREDENTIALS_DIRECTORY"] = str(self.credentials)
        completed = subprocess.run([sys.executable, "-I", str(HELPER), "--config", str(self.config_file)],
                                   input=b"", capture_output=True, env=env, timeout=120)
        result = subprocess.CompletedProcess(completed.args, completed.returncode,
                                             completed.stdout.decode("utf-8", "replace"),
                                             completed.stderr.decode("utf-8", "replace"))
        self.outputs.append(result.stdout + result.stderr)
        return result

    def paths(self):
        """The paths the fake saw in the last run, in order."""
        return [path for _, path, _, _ in self.fake.calls]

    def lines(self, path):
        """A JSON-lines file, parsed."""
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def cli_calls(self):
        """Every call the fake site CLI received."""
        return self.lines(self.cli_log)

    def runs(self):
        """Every call the fake systemd-run received."""
        return self.lines(self.run_log)

    def last_report(self):
        """The report of the last CLI call, or an empty dict."""
        calls = self.cli_calls()
        return calls[-1]["payload"].get("report", {}) if calls else {}

    def leaks(self):
        """Every place the token or a fixture name must never be: the outputs, systemd-run's arguments, the reports."""
        places = list(self.outputs)
        for run in self.runs():
            places.append(json.dumps(run["args"]))
        for call in self.cli_calls():
            places.append(json.dumps(call["payload"]))
        found = []
        for secret in {self.fake.token} | self.fake.fixture_names():
            found += [secret[:16] + "..." for place in places if secret in place]
        return found

    def close(self):
        """Stop the fake Portainer and remove the world's files."""
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.root, ignore_errors=True)


def well_formed(report):
    """Why a report is not of the site's shape, or an empty string."""
    keys = set(report)
    if not REPORT_REQUIRED <= keys <= REPORT_REQUIRED | REPORT_OPTIONAL:
        return f"keys {sorted(keys ^ REPORT_REQUIRED)}"
    if not TIME.fullmatch(report["checkedAt"]):
        return f"checkedAt {report['checkedAt']!r}"
    if not isinstance(report["up"], bool) or not isinstance(report["environmentUp"], bool):
        return "up or environmentUp is not a bool"
    if "version" in report and not (isinstance(report["version"], str) and 0 < len(report["version"]) <= 32):
        return f"version {report['version']!r}"
    if "edition" in report and report["edition"] not in ("EE", "CE"):
        return f"edition {report['edition']!r}"
    if report["licenseValid"] not in (True, False, None):
        return f"licenseValid {report['licenseValid']!r}"
    if report["licenseExpiresAt"] is not None and not TIME.fullmatch(report["licenseExpiresAt"]):
        return f"licenseExpiresAt {report['licenseExpiresAt']!r}"
    if not (isinstance(report["environmentName"], str) and 0 < len(report["environmentName"]) <= 64):
        return f"environmentName {report['environmentName']!r}"
    counts = report["containers"]
    if set(counts) != set(COUNTS) or any(type(counts[name]) is not int or counts[name] < 0 for name in COUNTS):
        return f"containers {counts!r}"
    for name in ("imagesChecked", "imagesOutdated"):
        if report[name] is not None and (type(report[name]) is not int or report[name] < 0):
            return f"{name} {report[name]!r}"
    if report["error"] is not None and not (isinstance(report["error"], str) and 0 < len(report["error"]) <= 300):
        return f"error {report['error']!r}"
    return ""


world = World()
if world.systemd_run is None:
    skip("every run of the helper", "no fake systemd-run can be built here: pip's distlib launcher is missing")
    world.close()
    print(f"hcw-portainer-check.test.py: {passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)

# --- A healthy host ---------------------------------------------------------------------

result = world.helper()
calls = world.cli_calls()
report = world.last_report()
check("a healthy host: exit 0, one summary line on stdout and nothing on stderr",
      result.returncode == 0 and result.stdout.count("\n") == 1 and result.stdout.startswith("hcw-portainer-check: checked: ")
      and not result.stderr, result.stdout + result.stderr)
check("the report is delivered once, as {check: portainer, report}",
      len(calls) == 1 and set(calls[0]["payload"]) == {"check", "report"} and calls[0]["payload"]["check"] == "portainer",
      json.dumps(calls))
check("the report has the site's shape and nothing else", not well_formed(report), well_formed(report) or json.dumps(report))
check("it says Portainer is up, its version and edition, and the licence is valid to its expiry",
      report.get("up") is True and report.get("version") == "2.45.2" and report.get("edition") == "EE"
      and report.get("licenseValid") is True
      and str(report.get("licenseExpiresAt")).startswith((now() + 340 * DAY).strftime("%Y-%m-%d")), json.dumps(report))
check("it names the local environment, up, found by name and not by Id 1",
      report.get("environmentName") == "local" and report.get("environmentUp") is True, json.dumps(report))
check("it counts the containers: 4 in all, 3 running, 1 exited, none unhealthy or restarting",
      report.get("containers") == {"total": 4, "running": 3, "unhealthy": 0, "restarting": 0, "exited": 1}, json.dumps(report))
check("it checked the three running containers' images and found none outdated, with no error",
      report.get("imagesChecked") == 3 and report.get("imagesOutdated") == 0 and report.get("error") is None, json.dumps(report))
check("checkedAt is UTC to the second, and now",
      TIME.fullmatch(report.get("checkedAt", "")) and abs(
          (datetime.datetime.strptime(report["checkedAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC) - now()).total_seconds()) < 60,
      report.get("checkedAt"))
run = world.runs()[-1] if world.runs() else {}
argv = run.get("args", [])
check("the CLI runs as the agent's user and group, with its environment file and checkout",
      f"--uid={config['agent_user']}" in argv and f"--gid={config['agent_group']}" in argv
      and f"--property=EnvironmentFile={world.env_file}" in argv
      and f"--property=WorkingDirectory={world.app}" in argv, json.dumps(argv))
check("through systemd-run --pipe --wait, with hcw-coder-automation's properties and the CLI after --",
      argv[:6] == ["--pipe", "--wait", "--quiet", "--collect", "--service-type=exec", f"--uid={config['agent_user']}"]
      and all(f"--property={name}" in argv for name in
              ("Environment=NODE_ENV=production", "NoNewPrivileges=yes", "PrivateTmp=yes", "ProtectSystem=full",
               "ProtectHome=yes", "RuntimeMaxSec=20"))
      and argv[-3:] == ["--", sys.executable, "bin/report-host-check.js"], json.dumps(argv))
check("systemd-run gets PATH and LC_ALL and nothing else: no $CREDENTIALS_DIRECTORY, no token",
      run.get("env") == ["LC_ALL", "PATH"], json.dumps(run.get("env")))
check("the CLI saw the agent's environment and NODE_ENV=production, and ran in the agent's checkout",
      calls and calls[0]["mode"] == "ok" and calls[0]["node_env"] == "production" and calls[0]["cwd"] == str(world.app)
      and "CREDENTIALS_DIRECTORY" not in calls[0]["env"], json.dumps(calls))
check("the summary line carries the counts and the licence date, and no container or image name",
      "Portainer 2.45.2 EE up" in result.stdout and "environment local up with 4 containers (3 running" in result.stdout
      and "3 images checked, 0 outdated" in result.stdout and "licence valid to" in result.stdout
      and "reported to the site" in result.stdout and not any(name in result.stdout for name in world.fake.fixture_names()),
      result.stdout)

# What the fake saw in that run: the order of the reads, and the environment they were read from.
seen = list(world.fake.calls)
check("the helper reads status, version, licences, endpoints, then the containers of the environment named local (Id 3)",
      world.paths()[:5] == ["/api/system/status", "/api/system/version", "/api/licenses", "/api/endpoints",
                            "/api/endpoints/3/docker/containers/json"]
      and len(seen) > 4 and seen[4][2] == {"all": ["true"]}, json.dumps(seen))
check("and one image_status per running container, under /docker/3, none for the exited one or the decoy",
      sorted(world.paths()[5:]) == sorted(f"/api/docker/3/containers/{cid}/image_status" for cid in world.fake.ids[:3])
      and not any("/endpoints/1/" in path or "/docker/1/" in path for path in world.paths()), json.dumps(seen))
check("every request is a GET; the fake saw no other method",
      all(method == "GET" for method, _, _, _ in seen) and not world.fake.other_methods, str(world.fake.other_methods))
check("every request after /system/status carried the token in X-API-Key",
      len(seen) > 1 and all(authorised for _, _, _, authorised in seen[1:]), json.dumps(seen))

# --- What changes in the counts --------------------------------------------------------

world.fake.containers[3][1]["Status"] = "Up 3 days (unhealthy)"
result = world.helper()
report = world.last_report()
check("an unhealthy container is counted (it is still running)",
      result.returncode == 0 and report.get("containers", {}).get("unhealthy") == 1
      and report["containers"]["running"] == 3, json.dumps(report))
world.fake.containers[3][1]["Status"] = "Up 3 days (healthy)"
world.fake.containers[3][2]["State"] = "restarting"
world.fake.containers[3][2]["Status"] = "Restarting (1) 5 seconds ago"
result = world.helper()
report = world.last_report()
check("a restarting container is counted as restarting, not running, and its image is not checked",
      result.returncode == 0 and report.get("containers") == {"total": 4, "running": 2, "unhealthy": 0, "restarting": 1, "exited": 1}
      and report.get("imagesChecked") == 2, json.dumps(report))
world.fake.containers[3][2]["State"] = "running"
world.fake.containers[3][2]["Status"] = "Up 2 hours"
world.fake.image_status[world.fake.ids[0]] = "outdated"
world.fake.image_status[world.fake.ids[2]] = "processing"
result = world.helper()
report = world.last_report()
check("an outdated image is counted; an image Portainer is still processing is not a checked one",
      result.returncode == 0 and report.get("imagesChecked") == 2 and report.get("imagesOutdated") == 1, json.dumps(report))
check("outdated images and unhealthy containers are the site's warnings, not this run's failure (exit 0)",
      result.returncode == 0 and report.get("error") is None, result.stderr)
world.fake.image_status[world.fake.ids[0]] = "updated"
world.fake.image_status[world.fake.ids[2]] = "updated"
exited_only = world.fake.containers[3][3]
world.fake.containers[3] = [exited_only]
result = world.helper()
report = world.last_report()
check("with no container running, zero images were checked and zero are outdated (not unknown)",
      result.returncode == 0 and report.get("containers") == {"total": 1, "running": 0, "unhealthy": 0, "restarting": 0, "exited": 1}
      and report.get("imagesChecked") == 0 and report.get("imagesOutdated") == 0, json.dumps(report))
world.fake.containers[3] = [container(world.fake.ids[i], "running", "Up 1 hour", world.fake.names[i], world.fake.images[i])
                            for i in range(3)] + [exited_only]

# --- The licence and the edition ---------------------------------------------------------

world.fake.licenses[0]["valid"] = None
result = world.helper()
report = world.last_report()
check("a licence whose validity Portainer leaves null is reported as unknown, with its expiry",
      result.returncode == 0 and report.get("licenseValid") is None and report.get("licenseExpiresAt") is not None,
      json.dumps(report))
world.fake.licenses[0]["valid"] = False
result = world.helper()
report = world.last_report()
check("a licence Portainer marks invalid is reported as such, and the run still passes",
      result.returncode == 0 and report.get("licenseValid") is False and "licence not valid" in result.stdout, result.stdout)
world.fake.licenses = []
result = world.helper()
report = world.last_report()
check("no licence at all is unknown, with no expiry",
      result.returncode == 0 and report.get("licenseValid") is None and report.get("licenseExpiresAt") is None, json.dumps(report))
world.fake.licenses = [{"id": "lic-fixture", "expiresAt": int((now() + 340 * DAY).timestamp()), "valid": True}]
world.fake.fail["/api/licenses"] = 403
result = world.helper()
report = world.last_report()
check("a licence read Portainer refuses (403) leaves the licence unknown, notes it, and does not fail the run",
      result.returncode == 0 and report.get("licenseValid") is None and "GET /licenses answered HTTP 403" in result.stderr
      and report.get("error") is None, result.stderr)
world.fake.fail.clear()
for label, expected in (("BE", "EE"), ("CE", "CE"), ("Community", None)):
    world.fake.edition = label
    result = world.helper()
    report = world.last_report()
    check(f"ServerEdition {label!r} is reported as {expected!r}" if expected else f"ServerEdition {label!r} leaves the edition out",
          result.returncode == 0 and report.get("edition") == expected and ("edition" in report) == bool(expected), json.dumps(report))
world.fake.edition = "EE"
world.fake.update_available = True
result = world.helper()
check("an available Portainer update is said in the journal line", result.returncode == 0
      and "a Portainer update is available" in result.stdout, result.stdout)
world.fake.update_available = False
world.fake.fail["/api/system/version"] = 500
result = world.helper()
report = world.last_report()
check("a failed version read leaves the edition out, notes it, and does not fail the run",
      result.returncode == 0 and "edition" not in report and report.get("version") == "2.45.2"
      and "GET /system/version answered HTTP 500" in result.stderr, result.stderr)
world.fake.fail.clear()

# --- The environment -----------------------------------------------------------------

world.fake.endpoints[1]["Name"] = "renamed-fixture"
result = world.helper()
report = world.last_report()
check("no environment named local: exit 1, the report delivered with environmentUp false and the reason in error",
      result.returncode == 1 and report.get("up") is True and report.get("environmentUp") is False
      and "no environment named local" in str(report.get("error")) and report.get("imagesChecked") is None
      and report["containers"]["total"] == 0, json.dumps(report) + result.stderr)
check("and the Id 1 decoy was not read in its place",
      not any("/endpoints/1/" in path for path in world.paths()))
world.fake.endpoints[1]["Name"] = "local"
world.fake.endpoints[1]["Status"] = 2
result = world.helper()
report = world.last_report()
check("the local environment down (Status 2): exit 1, environmentUp false, the reason in error, no containers read",
      result.returncode == 1 and report.get("environmentUp") is False and "is down (Portainer Status 2)" in str(report.get("error"))
      and not any("/containers/json" in path for path in world.paths()), json.dumps(report))
world.fake.endpoints[1]["Status"] = 1
world.fake.fail["/api/endpoints"] = 500
result = world.helper()
report = world.last_report()
check("an endpoints read that fails: exit 1 with the status in error, the report still delivered",
      result.returncode == 1 and "GET /endpoints answered HTTP 500" in str(report.get("error"))
      and report.get("up") is True and "failed: " in result.stdout, result.stdout + result.stderr)
world.fake.fail.clear()
world.fake.fail["/api/endpoints/3/docker/containers/json"] = 500
result = world.helper()
report = world.last_report()
check("a container list that fails: exit 1, environmentUp true, counts zero, images unknown",
      result.returncode == 1 and report.get("environmentUp") is True and report["containers"]["total"] == 0
      and report.get("imagesChecked") is None and "containers/json answered HTTP 500" in str(report.get("error")), json.dumps(report))
world.fake.fail.clear()

# --- The token, Portainer down, the site down -----------------------------------------------

world.credential("ptr_" + random_text(40))
result = world.helper()
report = world.last_report()
check("a token Portainer refuses: exit 1, the report delivered with the reason and how to set the key again",
      result.returncode == 1 and "refused the token (HTTP 401)" in str(report.get("error"))
      and "vault_portainer_api_token" in result.stderr, result.stderr)
world.credential(world.fake.token)
before = len(world.cli_calls())
result = world.helper(credentials=False)
check("without $CREDENTIALS_DIRECTORY the helper refuses before reading anything, naming LoadCredential=, and reports nothing",
      result.returncode == 1 and "LoadCredential=" in result.stderr and len(world.cli_calls()) == before
      and not world.paths(), result.stderr)
world.credential("")
result = world.helper()
check("an empty credential is refused the same way", result.returncode == 1 and "is empty" in result.stderr
      and len(world.cli_calls()) == before, result.stderr)
world.credential(world.fake.token)
good_url = world.config["portainer_url"]
world.write_config(portainer_url="https://192.0.2.10:9443")
result = world.helper()
check("a Portainer URL off the loopback is refused (verification is off), nothing read, nothing reported",
      result.returncode == 1 and "refusing the Portainer URL" in result.stderr and len(world.cli_calls()) == before, result.stderr)
world.write_config(portainer_url=f"http://127.0.0.1:{free_port()}")
result = world.helper()
report = world.last_report()
check("Portainer down: exit 1, and an up:false report is still delivered first",
      result.returncode == 1 and len(world.cli_calls()) == before + 1 and report.get("up") is False
      and "did not answer" in str(report.get("error")) and not well_formed(report), json.dumps(report) + result.stderr)
check("it carries no version or edition, the environment down, zero counts and unknown images",
      "version" not in report and "edition" not in report and report.get("environmentUp") is False
      and report.get("containers") == {"total": 0, "running": 0, "unhealthy": 0, "restarting": 0, "exited": 0}
      and report.get("imagesChecked") is None and report.get("imagesOutdated") is None, json.dumps(report))
check("the journal line says Portainer is not answering and the site has the report",
      result.stdout.startswith("hcw-portainer-check: failed: Portainer is not answering") and "reported to the site" in result.stdout,
      result.stdout)
world.write_config(portainer_url=good_url)
world.cli_mode("fail")
result = world.helper()
check("the site's CLI failing: exit 1, its own stderr relayed under this helper's name, and the summary says so",
      result.returncode == 1 and "hcw-portainer-check: site CLI: report-host-check: HTTP_502" in result.stderr
      and "the report did not reach the site: the site's CLI exited with 1" in result.stderr
      and result.stdout.startswith("hcw-portainer-check: failed: Portainer 2.45.2 EE up")
      and result.stdout.rstrip().endswith("the report did not reach the site"), result.stdout + result.stderr)
world.cli_mode("ok")
world.env_file.rename(world.root / "labs-agent.env.away")
result = world.helper()
check("a lab agent with no environment file fails the run, saying so",
      result.returncode == 1 and "the lab agent is not configured" in result.stderr, result.stderr)
(world.root / "labs-agent.env.away").rename(world.env_file)
world.write_config(systemd_run=str(world.root / "bin" / "missing-systemd-run"))
result = world.helper()
check("a systemd-run that cannot be started fails the run", result.returncode == 1
      and "could not be started" in result.stderr, result.stderr)
world.write_config(systemd_run=str(world.systemd_run))
result = world.helper()
check("and a healthy run after all that is exit 0 again", result.returncode == 0, result.stdout + result.stderr)

# --- Every payload, and the leak check ---------------------------------------------------------

payloads = [call["payload"] for call in world.cli_calls()]
bad = [(p, well_formed(p.get("report", {}))) for p in payloads if set(p) != {"check", "report"} or p["check"] != "portainer"
       or well_formed(p.get("report", {}))]
check(f"all {len(payloads)} payloads are {{check: portainer, report}} with a report of the site's shape",
      payloads and not bad, json.dumps(bad[:1]))
leaks = world.leaks()
check("neither the token nor any container or image name is in anything the helper printed, systemd-run's arguments or any report",
      not leaks, ", ".join(leaks))
if os.name == "posix":
    check("the fakes were run as programs, as the host runs them", stat.S_IMODE(os.stat(world.systemd_run).st_mode) & 0o100)
world.close()

print(f"hcw-portainer-check.test.py: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
