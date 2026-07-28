#!/bin/zsh
set -e
cd "$(dirname "$0")"

APP=build/Yap.app
rm -rf build
mkdir -p "$APP/Contents/MacOS"

swiftc -O Sources/*.swift -o "$APP/Contents/MacOS/Yap"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"

echo "Built $APP"
