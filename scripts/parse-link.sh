#!/bin/bash
# 从 Google Maps 短链接解析街景坐标
# 用法：./scripts/parse-link.sh <短链接>
# 示例：./scripts/parse-link.sh https://maps.app.goo.gl/A7DH955qhhU3Z3Vm8

set -e

if [ -z "$1" ]; then
  echo "Usage: ./scripts/parse-link.sh <google-maps-short-link>" >&2
  exit 1
fi

FINAL_URL=$(curl -s -o /dev/null -w "%{url_effective}" -L "$1")

# 解析 @lat,lng
if [[ $FINAL_URL =~ @(-?[0-9.]+),(-?[0-9.]+) ]]; then
  LAT=${BASH_REMATCH[1]}
  LNG=${BASH_REMATCH[2]}
else
  echo "Failed to parse coordinates" >&2
  exit 1
fi

# 解析 heading (h 参数)
HEADING=0
if [[ $FINAL_URL =~ ([0-9.]+)h ]]; then
  HEADING=${BASH_REMATCH[1]}
fi

# 解析 tilt 天顶角 (t 参数)，转换为 pitch（水平角）
PITCH=0
if [[ $FINAL_URL =~ ([0-9.]+)t ]]; then
  TILT=${BASH_REMATCH[1]}
  PITCH=$(python3 -c "print(round(90 - $TILT, 2))")
fi

cat <<JSON
{
  "lat": $LAT,
  "lng": $LNG,
  "heading": $HEADING,
  "pitch": $PITCH,
  "zoom": 1
}
JSON
