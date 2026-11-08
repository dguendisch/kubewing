#!/usr/bin/env bash
# The monthly dependency routine (Development.md, Dependencies). Needs network.
#
#   deps.sh outdated   report only: Go modules and toolchain, npm packages, Node, the workflow's
#                      actions, and known vulnerabilities (govulncheck, npm audit); changes nothing.
#                      The npm table says what `update` does with each (takes, cooldown, by hand).
#   deps.sh update     the safe part: Go's direct modules to their latest (k8s.io only within its
#                      minor, wails held), the Go toolchain to its latest patch, npm packages within
#                      package.json's ranges (only releases older than AGE days), Playwright's
#                      Chromium; then `make frontend test`
#
# Majors, held packages, Node and the actions stay deliberate, one change each (see Development.md).
# Usually via make: `make outdated`, `make update`. Go's and npm's caches come from the Makefile.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "deps: $*" >&2; exit 1; }
section() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# Bumped only by hand: wails' Go module and its npm runtime (@wailsio/runtime, pinned exactly) must
# match, and internal/app/zoom_darwin.go calls private methods of it. k8s.io modules move together
# and only within their minor.
GO_HOLD=(github.com/wailsapp/wails/v3)
GO_SAME_MINOR='^k8s\.io/'
# npm releases younger than this are left out: a compromised release is usually caught within days.
AGE=${AGE:-7}
GOVULNCHECK=${GOVULNCHECK:-golang.org/x/vuln/cmd/govulncheck@latest}

held() { local m; for m in "${GO_HOLD[@]}"; do [[ $1 == "$m" ]] && return 0; done; return 1; }
minor() { sed -E 's/^(v?[0-9]+\.[0-9]+).*/\1/' <<<"$1"; }

# govulncheck's findings that the code reaches, one block each: id, title, where found, where fixed
vulns_go() {
	go run "$GOVULNCHECK" ./... 2>&1 | awk '
		/^Vulnerability #/ { print; title = ""; intitle = 1; next }
		intitle && /More info:/ { print "    " title; intitle = 0; next }
		intitle { sub(/^ +/, ""); title = title (title == "" ? "" : " ") $0; next }
		/^ +(Found|Fixed) in:/ { print }
		/^(Your code|No vulnerabilities)/ { print }
		/^govulncheck:|^go: / { print }' || true
}

# the modules whose vulnerabilities the code reaches, at the version fixing each: "path@version" lines
# (the standard library's have no dot in their first path element: the toolchain fixes those)
vuln_fixes_go() {
	go run "$GOVULNCHECK" ./... 2>/dev/null |
		awk '/^ +Fixed in: / { split($3, p, "/"); if (p[1] ~ /\./) print $3 }' |
		sort -u || true
}

go_toolchain() {
	local lang cur patch latest
	lang=$(awk '$1 == "go" { print $2 }' go.mod)
	cur=$(awk '$1 == "toolchain" { sub(/^go/, "", $2); print $2 }' go.mod)
	patch=$(go list -m -f '{{.Version}}' "go@$(minor "$lang")")
	latest=$(go list -m -f '{{.Version}}' go@latest)
	echo "go.mod: go $lang${cur:+, toolchain go$cur}   local: $(go env GOVERSION)"
	echo "latest $(minor "$lang").x: $patch   latest: $latest"
}

node_version() {
	local want tmp
	want=$(tr -d ' v\n' <.node-version)
	tmp=$(mktemp -d)
	# curl, not node's fetch: that ignores the HTTPS_PROXY a sandbox or a company network may need
	if curl -fsS https://raw.githubusercontent.com/nodejs/Release/main/schedule.json -o "$tmp/schedule.json" &&
		curl -fsS https://nodejs.org/dist/index.json -o "$tmp/index.json"; then
		node - "$want" "$tmp" <<-'EOF'
			const [want, dir] = [process.argv[2].split(".")[0], process.argv[3]];
			const schedule = require(`${dir}/schedule.json`), index = require(`${dir}/index.json`);
			const s = schedule[`v${want}`] || {};
			const today = new Date().toISOString().slice(0, 10);
			const eol = s.end ? (s.end <= today ? `END OF LIFE since ${s.end}` : `supported until ${s.end}`) : "unknown";
			const lts = index.find((r) => r.lts);
			const latestOf = index.find((r) => r.version.startsWith(`v${want}.`));
			console.log(`.node-version: ${want} (${eol}), latest ${want}.x: ${latestOf ? latestOf.version : "?"}, local: ${process.version}`);
			console.log(`latest LTS: ${lts.version} (${lts.lts})`);
		EOF
	else
		echo "couldn't check"
	fi
	rm -rf "$tmp"
}

