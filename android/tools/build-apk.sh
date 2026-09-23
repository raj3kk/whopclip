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

VERSION_CODE="${VERSION_CODE:-${1:-7}}"
VERSION_NAME="${VERSION_NAME:-${2:-1.0.5}}"
APP_ID="com.whopclip.agent"
echo "building versionCode=$VERSION_CODE versionName=$VERSION_NAME"

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

echo "== 3b. library R classes (v14 root fix) =="
# AAR bytecode references its OWN library R classes (e.g.
# androidx.work.R$bool.workmanager_test_configuration,
# androidx.startup.R$string.androidx_startup). aapt2 --java only emits the
# APP's R class, so without this step those classes are missing from the dex
# -> NoClassDefFoundError: v12 died at WorkManager.initialize(), v13 died at
# app launch inside InitializationProvider (before Application.onCreate).
LIB_R_KT="$OUT/lib_r_kt"
python3 "$ROOT/tools/gen_lib_r.py" \
  "$R_JAVA/com/whopclip/agent/R.java" "$LIB_R_KT" "$OUT"/aar/*/
echo "library R.kt files: $(find "$LIB_R_KT" -name 'R.kt' | wc -l)"

echo "== 4. kotlinc =="
find "$SRC/java" -name "*.kt" > "$OUT/sources.txt"
find "$R_JAVA" -name "*.java" >> "$OUT/sources.txt"
find "$LIB_R_KT" -name "R.kt" >> "$OUT/sources.txt"
wc -l "$OUT/sources.txt"
# v14: 29 generated library R.kt files (~10k declarations) push the kotlinc
# analyzer past its default heap -> analyzer crash + SIGKILL. Give it 4g.
JAVA_OPTS="-Xmx4g" "$KOTLINC" -cp "$PLATFORM:$CP" -d "$OUT/classes" @"$OUT/sources.txt" \
  -jvm-target 17 -nowarn 2>&1 | tail -20

echo "== 5. d8 (dex) =="
# Program inputs: our classes + every dependency jar/classes.jar.
# kotlin-stdlib: deps/ copies are STALE (1.7.x, pre-Kotlin-1.9) and are
# excluded to avoid duplicate/version-mismatch classes. The compiler's own
# bundled stdlib (matches kotlinc) is dexed instead. WITHOUT this the APK
# ships zero kotlin.* classes -> instant NoClassDefFoundError on launch
# (WhopClipApp is Kotlin; process dies before any UI).
KOTLIN_STDLIB="$HOME/workspace/.kotlin/kotlinc/lib/kotlin-stdlib.jar"
if [ ! -f "$KOTLIN_STDLIB" ]; then
  echo "FATAL: kotlin-stdlib.jar not found at $KOTLIN_STDLIB"; exit 1
fi
D8_INPUTS="$KOTLIN_STDLIB $(echo "$CP" | tr ':' '\n' | grep -v "kotlin-stdlib" | tr '\n' ' ') $(find "$OUT/classes" -name '*.class' | tr '\n' ' ')"
echo "DEBUG: KOTLIN_STDLIB=$KOTLIN_STDLIB" >&2
echo "DEBUG: D8_INPUTS starts with: $(echo "$D8_INPUTS" | cut -c1-200)" >&2
"$BT/d8" --lib "$PLATFORM" --min-api 26 --output "$OUT/dex" $D8_INPUTS 2>&1 | tail -5
ls "$OUT/dex"
# Launch-crash guard: kotlin stdlib classes MUST be class definitions in dex.
# NOTE: dexdump output goes to a temp file first — piping straight into
# `grep -q` trips pipefail (SIGPIPE, exit 141) when grep closes the pipe early.
echo "DEBUG: checking $OUT/dex/classes.dex with $BT/dexdump" >&2
ls -la "$OUT/dex/" >&2
"$BT/dexdump" "$OUT/dex/classes.dex" 2>/dev/null > "$OUT/dex/dump.txt" || {
  echo "FATAL: dexdump failed on classes.dex"; exit 1
}
if ! grep -q "Class descriptor.*Lkotlin/jvm/internal/Intrinsics;'" "$OUT/dex/dump.txt"; then
  echo "DEBUG: grep found no match; sample descriptors:" >&2
  grep "Class descriptor" "$OUT/dex/dump.txt" | head -5 >&2
  echo "FATAL: kotlin stdlib missing from dex — APK would crash on launch"; exit 1
fi
echo "dex verification OK: kotlin stdlib present ($(grep -c "Class descriptor" "$OUT/dex/dump.txt") class defs)"
# v14 regression guard: library R classes MUST be class definitions in dex.
# Missing ones caused v12 (WorkManager.initialize) and v13 (app launch)
# NoClassDefFoundError deaths. Fail the build instead of shipping a crash.
python3 - "$OUT/dex/classes.dex" <<'PYEOF'
import struct, sys, re
d = open(sys.argv[1],'rb').read()
def u32(o): return struct.unpack_from('<I', d, o)[0]
nstr, ostr = u32(0x38), u32(0x3C)
ntyp, otyp = u32(0x40), u32(0x44)
ndef, odef = u32(0x60), u32(0x64)
strings = []
for i in range(nstr):
    so = u32(ostr + i*4); p = so; ln = 0; sh = 0
    while True:
        b = d[p]; p += 1; ln |= (b & 0x7f) << sh
        if not (b & 0x80): break
        sh += 7
    strings.append(d[p:p+ln].decode('utf-8','replace'))
tdesc = [strings[u32(otyp + i*4)] for i in range(ntyp)]
defined = {tdesc[u32(odef + i*32)] for i in range(ndef)}
ref = set(tdesc)
killers = ['Landroidx/work/R$bool;', 'Landroidx/startup/R$string;']
for k in killers:
    if k not in defined:
        print(f"FATAL: library R killer class not in dex: {k}"); sys.exit(1)
    print(f"R-guard OK (defined): {k}")
pat = re.compile(r'^L(androidx|com/google/android|com/whopclip)/[\w/]*R\$')
missing = sorted(t for t in (ref - defined) if pat.match(t))
if missing:
    print(f"FATAL: {len(missing)} referenced library R classes missing from dex:")
    for m in missing[:20]: print("  ", m)
    sys.exit(1)
print("R-guard OK: no missing library R classes")
PYEOF

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
"$BT/apksigner" verify --print-certs "$OUT/apk/whopclip-v${VERSION_CODE}.apk" > "$OUT/verify-certs.txt"
head -6 "$OUT/verify-certs.txt"
"$BT/aapt2" dump badging "$OUT/apk/whopclip-v${VERSION_CODE}.apk" > "$OUT/verify-badging.txt"
head -3 "$OUT/verify-badging.txt"
ls -la "$OUT/apk/whopclip-v${VERSION_CODE}.apk"
