---
title: Docker Desktop for the labs
subtitle: Install Docker Desktop on Windows or macOS, find your way round its dashboard, give it what the lab image needs, and run the labs' follow-along line in a folder of your own.
date: 2026-09-29
track: how-to
part: 2 of 3
tags: [docker, docker-desktop, containers, wsl, labs]
reading: 13
---

Every lab on <https://hybridcloudworks.com/education/labs> has a "Run it
locally" line. Inspecting the latest manifest digest and pinning it runs the
reproducible image:

PowerShell:

```powershell
$d = docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-lab:latest --format '{{.Manifest.Digest}}'; docker run --rm -it -v ${PWD}:/workspace "hybridcloudworks/hcw-lab@$d"
```

bash:

```bash
d=$(docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-lab:latest --format '{{.Manifest.Digest}}'); docker run --rm -it -v "$PWD":/workspace "hybridcloudworks/hcw-lab@$d"
```

It needs Docker and nothing else: no Terraform, no Azure CLI, no Python on
your machine. On Windows and macOS, Docker means Docker Desktop. This part
installs it, walks the parts of the dashboard you will use, sets the resources
that matter for the lab image, and runs that line in a folder of your own. It
ends with how Desktop relates to the Docker Engine on the Hybrid Lab host,
where the browser workspaces built on the same image run, because that
difference explains the one behaviour that surprises people.

