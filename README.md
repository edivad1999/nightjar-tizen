# Nightjar for Tizen

Nightjar for Tizen is a Samsung TV web app that streams a game from a Rubylight host. It speaks Rubylight's WebRTC TV protocol, version 2, on the LAN. The TV is the WebRTC answerer. The PC is the offerer and is ICE-lite. Video plays in a `<video>` element.

The product model is [Nightjar](https://github.com/RamazanKara/nightjar). The wire contract is [Monlight-Tizen-WebRtc-Client](https://github.com/mlopezsegura/Monlight-Tizen-WebRtc-Client) `docs/protocol.md`, which Rubylight implements. This tree does not include the retired Windows gateway.

## What this build does

- Saves PCs and connects to an address you type, including an IPv6 literal. Search broadcasts a UDP `discover` datagram on port 8000.
- Shows a four-digit PIN. You enter that PIN in the Rubylight console. The TV then stores the client id and secret and answers later nonces with HMAC-SHA256.
- Lists the host's games and asks for cover art.
- Starts a session with resolution, frame rate, bitrate, H.264, HEVC, or AV1, and HDR10. HDR is not offered for H.264 or 720p.
- Strips `http://www.webrtc.org/experiments/rtp-hdrext/color-space` from the offer and the answer. On Tizen that extension produced zero decoded frames. Colour stays in the HEVC VUI and SEI, or in the AV1 sequence header.
- Plays the stream, sends gamepad state and rumble, and opens a stream menu on Back or Exit. Disconnect leaves the game running. Quit game stops it on the PC.
- Builds an unsigned `.wgt`.

Wake-on-LAN and network search send UDP. A Tizen web app cannot send UDP from JavaScript, so `npm run build` compiles `tizen/wasm/wake-on-lan.c` with Samsung Emscripten 1.39.4.7 and packs `wasm/wake-on-lan.js`, the wasm binary, the pthread worker, and `wasm/nightjar-udp.js`. That script sets `globalThis.NightjarUdp` to `{ broadcast, wake }` before `app.js`. Each magic packet goes to `255.255.255.255`, the PC's last IPv4 address, and `ff02::1`. The exact `emcc` command is in `scripts/build-wake-on-lan.sh`. Signing stays manual.

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

## Install a release

A push to `main` publishes an unsigned `nightjar.wgt` on [Releases](../../releases/latest). The workflow reads the next version from git tags, the same way [tizentube-alone](https://github.com/edivad1999/tizentube-alone) does, writes it into `tizen/config.xml`, and uploads that package. If that version is newer than the manifest, the workflow commits `tizen/config.xml` back to `main`. A pull request uploads the widget as an artifact and stops there.

1. Download `nightjar.wgt` from Releases.
2. In Tizen Studio, open Tools, then Certificate Manager. Create a profile. The author certificate is a new Samsung certificate. The distributor certificate is Samsung, Public, on the same account.
3. Sign the downloaded file. The release package has no signature.

```sh
tizen package -t wgt -s <certificate-profile> -- nightjar.wgt
```

4. On the TV, open Settings, Support, About Smart TV and press `1 2 3 4 5`. Turn Developer Mode on. Set Host PC IP to the LAN address of the PC you sign and install from, for example `192.168.1.50`. Restart the TV.
5. Install it. `sdb` is in `~/tizen-studio/tools/`.

```sh
sdb connect <tv-ip>
sdb install nightjar.wgt
```

Cut a release by pushing `main`:

```sh
git push origin main
```

The Release workflow can also be started with `workflow_dispatch`. See [`.github/workflows/release.yml`](.github/workflows/release.yml).

## Sideload

Developed against a Samsung S90D on Tizen 9. Developer Mode on the TV must list your PC's LAN address, for example `192.168.1.50`.

1. Install Tizen Studio and the TV extension. Enable Developer Mode on the TV and set the host PC IP to your PC's LAN address.
2. Connect, then install the signed widget:

```sh
sdb connect <tv-ip>
sdb install <signed>.wgt
```

This repository does not deploy to a TV.

## Run it

1. In Rubylight, turn on the WebRTC server. Signalling is `ws://<pc>:8000`. Discovery is UDP port 8000.
2. On the TV, add the PC address or search the network.
3. Read the PIN on the TV and enter it in the Rubylight console.
4. Open a game. Remote Back opens the stream menu.

## Licence

GNU General Public License v3. See `LICENSE` and `NOTICE`.
