#!/data/data/com.termux/files/usr/bin/bash
# LearnHarness phone setup (Android, Termux). Run once from the unpacked
# bundle folder:   bash setup.sh
# Re-running it updates the app and keeps your data and sign-ins.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/learnharness"
STATE="$HOME/.learnharness"

if [ "$(uname -m)" != "aarch64" ]; then
	echo "This phone reports $(uname -m); the bundle supports 64-bit ARM (aarch64) only." >&2
	exit 1
fi

echo "== Installing Node.js and git"
pkg install -y nodejs-lts git

echo "== Installing LearnHarness to $APP"
rm -rf "$APP"
mkdir -p "$APP"
cp -r "$HERE/standalone/." "$APP/"
cp "$HERE/data-sync.cjs" "$APP/data-sync.cjs"

echo "== Adding the Android builds of the native parts"
for base in @resvg/resvg-js @napi-rs/canvas; do
	[ -f "$APP/node_modules/$base/package.json" ] || continue
	version="$(node -p "require('$APP/node_modules/$base/package.json').version")"
	tmp="$(mktemp -d)"
	(cd "$tmp" && npm pack --silent "$base-android-arm64@$version" >/dev/null && tar -xzf ./*.tgz)
	rm -rf "$APP/node_modules/$base-android-arm64"
	mv "$tmp/package" "$APP/node_modules/$base-android-arm64"
	rm -rf "$tmp"
done

install -m 755 "$HERE/lh" "$PREFIX/bin/lh"
mkdir -p "$STATE"
chmod 700 "$STATE"

echo "== Connecting your sync repo"
if [ -d "$STATE/data/.git" ]; then
	echo "Already connected."
else
	git config --global credential.helper store
	read -rp "Sync repo URL (like https://github.com/USER/learnharness-data.git): " REMOTE
	echo "GitHub asks for your username, then a password: paste your access token there."
	git clone --branch main "$REMOTE" "$STATE/data"
fi
node "$APP/data-sync.cjs" init --dir "$STATE/data" --device phone

echo
echo "Done. Start LearnHarness by typing:  lh"
