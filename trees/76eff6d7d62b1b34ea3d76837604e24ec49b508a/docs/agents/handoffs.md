# Handoffs

## Map key

causet

## Extra document content

- Whether `refs/notes/causet` and `refs/causet/retention` match `origin`
  (`git for-each-ref refs/notes/causet refs/causet/retention` beside
  `git ls-remote origin refs/notes/causet refs/causet/retention`): they are published data, and a
  note recorded on this machine but not pushed is unmerged work.
- A branch landed with `cst merge --compact` but never reset onto `main` still lists as unmerged;
  list it with what was observed, and let the owner judge.
