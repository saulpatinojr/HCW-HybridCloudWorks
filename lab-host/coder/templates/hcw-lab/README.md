# hcw-lab

A browser workspace for the HybridCloudWorks labs: VS Code (code-server) on
the `hcw-lab` image, which carries `az`, `terraform`, `kubectl`, `helm`,
`ansible` and `git`. Pick a lab and the folder for it is checked out and
opened for you.

- **One CPU, 2 GiB of memory, one hour.** The workspace stops itself an hour
  after it starts; your files in the home folder survive a stop and come
  back when you start it again. Deleting the workspace deletes them.
- **You are `nobody` (uid 65534)**, with no `sudo`, no Docker, no access to
  the host. Everything a lab needs is already installed.
- **Network is on**, so `az login --use-device-code` and `terraform init`
  work.
- **A cloud sign-in lasts until the workspace stops.** `az login`, and the
  AWS and Google Cloud CLIs if you add them, keep their sign-in in memory
  (`/tmp/cloud-creds`), never in your home folder, so stopping the workspace
  signs you out and leaves nothing of it on disk. Sign in again after a
  start.
- **One running lab at a time.** Starting a lab while another of yours is
  starting or running is refused with `Stop your other lab first:` and that
  lab's name. Stop it (your files stay) and start this one again. Stopped
  labs do not count, so you can keep one for every lab.

Source: `lab-host/coder/templates/hcw-lab` in
[saulpatinojr/HCW-HybridCloudWorks](https://github.com/saulpatinojr/HCW-HybridCloudWorks).
