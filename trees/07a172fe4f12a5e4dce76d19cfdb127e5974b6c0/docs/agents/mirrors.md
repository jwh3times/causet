# Agent and skill mirrors

`AGENTS.md` is canonical repository guidance; `CLAUDE.md` imports it.
The mirror generator handles separate agent definitions and skill assets:

| Authored source | Generated output |
| --- | --- |
| `.claude/agents/*.md` | `.codex/agents/*.toml` |
| `.agents/skills/` | `.claude/skills/` |

Run `npm run sync:agents` after changing a source, and include the generated
files with the change. CI runs `npm run sync:agents -- --check`, which reports
missing, changed, and orphaned files without writing. Regeneration removes
orphaned files in both generated trees; keep authored files in the source trees.
Missing source directories are treated as empty. Symlinks in mirror trees
are rejected; use real files and directories.

## Agent definitions

Each top-level Markdown agent definition needs YAML frontmatter containing
nonempty, single-line `name` and `description` fields, followed by instructions.
Use plain scalars, single-quoted scalars (double an embedded apostrophe), or
JSON-compatible double-quoted scalars. Block scalars are unsupported.

The generator emits `name`, `description`, and `developer_instructions` in
the corresponding TOML file. Claude-specific model and tool fields are omitted.
Instruction bodies use literal multiline TOML strings, preserving backslashes
and double quotes, normalizing CRLF to LF, and ending with a newline.
Bodies containing three consecutive apostrophes or unsupported control
characters fail validation before any output changes.

## Skill assets

The complete skill tree is mirrored, including references, scripts, and binary
assets. Each `SKILL.md` receives a generated-file comment immediately after
the opening YAML delimiter and uses LF newlines. Other files are copied byte
for byte. Edit `.agents/skills/` and regenerate instead of editing the mirror.
