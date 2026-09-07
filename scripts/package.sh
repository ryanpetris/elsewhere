#!/bin/sh
# Native package tools build the checkout; every artifact is written to dist.
set -eu

kind=${1:?expected deb, tar or arch}
ELSEWHERE_VERSION=$(sh scripts/version.sh)
export ELSEWHERE_VERSION
mkdir -p dist
case "$kind" in
    deb)
        make build
        package_version=$(printf '%s' "${ELSEWHERE_VERSION#v}" | tr '-' '.')
        cargo deb -p elsewhere --locked --no-build --deb-version "$package_version-1" \
            --output "dist/elsewhere_${ELSEWHERE_VERSION}-1_$(dpkg --print-architecture).deb"
        ;;
    tar)
        make build
        name=elsewhere-$ELSEWHERE_VERSION-linux-$(uname -m)
        stage=$(mktemp -d dist/.tar-XXXXXX)
        trap 'rm -rf "$stage"' EXIT
        mkdir "$stage/$name"
        cp target/release/elsewhere README.md LICENSE docs/audio-visualiser.md docs/session-audio.md web/dist/THIRD_PARTY.txt "$stage/$name/"
        strip "$stage/$name/elsewhere"
        tar -C "$stage" -czf "dist/$name.tar.gz" "$name"
        ;;
    arch)
        export PKGDEST="$(pwd)/dist"
        cd packaging/arch
        makepkg -f --noconfirm
        package=$(makepkg --packagelist)
        suffix=${package##*.pkg.tar}
        mv "$package" "$PKGDEST/elsewhere-$ELSEWHERE_VERSION-1-$(uname -m).pkg.tar$suffix"
        ;;
    *) echo "Unknown package type: $kind" >&2; exit 1 ;;
esac
