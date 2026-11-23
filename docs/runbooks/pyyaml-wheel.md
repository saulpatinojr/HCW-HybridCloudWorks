# PyYAML wheel for the lab host: retired, kept as history

> **Status: retired on 2026-11-23 under
> [#1778](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1778).**
> The lab image and the lab host now install PyYAML 6.0.4 as an ordinary
> wheel (a ready-built Python package) from PyPI, checked against a SHA256
> written down beforehand, like every other Python package they install.
> Nothing here needs running any more. This page stays so that the two
> releases the old workflow made, and the one check that was kept, have an
> explanation.

## What this was

ansible-core (the tool that configures the lab host) imports PyYAML, a
Python library that reads YAML files. The lab image and the lab host both
install Python packages the same strict way: as wheels whose SHA256 is
pinned in
[`lab-image/versions.env`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-image/versions.env),
never built from source on the spot.

In November 2026 the base moved to CPython 3.15, and PyYAML 6.0.3, then its
newest release, had no wheel for that Python
([yaml/pyyaml#951](https://github.com/yaml/pyyaml/issues/951)). So, under
[#1505](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1505):

- the lab image built the wheel itself, from PyYAML's source archive, in a
  build step with no network;
- a workflow, `publish-pyyaml-wheel.yml`, took that one file out of the
  image build, attested it (a signed statement from GitHub saying which
  workflow, at which commit, built this exact file) and attached it to a
  release of this repository;
- the lab host downloaded the wheel from that release, checked its SHA256
  and its attestation with cosign, and installed it.

## Why it was retired

PyYAML 6.0.4 reached PyPI on 2026-11-20 with a wheel for CPython 3.15
([PyPI's listing for 6.0.4](https://pypi.org/pypi/PyYAML/6.0.4/json)). What
was checked on 2026-11-23, before anything was deleted:

- The file is
  `pyyaml-6.0.4-cp315-cp315-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl`,
  and the SHA256 PyPI lists for it equals the SHA256 of the downloaded
  file. That value is the `pyyaml==` line of `ANSIBLE_CORE_DEPS` in
  `versions.env`.
- It carries libyaml (the C library behind PyYAML's fast loader) inside
  itself. The wheel has no folder of bundled libraries, and `readelf -d` on
  its `yaml/_yaml.cpython-315-x86_64-linux-gnu.so` lists only `libc.so.6`
  and `libpthread.so.0` as needed at run time. That matters because neither
  the image nor the host's Python has a libyaml of its own.
- It runs on the C library both places have. The `manylinux_2_17` in the
  name means glibc (Linux's standard C library) 2.17 or newer; the image is
  Debian 13 and the host is Ubuntu 26.04 (24.04 is the fallback), all far
  newer, and the `cryptography` wheel on the same list already asks for
  glibc 2.34.
- The host runs the same Python line as the image (`PYTHON_VERSION` at the
  top of
  [`lab-host/bootstrap.sh`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/bootstrap.sh)
  and `BASE_PYTHON_VERSION` in `versions.env` are both 3.15.2), on the same
  kind of processor, so the one pinned wheel serves both. The host reads
  the same `ANSIBLE_CORE_DEPS` lines and installs them with
  `uv pip install --require-hashes --only-binary :all:`, so it cannot take
  a PyYAML whose SHA256 is not the pinned one.

## What went, and the one thing that stayed

The pull request for #1778 removed the build steps and the `pyyaml-wheel`
stage from `lab-image/Dockerfile`, the `PYYAML_*` block from `versions.env`,
the workflow and its two tests, and the block of `bootstrap.sh` that
downloaded the release file. Its description lists each item.

**One check was kept on purpose, against this page's own earlier list:**
the PyYAML line in
[`lab-image/smoke.sh`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-image/smoke.sh)
(the test that runs inside every built image). The old list said to delete
it. It stays, reworded, because it is now the only proof that the wheel
PyPI serves has the C loader: pip checks that the file is the pinned file,
not what the file can do. The check imports PyYAML in the image and fails
the build unless it prints the pinned version, `True` for
`yaml.__with_libyaml__` and `CSafeLoader`. A good run shows this line in
the `Build and smoke` job of
[`publish-lab-image.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/publish-lab-image.yml):

```text
ok:   PyYAML 6.0.4 with the libyaml C loader (PyPI's wheel)
```

## Bumping PyYAML from now on

PyYAML is one line of `ANSIBLE_CORE_DEPS`, moved the same way as the other
lines there; the steps are under "Updating a version" in the
[lab image README](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-image/README.md#updating-a-version).
Two things to know:

- The weekly pin bot (`scripts/lab-pins-upstream.mjs --bump image-base`)
  reads this line's SHA256 back from PyPI whenever it moves ansible-core,
  but it does not move the line itself. It only moves a dependency that
  ansible-core pins to one exact version, and ansible-core asks for
  `PyYAML>=5.1`, a range. The same is true of `jinja2`, `cryptography` and
  the other lines. A newer PyYAML is a hand bump.
- If a future base Python is newer than PyYAML's newest wheel, the build
  fails at the download step with pip saying it found no matching
  distribution for `pyyaml`. That is the situation #1505 solved; its pull
  requests are the worked example if it is ever needed again.

## The two releases it left behind

The workflow published two releases of this repository. They are not
releases of the site; each holds one wheel and its attestation.

| Release | Built for | Still used by |
| --- | --- | --- |
| [`pyyaml-6.0.3-cp315`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/releases/tag/pyyaml-6.0.3-cp315) | CPython 3.15 | A lab host that has not yet run `bootstrap.sh` from a commit after #1778, or one held back to an older commit |
| [`pyyaml-6.0.3-cp314`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/releases/tag/pyyaml-6.0.3-cp314) | CPython 3.14 | Only a host held back to a commit from before the move to 3.15 |

A session does not delete them. They cost nothing and can stay for good.
Deleting them is the owner's choice, and it is safe once both of these are
true:

1. The lab host has run `bootstrap.sh` from `main` after #1778 merged. This
   is PowerShell, on the owner's workstation:

   ```powershell
   ssh hcw-lab "sudo -n /opt/hcw-src/lab-host/bootstrap.sh"
   ```

   The run should end with `failed=0`. Then this line should print
   `6.0.4 True`:

   ```powershell
   ssh hcw-lab "/opt/uv/ansible-core/bin/python -c 'import yaml; print(yaml.__version__, yaml.__with_libyaml__)'"
   ```

   If it prints `6.0.3 True`, the host is still on the old wheel: read the
   end of the `bootstrap.sh` output for the reason before deleting anything.

2. Nobody plans to hold the host back to a commit from before #1778 (the
   `HCW_REPO_REF` setting in the
   [lab host README](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/README.md)).
   A host held back to such a commit downloads its wheel from the release
   whenever it has to build its ansible-core environment again, and stops
   with `refusing to run: could not download` if the release is gone.

**Deleting a release cannot be undone.** A wheel built again from the same
source would be a different file with a different SHA256, so the old
commits' pins could never be met again. To delete one, open its link in the
table above, choose the bin icon at the top right of the release, and
confirm with **Delete this release**. GitHub's steps are on
[Managing releases in a repository](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#deleting-a-release).
Deleting a release leaves its tag (the name on the commit) behind; the tag
is listed on the
[tags page](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tags) and
can be deleted there, or left: a tag with no release holds no file.
