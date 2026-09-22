#!/bin/bash
# WhopClip manual release build (no Gradle daemon — sandbox-safe).
# Steps: aapt2 compile+link -> kotlinc -> d8 -> apk -> zipalign -> apksigner.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/app/src/main"
DEPS="$ROOT/deps"
OUT="$ROOT/build-manual"
SDK="${ANDROID_SDK_ROOT:-$HOME/workspace/.android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
KOTLINC="$HOME/workspace/.kotlin/kotlinc/bin/kotlinc"

VERSION_CODE="${VERSION_CODE:-2}"
VERSION_NAME="${VERSION_NAME:-1.0.0}"
APP_ID="com.whopclip.agent"

rm -rf "$OUT"
mkdir -p "$OUT/compiled_res" "$OUT/classes" "$OUT/dex" "$OUT/apk"

echo "== 1. aapt2 compile (resources) =="
find "$SRC/res" -type f | "$BT/aapt2" compile --dir "$SRC/res" -o "$OUT/compiled_res.zip"

echo "== 2. extract AARs, merge resources in dependency order =="
MERGED="$OUT/merged_res"
# order.txt is BFS (roots first); reverse so dependencies merge first and
# dependents (e.g. material over appcompat) win on conflict; app res last.
RESLIST=""
tac "$DEPS/order.txt" 2>/dev/null | while read -r n; do
  aar="$DEPS/$n.aar"; [ -f "$aar" ] || continue
  d="$OUT/aar/$n"; mkdir -p "$d"
  unzip -q -o "$aar" -d "$d" >/dev/null
  [ -d "$d/res" ] && echo "$d/res"
  echo "JAR:$d/classes.jar"
done > "$OUT/reslist.txt"
grep "^JAR:" "$OUT/reslist.txt" | sed 's/^JAR://' | grep -v "kotlin-stdlib" > "$OUT/jars.txt"
for jar in "$DEPS"/*.jar; do echo "$jar"; done | grep -v "kotlin-stdlib" >> "$OUT/jars.txt"
CP="$(tr '\n' ':' < "$OUT/jars.txt" | sed 's/:$//')"
RESLIST="$(grep -v "^JAR:" "$OUT/reslist.txt")"
python3 "$ROOT/tools/merge_res.py" "$MERGED" $RESLIST "$SRC/res"

echo "== 3. aapt2 compile + link =="
"$BT/aapt2" compile --dir "$MERGED" -o "$OUT/compiled_res.zip"
R_JAVA="$OUT/r_java"
"$BT/aapt2" link -o "$OUT/base.apk" \
  --manifest "$SRC/AndroidManifest.xml" \
  -I "$PLATFORM" \
  --java "$R_JAVA" \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --min-sdk-version 26 --target-sdk-version 34 \
  "$OUT/compiled_res.zip" \
  --auto-add-overlay

echo "== 4. kotlinc =="
find "$SRC/java" -name "*.kt" > "$OUT/sources.txt"
find "$R_JAVA" -name "*.java" >> "$OUT/sources.txt"
wc -l "$OUT/sources.txt"
"$KOTLINC" -cp "$PLATFORM:$CP" -d "$OUT/classes" @"$OUT/sources.txt" \
  -jvm-target 17 -nowarn 2>&1 | tail -20

echo "== 5. d8 (dex) =="
# Program inputs: our classes + every dependency jar/classes.jar.
# kotlin-stdlib comes from the kotlinc dist (already baked into our classes).
D8_INPUTS="$(echo "$CP" | tr ':' '\n' | grep -v "kotlin-stdlib" | tr '\n' ' ') $(find "$OUT/classes" -name '*.class' | tr '\n' ' ')"
"$BT/d8" --lib "$PLATFORM" --min-api 26 --output "$OUT/dex" $D8_INPUTS 2>&1 | tail -5
ls "$OUT/dex"

echo "== 6. merge dex + resources into APK =="
cp "$OUT/base.apk" "$OUT/apk/unsigned.apk"
cd "$OUT/dex" && zip -q -X "$OUT/apk/unsigned.apk" *.dex && cd "$ROOT"

echo "== 7. zipalign =="
"$BT/zipalign" -f 4 "$OUT/apk/unsigned.apk" "$OUT/apk/aligned.apk"

echo "== 8. apksigner =="
STOREPW="$(cat "$HOME/.config/whopclip/keystore.pw")"
"$BT/apksigner" sign --ks "$ROOT/whopclip-release.keystore" \
  --ks-pass "pass:$STOREPW" --key-pass "pass:$STOREPW" \
  --ks-key-alias whopclip \
  --out "$OUT/apk/whopclip-v${VERSION_CODE}.apk" "$OUT/apk/aligned.apk"

echo "== 9. verify =="
"$BT/apksigner" verify --print-certs "$OUT/apk/whopclip-v${VERSION_CODE}.apk" | head -6
"$BT/aapt2" dump badging "$OUT/apk/whopclip-v${VERSION_CODE}.apk" | head -3
ls -la "$OUT/apk/whopclip-v${VERSION_CODE}.apk"
