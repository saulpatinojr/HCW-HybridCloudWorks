#!/usr/bin/env bash
# Adapts the lab host's rendered Caddy configuration with the pinned Caddy
# release and checks the one thing the templates rely on Caddy for and
# nothing else proves (ADR 0035, the per-name direct-visit redirect): that
# Caddy orders every `vars` directive ahead of `redir`, with the snippet's
# `vars lab_direct_visit_redirect` first and a route's `vars @addon_<id>
# lab_direct_visit_redirect` after it, so the later one wins for that name,
# and that the redir reads the variable as a placeholder. It also reads the
# global options back as Caddy adapted them (#958): the admin API on the
# unit's Unix socket and every server on h1 and h2 only.
#
# The configuration is rendered by ansible-core's own template module, from
# this directory's inventory (so group_vars/all.yml applies) with the three
# roles' defaults and vars passed as extra vars, exactly as the roles render
# it, into a scratch directory: the Caddyfile beside conf.d/ with the apex,
# coder and addons routes. One departure, stated: the `tls` block is cut
# from the rendered Caddyfile, because the release binary has no Cloudflare
# DNS module and `caddy adapt` refuses an unknown provider; the vault token
# is a placeholder so the TLS site block, the one the panes use, is the
# branch rendered. Caddy is the release tarball for the version group_vars
# pins, checked against the SHA-512 below, which is the linux_amd64 line of
# that release's caddy_<version>_checksums.txt, read 2026-10-10. A version
# bump moves both lines together.
#
# No root and no Docker needed; ansible-core on PATH. CI runs it in the
# `ansible-lint (lab-host)` job; lab-host/README.md ("Validating without a
# host") has the container line.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ansible="$(cd "${here}/../../.." && pwd)"
group_vars="${ansible}/group_vars/all.yml"

CADDY_SHA512='a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7'

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

command -v ansible > /dev/null || { echo "ansible is not on PATH; install ansible-core" >&2; exit 1; }
python=''
for candidate in python3 python; do
  if command -v "${candidate}" > /dev/null; then
    python="$(command -v "${candidate}")"
    break
  fi
done
[ -n "${python}" ] || { echo "no python on PATH" >&2; exit 1; }

