# Nightjar for Tizen

Nightjar for Tizen is a Samsung TV web app that streams a game from a Rubylight host. It speaks Rubylight's WebRTC TV protocol, version 2, on the LAN. The TV is the WebRTC answerer. The PC is the offerer and is ICE-lite. Video plays in a `<video>` element.

The product model is [Nightjar](https://github.com/RamazanKara/nightjar). The wire contract is [Monlight-Tizen-WebRtc-Client](https://github.com/mlopezsegura/Monlight-Tizen-WebRtc-Client) `docs/protocol.md`, which Rubylight implements. This tree does not include the retired Windows gateway.

## What this build does

- Saves PCs and connects to an address you type. Search listens for a UDP `discover` reply on port 8000 when a socket bridge is present.
- Shows a four-digit PIN. You enter that PIN in the Rubylight console. The TV then stores the client id and secret and answers later nonces with HMAC-SHA256.
- Lists the host's games and asks for cover art.
- Starts a session with resolution, frame rate, bitrate, H.264, HEVC, or AV1, and HDR10. HDR is not offered for H.264 or 720p.
- Strips `http://www.webrtc.org/experiments/rtp-hdrext/color-space` from the offer and the answer. On Tizen that extension produced zero decoded frames. Colour stays in the HEVC VUI and SEI, or in the AV1 sequence header.
- Plays the stream, sends gamepad state and rumble, and opens a stream menu on Back or Exit. Disconnect leaves the game running. Quit game stops it on the PC.
- Builds an unsigned `.wgt`.

Wake-on-LAN and network search send UDP. A Tizen web app cannot send UDP from JavaScript. `tizen/wasm/wake-on-lan.c` is the socket module, adapted from the protocol client. Build it with Samsung's Emscripten, then set `globalThis.NightjarUdp` to `{ broadcast, wake }` before the page script. Until that module is on the TV, add the PC by address. The magic packet itself is covered by the unit tests.

## Build

Node.js 22.

```sh
npm ci
npm test
npm run build
```

`npm test` runs the protocol, session, and shell tests, a UDP discovery exchange, and a headless pairing run against a mock Rubylight host. `npm run build` writes `dist/nightjar.wgt`.

The package is unsigned. Tizen Studio signs it with your distributor certificate before a TV will install it:

```sh
tizen package -t wgt -s <certificate-profile> -- staging
```

The signed file is what you install. `staging/` is the widget root the command packages.

## Sideload

Target used here: a Samsung S90D on Tizen 9. Developer Mode on the TV must list your PC as `192.168.1.168`.

1. Install Tizen Studio and the TV extension. Enable Developer Mode on the TV and set the host PC IP to `192.168.1.168`.
2. Connect, then install the signed widget:

```sh
sdb connect <tv-ip>
sdb install <signed>.wgt
```

This repository does not deploy to a TV.

## Run it

1. In Rubylight, turn on the WebRTC server. Signalling is `ws://<pc>:8000`. Discovery, when the socket module is built, is UDP port 8000.
2. On the TV, add the PC address or search the network.
3. Read the PIN on the TV and enter it in the Rubylight console.
4. Open a game. Back opens the stream menu.

## Licence

GNU General Public License v3. See `LICENSE` and `NOTICE`.
