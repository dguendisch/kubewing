package app

// Version is this build's release, without the tag's "v" (0.2.0, 0.2.0-rc.1;
// 0.2.0-3-gabc1234 for commits after a tag). The Makefile sets it from the git
// tag (-ldflags -X); a plain `go build` stays "dev".
var Version = "dev"
