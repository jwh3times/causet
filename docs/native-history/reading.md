# Reading history: `log` and `show`

The third part of the [native history contract](README.md). It defines what
`cst log` and `cst show` print in a native repository: ADR-0046 decision 2's
output rules, as
[ADR-0047](../adr/0047-build-n2-as-native-history-with-a-fact-log-and-an-operation-log.md)
decision 12 applies them to N2's reads. Both are experimental, behind
`CAUSET_EXPERIMENTAL=native`, and read native commits and tags alone. They
start no Git process.

## 1. Three outputs

| Asked for | Output | Contract |
| --- | --- | --- |
| `--format=<template>` | Git's `--format`, byte for byte | §2, with Git's output on the Git-backed original as the oracle, IDs translated ([commits.md §6](commits.md#6-naming-commits)) |
| `--json` | `causet.log/v1` or `causet.show/v1` | the [schema catalog](../schemas/README.md) |
| neither | cst's own human output | §5; it is for people and promises no layout to scripts |

`--json` and `--format` together are refused (`usage-conflicting-options`). A
refusal under `--json` is the failure envelope (ADR-0021).

## 2. `--format`

`--format=` and `--pretty=` take `format:<t>`, `tformat:<t>`, or a template
with a `%`, as Git's `get_commit_format` reads them. An empty value is an
empty `tformat:`. A placeholder prints as Git's `pretty.c` prints it:

- **IDs:** `%H %h %T %t %P %p`, each a native ID. An abbreviation is the
  shortest unique prefix, at least as long as Git's `core.abbrev=auto` makes
  one (commits.md §6).
- **Identities:** `%an %ae %al`, `%ad %aD %ar %at %ai %aI %as`, and the
  committer's `%c…`. `%ad` and `%cd` follow `--date`.
- **Message:** `%s %f %b %B %e`, and `%(trailers[:options])` with every
  option Git has: `key`, `only`, `unfold`, `separator`,
  `key_value_separator`, `keyonly` and `valueonly`. A trailer block is found
  as Git finds one with no trailer configuration.
- **Layout:** `%n %% %x<hex>`, `%m`, the `%+`, `%-` and `% ` prefixes,
  padding and truncation (`%<(…)` and the rest), and wrapping (`%w(…)`).
- **Colour:** cst never colours. Every `%C…` prints what Git prints when its
  output is not a terminal: nothing.
- **Unknown:** a placeholder Git does not know prints as Git prints it, `%`
  and all.

An ISO-8859-1 message is re-encoded to UTF-8, as Git re-encodes it. A message
in bytes that are not UTF-8 prints as it is stored.

### 2.1 Refused placeholders

These are refused before anything prints, with `unsupported-feature`. Each
reads something native history does not hold yet, or the host's time zone or
terminal:

| Placeholder | Why |
| --- | --- |
| `%d %D %S %(decorate) %(describe)` | They read names, beside a `HEAD` that is no name (#455). |
| `%N` | A native repository holds records as facts, and a fact keeps no note's bytes (facts.md §6). |
| `%g…` | A native repository keeps no reflog. |
| `%G…` | Native history carries no Git signatures (commits.md §7.1). |
| `%aN %aE %aL`, `%cN %cE %cL` | No mailmap is read. |
| `%ah %ch` | A human date reads the host's time zone. |
| `%<\|(-<n>)` and the like | A column counted back from the terminal's width. |
| `%C(always,…)` | cst never colours. |

Re-encoding from an encoding other than ISO-8859-1 or UTF-8 is refused when a
commit needs it. So are padding and wrapping of text that is UTF-8 but not
ASCII, because its width needs Git's tables of character widths.

## 3. `log`

`cst log [<options>] [<revision>...]` walks as Git's revision walk does. By
default it walks from `HEAD`. A revision is `<rev>`, `^<rev>` or `<a>..<b>`,
where an empty side is `HEAD`.

- **Order:** newest first by commit date, a merge's parents waiting behind
  every commit of their date already waiting.
- **Ranges:** Git's `limit_list`, with its slop of five commits, so a history
  whose dates are out of step with its shape prints what Git prints.
- **Options:** `-<n>`, `-n <n>` and `--max-count=<n>`; `--skip=<n>`;
  `--reverse`; `--first-parent`; `--merges` and `--no-merges`;
  `--date=<mode>` and `--relative-date`; `-s` and `--no-patch`, which change
  nothing.
- **Date modes:** `default`, `relative`, `short`, `iso`, `iso-strict`, `rfc`,
  `raw` and `unix`, under Git's spellings. A relative date is in English.
  `local` and `human` read the host's time zone, and `auto:` its terminal, so
  they are refused. So is `format:`, which hands its template to the C
  library's `strftime`, whose output differs from one platform to another.

Refused, each with a registered code:

- `a...b` and `--not`;
- paths;
- Git's named formats, `--oneline` and `--pretty` among them, which are its
  human output;
- a patch, such as `-p` or `--stat`;
- every other option.

## 4. `show`

`cst show [-s] [<options>] [<object>...]` shows each object named. By default
it shows `HEAD`.

- **A commit** prints as one `log` entry.
- **An annotated tag** prints as `git show` prints one, then what it tags:
  `tag <name>`, `Tagger: <name> <<email>>` when the tagger line has an email,
  a blank line and the message, signature and all. A tag of a tag repeats
  this, down to the commit.
- **Once only:** a commit already shown, as what a tag tags or by name, is not
  shown again, as Git's `SHOWN` flag decides.
- **With `--format`:** it needs `-s`. Without `-s`, Git follows each commit
  with a patch, which no phase builds yet.
- **Refused:** a tree or a blob, named or tagged.

## 5. Human output

Without `--format` or `--json`, each commit prints as follows, with a blank
line between entries:

```
commit <native ID>
Merge:   <parent> <parent>                       a merge only, parents abbreviated
Author:  <name> <<email>>                        or the line as it is, when Git cannot split it
Date:    <author date in --date's mode>          when the line has one
Commit:  <name> <<email>>, <date>                when it differs from the author's
Change:  <changeId>                              when it has one
Lineage: derived from <id>; origin <commit>      when it has either
Actors:  <role> by <actor> (<kind>, for <whom>)  when it has any; ";" between actors

    <message, each line indented by four spaces>
```

A tag prints as `tag <name> <native ID>`, then `Tagger:`, `Date:`,
`Actors:` and its message in the same way, followed by what it tags. A date
Git's `log` dies on prints as its digits and zone.

## 6. Where Git cannot be matched

- **A commit with no message.** Git's `%B` of one reads past the end of the
  commit's buffer and prints whatever follows it. cst prints nothing.
- **The walk's date.** Git orders by the committer line straight after the
  first author line. A native commit keeps the last committer line, so a
  commit whose header repeats or reorders those lines may walk in another
  place. No Git writes one.
- **A NUL in a commit's header.** Git reads the commit as a C string, so a
  NUL in an identity line ends every line after it too. A native commit keeps
  each line whole, and cst cuts each at its own first NUL. No Git writes one.
- **Repeated tagger lines.** `git show` prints a `Tagger:` line for each, and
  a native tag keeps the first.
- **A tag whose message is empty.** A native tag holds no difference between
  a blank line before an empty message and no blank line, so `show` prints
  neither. Git writes no such tag.
