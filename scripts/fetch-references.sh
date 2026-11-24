#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ref="$root/reference"
mkdir -p "$ref"

fetch() {
  local name="$1"
  local url="$2"
  local dest="$ref/$name"
  if [[ -d "$dest/.git" ]]; then
    git -C "$dest" remote set-url origin "$url"
    git -C "$dest" fetch --depth 1 origin
    git -C "$dest" reset --hard FETCH_HEAD
  else
    rm -rf "$dest"
    git clone --depth 1 "$url" "$dest"
  fi
}

fetch rubylight https://github.com/RamazanKara/Rubylight.git
fetch vibepollo https://github.com/Nonary/Vibepollo.git
fetch moonlight-webrtc-tizen https://github.com/tsoas/moonlight-webrtc-tizen.git
