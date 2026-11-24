# moonlight-tizen

A Tizen Nightjar: a Samsung Tizen TV client for [Rubylight](https://github.com/RamazanKara/Rubylight). It talks Rubylight's WebRTC TV protocol, version 2, directly to the host. It does not use a proxy, and it does not target other Sunshine forks.

The feature and UX model is [Nightjar](https://github.com/RamazanKara/nightjar), Rubylight's native Android and desktop client. Tizen cannot run Nightjar's Moonlight and RTSP engine, so the stream itself uses WebRTC.

## Reference clones

`reference/` holds shallow clones used as reading material while the app is built. Git ignores this directory. Do not commit it.

- [Rubylight](https://github.com/RamazanKara/Rubylight), the host
- [Nightjar](https://github.com/RamazanKara/nightjar), the native client to model
- [Monlight-Tizen-WebRtc-Client](https://github.com/mlopezsegura/Monlight-Tizen-WebRtc-Client), the TV protocol specification and the official Tizen WebRTC client
- [moonlight-webrtc-tizen](https://github.com/tsoas/moonlight-webrtc-tizen), the abandoned PoC that introduced the Tizen app and the retired Windows gateway

To create or update the clones, run:

```sh
./scripts/fetch-references.sh
```

See [AGENTS.md](AGENTS.md) for the file map and what to read for each task.
