# Agent and skill mirrors

`AGENTS.md` is canonical repository guidance; `CLAUDE.md` imports it.
`scripts/sync-agents.mjs` generates the harness-specific copies of separate
agent definitions and skill assets:

| Authored source | Generated output |
| --- | --- |
| `.claude/agents/*.md` | `.codex/agents/*.toml` |
| `.agents/skills/` | `.claude/skills/` |

Run `npm run sync:agents` after changing a source, and include the generated
files with the change. CI runs `npm run sync:agents:check`, which reports
missing, changed, and orphaned files without writing. Regeneration removes
orphaned files and the empty directories they leave in both generated trees;
keep authored files in the source trees. Missing source directories are
treated as empty. A symlink in an authored tree (or an authored tree that is
itself a symlink) is an error; use real files and directories. A symlink in a
generated tree is reported as orphaned and removed without being followed;
regeneration removes such links before writing anything, so a
`.claude/skills/<name>` that `npx skills update` linked to its source is
replaced by a copy rather than written through.
`node scripts/sync-agents.mjs --hook` is the Claude Code PostToolUse form: it
reads the hook payload on stdin and regenerates only when the edited file is
under an authored tree.

`npm run lint:agents` (`scripts/lint-agent-neutrality.mjs`, also a step of
CI's `static checks` job) checks that the authored sources read correctly from
both trees: no artifacts of a blind `claude`-to-`Codex` substitution (`.Codex/`
paths), no relative link that resolves from the source directory but not from
the mirrored one, and no bare positional parameter (`$` followed by a digit) in
a skill body, which Claude Code replaces with the invocation's argument words;
write a named or braced variable instead.

The generator, the lint and their tests (`scripts/sync-agents.test.mjs`,
`scripts/lint-agent-neutrality.test.mjs`) are copies of the canonical ones in
`jwh3times/skills`. Do not adapt them locally; fix them there, then copy them
here.

## Agent definitions

Each top-level Markdown agent definition needs YAML frontmatter containing
nonempty `name` and `description` fields, followed by instructions. `name`
must match the filename. The frontmatter parser accepts a small YAML subset:
plain scalars (which may continue on indented lines), single-quoted scalars
(double an embedded apostrophe), JSON-compatible double-quoted scalars, `- item`
lists, and comments. Block scalars, control characters other than tab, and any
other line shape are rejected before any output changes.

The generator emits `name`, `description`, and `developer_instructions` in
the corresponding TOML file, plus `sandbox_mode = "read-only"` when a `tools`
list names no file-writing tool (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`).
Claude-specific `model`, `color`, and tool fields are otherwise omitted.
Instruction bodies use a literal multiline TOML string, preserving backslashes
and double quotes and normalizing CRLF to LF; the closing `'''` follows the
body's last line. A body a literal string cannot hold (one containing `'''`
or ending in an apostrophe) falls back to an escaped basic multiline string.

## Skill assets

The complete skill tree is mirrored, including references, scripts, and binary
assets. Each `SKILL.md` receives a generated-file comment immediately after
the opening YAML delimiter and uses LF newlines. Other files are copied byte
for byte. Edit `.agents/skills/` and regenerate instead of editing the mirror.
