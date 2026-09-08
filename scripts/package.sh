#!/bin/sh
# Native package tools build the checkout; every artifact is written to dist.
set -eu

kind=${1:?expected deb, tar or arch}
ELSEWHERE_VERSION=$(sh scripts/version.sh)
export ELSEWHERE_VERSION
build_dir=${CARGO_TARGET_DIR:-target}
mkdir -p dist
if [ "$kind" = deb ] || [ "$kind" = tar ]; then
    . /etc/os-release
    distribution="$ID${VERSION_ID:+-$VERSION_ID}"
    case "$distribution" in *[!a-zA-Z0-9._-]*|'') echo "Invalid distribution label" >&2; exit 1 ;; esac
fi
case "$kind" in
    deb)
        make build
        package_version=$(printf '%s' "${ELSEWHERE_VERSION#v}" | tr '-' '.')
        cargo deb -p elsewhere --locked --no-build --deb-version "$package_version-1" \
            --output "dist/elsewhere_${package_version}-1_${distribution}_$(dpkg --print-architecture).deb"
        ;;
    tar)
        make build
        name=elsewhere-$ELSEWHERE_VERSION-$distribution-$(uname -m)
        stage=$(mktemp -d dist/.tar-XXXXXX)
        trap 'rm -rf "$stage"' EXIT
        mkdir "$stage/$name"
        cp "$build_dir/release/elsewhere" README.md LICENSE ACKNOWLEDGEMENTS.md docs/audio-visualiser.md docs/session-audio.md docs/native-dependencies.md "$stage/$name/"
        strip "$stage/$name/elsewhere"
        tar -C "$stage" -czf "dist/$name.tar.gz" "$name"
        ;;
    arch)
        export PKGDEST="$(pwd)/dist"
        cd packaging/arch
        makepkg -f --noconfirm
        ;;
    *) echo "Unknown package type: $kind" >&2; exit 1 ;;
esac
