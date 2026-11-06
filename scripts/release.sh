#!/usr/bin/env bash
# Tags the next kubewing release on the current commit; pushing the tag is left to you,
# and that push makes the GitHub release (.github/workflows/release.yml).
#
#   BUMP=patch|minor|major  the step from the newest final release (none yet: from 0.0.0)
#   RC=1                    a release candidate: vX.Y.Z-rc.N, N counting up per X.Y.Z;
#                           without RC=1, the same BUMP promotes those candidates to vX.Y.Z
#   DRY=1                   only show what would happen
#   SKIP_TESTS=1            don't run `make test` first (e.g. promoting a tested candidate)
#
# Usually via make: `make release BUMP=minor RC=1`.
# The release notes are Changelog.md's [Unreleased] section. A final also stamps that section with
# its version and date, committed as "release: vX.Y.Z" before tagging; a candidate commits nothing.
# The tag is the only place the version lives otherwise (see Architecture.md, Releases).
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "release: $*" >&2; exit 1; }
truthy() { [[ -n ${1:-} && $1 != 0 && $1 != false ]]; }

BUMP=${BUMP:-}
case $BUMP in
patch | minor | major) ;;
*) die "BUMP=patch|minor|major is required (RC=1 for a release candidate, DRY=1 to only show)" ;;
esac
truthy "${RC:-}" && rc=1 || rc=
truthy "${DRY:-}" && dry=1 || dry=

# --- the commit: main, clean, and the same as on GitHub ---
branch=$(git symbolic-ref --quiet --short HEAD || true)
[[ $branch == main ]] || die "releases are tagged on main (on: ${branch:-a detached HEAD})"
[[ -z $(git status --porcelain) ]] || die "the working tree has changes: commit or stash them first"
git fetch --quiet --tags origin main
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] ||
	die "main isn't origin/main: push (or pull) first, so the tag lands on a commit GitHub has"

# --- the next version ---
final_re='^v([0-9]+)\.([0-9]+)\.([0-9]+)$'
base_tag=$(git tag --list 'v[0-9]*' --sort=-v:refname | grep -E "$final_re" | head -n 1 || true)
if [[ $base_tag =~ $final_re ]]; then
	major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]}
else
	major=0 minor=0 patch=0
fi
case $BUMP in
major) major=$((major + 1)) minor=0 patch=0 ;;
minor) minor=$((minor + 1)) patch=0 ;;
patch) patch=$((patch + 1)) ;;
esac
target=v$major.$minor.$patch

# candidates of the target so far, highest N (numerically: rc.10 after rc.9)
last_rc=0
for t in $(git tag --list "$target-rc.*"); do
	n=${t#"$target-rc."}
	[[ $n =~ ^[0-9]+$ ]] && ((n > last_rc)) && last_rc=$n
done

if [[ -n $rc ]]; then
	tag=$target-rc.$((last_rc + 1))
	# notes since the previous candidate, else since the last final
	if ((last_rc > 0)); then since=$target-rc.$last_rc; else since=$base_tag; fi
else
	tag=$target
	since=$base_tag
fi
git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null && die "$tag already exists locally"
# one release per commit; only a final may join the candidates of its own version
for t in $(git tag --points-at HEAD --list 'v[0-9]*'); do
	[[ -z $rc && $t == "$target-rc."* ]] || die "this commit is already released as $t"
done
[[ -z $(git ls-remote --tags origin "refs/tags/$tag") ]] || die "$tag already exists on origin"

# --- release notes: Changelog.md's [Unreleased] section ---
# A candidate previews its version, so it gets the whole section too (not only what's new since
# the previous candidate).
range=HEAD
[[ -n $since ]] && range=$since..HEAD
(($(git rev-list --count "$range") > 0)) || die "no commits since $since"
[[ -f Changelog.md ]] || die "Changelog.md is missing"
grep -qx '## \[Unreleased\]' Changelog.md || die "Changelog.md has no '## [Unreleased]' section"
# the lines between "## [Unreleased]" and the next "## [", without leading and trailing blank lines
notes=$(awk '/^## \[/ { if (in_section) exit; in_section = ($0 == "## [Unreleased]"); next }
	in_section { if (NF) { printf "%s", blank; blank = ""; print; seen = 1 } else if (seen) blank = blank "\n" }' Changelog.md)
[[ -n $notes ]] || die "Changelog.md's [Unreleased] section is empty: add this release's changes there first"

version=${target#v}
today=$(date +%F)

echo "release: ${base_tag:-no release yet} → $tag ($BUMP${rc:+, candidate})"
if [[ -z $rc ]] && ((last_rc > 0)); then
	if [[ $(git rev-list -n 1 "$target-rc.$last_rc") == $(git rev-parse HEAD) ]]; then
		echo "         promotes $target-rc.$last_rc (same commit)"
	else
		echo "         promotes $target-rc.$last_rc, with commits made after it"
	fi
fi
echo "         on $(git log -1 --format='%h %s')"
[[ -z $rc ]] && echo "         Changelog.md: [Unreleased] becomes [$version] - $today, committed as 'release: $tag'"
echo "notes (Changelog.md, [Unreleased]):"
echo "$notes" | sed 's/^/  /'

if [[ -n $dry ]]; then
	echo "release: dry run, nothing tagged"
	exit 0
fi

if truthy "${SKIP_TESTS:-}"; then
	echo "release: skipping make test"
else
	make test || die "make test failed: nothing tagged"
fi

# --- a final stamps its version into Changelog.md, in a commit of its own ---
if [[ -z $rc ]]; then
	stamped=$(mktemp "${TMPDIR:-/tmp}/kubewing-changelog.XXXXXX")
	awk -v heading="## [$version] - $today" \
		'!done && $0 == "## [Unreleased]" { print; print ""; print heading; done = 1; next } { print }' \
		Changelog.md >"$stamped"
	cat "$stamped" >Changelog.md
	rm -f "$stamped"
	git commit --quiet --only Changelog.md -m "release: $tag"
fi

# --- the tag: annotated, its message is the release notes on GitHub ---
# --cleanup=whitespace keeps the notes' "### Added" headings (strip would drop them as comments)
printf 'kubewing %s\n\n%s\n' "$tag" "$notes" | git tag --annotate --cleanup=whitespace --file - "$tag"

if [[ -z $rc ]]; then
	cat <<EOF2

release: committed Changelog.md and tagged $tag (local only). To publish both:
  git push --atomic origin main $tag
To undo instead:
  git tag -d $tag && git reset --hard HEAD^
EOF2
else
	cat <<EOF2

release: tagged $tag (local only). To publish:
  git push origin $tag
To undo instead:
  git tag -d $tag
EOF2
fi