# `uses: owner/repo@<sha> # vX.Y.Z` lines in the workflows: the newest release tag and its commit
actions() {
	local uses repo cur tags latest sha
	grep -ho 'uses: [^ ]*@[0-9a-f]\{40\} # v[0-9.]*' .github/workflows/*.yml | sort -u | while read -r _ uses _ cur; do
		repo=$(cut -d@ -f1 <<<"$uses" | cut -d/ -f1-2)
		tags=$(git ls-remote --tags "https://github.com/$repo" 'v*' 2>/dev/null) || { echo "$repo: couldn't list tags"; continue; }
		latest=$(awk '{ sub("refs/tags/", "", $2); sub(/\^\{\}$/, "", $2); print $2 }' <<<"$tags" |
			grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -uV | tail -n 1)
		if [[ $latest == "$cur" ]]; then
			echo "$repo $cur: up to date"
		else
			# an annotated tag's commit is its peeled ^{} line
			sha=$(awk -v t="refs/tags/$latest" '$2 == t "^{}" { print $1; f = 1 } END { if (!f) exit 1 }' <<<"$tags" ||
				awk -v t="refs/tags/$latest" '$2 == t { print $1 }' <<<"$tags")
			echo "$repo $cur -> $latest   uses: $(cut -d@ -f1 <<<"$uses")@$sha # $latest"
		fi
	done
}

# npm outdated's table, with what make update does about each: "Wanted" (the newest in package.json's
# range) may still be in its AGE-day cooldown, an exact version is held, a "Latest" beyond the range is
# a major (or a 0.x minor).
npm_outdated() {
	(cd frontend && node - "$AGE") <<-'EOF'
		const { execFileSync } = require("child_process");
		const age = Number(process.argv[2]);
		const day = 864e5;
		const date = (t) => new Date(t).toISOString().slice(0, 10);
		// as in update: releases before this day's start (UTC)
		const cutoff = new Date(date(Date.now() - age * day)).getTime();
		const npm = (...args) => {
			try {
				return execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			} catch (e) {
				return e.stdout; // npm outdated exits 1 when something is outdated
			}
		};
		const json = (...args) => JSON.parse(npm(...args, "--json") || "null");
		const pkg = require("./package.json");
		const specs = { ...pkg.dependencies, ...pkg.devDependencies };
		const outdated = json("outdated") || {};
		const rows = [["Package", "Current", "Wanted", "Latest", "make update"]];
		for (const [name, o] of Object.entries(outdated)) {
			const spec = specs[name] || "";
			const cur = o.current || "-";
			const notes = [];
			if (/^\d/.test(spec)) {
				notes.push("held (exact version): by hand");
			} else {
				if (o.wanted !== o.current) {
					const time = json("view", name, "time") || {};
					// the versions in range, oldest first; the newest out of its cooldown is what update takes
					const inRange = [].concat(json("view", `${name}@${spec}`, "version") || []);
					const ok = inRange.filter((v) => time[v] && new Date(time[v]).getTime() < cutoff).pop();
					// the first day the cutoff passes it: AGE + 1 days after its publishing day
					const pub = time[o.wanted] && date(time[o.wanted]);
					const from = pub ? date(new Date(pub).getTime() + (age + 1) * day) : "?";
					const cooling = `${o.wanted} from ${from} (published ${pub || "?"})`;
					if (ok === o.wanted) notes.push(`takes ${o.wanted}`);
					else if (ok && ok !== o.current) notes.push(`takes ${ok}; cooldown: ${cooling}`);
					else notes.push(`cooldown: ${cooling}`);
				}
				if (o.latest !== o.wanted) notes.push(`${o.latest} is beyond the range (major or 0.x minor): by hand`);
			}
			rows.push([name, cur, o.wanted, o.latest, notes.join("; ")]);
		}
		if (rows.length === 1) {
			console.log("all up to date");
		} else {
			const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
			for (const r of rows) console.log(r.map((c, i) => (i < r.length - 1 ? c.padEnd(w[i]) : c)).join("  "));
			console.log(`(cooldown: make update takes only releases older than ${age} days; AGE=${age})`);
		}
	EOF
}

outdated() {
	section "Go modules (direct)"
	local out
	out=$(go list -m -u -f '{{if and .Update (not .Indirect) (not .Main)}}{{.Path}} {{.Version}} -> {{.Update.Version}}{{end}}' all)
	if [[ -z $out ]]; then echo "all up to date"; else
		while read -r path rest; do
			note=
			held "$path" && note="   (held: bump by hand)"
			[[ $path =~ $GO_SAME_MINOR ]] && note="   (update: within $(minor "${rest%% *}") only)"
			echo "$path $rest$note"
		done <<<"$out"
	fi
	echo "(new major versions of Go modules are new module paths and don't show here)"

	section "Go toolchain"
	go_toolchain

	section "npm packages (frontend)"
	npm_outdated

	section "Node"
	node_version

	section "GitHub Actions (.github/workflows)"
	actions

	section "Vulnerabilities: Go (govulncheck)"
	vulns_go

	section "Vulnerabilities: npm (npm audit)"
	(cd frontend && npm audit) || true
}

update() {
	[[ -z $(git status --porcelain -- go.mod go.sum frontend/package.json frontend/package-lock.json) ]] ||
		die "go.mod, go.sum or frontend/package*.json have uncommitted changes: commit or stash them first, so the update is a diff of its own"

	section "Go modules"
	# Direct modules only: their own requirements decide the indirect ones (go get -u would raise
	# those to their latest too, e.g. k8s.io's pseudo-versioned helpers, past what k8s.io was tested with).
	local args=() path ver
	while read -r path ver; do
		held "$path" && { echo "held: $path $ver"; continue; }
		if [[ $path =~ $GO_SAME_MINOR ]]; then args+=("$path@$(minor "$ver")"); else args+=("$path@latest"); fi
	done < <(go list -m -f '{{if not (or .Indirect .Main)}}{{.Path}} {{.Version}}{{end}}' all)
	go get "${args[@]}" toolchain@patch
	go mod tidy
	# an indirect module the code reaches a vulnerability in: raised to the version that fixes it
	local fixes
	fixes=$(vuln_fixes_go)
	if [[ -n $fixes ]]; then
		echo "raising for vulnerabilities:" $fixes
		# shellcheck disable=SC2086 # one module@version per word
		go get $fixes
		go mod tidy
	fi

	section "npm packages"
	local before
	before=$(node -e "console.log(new Date(Date.now() - $AGE * 864e5).toISOString().slice(0, 10))")
	echo "within package.json's ranges, released before $before"
	# Only the packages with a range: the exact (held) ones may be younger than AGE (a hand-made bump
	# like wails'), and a plain `npm update --before` fails on any locked version newer than the date.
	(
		cd frontend
		local ranged=() name
		while read -r name; do ranged+=("$name"); done < <(node -e '
			const p = require("./package.json");
			for (const [n, v] of Object.entries({ ...p.dependencies, ...p.devDependencies }))
				if (!/^\d/.test(v)) console.log(n);')
		npm update "${ranged[@]}" --before="$before" --no-audit --no-fund
	)

	section "Playwright Chromium"
	# a new @playwright/test wants its own browser build
	(cd frontend && ./node_modules/.bin/playwright install chromium)

	section "Tests"
	make frontend test

	section "Changes"
	git diff --stat -- go.mod go.sum frontend/package.json frontend/package-lock.json

	section "Remaining vulnerabilities: Go"
	vulns_go
	echo
	echo "Next: make e2e (outside the sandbox), then look at what make outdated still lists (see Development.md)."
}

case ${1:-} in
outdated) outdated ;;
update) update ;;
*) die "usage: $0 outdated|update" ;;
esac
