"""The modules of hcw-portainer-check (#1845).

The portainer role installs them in
/usr/local/lib/hcw-lab/portainer-check/hcw_portainer_check/, root-owned and
writable by root only, and /usr/local/libexec/hcw-portainer-check checks that
before it imports them. That script's docstring has the design; cli.main()
is the run.
"""
