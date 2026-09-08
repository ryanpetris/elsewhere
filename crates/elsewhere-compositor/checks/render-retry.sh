#!/bin/sh
# Run from the repository root inside the Docker rig.
set -eu
retry_root=$(mktemp -d /tmp/elsewhere-render-retry-XXXXXX)
trap 'rm -rf "$retry_root"' EXIT
mkdir -m 700 "$retry_root/runtime"
wayland-scanner client-header /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml "$retry_root/xdg-shell-client-protocol.h"
wayland-scanner private-code /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml "$retry_root/xdg-shell-protocol.c"
cc -I"$retry_root" crates/elsewhere-compositor/checks/thumbnail-client.c "$retry_root/xdg-shell-protocol.c" -lwayland-client -o "$retry_root/source"
XDG_RUNTIME_DIR="$retry_root/runtime" cargo run -p elsewhere-compositor --example check-render-retry -- "$retry_root/source" "$retry_root/commands"
