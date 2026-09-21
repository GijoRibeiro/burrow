#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
stage=$(mktemp -d /tmp/cloovies-awake-test.XXXXXX)
trap 'rm -rf "$stage"' EXIT
swiftc app/keep-awake.swift app/keep-awake-tests.swift -framework IOKit -o "$stage/test"
"$stage/test"
