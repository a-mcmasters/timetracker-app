#!/usr/bin/env bash
# Builds TimeTracker.apk from the web app in ../ without Gradle.
# Needs: JDK 17+, Python 3 with Pillow, and an Android SDK with
#   platforms;android-34 and build-tools;35.0.0  (set ANDROID_HOME).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK}"
BT="$SDK/build-tools/35.0.0"
# On Windows (Git Bash) d8 and apksigner are .bat files.
D8="$BT/d8"; [ -f "$D8" ] || D8="$D8.bat"
APKSIGNER="$BT/apksigner"; [ -f "$APKSIGNER" ] || APKSIGNER="$APKSIGNER.bat"
JAR="$SDK/platforms/android-34/android.jar"
OUT="$HERE/build"
KEYSTORE="${KEYSTORE:-$HERE/timetracker.keystore}"

rm -rf "$OUT" && mkdir -p "$OUT"/{res,assets,classes,dex,compiled}

# Resources: copy static res + generated launcher icons
cp -r "$HERE/res/." "$OUT/res/"
python3 "$HERE/make_icons.py" "$OUT/res"

# The web app itself goes in assets/
cp "$HERE/../index.html" "$HERE/../index.js" "$HERE/../styles.css" "$OUT/assets/"

"$BT/aapt2" compile --dir "$OUT/res" -o "$OUT/compiled/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "$JAR" \
  --manifest "$HERE/AndroidManifest.xml" -A "$OUT/assets" \
  --java "$OUT/gen" "$OUT/compiled/res.zip"

javac -source 8 -target 8 -nowarn -Xlint:-options -bootclasspath "$JAR" -classpath "$JAR" \
  -d "$OUT/classes" $(find "$HERE/src" "$OUT/gen" -name '*.java')
(cd "$OUT/classes" && jar cf "$OUT/classes.jar" .)
"$D8" --min-api 24 --lib "$JAR" --output "$OUT/dex" "$OUT/classes.jar"
python3 -c "import sys, zipfile; zipfile.ZipFile(sys.argv[1], 'a').write(sys.argv[2], 'classes.dex')" \
  "$OUT/unsigned.apk" "$OUT/dex/classes.dex"

"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

# Signing key: keep this file! Updates must be signed with the same key,
# otherwise Android makes you uninstall first (which deletes your data).
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass timetracker -keypass timetracker \
    -alias timetracker -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Time Tracker" >/dev/null 2>&1
fi
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass pass:timetracker --key-pass pass:timetracker \
  --out "$HERE/../TimeTracker.apk" "$OUT/aligned.apk"
"$APKSIGNER" verify "$HERE/../TimeTracker.apk"
echo "Built $(cd "$HERE/.." && pwd)/TimeTracker.apk"
