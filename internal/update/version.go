package update

import (
	"fmt"
	"slices"
	"strings"

	"golang.org/x/mod/semver"
)

// AssetName is the release zip of a version (Makefile's DIST).
func AssetName(version string) string {
	return "kubewing-" + version + "-macos-arm64.zip"
}

// Released reports whether version is a release build: a final (0.2.0) or
// a candidate (0.2.0-rc.1). Development builds (dev, 0.0.0-dev, commits
// after a tag as 0.2.0-3-gabc1234, -dirty) are never updated: the person
// building them knows better.
func Released(version string) bool {
	v := "v" + version
	// canonical: all three numbers (semver takes "v0.1" as v0.1.0), no build metadata
	if !semver.IsValid(v) || semver.Canonical(v) != v {
		return false
	}
	pre := semver.Prerelease(v)
	return pre == "" || isRC(pre)
}

// isRC: "-rc.N" is the only pre-release make release tags.
func isRC(pre string) bool {
	n, ok := strings.CutPrefix(pre, "-rc.")
	if !ok || n == "" {
		return false
	}
	for _, c := range n {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// Version is a release's version without the tag's "v"; "" for a tag that
// isn't one of make release's.
func (r Release) Version() string {
	v := strings.TrimPrefix(r.Tag, "v")
	if !strings.HasPrefix(r.Tag, "v") || !Released(v) {
		return ""
	}
	return v
}

// Note is one version's release notes (Markdown: Changelog.md's section).
type Note struct {
	Version    string `json:"version"`
	Date       string `json:"date,omitempty"` // YYYY-MM-DD
	Prerelease bool   `json:"prerelease,omitempty"`
	Body       string `json:"body"`
	URL        string `json:"url,omitempty"`
}

// Offer is a newer version than the running one.
type Offer struct {
	Version    string `json:"version"`
	Prerelease bool   `json:"prerelease,omitempty"`
	// Notes: the offered version's and every final's in between, newest first.
	Notes []Note `json:"notes"`
	// URL is the release page.
	URL string `json:"url"`
	// Size of the download in bytes.
	Size int64 `json:"size"`

	release Release
}

// Pick finds the newest release above current that has the zip: finals
// only, candidates too with prereleases. The notes are the target's and those
// of every final between current and it. A candidate's notes accumulate until
// its final (see make release), so earlier candidates add nothing.
func Pick(rs []Release, current string, prereleases bool) (Offer, bool) {
	if !Released(current) {
		return Offer{}, false
	}
	cur := "v" + current
	var best *Release
	for i := range rs {
		r := &rs[i]
		v := r.Version()
		if r.Draft || v == "" || (r.Prerelease && !prereleases) || semver.Compare("v"+v, cur) <= 0 {
			continue
		}
		if _, ok := r.Asset(AssetName(v)); !ok {
			continue // still uploading, or a release without the macOS zip
		}
		if best == nil || semver.Compare("v"+v, "v"+best.Version()) > 0 {
			best = r
		}
	}
	if best == nil {
		return Offer{}, false
	}
	target := "v" + best.Version()
	var notes []Note
	for _, r := range rs {
		v := r.Version()
		if r.Draft || v == "" || semver.Compare("v"+v, cur) <= 0 || semver.Compare("v"+v, target) > 0 {
			continue
		}
		if r.Tag != best.Tag && r.Prerelease {
			continue
		}
		notes = append(notes, note(r))
	}
	sortNotes(notes)
	a, _ := best.Asset(AssetName(best.Version()))
	return Offer{Version: best.Version(), Prerelease: best.Prerelease, Notes: notes, URL: best.URL, Size: a.Size, release: *best}, true
}

func note(r Release) Note {
	n := Note{Version: r.Version(), Prerelease: r.Prerelease, Body: strings.TrimSpace(r.Body), URL: r.URL}
	if !r.Published.IsZero() {
		n.Date = r.Published.Format("2006-01-02")
	}
	return n
}

// sortNotes: newest version first.
func sortNotes(ns []Note) {
	slices.SortFunc(ns, func(a, b Note) int { return semver.Compare("v"+b.Version, "v"+a.Version) })
}

// digest parses GitHub's "sha256:<hex>".
func digest(d string) (string, error) {
	hex, ok := strings.CutPrefix(d, "sha256:")
	if !ok || len(hex) != 64 {
		return "", fmt.Errorf("no sha256 digest (%q)", d)
	}
	return strings.ToLower(hex), nil
}
