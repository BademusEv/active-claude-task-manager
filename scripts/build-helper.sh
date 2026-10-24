#!/bin/sh
# Compiles the frontmost-app helper (helper/front.swift -> build/front). The
# widget runs without it, only hiding with Claude and the "skip notifications
# while Claude is in front" check are off; so with `--optional` (npm install)
# a missing Swift compiler is a warning, not a failure.
set -e
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found: install the Xcode Command Line Tools with  xcode-select --install" >&2
  [ "$1" = "--optional" ] && exit 0
  exit 1
fi
mkdir -p build
swiftc -O -o build/front helper/front.swift
echo "built build/front"
