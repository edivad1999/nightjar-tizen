# moonlight-tizen agent guide

This repository is a Samsung Tizen game-streaming client. It talks WebRTC directly to Rubylight and Vibepollo. It does not use a proxy between the TV and the host.

## Setup

Before you read host or Tizen code, create or update the local clones:

```sh
./scripts/fetch-references.sh
```

`reference/` is gitignored. Treat it as read-only. Never edit it. Never commit it. Re-run the script if the folder is missing.

The script clones these repositories:

| Directory | Upstream | Branch | Role |
| --- | --- | --- | --- |
| `reference/rubylight` | [RamazanKara/Rubylight](https://github.com/RamazanKara/Rubylight) | `main` | Sunshine-family host with a native WebRTC TV protocol |
| `reference/vibepollo` | [Nonary/Vibepollo](https://github.com/Nonary/Vibepollo) | `master` | Apollo/Sunshine-family host with a browser WebRTC REST API |
| `reference/moonlight-webrtc-tizen` | [tsoas/moonlight-webrtc-tizen](https://github.com/tsoas/moonlight-webrtc-tizen) | `master` | Abandoned Tizen PoC. Reuse the TV app. Do not copy the Windows gateway. |

## Where to find what

Paths below are relative to each clone. They exist in the current shallow checkouts.

### Rubylight

Rubylight implements Moonlight WebRTC TV protocol version 2, designed for a Tizen TV app. The message list is in the [upstream protocol document](https://github.com/mlopezsegura/Monlight-Tizen-WebRtc-Client/blob/main/docs/protocol.md). Host behaviour and extensions are in `docs/webrtc.md`. Design notes are in `docs/webrtc-design.md`. Layout is in `docs/code-map.md`. Settings and default ports are in `docs/configuration.md`.

The WebRTC server is off by default. After it is enabled, discovery listens on UDP 8000. Signalling is a WebSocket on TCP `webrtc_port` (default 8000). Media uses UDP `webrtc_media_port` (default 8001). The host is ICE-lite and does not use STUN or TURN. The host creates the SDP offer.

- Signalling server, SDP, sessions, media, and discovery: `rust/host/webrtc/src/server.rs`, `sdp.rs`, `session.rs`, `media.rs`, `discovery.rs`, `clients.rs`, `guests.rs`, and `lib.rs`
- Wire types, PIN auth, input, and gamepad messages: `rust/core/session/src/webrtc/protocol.rs`, `auth.rs`, `input.rs`, `gamepad.rs`, and `capabilities.rs`
- Console and play-page sockets in `rust/host/web/src/web.rs`: `GET /api/webrtc/signal` and `GET /play/signal`. They are wired through `rust/host/stream/src/webrtc_bridge.rs`.
- Browser client: `rust/web/src/lib/webrtc/signalling.ts`, `client.ts`, `play.ts`, `input.ts`, and `gamepad.ts`
- Standalone test client: `rust/tests/webrtc_client/signalling.js`, `client.js`, and `input/input.js`
- Classic Moonlight/GameStream pairing and launch, which is not the WebRTC TV path: `rust/host/stream/src/nvhttp/pairing.rs`, `launch.rs`, `rust/core/crypto/src/pairing.rs`, and `rust/host/web/src/native_api/pairing.rs`

The host opens DataChannels named `control` (ordered, reliable) and `gamepad` (unordered, no retransmits). Keyboard and mouse use a client-opened `input` channel that must be ordered and reliable.

### Vibepollo

Vibepollo WebRTC is an authenticated HTTPS REST API on the Web UI server (default `https://host:47990`). The browser creates the offer. The host answers. ICE candidates travel over HTTP POST plus an SSE or poll stream. This is not Rubylight's WebSocket TV protocol.

- Server routes in `src/confighttp.cpp`: `GET /api/webrtc/capabilities`; `POST /api/webrtc/sessions`; `GET` or `DELETE /api/webrtc/sessions/{id}`; `POST /api/webrtc/sessions/{id}/offer`; `GET /api/webrtc/sessions/{id}/answer`; `POST` and `GET /api/webrtc/sessions/{id}/ice`; `GET /api/webrtc/sessions/{id}/ice/stream`; `GET /api/webrtc/cert`
- Session, capture, encode, and data-channel input: `src/webrtc_stream.cpp` and `src/webrtc_stream.h`
- Web UI authentication with session tokens, cookies, or Bearer API tokens, not Moonlight PIN pairing: `src/http_auth.cpp`
- Current browser client: `src_assets/common/assets/web/services/webrtc.ts`, `views/BrowserStreamView.vue`, `utils/webrtc/browserGamepad.ts`, and `types/webrtc.ts`
- Older client, still useful for input payload shapes: `src_assets/common/assets/web-legacy/views/WebRtcClientView.vue`, `utils/webrtc/client.ts`, `utils/webrtc/input.ts`, and `services/webrtcApi.ts`
- Classic Moonlight/GameStream (RTSP, not WebRTC): `src/nvhttp.cpp`, `src/rtsp.cpp`, `src/http_pairing_policy.cpp`, `src/crypto.cpp`, and `src/input.cpp`
- libwebrtc build flag: `cmake/dependencies/webrtc.cmake`

`architecture.md` is a good walk-through of the host pipeline. Its frontend paths are stale. The current UI is `BrowserStreamView.vue` and `services/webrtc.ts`. The older files live under `src_assets/common/assets/web-legacy/`.

The current client opens one DataChannel named `input` (`maxRetransmits: 0`, `ordered: true`) and sends JSON on it.

### moonlight-webrtc-tizen

The PoC has two parts. The Tizen app under `tizen/` is the starting point for packaging, UI, and TV-side WebRTC. The Windows process under `src/gateway/` is a proxy. The TV never talks to Sunshine. Do not copy that proxy.

Reuse or study these files:

- Protocol the TV speaks today: `docs/gateway-protocol.md` (version 1 JSON over a WebSocket on port 8000)
- Tizen package and privileges: `tizen/config.xml`
- App shell and stream: `tizen/index.html`, `tizen/app.js`, `tizen/ui.js`, and `tizen/ui.css`
- Gamepad playback and UI navigation: `tizen/gamepad-input.js` and `tizen/gamepad-ui-navigation.js`
- Stored gateways and IPv4 entry: `tizen/gateway-store.js` and `tizen/gateway-ipv4.js`
- Settings and artwork: `tizen/preferences.js` and `tizen/application-artwork.js`
- WGT packaging: `packaging/tizen/build-package.ps1`
- Samsung SDP constraints, including HEVC profile, the game-mode image attribute, and HDR extension behaviour: `src/webrtc/SamsungSdp.cpp` and `src/webrtc/SamsungSdp.h`

The TV uses `RTCPeerConnection` and a `<video>` element in `tizen/app.js`. It does not use AVPlay or WebAssembly. The peer that sends the offer is the gateway today. The TV answers. The TV waits for host-created DataChannels named `control` and `gamepad`.

Read the following only to understand the old proxy. Do not port them into the Tizen app:

- The gateway: `src/gateway/`
- The gateway's Moonlight/Sunshine client: `src/moonlight/control/MoonlightPairing.cpp`, `MoonlightSession.cpp`, `SunshineHttpClient.cpp`, `src/moonlight/input/MoonlightInputBridge.cpp`, and `src/webrtc/WebRtcMediaSender.cpp`

## What to read for each task

- Implement Rubylight signalling. Read the "For client authors" section of `docs/webrtc.md` and the [upstream protocol document](https://github.com/mlopezsegura/Monlight-Tizen-WebRtc-Client/blob/main/docs/protocol.md). Then read `rust/core/session/src/webrtc/protocol.rs` and either `rust/web/src/lib/webrtc/signalling.ts` or `rust/tests/webrtc_client/signalling.js`.
- Implement Vibepollo signalling. Read the routes in `src/confighttp.cpp` and the client in `src_assets/common/assets/web/services/webrtc.ts`. Use `architecture.md` for the host pipeline only.
- Pair or authenticate. For Rubylight WebRTC, read the "Pair a TV or a browser" section of `docs/webrtc.md` and `rust/core/session/src/webrtc/auth.rs`. The TV shows a four-digit PIN. The host stores a client id and secret. For Vibepollo WebRTC, authenticate to the Web UI with `src/http_auth.cpp`. Do not use Moonlight `/pair` for either WebRTC path.
- Start a session and negotiate codecs. For Rubylight, the client sends `start-session` and the host returns the offer. See `docs/webrtc.md`, `rust/host/webrtc/src/sdp.rs`, and `session.rs`. For Vibepollo, `POST /api/webrtc/sessions`, then `POST .../offer` with the browser's SDP. For Tizen SDP quirks that already shipped on a Samsung TV, read `src/webrtc/SamsungSdp.cpp` in the PoC.
- Send input. For Rubylight or a TV-protocol host, send gamepad JSON on `gamepad` and optional keyboard or mouse JSON on `input`, as in `docs/webrtc.md` and the PoC files `tizen/app.js` and `tizen/gamepad-input.js`. For Vibepollo, send JSON on the single `input` channel from `services/webrtc.ts` and `utils/webrtc/browserGamepad.ts`. The message shapes are not the same.
- Build the Tizen app UI or package. Start from `tizen/config.xml`, `tizen/index.html`, `tizen/ui.js`, and `packaging/tizen/build-package.ps1`. Keep the `<video>` element and `RTCPeerConnection` unless a later investigation proves AVPlay is required.

## Project conventions

Application code, packaging, and docs for moonlight-tizen live in this repository, outside `reference/`. `reference/` is only a local reading tree.
