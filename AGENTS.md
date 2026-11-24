# nightjar-tizen agent guide

This repository is a Tizen Nightjar: a Samsung Tizen TV client for Rubylight only. It talks Rubylight's WebRTC TV protocol, version 2, directly to the host. Model features and UX on Nightjar. Use WebRTC for the stream, because Tizen cannot run Nightjar's native Moonlight engine.

## Setup

Before you read host, Nightjar, or Tizen code, create or update the local clones:

```sh
./scripts/fetch-references.sh
```

`reference/` is gitignored. Treat it as read-only. Never edit it. Never commit it. Re-run the script if the folder is missing. The script also deletes a leftover `reference/vibepollo` directory, which this project no longer uses.

The script clones these repositories:

| Directory | Upstream | Branch | Role |
| --- | --- | --- | --- |
| `reference/rubylight` | [RamazanKara/Rubylight](https://github.com/RamazanKara/Rubylight) | `main` | The host, including the WebRTC TV server |
| `reference/nightjar` | [RamazanKara/nightjar](https://github.com/RamazanKara/nightjar) | `main` | Rubylight's native Android and desktop client. The feature and UX model. Not a WebRTC client. |
| `reference/rubylight-tv-protocol` | [mlopezsegura/Monlight-Tizen-WebRtc-Client](https://github.com/mlopezsegura/Monlight-Tizen-WebRtc-Client) | `master` | The protocol specification and the official Tizen WebRTC client that already talks to the host with no proxy |
| `reference/moonlight-webrtc-tizen` | [tsoas/moonlight-webrtc-tizen](https://github.com/tsoas/moonlight-webrtc-tizen) | `master` | Abandoned PoC. Ancestor of the official Tizen app. Reuse TV-side learnings. Do not copy the Windows gateway. |

## Nightjar's stack, and what carries over

Nightjar is developed in Rubylight's `client/` folder and mirrored to this clone. It is a host-neutral Moonlight-protocol client for Android, Android TV, Fire TV, Windows, Linux, and macOS.

The Android app is Java, under `app/`, Gradle applicationId `com.butterpollo.client`. The streaming engine and desktop app are Rust, in the `protocol/` workspace. Discovery, PIN or QR pairing, app launch, and the stream itself use HTTPS GameStream plus RTSP, an encrypted control channel, and ENet with FEC. That path is documented in `docs/code-map.md` and implemented in `protocol/client/` (`nightjar-core`) and `protocol/client/src/http/`.

Do not port `nightjar-core`, the ENet or RTSP transport, PyroWave, USB forwarding, or the native HTTP API into the Tizen app. Tizen is limited to a web app with `RTCPeerConnection`. The reusable parts are the product: the library and game pages in `docs/console.md`, settings in `docs/settings.md`, controls and the stream menu in `docs/controls.md`, pairing UX in `docs/pairing.md`, the performance overlay in `docs/stream-health.md`, and controller-first TV navigation in `docs/gamepad-navigation.md`. Gate host extras by capability, not by brand, as `docs/features.md` and `protocol/policy/src/http/capabilities.rs` do.

## Where to find what

Paths below are relative to each clone. They exist in the current shallow checkouts.

### Rubylight

Rubylight implements protocol version 2 as `reference/rubylight-tv-protocol/docs/protocol.md` describes it. Host behaviour and extensions are in `docs/webrtc.md`. Design notes are in `docs/webrtc-design.md`. Settings and default ports are in `docs/configuration.md`.

The WebRTC server is off by default. After it is enabled, discovery listens on UDP 8000. Signalling is a WebSocket on TCP `webrtc_port` (default 8000). Media uses UDP `webrtc_media_port` (default 8001). The host is ICE-lite and does not use STUN or TURN. The host creates the SDP offer.

- Signalling, SDP, sessions, media, and discovery: `rust/host/webrtc/src/server.rs`, `sdp.rs`, `session.rs`, `discovery.rs`, and the rest of that crate
- Wire types, PIN auth, input, and gamepad messages: `rust/core/session/src/webrtc/protocol.rs`, `auth.rs`, `input.rs`, and `gamepad.rs`
- Browser and test clients of the same protocol: `rust/web/src/lib/webrtc/signalling.ts`, `input.ts`, `gamepad.ts`, and `rust/tests/webrtc_client/signalling.js`
- Browser-only guests, which are not part of TV protocol v2: `docs/browser-guests.md`

The host opens DataChannels named `control` (ordered, reliable) and `gamepad` (unordered, no retransmits). Keyboard and mouse use a client-opened `input` channel that must be ordered and reliable. Surround audio is a Rubylight extension. It has not been tested on Tizen.

### Nightjar

Start with `docs/code-map.md` and `docs/features.md`.

- Product and UX: `docs/console.md`, `docs/pairing.md`, `docs/settings.md`, `docs/controls.md`, `docs/stream-health.md`, `docs/gamepad-navigation.md`, `docs/PARITY-MATRIX.md`
- Native pairing, launch, and host HTTP, which do not run on Tizen: `protocol/client/src/http/pairing.rs`, `launch.rs`, and the rest of `protocol/client/src/http/`
- Host capability flags to emulate in spirit: `protocol/policy/src/http/capabilities.rs`
- Android TV and phone UI: `app/src/main/java/com/limelight/PcView.java`, `AppView.java`, `Game.java`, `GameOverlays.java`, `computers/`, `discovery/`, `preferences/`, `nvstream/http/PairingManager.java`, `nvstream/wol/`, `binding/video/PerformanceOverlay.java`
- Desktop UI pages: `protocol/desktop-ui/`

### rubylight-tv-protocol

This is the specification and a working Tizen client that already dropped the Windows gateway. Prefer it over the PoC for protocol and TV-side WebRTC.

- The contract: `docs/protocol.md`
- Product overview: `README.md`
- Tizen package and privileges: `tizen/config.xml`
- App shell and stream: `tizen/index.html`, `tizen/app.js`, `tizen/ui.js`, and `tizen/ui.css`
- Pairing and stored PCs: `tizen/gateway-auth.js`, `tizen/gateway-store.js`, and `tizen/gateway-ipv4.js`. The "gateway" names are leftover. The client talks to the host.
- Gamepad playback and UI navigation: `tizen/gamepad-input.js` and `tizen/gamepad-ui-navigation.js`
- Wake-on-LAN, which Tizen JavaScript cannot send as UDP: `tizen/wake-on-lan.js` and `tizen/wasm/wake-on-lan.c`
- Decoder and latency helpers: `tizen/frame-rate-support.js`, `tizen/frame-interpolation.js`, `tizen/stall-watchdog.js`, `tizen/stream-latency.js`, and `tizen/low-latency.js`
- Settings, artwork, and storage: `tizen/preferences.js`, `tizen/application-artwork.js`, `tizen/durable-storage.js`, and `tizen/update-check.js`
- WGT packaging: `packaging/tizen/build-package.ps1`

The TV uses `RTCPeerConnection` and a `<video>` element. It does not use AVPlay. The host sends the offer. The TV answers. The TV waits for host-created DataChannels named `control` and `gamepad`.

### moonlight-webrtc-tizen

The PoC split a Windows gateway from the Tizen app. The official client above replaced that architecture. Study the PoC for ancestry and for the Samsung SDP notes in `src/webrtc/SamsungSdp.cpp` and `src/webrtc/SamsungSdp.h`. The same HDR rule is also in `docs/protocol.md` under SDP.

Reuse only TV-side ideas in `tizen/` and `docs/gateway-protocol.md` as history of protocol v1. Do not copy `src/gateway/` or the gateway's Moonlight/Sunshine client under `src/moonlight/`.

## What to read for each task

- Learn the product. Read Nightjar `docs/features.md` and `docs/console.md`, then the official Tizen `README.md` and `tizen/ui.js`.
- Implement discovery, pairing, or auth. Read `docs/protocol.md` (Discovery and TV authentication) and Rubylight `docs/webrtc.md` (Pair a TV or a browser, and For client authors). Then read `tizen/gateway-auth.js` and `rust/core/session/src/webrtc/auth.rs`. The TV shows a four-digit PIN. The user enters it in the Rubylight console. Do not implement Nightjar's QR codes, pairing links, or GameStream `/pair`.
- List and launch apps. Read `docs/protocol.md` (Applications, Start a session, Stop or switch) and `tizen/app.js` in the official client. For the library UX, read Nightjar `docs/console.md`. Cover art comes from `get-app-artwork`, not from Nightjar's native library API.
- Negotiate video and audio. Read `docs/protocol.md` (Capabilities, Start a session, SDP) and Rubylight `rust/host/webrtc/src/sdp.rs`. Probe the TV with Media Capabilities and `RTCRtpReceiver.getCapabilities`. Then apply the Samsung HDR rule in the mapping table below.
- Send input. Read `docs/protocol.md` (Feedback), Rubylight `docs/webrtc.md` (The input channel, Gamepads), `tizen/gamepad-input.js`, and Nightjar `docs/controls.md` for the stream-menu UX only.
- Wake a sleeping PC. Read `docs/protocol.md` (Wake-on-LAN) and `tizen/wasm/wake-on-lan.c`. A Tizen web app cannot send UDP from JavaScript.
- Build the Tizen package or shell. Start from the official client's `tizen/config.xml`, `tizen/index.html`, and `packaging/tizen/build-package.ps1`. Keep the `<video>` element and `RTCPeerConnection` unless a later investigation proves AVPlay is required.

## Nightjar features on Tizen WebRTC

This table is the product bar. "Yes" means protocol v2 plus a Tizen web app can do it. "Partial" means a simpler form exists. "No" means the Nightjar feature needs the native engine or the native HTTP API.

| Nightjar feature | On a Tizen Nightjar |
| --- | --- |
| Find a PC or add it by address | Yes. UDP `discover` to port 8000, or a typed address. Not mDNS. Broadcasts stay on one subnet. |
| PIN pairing | Partial. The TV creates the PIN and the user enters it in Rubylight. No QR code, no pairing link, no host-generated one-time PIN. |
| Wake-on-LAN | Yes, from the official client's WebAssembly module, not from JavaScript UDP. |
| App list, artwork, play, resume, stop, switch | Yes, through `get-apps`, `get-app-artwork`, `start-session`, `stop-session`, `stop-host-session`, and `switch-session`. |
| Multi-PC Home with store shelves, play time, and Steam collections | No. Those need Rubylight's native library API. Cache covers and a list of saved PCs locally, as the official Tizen client does. |
| H.264, HEVC, AV1, HDR10, bitrate, resolution, and frame rate at session start | Yes, via `capabilities` and `start-session`. Offer only what the TV decoder announces. 1440p is experimental. Rates above 60 fps depend on the TV. H.264 HDR and 720p HDR are rejected. |
| Mid-stream bitrate or frame-rate changes, adaptive bitrate, FEC | No. Not in TV protocol v2. |
| HDR10+, HLG, Dolby Vision, 4:4:4, PyroWave, Frame Warp, Real VRR, device-side upscaling | No. Native engine or native API only. |
| HDR colour-space RTP extension | Do not send it. On Samsung Tizen it produced zero decoded frames. The same Main10 or AV1 HDR stream works when the TV reads colour from HEVC VUI and SEI or from the AV1 sequence header. See `docs/protocol.md` and the PoC file `src/webrtc/SamsungSdp.cpp`. |
| Stereo Opus | Yes. |
| 5.1 or 7.1 surround, audio passthrough, microphone | Partial at most. Rubylight can offer surround on an `input` extension. It is untested on Tizen. Passthrough and mic are not in TV protocol v2. |
| Gamepad, rumble, and controller mouse mode | Yes, on the `gamepad` and `control` channels. |
| Keyboard and mouse | Yes, if the client opens a reliable `input` channel, which is a Rubylight extension. |
| USB controllers, DualSense adaptive triggers, touch, pen | No, aside from what the Tizen Gamepad API already exposes. |
| Stream menu, disconnect versus stop | Yes. Model the UX on Nightjar `docs/controls.md` and the official Tizen stream controls. |
| Performance overlay, stall recovery, `client-log`, `request-keyframe` | Yes, as in the official client's stall watchdog and latency helpers. Host CPU and GPU meters from the native API are not available. |
| Guests, invite links, co-op, Continue here | No. Those are native API or the browser guest path, not TV protocol v2. |
| Clipboard, files, shared folders, USB forwarding | No. |
| Play over the internet (STUN, hole punch, forwarded ports) | No as designed. The host is ICE-lite and has no STUN or TURN. A shared LAN or Tailscale may still work as a network. |

## Do not copy

- The PoC Windows gateway and its Moonlight client: `reference/moonlight-webrtc-tizen/src/gateway/` and `src/moonlight/`
- Nightjar's streaming transport: `protocol/client/`, ENet, RTSP, FEC, PyroWave, USB, and `protocol/client/src/http/` except as a catalogue of features the TV protocol does not have
- Vibepollo or any other Sunshine fork as a target

## Project conventions

Application code, packaging, and docs for nightjar-tizen live in this repository, outside `reference/`. `reference/` is only a local reading tree. Do not rename this repository.
