### Fixed

- **Asking `cst fetch`, `pull`, `push` or `clone` for help now shows Git's help and moves no
  records (#499).** `cst push --help` used to publish the clone's notes and retention to the remote
  before Git printed its help. `cst fetch --help` and `cst pull --help` fetched records after Git's
  help exited, and `cst clone --help` failed with an error about the cloned directory. Help is read
  the way Git's option parser reads it: `--help`, `--help-all`, `-h`, or a cluster of short options
  that reaches `h` (`-qh`). An option's value (`push -o -h`, `push -oh`) and anything after `--` are
  not help, so those commands still move records. Help with `--json` is refused with
  `usage-unknown-option`, as `cst pull --json` is, because Git prints its help on standard output.
