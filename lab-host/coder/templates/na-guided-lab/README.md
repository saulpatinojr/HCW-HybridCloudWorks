# na-guided-lab

A browser workspace for inspecting a Cloud Network Assessment bundle: VS Code
(code-server) on the `hcw-lab` image with `jq`, `python3` and `git`.

- **One CPU, 2 GiB of memory, one hour.** The workspace stops itself an hour
  after it starts; your files in `/tmp/home/assessment` survive a stop.
- **You are `nobody` (uid 65534)**, with no `sudo`, no Docker, no access to
  the host, and no cloud credentials.

Source: `lab-host/coder/templates/na-guided-lab` in
[saulpatinojr/HCW-HybridCloudWorks](https://github.com/saulpatinojr/HCW-HybridCloudWorks).
