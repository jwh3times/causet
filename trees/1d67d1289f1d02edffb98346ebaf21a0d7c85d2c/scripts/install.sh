#!/bin/sh
# Install the prebuilt `cst` executable of causet from a GitHub release
# (ADR-0038, amendment of 2026-10-08). Needs no Node.js and no npm.
#
#   sh install.sh [--version <x.y.z>] [--prefix <directory>]
#                 [--target <rust-target>] [--from <url-or-directory>]
#
# It downloads SHA256SUMS and this host's archive, refuses an archive whose
# SHA-256 is not the listed one, and copies `cst` (and the `vlab` alias) into
# the prefix, ~/.local/bin by default. It changes no shell profile and asks
# for no elevation. To upgrade, run it again. To uninstall, delete the two
# files it names when it finishes.

set -eu

repository="https://github.com/jwh3times/causet"
version=""
prefix="${HOME:-}/.local/bin"
target=""
from=""

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--prefix|--target|--from)
      [ "$#" -ge 2 ] || fail "$1 needs a value."
      case "$1" in
        --version) version="${2#v}" ;;
        --prefix) prefix="$2" ;;
        --target) target="$2" ;;
        --from) from="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "Unknown option '$1'. Use --version, --prefix, --target or --from." ;;
  esac
done

if [ -z "$target" ]; then
  system=$(uname -s)
  machine=$(uname -m)
  case "$machine" in
    x86_64|amd64) machine="x86_64" ;;
    aarch64|arm64) machine="aarch64" ;;
  esac
  case "$system" in
    Linux)
      # glibc and musl executables are not interchangeable.
      if ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 || true) | grep -qi musl; then
        target="$machine-unknown-linux-musl"
      else
        target="$machine-unknown-linux-gnu"
      fi
      ;;
    Darwin) target="$machine-apple-darwin" ;;
    *) target="$machine-unknown-$system" ;;
  esac
fi

if [ -z "$from" ]; then
  if [ -n "$version" ]; then
    from="$repository/releases/download/v$version"
  else
    from="$repository/releases/latest/download"
  fi
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

# Copy one release file into the work directory, from a directory or a URL.
fetch() {
  case "$from" in
    http://*|https://*)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$from/$1" -o "$work/$1" || return 1
      elif command -v wget >/dev/null 2>&1; then
        wget -q "$from/$1" -O "$work/$1" || return 1
      else
        fail "Neither curl nor wget is available to download $from/$1."
      fi
      ;;
    *) cp "$from/$1" "$work/$1" 2>/dev/null || return 1 ;;
  esac
}

fetch SHA256SUMS || fail "SHA256SUMS could not be read from $from."

# The archive for this target, at the requested version or the one listed.
if [ -n "$version" ]; then
  archive="cst-$version-$target.tar.gz"
  grep -q "  $archive\$" "$work/SHA256SUMS" || archive=""
else
  archive=$(sed -n "s/^[0-9a-f]\{64\}  \(cst-[^ ]*-$target\.tar\.gz\)\$/\1/p" "$work/SHA256SUMS" | head -n 1)
fi
if [ -z "$archive" ]; then
  fail "This release lists no cst archive for $target${version:+ at version $version}.
Prebuilt executables are published for a few platforms only. The npm package
@holland-vip/causet carries the JavaScript CLI for every other one:
  npm install -g @holland-vip/causet"
fi
expected=$(sed -n "s/^\([0-9a-f]\{64\}\)  $archive\$/\1/p" "$work/SHA256SUMS" | head -n 1)
[ -n "$expected" ] || fail "SHA256SUMS lists no digest for $archive."

fetch "$archive" || fail "$archive could not be read from $from."

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$archive" | cut -d ' ' -f 1)
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$work/$archive" | cut -d ' ' -f 1)
else
  fail "Neither sha256sum nor shasum is available to check $archive."
fi
if [ "$actual" != "$expected" ]; then
  fail "$archive has SHA-256 $actual, not the $expected its release lists. Nothing was installed."
fi

mkdir "$work/unpacked"
tar -xzf "$work/$archive" -C "$work/unpacked"
[ -f "$work/unpacked/cst" ] || fail "$archive holds no cst executable."
chmod 755 "$work/unpacked/cst"

released="${archive#cst-}"
released="${released%-"$target".tar.gz}"
reported=$("$work/unpacked/cst" --version 2>/dev/null || true)
if [ "$reported" != "causet $released" ]; then
  fail "The executable in $archive reports '$reported', not 'causet $released'. Nothing was installed."
fi

mkdir -p "$prefix"
# Copied beside its destination and renamed, so a running cst is never half written.
cp "$work/unpacked/cst" "$prefix/.cst.new"
mv -f "$prefix/.cst.new" "$prefix/cst"
ln -sf cst "$prefix/vlab"

printf 'Installed causet %s (%s):\n  %s\n  %s -> cst\n' "$released" "$target" "$prefix/cst" "$prefix/vlab"
case ":${PATH:-}:" in
  *":$prefix:"*) ;;
  *) printf '\n%s is not on PATH. Add it for this shell with:\n  export PATH="%s:$PATH"\n' "$prefix" "$prefix" ;;
esac
