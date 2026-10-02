#!/bin/sh
# Downloads the stock footage and cuts it into the frames video.html reads.
# Mixkit clips, free for commercial use, no attribution required (mixkit.co/license).
set -e
cd "$(dirname "$0")"
mkdir -p stock
cut() { # name, mixkit id, start s, length s
  [ -f stock/$2.mp4 ] || curl -sf -A "Mozilla/5.0" -o stock/$2.mp4 "https://assets.mixkit.co/videos/$2/$2-720.mp4"
  rm -rf clips/$1 && mkdir -p clips/$1
  ffmpeg -loglevel error -y -ss $3 -t $4 -i stock/$2.mp4 -vf "fps=30,scale=1280:720" -q:v 3 clips/$1/%04d.jpg
}
cut night 8843 4 5
cut frustrated 39854 2 5
cut together 4872 3 6
cut code 41642 1 4
cut glasses 221 3 4
cut coffee 1730 5 4
cut handshake 46755 1 4
