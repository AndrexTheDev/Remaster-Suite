#!/bin/sh
# The sandbox image ships no ffmpeg; the toolkit needs one for the codec rows.
# @ffmpeg-installer/linux-x64 carries a static build inside the npm tarball, so
# this works on a host that can only reach the npm registry.
set -e
mkdir -p "$HOME/.toolkit"
cd "$HOME/.toolkit"
[ -d node_modules/@ffmpeg-installer/linux-x64 ] || npm install --no-audit --no-fund @ffmpeg-installer/linux-x64
chmod +x node_modules/@ffmpeg-installer/linux-x64/ffmpeg
echo "ffmpeg: $HOME/.toolkit/node_modules/@ffmpeg-installer/linux-x64/ffmpeg"
"$HOME/.toolkit/node_modules/@ffmpeg-installer/linux-x64/ffmpeg" -version 2>&1 | head -1
