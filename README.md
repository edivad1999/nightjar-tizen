# moonlight-tizen

A Samsung Tizen game-streaming client. It talks WebRTC directly to Sunshine and Apollo forks, including Rubylight and Vibepollo. It does not use the proxy layer from the abandoned moonlight-webrtc-tizen proof of concept.

## Reference clones

`reference/` holds shallow clones of upstream projects used as reading material while the app is built. Git ignores this directory. Do not commit it.

- [Rubylight](https://github.com/RamazanKara/Rubylight)
- [Vibepollo](https://github.com/Nonary/Vibepollo)
- [moonlight-webrtc-tizen](https://github.com/tsoas/moonlight-webrtc-tizen), an abandoned proof of concept

To create or update the clones, run:

```sh
./scripts/fetch-references.sh
```
