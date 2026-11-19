#!/bin/bash
# HERDCODE — reproducible APK build (no Gradle), same pipeline as STYXWORKS.
# aapt2 -> javac -> d8 -> zipalign -> uber-apk-signer (dedicated keystore).
# The client HTML is copied fresh from its canonical home on every build.
# SDK + JDK are reused from the styxworks-app toolchain install.
set -euo pipefail

# Repo copy: the keystore password is NEVER hardcoded. Set it in the environment:
#   export HERDCODE_KS_PASS=<your keystore password>
: "${HERDCODE_KS_PASS:?HERDCODE_KS_PASS is not set}"

APP="$HOME/workspace/herdcode-app"
CLIENT="$HOME/workspace/your_files/herdcode/herdcode.html"
P="$APP/project"
B="$P/build"
export JAVA_HOME="$HOME/workspace/styxworks-app/tools/jdk17"
export PATH="$JAVA_HOME/bin:$PATH"
BT="$HOME/workspace/styxworks-app/sdk/build-tools/34.0.0"
AJAR="$HOME/workspace/styxworks-app/sdk/platforms/android-34/android.jar"
SIGNER="$HOME/workspace/idle-cpu-mod/tools/uber-apk-signer.jar"

# One-time: dedicated signing key for herdcode (updates must reuse it).
if [ ! -f "$APP/tools/herdcode.keystore" ]; then
  keytool -genkeypair -keystore "$APP/tools/herdcode.keystore" -alias herdcode \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "${HERDCODE_KS_PASS}" -keypass "${HERDCODE_KS_PASS}" \
    -dname "CN=HckrSlsh HerdCode, O=HckrSlsh, C=US" 2>/dev/null
  echo "generated $APP/tools/herdcode.keystore"
fi

rm -rf "$B"
mkdir -p "$B/gen" "$B/classes" "$B/dex" "$P/assets" "$APP/out"
cp "$CLIENT" "$P/assets/index.html"

echo "[1/6] aapt2 compile+link"
"$BT/aapt2" compile --dir "$P/res" -o "$B/res.zip"
"$BT/aapt2" link -o "$B/unsigned.apk" -I "$AJAR" \
    --manifest "$P/AndroidManifest.xml" -A "$P/assets" \
    --java "$B/gen" "$B/res.zip"

echo "[2/6] javac"
javac -encoding UTF-8 -source 8 -target 8 -cp "$AJAR" -d "$B/classes" \
    $(find "$B/gen" "$P/src" -name '*.java') 2>/dev/null

echo "[3/6] d8"
"$BT/d8" --release --lib "$AJAR" --output "$B/dex" \
    $(find "$B/classes" -name '*.class')

echo "[4/6] add classes.dex"
python3 - "$B/unsigned.apk" "$B/dex/classes.dex" <<'PYEOF'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a') as z:
    z.write(dex, 'classes.dex')
PYEOF

echo "[5/6] zipalign"
"$BT/zipalign" -f -p 4 "$B/unsigned.apk" "$B/aligned.apk"

echo "[6/6] sign"
java -jar "$SIGNER" --apks "$B/aligned.apk" \
    --ks "$APP/tools/herdcode.keystore" --ksAlias herdcode \
    --ksPass "${HERDCODE_KS_PASS}" --ksKeyPass "${HERDCODE_KS_PASS}" --out "$APP/out/" \
    2>&1 | grep -E 'sign success|signature verified|zipalign verified|checksum' || true

cp "$APP/out/aligned-aligned-signed.apk" "$APP/out/herdcode.apk"
echo "DONE: $APP/out/herdcode.apk"
