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
# Ad-hoc signatures change every build, which makes macOS forget the grant.
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/{print $2; exit}')
if [ -z "$IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Yap Local Signing/{print $2; exit}')
fi
if [ -z "$IDENTITY" ]; then
  TMP=$(mktemp -d)
  cat > "$TMP/cert.conf" << 'EOF'
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = Yap Local Signing
[ ext ]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
  openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -days 3650 -nodes -config "$TMP/cert.conf"
  # Modern PKCS12 defaults use a MAC that `security import` rejects.
  openssl pkcs12 -export -out "$TMP/cert.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "Yap Local Signing" -passout pass:yap -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
  security import "$TMP/cert.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P yap -A
  security add-trusted-cert -r trustRoot -p codeSign -k "$HOME/Library/Keychains/login.keychain-db" "$TMP/cert.pem"
  rm -rf "$TMP"
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Yap Local Signing/{print $2; exit}')
fi
codesign --force --sign "${IDENTITY:--}" "$APP"

echo "Built $APP"
