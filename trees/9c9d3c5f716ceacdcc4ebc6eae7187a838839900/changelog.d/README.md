# Changelog fragments

Each branch writes its changelog entries here, in one file named for the branch with each `/`
replaced by `-` (`feat/470-cst-tag-list` → `feat-470-cst-tag-list.md`). `/ship` writes it; never
edit `CHANGELOG.md` on a branch.

A fragment holds only category headings and their bullets, with no version or date, using Keep a
Changelog's categories:

```markdown
### Added

- **`cst tag` lists native tags with their targets.** ...

### Fixed

- **`cst log` no longer stops at a merge whose second parent is missing.** ...
```

Name a file in backticks rather than linking it: a relative link resolves from `changelog.d/` on
the branch but from the repository root once stamped into `CHANGELOG.md`, so it breaks in one place
or the other.

After the landing, `.github/workflows/version.yml` runs `scripts/stamp-changelog.mjs`, which moves
the fragments that landing added into its dated section of `CHANGELOG.md`, deletes them, and tags
the landing (`docs/adr/0049-stamp-each-landings-changelog-section-and-tag-after-it-lands.md`). A
landing with no fragment gets one `### Changed` bullet from its title. A fragment already on `main`
belongs to the landing that added it: never edit or delete it, and the changelog check rejects a
branch that does. This README is not a fragment.
