#!/usr/bin/env python3
"""Refresh dependency credits after cargo fetch and npm ci in web."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
metadata = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--locked", "--format-version", "1"], cwd=root))
entries = []


def notice(directory, explicit=None):
    paths = set(
        path for path in directory.iterdir()
        if path.is_file() and path.name.lower().startswith(("license", "licence", "copying", "notice", "copyright"))) if directory.is_dir() else set()
    if explicit:
        paths.add(directory / explicit)
    return "\n\n".join(path.read_text().strip() for path in sorted(paths) if path.is_file())


for package in metadata["packages"]:
    if package["id"] in metadata["workspace_members"]:
        continue
    entries.append(("Rust", package["name"], package["version"], package["license"],
                    notice(Path(package["manifest_path"]).parent, package["license_file"])))

lock = json.loads((root / "web/package-lock.json").read_text())
for path, package in lock["packages"].items():
    if not path or package.get("link"):
        continue
    if not (root / "web" / path).is_dir() and not package.get("optional", False):
        raise RuntimeError("Run npm ci in web before refreshing acknowledgements")
    name = package.get("name") or path.rsplit("node_modules/", 1)[-1]
    entries.append(("JavaScript", name, package["version"], package.get("license"),
                    notice(root / "web" / path)))

text = """# Acknowledgements

Elsewhere is made possible by these open source projects and their contributors.

FFmpeg, PipeWire, WirePlumber, Mesa, libva, libxkbcommon and Xwayland provide native
media and desktop services. Their system packages include their notices and source
information; see [native dependencies](https://github.com/ryanpetris/elsewhere/blob/master/docs/native-dependencies.md).

The following credits cover the Rust and JavaScript dependency locks, including
build tools and platform dependencies. Full notice text is included where present
in the installed package; other entries give the package's declared license.
Run `python3 scripts/acknowledgements.py` after fetching Cargo dependencies and
running `npm ci` in `web` to refresh this file.
"""
for kind, name, version, license_name, body in sorted(set(entries)):
    if not body and not license_name:
        raise RuntimeError(f"Missing license for {kind} dependency {name} {version}")
    text += f"\n## {name} {version} ({kind})\n\n"
    text += "\n".join("    " + line.expandtabs().rstrip() if line.strip() else "" for line in
                      (body or f"License: {license_name}").splitlines()) + "\n"

(root / "ACKNOWLEDGEMENTS.md").write_text(text)
