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

.PHONY: deps frontend build run headless test test-go test-fe e2e golden-update lint

deps:
	go mod download all
	cd frontend && npm install
	cd frontend && ./node_modules/.bin/playwright install chromium

frontend:
	cd frontend && ./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build --mode production

build: frontend
	go build -o bin/kubewing .

run: build
	./bin/kubewing

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