**Checked on 2026-09-29:** the current release is Docker Desktop 4.93.0,
dated 2026-09-28 in Docker's
[release notes](https://docs.docker.com/desktop/release-notes/), and it bundles
Docker Engine 29.8.1. The four most recent releases are a week apart, so
expect a newer number by the time you read this.

## What you'll have at the end

| Piece | Result |
| --- | --- |
| Docker Desktop | 4.93.0 or later, using the WSL 2 backend on Windows |
| Resources | Memory, disk and file sharing checked against what the lab image needs |
| The lab image | Pinned by digest from `docker.io/hybridcloudworks/hcw-lab:latest`: 497 MB to pull, 2.73 GB on disk |
| A lab shell | `nobody@<container id>:/workspace$`, in your own folder, with terraform 1.16.4, the Azure CLI, kubectl, helm and Ansible |

## What it costs

**The licence depends on who you are.** Checked on 2026-09-29 against the
[Docker Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/)
(marked "Last updated on August 26, 2026") and Docker's
[licensing page](https://docs.docker.com/subscription-billing/desktop-license/).
Docker Desktop is free for personal use, education, non-commercial open
source projects, and small businesses: "fewer than 250 employees AND less than
$10 million in annual revenue", in the licensing page's words. Professional
use in a larger organisation needs a paid subscription, and Docker names Pro,
Team and Business as the ones that include Desktop. The agreement is blunt
about the public sector: "Government Entities shall not use Docker Desktop or
access other Entitlements of the Services without a paid subscription for
Services."

The same page says the engine is not affected: "The licensing and
distribution terms for Docker and Moby open-source projects, such as Docker
Engine, aren't changing." That matters at the end of this part.

**Then disk.** The lab image is a 497 MB download and 2.73 GB once unpacked,
measured with Docker Desktop 4.93.0 on 2026-09-29. Pulling it needs no Docker
Hub account.

---

## Why Docker Desktop

The alternative is installing the lab's tools on your machine: Terraform, the
Azure CLI, kubectl, helm, Ansible and a Python for it, each at whatever version
your package manager offers. Every one would then differ from the version the
labs were checked against, and a lab that fails on a version you did not
choose is a lab about your package manager. One image pins all of them.

Docker Engine, the part that actually runs containers, is Linux software. On a
Linux machine you can install it directly. Windows and macOS have no Linux
kernel of their own, so Docker Desktop brings one: it runs Docker Engine inside
a small Linux virtual machine it manages for you, and adds the parts you would
otherwise assemble by hand, which are the `docker` command on your own
terminal, sharing your folders into that VM, reaching container ports on
`localhost`, a dashboard, and updates. On Windows that VM is the WSL 2 utility
VM, which is why the WSL 2 backend matters.

---

## Prerequisites

The install steps and settings in this article are also kept as a reference
page at <https://hybridcloudworks.com/docker/desktop>.

**Windows**, from Docker's
[Windows install page](https://docs.docker.com/desktop/setup/install/windows-install/),
for the WSL 2 backend on x86_64:

- Windows 10 64-bit version 22H2 (build 19045), or Windows 11 64-bit version
  23H2 (build 22631) or higher, in the Enterprise, Pro or Education edition.
- WSL version 2.1.5 or later.
- 8 GB of system RAM, a 64-bit processor with Second Level Address Translation,
  and hardware virtualisation turned on in the BIOS or UEFI.

**macOS**, from Docker's
[Mac install page](https://docs.docker.com/desktop/setup/install/mac-install/):

- One of the current and two previous major macOS releases.
- At least 4 GB of RAM.

Both: an account on the machine that can install software, and a folder to
work in. No Docker Hub account.

---

## The steps

### 1. Install on Windows, with the WSL 2 backend

Check WSL first. PowerShell:

```powershell
wsl --version
```

The first line should read `WSL version:` followed by 2.1.5 or later. If no
version details appear, you have the older WSL built into Windows, which
Docker Desktop does not support. Update it from a PowerShell window opened as
administrator:

```powershell
wsl --update
```

Download **Docker Desktop for Windows - x86_64** from the
[Windows install page](https://docs.docker.com/desktop/setup/install/windows-install/)
and run it. The installer offers two modes. **Per-user**, the default, installs
without administrator rights and uses the WSL 2 backend, which is all the labs
need. **All users** needs administrator rights and is only required for
Windows containers or the Hyper-V backend, which the labs do not use. On the
Configuration page, keep **Use WSL 2 instead of Hyper-V** selected if it is
offered.

To install per-user from PowerShell instead, once the installer is in your
Downloads folder:

```powershell
Start-Process "$env:USERPROFILE\Downloads\Docker Desktop Installer.exe" -Wait -ArgumentList 'install', '--user'
```

Docker Desktop does not start on its own after installing. Open it from the
Start menu, read the Docker Subscription Service Agreement it shows, and
select **Accept**; it will not run until you do.

**Verify:** in a new PowerShell window,

```powershell
docker version
```

Trimmed:

```text
Client:
 Version:           29.8.1
 ...
 Context:           desktop-linux

Server: Docker Desktop 4.93.0 (240920)
 Engine:
  Version:          29.8.1
  ...
  OS/Arch:          linux/amd64
```

Two lines matter. `Server: Docker Desktop` means the command reached the
engine inside Desktop, and `OS/Arch: linux/amd64` means that engine runs Linux
containers, which is what the lab image is. To confirm the backend:

```powershell
docker info
```

Its `Kernel Version:` line ends in `-microsoft-standard-WSL2`, and its
`Operating System:` line reads `Docker Desktop`.

### 2. Install on macOS

Download **Docker Desktop for Mac with Apple silicon** or **with Intel chip**
from the [Mac install page](https://docs.docker.com/desktop/setup/install/mac-install/),
whichever matches your Mac. Open `Docker.dmg`, drag Docker to **Applications**,
and open it from there. Accept the Docker Subscription Service Agreement, then
choose **Use recommended settings (Requires password)**.

To install from a terminal instead, with `Docker.dmg` in your Downloads
folder. bash (or zsh, macOS's default shell):

```bash
sudo hdiutil attach ~/Downloads/Docker.dmg
```

```bash
sudo /Volumes/Docker/Docker.app/Contents/MacOS/install
```

```bash
sudo hdiutil detach /Volumes/Docker
```

Docker's page warns that the `install` step "can take several minutes to run",
because macOS checks a new application the first time it is used.

**Verify:** `docker version` in a new terminal shows a `Server: Docker
Desktop` section with the version you installed.

How this was checked: every output quoted in this part was measured on
2026-09-29 on Windows 11 Pro, with Docker Desktop 4.93.0 already installed and
using the WSL 2 backend. The installer commands in steps 1 and 2, the WSL
update and the `.wslconfig` change in step 4 follow Docker's and Microsoft's
pages and were not re-run for this article, and nothing here was run on a Mac.

### 3. Find your way round the dashboard

Open Docker Desktop. The dashboard's left-hand navigation holds more than the
labs need; four views are the ones you will use, and each is the picture of a
command you can also type.

- **Containers** (`docker ps -a`). Every running and stopped container. While a
  lab container runs, it is listed here under a generated name. Select it for
  its **Logs**, **Inspect**, **Bind mounts**, **Files** and **Stats** tabs.
  **Bind mounts** shows your folder mapped to `/workspace`, and **Stats** shows
  its CPU and memory over time. The lab command's `--rm` removes the container
  when you exit, so it disappears from this list on its own.
- **Images** (`docker image ls`). Every image on disk, with its tag, size and
  whether any container uses it. `hybridcloudworks/hcw-lab` appears here after
  the first pull. This is also where you reclaim disk: select unused images and
  delete them.
- **Volumes** (`docker volume ls`). Named volumes, which Docker stores inside
  its VM. The lab command does not create one. `-v ${PWD}:/workspace` is a bind
  mount, your own folder shared into the container, so your files stay yours
  and survive the container. Nothing from the lab shows up here, and that is
  correct.
- **Builds**. Images you build yourself, as in part 1. A build started from the
  terminal ends with a `View build details: docker-desktop://dashboard/build/…`
  line that opens it here.

**Settings** is an icon in the dashboard's header, and the **Troubleshoot**
icon in the same header restarts Docker Desktop when something is stuck.
Docker's [dashboard guide](https://docs.docker.com/desktop/use-desktop/) covers
the rest.

### 4. Give it what the lab image needs

Four settings matter for this image. Defaults are fine on most machines; this
step is about knowing where each one lives before you need it.

**Memory and CPUs.** For scale: the browser workspaces on the labs page are
built on this same image and get one CPU and two gigabytes of memory each.
Terraform starts
one plugin process per provider configuration, so `terraform validate` on the
Landing Zone Builder's full default build was killed for lack of memory at
256 MB and passed at 512 MB, measured on 2026-09-27. Docker Desktop's defaults
give its VM half the machine's memory, which on any machine that meets the
requirements above is at least 2 GB, so the defaults cover both.

- **Windows, WSL 2 backend.** Docker Desktop has no memory or CPU slider in this
  mode. Docker's [settings page](https://docs.docker.com/desktop/settings-and-maintenance/settings/)
  says to "configure memory, CPU, and swap limits on the WSL 2 utility VM",
  which WSL reads from `%UserProfile%\.wslconfig`. By
  [Microsoft's reference](https://learn.microsoft.com/en-us/windows/wsl/wsl-config),
  the defaults are 50% of Windows' memory and every logical processor.
  Microsoft suggests the **WSL Settings** app in the Start menu for changing
  them. To edit the file directly instead, PowerShell:

  ```powershell
  $f = "$env:USERPROFILE\.wslconfig"; if (-not (Test-Path $f)) { New-Item -ItemType File -Path $f | Out-Null }; notepad $f
  ```

  It creates an empty file only if there is none, so an existing one is opened,
  not replaced. To cap the VM at Microsoft's own example values, twice what
  each browser workspace gets:

  ```ini
  [wsl2]
  memory=4GB
  processors=2
  ```

  Quit Docker Desktop, then apply it. WSL reads the file only when its VM
  starts:

  ```powershell
  wsl --shutdown
  ```

  Start Docker Desktop again. `docker info` then reports the new `CPUs:` and
  `Total Memory:`.
- **macOS.** **Settings**, **Resources**, **Advanced** holds **CPU limit**,
  **Memory limit** (by default 50% of the Mac's memory), **Swap** and **Disk
  usage limit**. Select **Apply** after a change.

**Disk.** The image takes 2.73 GB, and part 1's build leaves a cache on top.
`docker system df` shows what images, containers, volumes and build cache use,
and the **Images** view deletes what you no longer need. **Settings**,
**Resources**, **Advanced** also holds the disk image location, if the drive
it is on is short of space.

**File sharing.**

- **macOS** shares `/Users`, `/Volumes`, `/private`, `/tmp` and `/var/folders`
  with containers by default. A lab folder anywhere else fails with
  `Mounts denied` until you add it under **Settings**, **Resources**, **File
  sharing**.
- **Windows** needs no setting for a folder on a Windows drive. Docker's
  [WSL best practices](https://docs.docker.com/desktop/features/wsl/best-practices/)
  note that bind mounts from the Linux filesystem are much faster than from
  the Windows one. A lab folder holds a handful of small files, so keep it
  wherever is convenient, and move it into a WSL distribution if file
  operations in the container feel slow.

**Apple silicon.** The lab image is built for `linux/amd64` only; its
configuration on Docker Hub says so. On an Apple silicon Mac, Docker Desktop
runs it under emulation, and the **Images** view marks such an image with an
`amd64` chip, which Docker's guide says "can cause poor performance or
failures". **Settings**, **General**, **Use Rosetta for x86_64/amd64 emulation
on Apple Silicon** is the setting Docker describes as accelerating that
emulation; turn it on if it is off. Not measured on a Mac for this article.

### 5. Pull the lab image

PowerShell:

```powershell
$d = docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-lab:latest --format '{{.Manifest.Digest}}'; $d; docker pull "hybridcloudworks/hcw-lab@$d"
```

bash:

```bash
d=$(docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-lab:latest --format '{{.Manifest.Digest}}'); echo "$d"; docker pull "hybridcloudworks/hcw-lab@$d"
```

**Verify:**

```bash
docker image ls hybridcloudworks/hcw-lab
```

```text
IMAGE                             ID             DISK USAGE   CONTENT SIZE   EXTRA
hybridcloudworks/hcw-lab          ce7cc655da13       2.73GB          497MB
```

The ID changes whenever a new image is published. The two sizes are the ones
that matter: what the pull downloaded, and what it takes on disk. The image
also appears in the **Images** view.

### 6. Run the follow-along line in your folder

Change into the folder that holds your files first; the container mounts it
at `/workspace`. Then pick the line for the shell you are in.

PowerShell:

```powershell
docker run --rm -it -v ${PWD}:/workspace "hybridcloudworks/hcw-lab@$d"
```

bash:

```bash
docker run --rm -it -v "$PWD":/workspace "hybridcloudworks/hcw-lab@$d"
```

On Windows, use the PowerShell line. The bash line is for macOS, Linux and the
shell inside a WSL distribution; in Git Bash on Windows it starts a container
with an empty `/workspace` (see "When it doesn't work").

**Verify:** a `nobody@<container id>:/workspace$` prompt. Inside the
container (bash):

```bash
ls
```

lists your files, and

```bash
terraform version
```

prints

```text
Terraform v1.16.4
on linux_amd64
```

While it runs, the container is in the **Containers** view, and its **Bind
mounts** tab shows your folder. Type `exit` to leave; `--rm` deletes the
container, and your files stay where they were.

---

## How Desktop relates to Docker Engine on the lab host

Docker Desktop is not a different Docker. The `docker version` output in
step 1 shows a 29.8.1 client talking to `Server: Docker Desktop 4.93.0`,
whose `Engine` is Docker Engine 29.8.1. It is the same engine, running inside
the Linux VM that Desktop manages, and the `docker` command on your terminal
reaches it through a context Desktop sets up, `desktop-linux`.

The Hybrid Lab host, where the browser workspaces on the labs page run, is a
single Linux server with no Desktop at all. Docker Engine runs directly on
Ubuntu 26.04 LTS, installed from Docker's own apt repository, and the host's
configuration pins it to 29.8.1: the same engine release Desktop 4.93.0
bundles.

| | Docker Desktop on your machine | Docker Engine on the Hybrid Lab host |
| --- | --- | --- |
| Engine | 29.8.1, inside a Linux VM Desktop manages (the WSL 2 utility VM on Windows) | 29.8.1, directly on Ubuntu 26.04 LTS |
| The image | Pinned by digest from `docker.io/hybridcloudworks/hcw-lab:latest` | Browser workspaces built on the same image |
| Your folder | Shared into the VM by Desktop's file sharing | A directory on the same Linux machine |
| Resources | What you give the VM (step 4) | One CPU and two gigabytes per browser workspace |
| Licence | Docker Subscription Service Agreement | Docker Engine's open-source licence |

**The difference you can see is file ownership.** Desktop shares your folder
into its VM through a file-sharing layer, and on Windows the container sees
your files as owned by root and writable by everyone. The container runs as
uid 65534, Debian's `nobody`, and can still write beside your files. Measured
on 2026-09-29 with Docker Desktop 4.93.0 on Windows, after the container
created one file in a mounted folder:

```text
drwxrwxrwx 1 root   root    4096 Sep 29 05:57 .
drwxr-xr-x 1 root   root    4096 Sep 29 05:57 ..
-rwxrwxrwx 1 root   root      13 Sep 29 05:56 main.tf
-rw-r--r-- 1 nobody nogroup    0 Sep 29 05:57 written-by-container
```

Docker Engine on Linux has no such layer. A bind mount shows the files' real
owner and mode, so a folder owned by your own user, with the mode `mkdir`
usually gives it (755), is readable by uid 65534 and not writable. Reproduced
on 2026-09-29 inside Desktop's own Linux VM, where ownership passes through the
same way, with a directory owned by uid 1000, mode 755, mounted into the image:

```text
drwxr-xr-x 2 1000 1000 4096 Sep 29 05:57 .
drwxr-xr-x 3 root root 4096 Sep 29 05:57 ..
-rw-r--r-- 1 1000 1000   13 Sep 29 05:57 main.tf
terraform {}
touch: cannot touch 'probe': Permission denied
```

That is why the image sends everything its tools write to `/tmp` inside the
container, and why the lab host's own checks work on a copy of your files. On
Linux, expect the container to read your folder and not write to it. Part 1
explains how the image is built around that. How macOS's file sharing presents
ownership was not measured for this article.

---

## How to know it worked

- `docker version` shows `Server: Docker Desktop` and `OS/Arch: linux/amd64`
  (or `linux/arm64` on Apple silicon), and on Windows `docker info` shows a
  kernel ending `-microsoft-standard-WSL2`.
- `docker image ls hybridcloudworks/hcw-lab` shows `latest` at 2.73GB on disk
  and 497MB of content.
- The follow-along line gives a `nobody@<container id>:/workspace$` prompt,
  `ls` there lists your files, and `terraform version` prints
  `Terraform v1.16.4`.
- After `exit`, the container is gone from the **Containers** view and your
  files are unchanged.

---

## When it doesn't work

**`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running`**,
ending `The system cannot find the file specified.` Docker Desktop is not
running. The message names a pipe and a path, which reads like a broken
install; it is almost always a stopped app. Start Docker Desktop from the
Start menu, or from any terminal:

```bash
docker desktop start
```

`docker desktop status` then reports `Status` as `starting`, and then
`running`.

**The container starts, and `/workspace` is empty.** You ran the bash line in
Git Bash on Windows. Git Bash rewrites arguments that look like Unix paths
into Windows paths before Docker sees them, so the mount lands somewhere other
than your folder, with no error at all. Measured on 2026-09-29. Use the
PowerShell line on Windows, or the bash line inside a WSL distribution.

**`Mounts denied`** on macOS. Your folder is outside the directories Docker
Desktop shares by default. Move it under your home folder, or add its location
under **Settings**, **Resources**, **File sharing**.

**`wsl --version` shows no version details.** The WSL built into Windows is
too old for Docker Desktop, which needs 2.1.5 or later; Docker's best-practice
page lists hangs among what older versions cause. Run `wsl --update` from a
PowerShell window opened as administrator, then start Docker Desktop again.

**Slow, or failing only on an Apple silicon Mac.** The lab image is
`linux/amd64` and runs under emulation there. Check the Rosetta setting in
step 4.

---

## What's next

Part 1, "Building a lab image you can trust", reads the Dockerfile behind the
image you just ran: why every base image is pinned by digest, how it works with
the network off, why it runs as uid 65534, and how to verify its provenance
yourself. More on Docker is on the
[Docker page](https://hybridcloudworks.com/docker).

The labs are at <https://hybridcloudworks.com/education/labs>. Each also has
an **Open lab workspace** button, behind a GitHub sign-in, that opens a
workspace built on this same image on the Hybrid Lab host, in your browser, if
you would rather not install anything.
