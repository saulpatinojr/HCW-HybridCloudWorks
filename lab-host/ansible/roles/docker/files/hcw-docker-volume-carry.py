#!/usr/bin/python3
"""Copy a Docker named volume's data into the user-namespaced data root.

Installed by the docker role as /usr/local/libexec/hcw-docker-volume-carry
and run by it once per volume, on the run that turns userns-remap on (LAB-5,
2026-10-07). With userns-remap the daemon keeps its objects under
/var/lib/docker/<uid>.<gid> and no longer sees /var/lib/docker/volumes, so a
volume that holds state (Coder's PostgreSQL cluster, Portainer's database)
would come back empty. This copies the old data into the new, empty volume of
the same name.

A remapped container's uid N is the remapped range's first uid plus N on the
host, so data a remapped container will own is shifted by that base
(--uid-shift, --gid-shift). Data a container opted out of the remap for
(--userns=host, which Portainer uses to reach the socket) keeps its owners
(shifts of 0).

Copy, never move: the source is only read. The copy is made beside the
destination and renamed into place, so an interrupted run leaves either the
empty volume or the finished copy, never half of one. It refuses, changing
nothing, when the destination already holds anything, because then a
container has started on it and the data there is not this copy's to replace.

    hcw-docker-volume-carry --from SRC --to DST --uid-shift N --gid-shift N

Exits 0 with one summary line on stdout, non-zero with the reason on stderr.
"""

import argparse
import os
import shutil
import stat
import subprocess
import sys

# userns-remap allocates 65536 subordinate ids; a uid at or above that has no
# place in the remapped range.
RANGE = 65536
# cp by its full path, so this root-run helper never runs a cp found earlier
# on PATH. Ubuntu's merged /usr puts coreutils there (/bin is a link to it).
CP = "/usr/bin/cp"


def fail(message):
    print(f"hcw-docker-volume-carry: {message}", file=sys.stderr)
    sys.exit(1)


def shift_owner(path, uid_shift, gid_shift, seen):
    """Shift one inode's owner and group by the given bases, keeping its mode.

    `seen` holds the inodes already shifted: a hard link is a second name for
    the same inode, and shifting it twice would move it out of the range.
    Returns 1 when this call shifted the inode, 0 when it was seen before.
    """
    st = os.lstat(path)
    if (st.st_dev, st.st_ino) in seen:
        return 0
    seen.add((st.st_dev, st.st_ino))
    if st.st_uid >= RANGE or st.st_gid >= RANGE:
        fail(
            f"{path} is owned by {st.st_uid}:{st.st_gid}, outside the {RANGE} ids a remapped "
            "container can use; refusing to guess where it belongs"
        )
    os.lchown(path, st.st_uid + uid_shift, st.st_gid + gid_shift)
    # chown clears setuid and setgid on files, even for root; put the mode back.
    if not stat.S_ISLNK(st.st_mode):
        os.chmod(path, stat.S_IMODE(st.st_mode))
    return 1


def shift_tree(root, uid_shift, gid_shift):
    """Shift every inode under root, root included; returns how many."""
    seen = set()
    count = shift_owner(root, uid_shift, gid_shift, seen)
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            count += shift_owner(os.path.join(parent, name), uid_shift, gid_shift, seen)
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--from", dest="source", required=True)
    parser.add_argument("--to", dest="destination", required=True)
    parser.add_argument("--uid-shift", type=int, required=True)
    parser.add_argument("--gid-shift", type=int, required=True)
    args = parser.parse_args()

    source = os.path.realpath(args.source)
    destination = os.path.realpath(args.destination)
    if not os.path.isdir(source):
        fail(f"{source} is not a directory")
    if not os.path.isdir(destination):
        fail(f"{destination} is not a directory; create the volume first")
    if os.listdir(destination):
        fail(
            f"{destination} is not empty, so a container has already started on this volume in the "
            f"remapped root. Nothing was changed, and {source} is untouched. To carry it: stop the "
            "container using the volume, remove the volume (docker volume rm), and re-run bootstrap.sh."
        )
    if args.uid_shift < 0 or args.gid_shift < 0:
        fail("the shifts are the remapped range's first uid and gid, never negative")

    staging = destination.rstrip("/") + ".hcw-carry"
    if os.path.lexists(staging):
        shutil.rmtree(staging)
    # cp -a keeps modes, timestamps, hard links, symlinks and extended
    # attributes, which PostgreSQL's data directory relies on (its mode 0700
    # above all).
    subprocess.run([CP, "-a", "--", source, staging], check=True)  # nosec B603 - list argv, cp by full path, no shell
    shifted = 0
    if args.uid_shift or args.gid_shift:
        try:
            shifted = shift_tree(staging, args.uid_shift, args.gid_shift)
        except BaseException:
            # A refused owner leaves no half-shifted copy behind.
            shutil.rmtree(staging, ignore_errors=True)
            raise
    os.rmdir(destination)
    os.rename(staging, destination)
    print(
        f"carried {source} -> {destination} "
        f"(uid +{args.uid_shift}, gid +{args.gid_shift}, {shifted} inodes re-owned)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
