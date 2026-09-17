#!/bin/zsh
set -e
cd "$(dirname "$0")"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc Sources/Stats.swift Sources/History.swift Sources/Settings.swift Sources/Wav.swift \
    Tests/StatsTests.swift -o "$TEST_DIR/StatsTests"
"$TEST_DIR/StatsTests"
