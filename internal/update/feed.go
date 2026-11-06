// Package update keeps kubewing up to date from its GitHub releases: it
// checks the release feed on a schedule (update.checkDays), offers a newer
// version with the release notes of every version in between, and installs
// it in place (download, verify, swap the bundle, relaunch; see install.go).
package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Repo is where the releases are published.
const Repo = "dguendisch/kubewing"

// FeedURL lists the newest releases: one request gives the versions, their
// notes and their assets (with digests). Anonymous: 60 requests an hour,
// far more than a daily check needs.
const FeedURL = "https://api.github.com/repos/" + Repo + "/releases?per_page=50"

// Release is one GitHub release, as far as the updater needs it.
type Release struct {
	Tag        string    `json:"tag_name"`
	Name       string    `json:"name"`
	Body       string    `json:"body"`
	Draft      bool      `json:"draft"`
	Prerelease bool      `json:"prerelease"`
	Published  time.Time `json:"published_at"`
	URL        string    `json:"html_url"`
	Assets     []Asset   `json:"assets"`
}

// Asset is a release's file.
type Asset struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	// URL downloads it (browser_download_url: anonymous, redirects to the CDN).
	URL string `json:"browser_download_url"`
	// Digest is GitHub's "sha256:<hex>" of the file ("" on releases before GitHub computed them).
	Digest string `json:"digest"`
}

// Asset returns the release's asset by name.
func (r Release) Asset(name string) (Asset, bool) {
	for _, a := range r.Assets {
		if a.Name == name {
			return a, true
		}
	}
	return Asset{}, false
}

// Feed fetches the releases, newest first.
type Feed interface {
	Releases(ctx context.Context) ([]Release, error)
}

// GitHub is the real feed.
type GitHub struct {
	Client *http.Client
	URL    string // "" = FeedURL
}

// Releases implements Feed.
func (g GitHub) Releases(ctx context.Context) ([]Release, error) {
	url := g.URL
	if url == "" {
		url = FeedURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := client(g.Client).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
			return nil, fmt.Errorf("GitHub's rate limit for anonymous requests is used up, try again later")
		}
		return nil, fmt.Errorf("GitHub answered %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	var rs []Release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&rs); err != nil {
		return nil, fmt.Errorf("reading the release list: %w", err)
	}
	return rs, nil
}

// File is a feed read from a JSON file in GitHub's format (the headless
// backend's -releases flag: tests, never the network).
type File string

// Releases implements Feed.
func (f File) Releases(context.Context) ([]Release, error) {
	b, err := os.ReadFile(string(f))
	if err != nil {
		return nil, err
	}
	var rs []Release
	if err := json.Unmarshal(b, &rs); err != nil {
		return nil, fmt.Errorf("%s: %w", f, err)
	}
	return rs, nil
}

func client(c *http.Client) *http.Client {
	if c != nil {
		return c
	}
	return &http.Client{Timeout: 30 * time.Second}
}
