#!/usr/bin/env python3
"""Archive a retired macOS bundle and forward its path to the installed app.

Run after replacing an app while its tmux descendants are still running.
Keeping a differently signed .app at their original responsibility path causes
TCC to alternate permission records between the old and new app signatures.
"""

import argparse
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import zipfile


def bundle_id(app):
    with (app / "Contents/Info.plist").open("rb") as stream:
        identifier = plistlib.load(stream).get("CFBundleIdentifier")
    if not identifier:
        raise ValueError(f"Missing bundle identifier: {app}")
    return identifier


def retire(backup, installed):
    backup = Path(backup).absolute()
    installed = Path(installed).resolve(strict=True)
    if backup.is_symlink():
        if backup.resolve() == installed:
            return backup.with_suffix(".zip")
        raise ValueError("Backup already points to a different app")
    if backup.suffix != ".app" or installed.suffix != ".app":
        raise ValueError("Both paths must be app bundles")
    original = backup.resolve(strict=True)
    if original == installed or original in installed.parents or installed in original.parents:
        raise ValueError("Backup and installed app must be separate bundles")
    if bundle_id(backup) != bundle_id(installed):
        raise ValueError("Backup and installed app have different bundle identifiers")
    for app in (backup, installed):
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)

    archive = backup.with_suffix(".zip")
    # Reserve the archive so an existing recovery copy is never overwritten.
    with archive.open("xb"):
        pass
    try:
        subprocess.run([
            "ditto", "-c", "-k", "--keepParent", "--norsrc", str(backup), str(archive)
        ], check=True)
        with zipfile.ZipFile(archive) as saved:
            if saved.testzip() or backup.name + "/Contents/Info.plist" not in saved.namelist():
                raise ValueError("Backup archive verification failed")
    except BaseException:
        archive.unlink(missing_ok=True)
        raise

    # Prepare the redirect before retiring the bundle. The installed bundle is
    # untouched, and the complete old bundle remains recoverable from the ZIP.
    with tempfile.TemporaryDirectory(prefix=".app-redirect-", dir=backup.parent) as stage:
        redirect = Path(stage) / backup.name
        redirect.symlink_to(installed, target_is_directory=True)
        shutil.rmtree(backup)
        redirect.replace(backup)
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup", type=Path, help="Retired .app moved aside during an update")
    parser.add_argument("installed", type=Path, help="Current installed .app with the same bundle ID")
    args = parser.parse_args()
    print(f"Retired app archived at {retire(args.backup, args.installed)}")
