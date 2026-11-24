#!/usr/bin/env bash
# Build tizen/wasm/wake-on-lan.c with Samsung Emscripten 1.39.4.7 (fastcomp).
# Tizen sockets live in that fork (library_tizen_sockfs.js). Stock Emscripten can
# compile the same C file, but the TV cannot send UDP with the stock binary.
#
# Download:
#   https://developer.samsung.com/smarttv/file/a5013a65-af11-4b59-844f-2d34f14d19a9
#   sha256 448c61e0ffdcc013536600eeb2e764abfa4ec49177489a563be27e3d2a5d8f4e
# Activate, with SAMSUNG_EMSDK pointing at the unpacked emsdk directory:
#   (cd "$SAMSUNG_EMSDK" && ./emsdk activate latest-fastcomp --embedded)
#
# Exact Samsung command (this script runs it):
#   emcc tizen/wasm/wake-on-lan.c -Os -Wall -Wextra -Werror \
#     -s WASM=1 \
#     -s ENVIRONMENT_MAY_BE_TIZEN=1 \
#     -s USE_PTHREADS=1 \
#     -s PTHREAD_POOL_SIZE=2 \
#     -s TOTAL_MEMORY=16777216 \
#     -s MODULARIZE=1 \
#     -s EXPORT_NAME=createWakeOnLanModule \
#     -s EXPORTED_FUNCTIONS='["_wol_send","_net_discover"]' \
#     -s EXTRA_EXPORTED_RUNTIME_METHODS='["ccall"]' \
#     -o build/wake-on-lan/wake-on-lan.js
#
# Ubuntu 26 dropped libxml2.so.2. Samsung's clang is linked to that soname, and
# libxml2 2.9 pulls in ICU 74. When those libraries are missing, this script
# downloads the Ubuntu 24.04 packages and puts them on LD_LIBRARY_PATH:
#   libxml2 2.9.14+dfsg-1.3ubuntu3.10
#     sha256 c5a065f85c1e6f605741e365e40cad71c3ceb0e85e2791400bd35b8896e12ad1
#   libicu74 74.2-1ubuntu3.1
#     sha256 c9a70989678660eed9a1e904c74fa043da8bec8e2036856fc16e31ced79b04f8
#
# Stock Emscripten 3.1, only when the Samsung SDK cannot be downloaded.
# Do not ship that binary to a TV; it has no Tizen sockets:
#   emcc tizen/wasm/wake-on-lan.c -Os -Wall -Wextra -Werror -pthread \
#     -s WASM=1 \
#     -s PTHREAD_POOL_SIZE=2 \
#     -s INITIAL_MEMORY=16777216 \
#     -s MODULARIZE=1 \
#     -s EXPORT_NAME=createWakeOnLanModule \
#     -s EXPORTED_FUNCTIONS='["_wol_send","_net_discover"]' \
#     -s EXPORTED_RUNTIME_METHODS='["ccall"]' \
#     -o build/wake-on-lan/wake-on-lan.js
set -euo pipefail

install_host_deb() {
  local url="$1" sha="$2" pattern="$3" tmp deb
  tmp="$(mktemp -d)"
  deb="$tmp/pkg.deb"
  curl -fL --retry 3 --retry-delay 2 -o "$deb" "$url"
  echo "$sha  $deb" | sha256sum -c -
  dpkg-deb -x "$deb" "$tmp/root"
  find "$tmp/root" -name "$pattern" \( -type f -o -type l \) -exec cp -a {} "$compat/" \;
  rm -rf "$tmp"
}

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/build/wake-on-lan}"
sdk_url="https://developer.samsung.com/smarttv/file/a5013a65-af11-4b59-844f-2d34f14d19a9"
sdk_sha256="448c61e0ffdcc013536600eeb2e764abfa4ec49177489a563be27e3d2a5d8f4e"
cache_root="${SAMSUNG_EMSDK_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/samsung-emscripten/1.39.4.7}"

if ! command -v python >/dev/null 2>&1; then
  python_bin="$(mktemp -d)"
  ln -s "$(command -v python3)" "$python_bin/python"
  export PATH="$python_bin:$PATH"
fi

if [[ -z "${SAMSUNG_EMSDK:-}" ]]; then
  SAMSUNG_EMSDK="$cache_root/emsdk"
fi

