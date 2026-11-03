#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
out="tests/fixtures/generated"
mkdir -p "$out"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=640x360:rate=30 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 2 -c:v libx264 -profile:v high -pix_fmt yuv420p -g 30 \
  -c:a aac -b:a 128k "$out/sample-h264-aac.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=1254x898:rate=24 \
  -t 1 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 24 \
  "$out/sample-h264-cropped.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=640x360:rate=30 \
  -f lavfi -i sine=frequency=330:sample_rate=48000 \
  -t 2 -c:v libx265 -tag:v hvc1 -x265-params log-level=error:keyint=30 \
  -pix_fmt yuv420p -c:a ac3 -ac 6 -b:a 384k "$out/sample-hevc-ac3.mkv"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=640x360:rate=30 \
  -f lavfi -i sine=frequency=550:sample_rate=48000 \
  -t 2 -c:v libvpx-vp9 -g 30 -b:v 500k \
  -c:a libopus -b:a 96k "$out/sample-vp9-opus.webm"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=640x360:rate=30 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -f lavfi -i sine=frequency=880:sample_rate=48000 \
  -t 2 -map 0:v -map 1:a -map 2:a -c:v libx264 -profile:v high -pix_fmt yuv420p -g 30 \
  -c:a aac -b:a 96k -metadata:s:a:0 language=eng -metadata:s:a:1 language=deu \
  "$out/sample-multi-audio.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=640x360:rate=30 \
  -f lavfi -i sine=frequency=660:sample_rate=44100 \
  -t 2 -c:v mpeg4 -vtag DIVX -g 30 -c:a libmp3lame -b:a 128k \
  "$out/sample-mpeg4-mp3.avi"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc2=size=320x180:rate=30 \
  -f lavfi -i smptebars=size=640x360:rate=30 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 2 -map 0:v -map 1:v -map 2:a -c:v libvpx-vp9 -g 30 -b:v 200k \
  -c:a libopus -b:a 64k "$out/sample-multi-video.webm"

printf '1\n00:00:00,200 --> 00:00:01,800\nHello WASM player\n\n2\n00:00:01,900 --> 00:00:02,000\nEnd\n' \
  > "$out/subtitle.srt"

ffmpeg -hide_banner -loglevel error -y \
  -i "$out/sample-h264-aac.mp4" -i "$out/subtitle.srt" \
  -c copy -c:s srt -metadata:s:s:0 language=eng "$out/sample-h264-aac-subs.mkv"

ffmpeg -hide_banner -loglevel error -y \
  -i "$out/sample-h264-aac.mp4" -i "$out/subtitle.ass" \
  -map 0 -map 1 -c copy -c:s ass -metadata:s:s:0 language=eng "$out/sample-h264-aac-ass.mkv"

ffmpeg -hide_banner -loglevel error -y \
  -i "$out/sample-h264-aac-ass.mkv" \
  -attach tests/fixtures/fonts/NotoSansLycian-Regular.ttf \
  -metadata:s:t:0 mimetype=font/ttf \
  -metadata:s:t:0 filename=NotoSansLycian-Regular.ttf \
  -c copy "$out/sample-h264-aac-ass-font.mkv"

node scripts/generate-fixture-manifest.mjs
