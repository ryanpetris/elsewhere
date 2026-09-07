#!/bin/sh
# Nearest reachable release tag, commit distance, and checkout state.
set -eu

if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
    echo 'Fetch full history before deriving a package version.' >&2
    exit 1
fi
set --
for tag in $(git tag --list | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'); do
    set -- "$@" --match "$tag"
done
if [ "$#" = 0 ]; then
    echo 'No vX.Y.Z release tags; fetch tags before building.' >&2
    exit 1
fi
description=$(git describe --tags --long "$@") || {
    echo 'No reachable release tag; fetch release tags and history before building.' >&2
    exit 1
}
tag=${description%-*-*}
distance=${description#"$tag"-}
distance=${distance%-*}
version=$tag
if [ "$distance" != 0 ]; then version=$version.$distance; fi
status=$(git status --porcelain --untracked-files=normal)
if [ -n "$status" ]; then version=$version-dirty; fi
printf '%s\n' "$version"
