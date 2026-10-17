# amo-guided-lab

A browser workspace for inspecting an Azure Migration Orchestrator assessment
bundle: VS Code (code-server) on the `hcw-lab` image with `terraform`, `jq`,
`python3` and `git`.

- **One CPU, 2 GiB of memory, one hour.** The workspace stops itself an hour
  after it starts; your files in `/tmp/home/assessment` survive a stop.
- **You are `nobody` (uid 65534)**, with no `sudo`, no Docker, no access to
  the host, and no cloud credentials. If you sign in to a cloud CLI anyway,
  the sign-in is kept in memory (`/tmp/cloud-creds`), never in your files,
  and lasts until the workspace stops.
- **One running lab at a time.** Starting this workspace while another of
  yours is starting or running is refused with `Stop your other lab first:`
  and that lab's name. Stop it (your files stay) and start this one again.

Source: `lab-host/coder/templates/amo-guided-lab` in
[saulpatinojr/HCW-HybridCloudWorks](https://github.com/saulpatinojr/HCW-HybridCloudWorks).