sockfs="$SAMSUNG_EMSDK/fastcomp/emscripten/src/library_tizen_sockfs.js"
if [[ ! -f "$sockfs" ]]; then
  if [[ "$SAMSUNG_EMSDK" != "$cache_root/emsdk" ]]; then
    echo "Samsung Emscripten was not found at $SAMSUNG_EMSDK (missing $sockfs)." >&2
    exit 1
  fi
  echo "Downloading Samsung Emscripten 1.39.4.7"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --retry 3 --retry-delay 2 -o "$tmp/sdk.zip" "$sdk_url"
  echo "$sdk_sha256  $tmp/sdk.zip" | sha256sum -c -
  unzip -q "$tmp/sdk.zip" -d "$tmp"
  if [[ ! -f "$tmp/emscripten-release-bundle/emsdk/fastcomp/emscripten/src/library_tizen_sockfs.js" ]]; then
    echo "The Samsung SDK archive has no Tizen sockets library." >&2
    exit 1
  fi
  mkdir -p "$cache_root"
  rm -rf "$SAMSUNG_EMSDK"
  mv "$tmp/emscripten-release-bundle/emsdk" "$SAMSUNG_EMSDK"
  rm -rf "$tmp"
  trap - EXIT
fi

emscripten="$SAMSUNG_EMSDK/fastcomp/emscripten"
config="$SAMSUNG_EMSDK/.emscripten"
if [[ ! -f "$config" ]]; then
  (cd "$SAMSUNG_EMSDK" && python ./emsdk.py activate latest-fastcomp --embedded)
fi

node_bin="$(find "$SAMSUNG_EMSDK/node" -type f -name node -perm -111 -print -quit)"
if [[ -z "$node_bin" ]]; then
  echo "The Samsung SDK at $SAMSUNG_EMSDK has no Node binary." >&2
  exit 1
fi

export EMSDK="$SAMSUNG_EMSDK"
export EM_CONFIG="$config"
export EM_CACHE="$SAMSUNG_EMSDK/.emscripten_cache"
export PATH="$emscripten:$(dirname "$node_bin"):$PATH"

clang="$SAMSUNG_EMSDK/fastcomp/fastcomp/bin/clang++"
compat="$cache_root/host-libs"
if ldd "$clang" 2>/dev/null | grep -q 'not found'; then
  echo "Samsung clang needs Ubuntu 24.04 libxml2 and ICU"
  mkdir -p "$compat"
  install_host_deb \
    "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxml2/libxml2_2.9.14+dfsg-1.3ubuntu3.10_amd64.deb" \
    "c5a065f85c1e6f605741e365e40cad71c3ceb0e85e2791400bd35b8896e12ad1" \
    "libxml2.so*"
  install_host_deb \
    "https://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu74_74.2-1ubuntu3.1_amd64.deb" \
    "c9a70989678660eed9a1e904c74fa043da8bec8e2036856fc16e31ced79b04f8" \
    "libicu*.so*"
  export LD_LIBRARY_PATH="$compat${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
if ldd "$clang" 2>/dev/null | grep -q 'not found'; then
  echo "Samsung clang is still missing host libraries:" >&2
  ldd "$clang" | grep 'not found' >&2
  exit 1
fi

mkdir -p "$out"
source="$root/tizen/wasm/wake-on-lan.c"
emcc "$source" -Os -Wall -Wextra -Werror \
  -s WASM=1 \
  -s ENVIRONMENT_MAY_BE_TIZEN=1 \
  -s USE_PTHREADS=1 \
  -s PTHREAD_POOL_SIZE=2 \
  -s TOTAL_MEMORY=16777216 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=createWakeOnLanModule \
  -s EXPORTED_FUNCTIONS='["_wol_send","_net_discover"]' \
  -s EXTRA_EXPORTED_RUNTIME_METHODS='["ccall"]' \
  -o "$out/wake-on-lan.js"

python3 - "$out" <<'PY'
import sys
from pathlib import Path

out = Path(sys.argv[1])
required = (
    "wake-on-lan.js",
    "wake-on-lan.wasm",
    "wake-on-lan.worker.js",
    "wake-on-lan.js.mem",
)
missing = [name for name in required if not (out / name).is_file()]
if missing:
    raise SystemExit(f"Wake-on-LAN build did not produce {', '.join(missing)}")
wasm = (out / "wake-on-lan.wasm").read_bytes()
js = (out / "wake-on-lan.js").read_text(encoding="utf-8", errors="replace")
mem = (out / "wake-on-lan.js.mem").read_bytes()
if wasm[:4] != b"\0asm":
    raise SystemExit("wake-on-lan.wasm is not WebAssembly")
if "createWakeOnLanModule" not in js or "_wol_send" not in js or "_net_discover" not in js:
    raise SystemExit("wake-on-lan.js is missing the module exports")
if b"ff02::1" not in mem or b'{"version":2,"type":"discover"}' not in mem:
    raise SystemExit("wake-on-lan.js.mem is missing the wake or discovery payload")
print(f"wake-on-lan module {out} ({len(wasm)} byte wasm)")
PY