version="$(sed -nE 's/^caddy_version: *v?([0-9.]+) *$/\1/p' "${group_vars}")"
[ -n "${version}" ] || { echo "caddy_version not found in ${group_vars}" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# The pinned release, by version and checksum. CADDY_BIN on PATH short-cuts
# the download for a workstation that has the binary.
caddy="${CADDY_BIN:-}"
if [ -z "${caddy}" ]; then
  tarball="${work}/caddy.tar.gz"
  curl -fsSL -o "${tarball}" "https://github.com/caddyserver/caddy/releases/download/v${version}/caddy_${version}_linux_amd64.tar.gz"
  echo "${CADDY_SHA512}  ${tarball}" | sha512sum -c --quiet - || {
    echo "caddy_${version}_linux_amd64.tar.gz does not match CADDY_SHA512 in $0: move both lines together" >&2
    exit 1
  }
  tar -xzf "${tarball}" -C "${work}" caddy
  caddy="${work}/caddy"
fi
check "caddy is the pinned version ${version}" "\"${caddy}\" version | grep -q \"^v${version} \""

# Rendered as the roles render it: the inventory's group_vars, each role's
# defaults and vars, and the one placeholder that selects the TLS branch.
mkdir -p "${work}/config/conf.d"
render() {
  (cd "${ansible}" && ansible localhost -c local -e ansible_become=false -m ansible.builtin.template \
    -a "src=$1 dest=$2" \
    -e @roles/caddy/defaults/main.yml -e @roles/caddy/vars/main.yml \
    -e @roles/coder/defaults/main.yml \
    -e @roles/addons/defaults/main.yml -e @roles/addons/vars/main.yml \
    -e vault_cloudflare_api_token=placeholder -e vault_caddy_acme_email= \
    -e "caddy_sites_dir=${work}/config/conf.d" > "${work}/render.log" 2>&1) \
    || { cat "${work}/render.log" >&2; echo "rendering $1 failed" >&2; exit 1; }
}
render roles/caddy/templates/Caddyfile.j2 "${work}/config/Caddyfile"
render roles/caddy/templates/00-apex.caddy.j2 "${work}/config/conf.d/00-apex.caddy"
render roles/coder/templates/10-coder.caddy.j2 "${work}/config/conf.d/10-coder.caddy"
render roles/addons/templates/20-addons.caddy.j2 "${work}/config/conf.d/20-addons.caddy"
check "the rendered Caddyfile is the TLS site block" "grep -q '^  import lab_panes_only$' \"${work}/config/Caddyfile\" && ! grep -q '^http://' \"${work}/config/Caddyfile\""
# The DNS-01 delegation (#948): with the role default (empty) no override is
# rendered; with the group_vars value the tls block names the lab-zone target
# exactly, because certmagic does not follow the CNAME by itself.
check "no dns_challenge_override_domain renders while the variable is empty" "! grep -q 'dns_challenge_override_domain' \"${work}/config/Caddyfile\""
(cd "${ansible}" && ansible localhost -c local -e ansible_become=false -m ansible.builtin.template \
  -a "src=roles/caddy/templates/Caddyfile.j2 dest=${work}/config/Caddyfile.delegated" \
  -e @roles/caddy/defaults/main.yml -e @roles/caddy/vars/main.yml \
  -e vault_cloudflare_api_token=placeholder -e vault_caddy_acme_email= \
  -e caddy_dns_challenge_override_domain=_acme-challenge.lab.hybridcloudinsights.com \
  -e "caddy_sites_dir=${work}/config/conf.d" > "${work}/render-delegated.log" 2>&1) \
  || { cat "${work}/render-delegated.log" >&2; echo "rendering the delegated Caddyfile failed" >&2; exit 1; }
check "the delegated render names the lab-zone target inside the tls block" "grep -q '^    dns_challenge_override_domain _acme-challenge.lab.hybridcloudinsights.com$' \"${work}/config/Caddyfile.delegated\""
check "group_vars sets the override to the lab-zone target infra-lab delegates to" "grep -q '^caddy_dns_challenge_override_domain: _acme-challenge.lab.hybridcloudinsights.com$' \"${ansible}/group_vars/all.yml\" && grep -q 'default     = \"_acme-challenge.lab.hybridcloudinsights.com\"' \"${ansible}/../../infra-lab/variables.tf\""
# The tls block, which needs the Cloudflare module the release binary lacks.
"${python}" - "${work}/config/Caddyfile" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
cut, n = re.subn(r"  tls \{\n.*?\n  \}\n", "", text, count=1, flags=re.S)
assert n == 1, "no tls block to cut"
open(path, "w", encoding="utf-8").write(cut)
PY
check "the rendered Caddyfile adapts" "\"${caddy}\" adapt --config \"${work}/config/Caddyfile\" --adapter caddyfile > \"${work}/adapted.json\" 2> \"${work}/adapt.err\"" "$(cat "${work}/adapt.err" 2> /dev/null || true)"

# The order Caddy settled on, one line per route of the site's subroute.
"${python}" - "${work}/adapted.json" > "${work}/order.txt" <<'PY'
import json, sys
adapted = json.load(open(sys.argv[1]))
for server in adapted["apps"]["http"]["servers"].values():
    for route in server["routes"]:
        for handler in route.get("handle", []):
            if handler.get("handler") != "subroute":
                continue
            for inner in handler["routes"]:
                hosts = ",".join(sorted(h for m in inner.get("match", []) for h in m.get("host", [])))
                for h in inner.get("handle", []):
                    kind = h.get("handler")
                    if kind == "vars":
                        values = {k: v for k, v in h.items() if k != "handler"}
                        print(f"vars host={hosts or '*'} {json.dumps(values, sort_keys=True)}")
                    elif kind == "static_response" and h.get("status_code") == 302:
                        print(f"redir host={hosts or '*'} {json.dumps(h.get('headers', {}).get('Location'))}")
                    else:
                        print(f"{kind} host={hosts or '*'}")
PY

order="$(cat "${work}/order.txt")"
global_line="$(grep -n '^vars host=\* {"lab_direct_visit_redirect": "https://hybridcloudworks.com/education/labs"}$' "${work}/order.txt" | cut -d: -f1 | head -1 || true)"
addon_line="$(grep -n '^vars host=migration.lab.hybridcloudworks.com {"lab_direct_visit_redirect": "https://hybridcloudworks.com/tools/migration"}$' "${work}/order.txt" | cut -d: -f1 | head -1 || true)"
redir_line="$(grep -n '^redir host=\* \["{http.vars.lab_direct_visit_redirect}"\]$' "${work}/order.txt" | cut -d: -f1 | head -1 || true)"

check "the snippet sets lab_direct_visit_redirect for every name" "[ -n \"${global_line}\" ]" "${order}"
check "the addons route sets it again for the add-on's name" "[ -n \"${addon_line}\" ]" "${order}"
check "the redir reads the variable as a placeholder" "[ -n \"${redir_line}\" ]" "${order}"
check "Caddy orders the snippet's vars, then the route's, then the redir" \
  "[ -n \"${global_line}\" ] && [ -n \"${addon_line}\" ] && [ -n \"${redir_line}\" ] && [ \"${global_line}\" -lt \"${addon_line}\" ] && [ \"${addon_line}\" -lt \"${redir_line}\" ]" "${order}"
check "no handler runs before the vars" "! sed -n \"1,\${global_line}p\" \"${work}/order.txt\" | grep -qvE '^vars '" "${order}"

# The global options (#958): the admin API on the unit's Unix socket, not on
# TCP, and every server on HTTP/1.1 and HTTP/2 only. One line each, printed
# from the adapted JSON, so a failure shows what Caddy settled on.
"${python}" - "${work}/adapted.json" > "${work}/globals.txt" <<'PY'
import json, sys
adapted = json.load(open(sys.argv[1]))
print("admin " + json.dumps(adapted.get("admin", {}).get("listen")))
servers = adapted["apps"]["http"]["servers"]
print("servers " + str(len(servers)))
for name, server in sorted(servers.items()):
    print(f"protocols {name} " + json.dumps(server.get("protocols")))
PY
globals_out="$(cat "${work}/globals.txt")"
servers_total="$(grep -c '^protocols ' "${work}/globals.txt" || true)"
servers_h1_h2="$(grep -cE '^protocols [^ ]+ \["h1", "h2"\]$' "${work}/globals.txt" || true)"
check "the admin API listens on the unit's Unix socket" "grep -qxF 'admin \"unix//run/caddy/admin.sock\"' \"${work}/globals.txt\"" "${globals_out}"
check "every server speaks h1 and h2 only, so no HTTP/3" "[ \"${servers_total}\" -gt 0 ] && [ \"${servers_total}\" -eq \"${servers_h1_h2}\" ]" "${globals_out}"
check "nothing in the rendered configuration names TCP 2019" "! grep -rqE '(^|[^0-9])2019([^0-9-]|$)' \"${work}/config\"" "$(grep -rnE '(^|[^0-9])2019([^0-9-]|$)' "${work}/config" || true)"

if [ "${failed}" -gt 0 ]; then
  echo "caddy-adapt.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "caddy-adapt.test.sh: all ${passed} checks passed"
