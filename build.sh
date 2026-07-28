#!/bin/zsh
set -e
cd "$(dirname "$0")"

APP=build/Yap.app
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O Sources/*.swift -o "$APP/Contents/MacOS/Yap"
cp Info.plist "$APP/Contents/Info.plist"
cp assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# A stable signing identity keeps the Accessibility grant across rebuilds.
# Falls back to ad-hoc if no Apple Development certificate exists.
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/{print $2; exit}')
codesign --force --sign "${IDENTITY:--}" "$APP"

echo "Built $APP"
