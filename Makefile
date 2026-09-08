# The binary embeds the viewer (web/dist, built by Vite), so the web build comes first.
#   make            the release binary, viewer included
#   make web        the viewer only (Node 24)
#   make test       cargo test, with the viewer built
#   make run ARGS='--no-tls --listen 127.0.0.1:8080 --exec foot'
#   make docker     the container image
#   make docker-run the image, built if needed, on port 8443 (ARGS go to elsewhere)
#   make version     the Git-derived build version
#   make check-version test version derivation (Python 3 and Git)
#   make package-deb Debian package (cargo-deb and dpkg required)
#   make package-tar tarball for the current distribution
#   make package-arch Arch package (makepkg, run as a non-root user)
#   make clean

.PHONY: all build web test run docker docker-run clean version check-version package-deb package-tar package-arch
# Package targets share Cargo and viewer build outputs.
.NOTPARALLEL:

all: build

build: web
	version=$${ELSEWHERE_VERSION:-$$(sh scripts/version.sh)} && ELSEWHERE_VERSION="$$version" cargo build --release --locked

version:
	@sh scripts/version.sh

check-version:
	python3 scripts/check-version.py

package-deb package-tar package-arch:
	sh scripts/package.sh $(@:package-%=%)

WEB_SRC := $(shell find web/src) web/index.html web/vite.config.js web/package.json web/package-lock.json LICENSE
DIST := web/dist/index.html web/dist/app.js web/dist/app.css web/dist/THIRD_PARTY.txt

web: $(DIST)

$(DIST) &: web/node_modules/.package-lock.json $(WEB_SRC)
	cd web && npm run build

web/node_modules/.package-lock.json: web/package-lock.json
	cd web && npm ci --no-audit --no-fund

test: web
	cargo test --workspace --locked

run: web
	cargo run --release --locked -- $(ARGS)

docker:
	docker build -t elsewhere .

# the render node's group, for hosts where it isn't world-accessible
docker-run: docker
	docker run --rm --device /dev/dri --group-add $$(stat -c %g /dev/dri/renderD128) --shm-size 1g \
		-p 8443:8443 -p 8443:8443/udp -v elsewhere-data:/home/elsewhere/.config/elsewhere elsewhere $(ARGS)

clean:
	rm -rf web/dist target dist
