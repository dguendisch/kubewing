# All toolchain caches live in .cache/ inside the repo (see .cache/env.sh).
# Go modules: `make deps` downloads them (needs network; may need to run
# outside a sandbox because some modules ship .vscode/ folders).
SHELL := /bin/bash
ROOT  := $(CURDIR)
export GOPATH     := $(ROOT)/.cache/gopath
export GOMODCACHE := $(ROOT)/.cache/gopath/pkg/mod
export GOCACHE    := $(ROOT)/.cache/gobuild
export GOBIN      := $(ROOT)/.cache/bin
export GOFLAGS    := -modcacherw
export npm_config_cache := $(ROOT)/.cache/npm
export PLAYWRIGHT_BROWSERS_PATH := $(ROOT)/.cache/ms-playwright
NPM_BIN := frontend/node_modules/.bin

# The release tag is the only place the version lives (see scripts/release.sh): v0.2.0 → 0.2.0,
# commits after it 0.2.0-3-gabc1234, uncommitted changes -dirty. CI passes VERSION= from the tag.
VERSION ?= $(shell git describe --tags --match 'v[0-9]*' --dirty 2>/dev/null | sed 's/^v//')
ifeq ($(VERSION),)
VERSION := 0.0.0-dev
endif
# Info.plist's CFBundleShortVersionString takes numbers only: 0.2.0-rc.1 → 0.2.0
SHORT_VERSION := $(shell echo '$(VERSION)' | sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
# The release signing key's public half (build/release-key.pub, see Development.md): without it a build
# checks for updates but can't install them.
RELEASE_KEY := $(shell cat build/release-key.pub 2>/dev/null)
LDFLAGS := -X github.com/dguendisch/kubewing/internal/app.Version=$(VERSION) -X github.com/dguendisch/kubewing/internal/update.PublicKey=$(RELEASE_KEY)
DIST := bin/kubewing-$(VERSION)-macos-arm64.zip

.PHONY: deps frontend build app dist sign release icon run headless test test-go test-fe e2e golden-update lint

deps:
	go mod download all
	cd frontend && npm install
	cd frontend && ./node_modules/.bin/playwright install chromium

frontend:
	cd frontend && ./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build --mode production

build: frontend
	go build -trimpath -ldflags '$(LDFLAGS)' -o bin/kubewing .

# macOS shows a bare binary as a generic "exec" in the Dock; a minimal bundle gives it the real icon.
# Exec'ing the bundled binary (not `open`) keeps stdout/stderr and flags in this terminal.
# The binary goes in as a fresh file, not an overwrite: the kernel caches a binary's signature
# per vnode, and a changed binary under the old one is killed at launch (SIGKILL, Code Signature Invalid).
APP := bin/kubewing.app
app: build
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp build/darwin/Info.plist $(APP)/Contents/
	plutil -replace CFBundleShortVersionString -string '$(SHORT_VERSION)' $(APP)/Contents/Info.plist
	plutil -replace CFBundleVersion -string '$(VERSION)' $(APP)/Contents/Info.plist
	cp build/darwin/icons.icns $(APP)/Contents/Resources/
	rm -f $(APP)/Contents/MacOS/kubewing
	cp bin/kubewing $(APP)/Contents/MacOS/

# The downloadable release asset (built by .github/workflows/release.yml). Not notarized: no paid Apple
# account. An ad-hoc signature over the whole bundle (not just the binary, which the linker signs) keeps
# a download from being "damaged"; ditto, not zip, keeps the bundle's metadata intact.
dist: app
	codesign --force --deep --sign - $(APP)
	codesign --verify --deep --strict $(APP)
	rm -f $(DIST) $(DIST).sha256
	ditto -c -k --keepParent $(APP) $(DIST)
	cd bin && shasum -a 256 $(notdir $(DIST)) > $(notdir $(DIST)).sha256
	@echo "built $(DIST)"

# Signs the release zip for the updater ($(DIST).sig); the key is the KUBEWING_SIGNING_KEY secret.
sign:
	go run ./internal/update/cmd/releasesign $(DIST)

# Tags the next release locally (notes from Changelog.md; a final commits its stamped changelog first);
# pushing is yours, and the tag's push makes the GitHub release.
# BUMP=patch|minor|major, RC=1 for a release candidate, DRY=1 to only show, SKIP_TESTS=1.
release:
	BUMP='$(BUMP)' RC='$(RC)' DRY='$(DRY)' SKIP_TESTS='$(SKIP_TESTS)' scripts/release.sh

run: app
	./$(APP)/Contents/MacOS/kubewing -wait

# Headless backend for browser dev / E2E: replays testdata/tapes (or uses kubeconfig without TAPES=).
TAPES ?= testdata/tapes
headless:
	go run . -headless 127.0.0.1:7777 $(if $(TAPES),-tapes $(TAPES) -catalog testdata/catalog.yaml)

test: lint test-go test-fe

test-go:
	go vet ./...
	go test -race ./internal/... -skip 'TestBridgeBudgetUnderEventStorm'
	go test ./internal/bridge -run 'TestBridgeBudgetUnderEventStorm'

test-fe:
	cd frontend && ./node_modules/.bin/tsc -b && ./node_modules/.bin/vitest run

# Chromium needs Mach ports, so this cannot run inside the macOS sandbox.
e2e:
	cd frontend && ./node_modules/.bin/playwright test

# Goldens are the spec: regenerate deliberately and review the diff on its own.
golden-update:
	go test ./internal/view -run TestGolden -update
	git diff --stat -- internal/view/testdata

lint:
	@test -z "$$(gofmt -l main.go internal)" || (gofmt -l main.go internal; exit 1)
	cd frontend && node scripts/lint-tokens.mjs

# build/appicon.svg is the source; the PNG and .icns are committed so builds need no rsvg-convert.
# iconutil needs the system temp dir, so this cannot run inside the macOS sandbox.
icon:
	rsvg-convert -w 1024 -h 1024 build/appicon.svg -o build/appicon.png
	cp build/appicon.svg frontend/public/favicon.svg
	rm -rf bin/icons.iconset && mkdir -p bin/icons.iconset
	for s in 16 32 128 256 512; do \
	  rsvg-convert -w $$s -h $$s build/appicon.svg -o bin/icons.iconset/icon_$${s}x$${s}.png; \
	  rsvg-convert -w $$((s*2)) -h $$((s*2)) build/appicon.svg -o bin/icons.iconset/icon_$${s}x$${s}@2x.png; \
	done
	iconutil -c icns bin/icons.iconset -o build/darwin/icons.icns
	rm -rf bin/icons.iconset
