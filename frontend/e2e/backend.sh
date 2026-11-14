#!/bin/bash
# Playwright's backend: stage fixtures, never repair them in application code.
set -eu
cd "$(dirname "$0")/../.."

umask 077
tmp=$(mktemp -d "${TMPDIR:-/tmp}/kubewing-e2e.XXXXXX")
pid=
cleanup() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir "$tmp/garden" "$tmp/garden/sessions" "$tmp/state"
cp testdata/garden/gardenctl-v2.yaml "$tmp/garden/"
for target in testdata/garden/sessions/*/target.yaml; do
  [ -f "$target" ] || continue
  session=$(basename "$(dirname "$target")")
  mkdir "$tmp/garden/sessions/$session"
  cp -p "$target" "$tmp/garden/sessions/$session/target.yaml"
  chmod 600 "$tmp/garden/sessions/$session/target.yaml"
done

# Make supplies the repo-local Go caches. Build first so the tracked process
# is the backend itself, not go run (which can leave its executable behind).
export GOPROXY=off GOFLAGS=-mod=mod
go build -o "$tmp/backend" .
# Include headless shells' separate temporary tree in the launcher's cleanup.
export TMPDIR="$tmp" KUBECONFIG="$tmp/kubeconfig"
: > "$KUBECONFIG"
"$tmp/backend" -headless 127.0.0.1:7777 \
  -tapes testdata/tapes -catalog testdata/catalog.yaml \
  -config testdata/config -garden "$tmp/garden" \
  -releases testdata/releases.json -releases-current 0.1.0 -state "$tmp/state" &
pid=$!
wait "$pid"
