# Changelog
## [Unreleased]
### Added
- `⌘,` (**kubewing → Settings…**) edits `config.yaml` in the app: a reference of every setting beside it, problems shown as you type, `⌘S` saves and applies
- `b` in the YAML view (`⌘B` in the editor) shows who set each line, like kubectl-blame: the field manager owning it and how long ago, beside the YAML

## [0.2.0] - 2026-11-07
### Added
- auto-updates: kubewing checks for a new version daily (`update.checkDays`, `0` = off), shows its release notes, and installs it on request; also **kubewing → Check for Updates…**

## [0.1.0] - 2026-11-06
### Added
- First release of kubewing: see the [highlights](https://github.com/dguendisch/kubewing#highlights) and the [manual](https://github.com/dguendisch/kubewing/blob/main/Manual.md)
