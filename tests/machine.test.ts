import assert from "node:assert/strict";
import test from "node:test";
import { authenticationProof } from "../src/protocol/auth.ts";
import { shouldAutoPair } from "../src/domain/pairing.ts";
import { HOST_CLOSE_POLICY, HOST_CLOSE_REPLACED, initialLink, step, type LinkState, type StepContext } from "../src/protocol/machine.ts";
import { parseServerMessage, type ServerMessage } from "../src/protocol/parse.ts";
import { DEFAULT_SETTINGS } from "../src/domain/settings.ts";
import { initialShell, reduceShell } from "../src/ui/model.ts";

const context: StepContext = {
  clientName: "Nightjar TV",
  nextPin: () => "1111",
};

function server(payload: string): ServerMessage {
  const parsed = parseServerMessage(payload);
  if (!parsed.ok) {
    throw new Error(parsed.code);
  }
  return parsed.message;
}

const secret = "ab".repeat(32);
const clientId = "cd".repeat(16);
const nonce = "12".repeat(32);

test("an unpaired TV shows a pin and stores the secret the host returns", () => {
  let state = initialLink(null);
  state = step(state, { kind: "connected" }, context).state;
  const challenged = step(state, {
    kind: "server",
    message: server(`{"version":2,"type":"auth-required","nonce":"${nonce}","pairing":"client-pin","macAddress":"02:00:00:00:00:0A"}`),
  }, context);
  assert.equal(challenged.state.phase.kind, "need-pair");
  assert.equal(challenged.effects.some((effect) => effect.kind === "store-mac"), true);

  const pairing = step(challenged.state, { kind: "pair", pin: "0421" }, context);
  assert.equal(pairing.state.phase.kind, "pairing");
  const sent = pairing.effects.find((effect) => effect.kind === "send");
  assert.ok(sent && sent.kind === "send");
  assert.deepEqual(JSON.parse(sent.text), {
    version: 2,
    type: "request-pairing",
    pin: "0421",
    clientName: "Nightjar TV",
  });

  const paired = step(pairing.state, {
    kind: "server",
    message: server(`{"version":2,"type":"paired","clientId":"${clientId}","clientSecret":"${secret}"}`),
  }, context);
  assert.equal(paired.effects[0]?.kind, "store-credentials");
  const online = step(paired.state, {
    kind: "server",
    message: server('{"version":2,"type":"gateway-status","gatewayName":"Den","sunshineDetected":true,"sunshinePaired":true,"sessionActive":false}'),
  }, context);
  assert.equal(online.state.phase.kind, "online");
  assert.equal(online.effects.some((effect) => effect.kind === "send" && effect.text.includes("get-apps")), true);
});

test("a saved TV proves the nonce and a bad proof forgets the secret", () => {
  let state = initialLink({ clientId, clientSecret: secret });
  state = step(state, { kind: "connected" }, context).state;
  const challenged = step(state, {
    kind: "server",
    message: server(`{"version":2,"type":"auth-required","nonce":"${nonce}","pairing":"client-pin"}`),
  }, context);
  assert.equal(challenged.state.phase.kind, "authenticating");
  const sent = challenged.effects.find((effect) => effect.kind === "send");
  assert.ok(sent && sent.kind === "send");
  const body = JSON.parse(sent.text) as { proof: string };
  assert.equal(body.proof, authenticationProof(secret, nonce));

  const failed = step(challenged.state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"authenticate","code":"authentication-failed","message":"no"}'),
  }, context);
  assert.equal(failed.state.credentials, null);
  assert.equal(failed.state.phase.kind, "need-pair");
  assert.equal(failed.effects.some((effect) => effect.kind === "drop-credentials"), true);
});

test("cancellation waits, a wrong pin asks again, and disable keeps the secret", () => {
  let state = initialLink(null);
  state = step(state, { kind: "pair", pin: "0421" }, { ...context }).state;
  const cancelled = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"request-pairing","code":"pairing-cancelled","message":"no"}'),
  }, context);
  assert.equal(cancelled.state.phase.kind, "need-pair");
  assert.equal(cancelled.effects.length, 0);

  const retry = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"request-pairing","code":"incorrect-pin","message":"no"}'),
  }, context);
  assert.equal(retry.state.phase.kind, "pairing");
  if (retry.state.phase.kind === "pairing") {
    assert.equal(retry.state.phase.pin, "1111");
  }

  const disabled = step(initialLink({ clientId, clientSecret: secret }), {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"authenticate","code":"client-disabled","message":"disabled"}'),
  }, context);
  assert.equal(disabled.state.phase.kind, "disabled");
  assert.ok(disabled.state.credentials);
});

test("a late offer from another session is ignored", () => {
  let state = initialLink({ clientId, clientSecret: secret });
  state = step(state, { kind: "connected" }, context).state;
  state = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"gateway-status","gatewayName":"Den","sunshineDetected":true,"sunshinePaired":true,"sessionActive":false}'),
  }, context).state;
  const started = step(state, { kind: "play", appId: "7", video: DEFAULT_SETTINGS }, context);
  const sent = started.effects.find((effect) => effect.kind === "send");
  assert.ok(sent && sent.kind === "send");
  const body = JSON.parse(sent.text) as { type: string; video: { codec: string; hdr: boolean } };
  assert.equal(body.type, "start-session");
  assert.equal(body.video.codec, "hevc");
  assert.equal(body.video.hdr, false);

  let live = step(started.state, {
    kind: "server",
    message: server('{"version":2,"type":"session-status","state":"streaming","sessionId":9}'),
  }, context).state;
  const ignored = step(live, {
    kind: "server",
    message: server('{"version":2,"type":"offer","sessionId":3,"sdp":"v=0"}'),
  }, context);
  assert.equal(ignored.effects.length, 0);
  const accepted = step(live, {
    kind: "server",
    message: server('{"version":2,"type":"offer","sessionId":9,"sdp":"v=0"}'),
  }, context);
  assert.equal(accepted.effects[0]?.kind, "apply-offer");
  if (accepted.effects[0]?.kind === "apply-offer") {
    assert.equal(accepted.effects[0].openInput, false);
  }
});

function online(state = initialLink({ clientId, clientSecret: secret })) {
  let next = step(state, { kind: "connected" }, context).state;
  next = step(next, {
    kind: "server",
    message: server('{"version":2,"type":"authenticated"}'),
  }, context).state;
  return step(next, {
    kind: "server",
    message: server('{"version":2,"type":"gateway-status","gatewayName":"Den","sunshineDetected":true,"sunshinePaired":true,"sessionActive":false}'),
  }, context).state;
}

test("not-authenticated keeps a saved pairing", () => {
  const state = online();
  assert.equal(state.signedIn, true);
  const early = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"client-log","code":"not-authenticated","message":"Sign in first"}'),
  }, context);
  assert.deepEqual(early.state.credentials, state.credentials);
  assert.equal(early.state.phase.kind, "online");
  assert.equal(early.effects.some((effect) => effect.kind === "drop-credentials"), false);

  const saved = step(step(initialLink({ clientId, clientSecret: secret }), { kind: "connected" }, context).state, {
    kind: "server",
    message: server(`{"version":2,"type":"auth-required","nonce":"${nonce}","pairing":"client-pin"}`),
  }, context).state;
  const raced = step(saved, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"client-log","code":"not-authenticated","message":"Sign in first"}'),
  }, context).state;
  const opened = reduceShell(initialShell(), { kind: "link", link: pairingLink() });
  const checking = reduceShell(opened, { kind: "link", link: saved });
  const stayed = reduceShell(checking, { kind: "link", link: raced });
  assert.deepEqual(stayed.association, { kind: "pair", view: { kind: "checking" } });
});

function pairingLink() {
  const challenged = step(step(initialLink(null), { kind: "connected" }, context).state, {
    kind: "server",
    message: server(`{"version":2,"type":"auth-required","nonce":"${nonce}","pairing":"client-pin"}`),
  }, context).state;
  return step(challenged, { kind: "pair", pin: "0421" }, context).state;
}

test("a rejected start returns to the library with a typed error", () => {
  const started = step(online(), { kind: "play", appId: "7", video: DEFAULT_SETTINGS }, context);
  const failed = step(started.state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"start-session","code":"unsupported-settings","message":"Unsupported resolution"}'),
  }, context);
  assert.equal(failed.state.phase.kind, "online");
  if (failed.state.phase.kind !== "online") {
    return;
  }
  assert.equal(failed.state.phase.snapshot.stream.kind, "none");
  assert.deepEqual(failed.state.phase.snapshot.lastStartError, {
    code: "unsupported-settings",
    message: "Unsupported resolution",
    appId: "7",
  });
  assert.equal(failed.effects.some((effect) => effect.kind === "close-media"), true);
  let shell = reduceShell(initialShell(), { kind: "link", link: started.state });
  assert.equal(shell.screen, "stream");
  shell = reduceShell(shell, { kind: "link", link: failed.state });
  assert.equal(shell.screen, "library");
  assert.deepEqual(shell.toast, { kind: "info", text: "Unsupported resolution" });
});

test("a socket drop mid-stream starts the same game again, and a host close does not", () => {
  const started = step(online(), { kind: "play", appId: "7", video: DEFAULT_SETTINGS }, context);
  const live = step(started.state, {
    kind: "server",
    message: server('{"version":2,"type":"session-status","state":"streaming","sessionId":9,"video":{"width":1920,"height":1080,"fps":60,"codec":"hevc","bitrateKbps":20000,"hdr":false},"audio":{"channels":2,"sampleRate":48000}}'),
  }, context).state;
  if (live.phase.kind !== "online") {
    throw new Error("expected to be streaming");
  }
  assert.equal(live.phase.snapshot.negotiated?.video?.codec, "hevc");
  assert.equal(live.phase.snapshot.negotiated?.audio?.sampleRate, 48000);

  const dropped = step(live, { kind: "closed", code: 1006, reason: "" }, context);
  assert.equal(dropped.state.phase.kind, "idle");
  assert.equal(dropped.state.resume?.appId, "7");
  assert.equal(dropped.state.credentials?.clientId, clientId);
  let shell = reduceShell(initialShell(), { kind: "link", link: live });
  shell = reduceShell(shell, { kind: "link", link: dropped.state });
  assert.equal(shell.screen, "stream");
  assert.deepEqual(shell.toast, { kind: "hidden" });

  const resumed = step(step(dropped.state, { kind: "connected" }, context).state, {
    kind: "server",
    message: server('{"version":2,"type":"gateway-status","gatewayName":"Den","sunshineDetected":true,"sunshinePaired":true,"sessionActive":true,"runningAppId":"7"}'),
  }, context);
  const start = resumed.effects.find((effect) => effect.kind === "send" && effect.text.includes("start-session"));
  assert.ok(start && start.kind === "send");
  assert.equal(JSON.parse(start.text).appId, "7");
  if (resumed.state.phase.kind === "online") {
    assert.equal(resumed.state.phase.snapshot.stream.kind, "starting");
    if (resumed.state.phase.snapshot.stream.kind === "starting") {
      assert.equal(resumed.state.phase.snapshot.stream.state, "reconnecting");
    }
  }

  const gaveUp = step(dropped.state, { kind: "resume-timeout" }, context);
  assert.equal(gaveUp.state.resume, null);
  assert.equal(gaveUp.state.phase.kind, "fault");

  const replaced = step(live, { kind: "closed", code: HOST_CLOSE_REPLACED, reason: "Opened in another tab or browser" }, context);
  assert.equal(replaced.state.phase.kind, "fault");
  if (replaced.state.phase.kind === "fault") {
    assert.equal(replaced.state.phase.message, "Opened in another tab or browser");
  }
  assert.equal(replaced.state.resume, null);
  assert.equal(replaced.effects.some((effect) => effect.kind === "stop-retry"), true);
  const replacedShell = reduceShell(shell, { kind: "link", link: replaced.state });
  assert.equal(replacedShell.screen, "hosts");
  assert.deepEqual(replacedShell.toast, { kind: "error", text: "Opened in another tab or browser" });

  const revoked = step(live, { kind: "closed", code: HOST_CLOSE_POLICY, reason: "The console sign-in ended" }, context);
  assert.equal(revoked.state.phase.kind, "fault");
  if (revoked.state.phase.kind === "fault") {
    assert.equal(revoked.state.phase.message, "The console sign-in ended");
  }
});

function offersPin(previous: string, link: LinkState): boolean {
  return shouldAutoPair({
    previousPhase: previous,
    phase: link.phase.kind,
    offerPin: link.offerPin,
    pairing: link.pairing,
  });
}

test("a cancelled pairing is not requested again after the socket closes", () => {
  let state = { ...initialLink(null), offerPin: true };
  state = step(state, { kind: "connected" }, context).state;
  const challenged = step(state, {
    kind: "server",
    message: server(`{"version":2,"type":"auth-required","nonce":"${nonce}","pairing":"client-pin","sunshineAvailable":true}`),
  }, context);
  assert.equal(offersPin("wait-auth", challenged.state), true);
  assert.equal(challenged.state.sunshineAvailable, true);
  const pairing = step(challenged.state, { kind: "pair", pin: "0421" }, context);
  const cancelled = step(pairing.state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"request-pairing","code":"pairing-cancelled","message":"The pairing request was cancelled"}'),
  }, context);
  assert.equal(cancelled.state.pairing.kind, "unpaired");
  assert.equal(offersPin("pairing", cancelled.state), false);
  const retry = { ...initialLink(null), offerPin: false };
  const again = step(step(retry, { kind: "connected" }, context).state, {
    kind: "server",
    message: server(`{"version":2,"type":"auth-required","nonce":"${nonce}","pairing":"client-pin","sunshineAvailable":false}`),
  }, context);
  assert.equal(again.state.phase.kind, "need-pair");
  assert.equal(again.state.offerPin, false);
  assert.equal(offersPin("wait-auth", again.state), false);
  assert.equal(again.effects.some((effect) => effect.kind === "send"), false);
  const fresh = step(again.state, { kind: "pair", pin: "1234" }, context);
  assert.equal(fresh.state.pairing.kind, "pairing");
  assert.equal(fresh.state.phase.kind, "pairing");
  const waiting = reduceShell(initialShell(), { kind: "link", link: pairing.state });
  const failed = reduceShell(waiting, {
    kind: "link",
    link: cancelled.state,
    notice: { kind: "failed", message: "The pairing request was cancelled" },
  });
  assert.deepEqual(failed.association, {
    kind: "pair",
    view: { kind: "failed", message: "The pairing request was cancelled" },
  });
});

test("sunshine availability and the input extension are kept", () => {
  let state = online();
  state = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"sunshine-availability","sunshineAvailable":false}'),
  }, context).state;
  state = step(state, {
    kind: "server",
    message: server(JSON.stringify({
      version: 2,
      type: "capabilities",
      videoModes: [{
        width: 1920,
        height: 1080,
        frameRates: [60],
        codecs: ["hevc"],
        hdrCodecs: ["hevc"],
        defaultCodec: "hevc",
        defaultBitrateKbps: 20000,
        experimental: false,
        hdrSupported: true,
        hdrExperimental: true,
      }],
      extensions: { audioChannels: [2], input: { label: "input", version: 1, keyboard: true, mouse: true } },
    })),
  }, context).state;
  if (state.phase.kind !== "online") {
    throw new Error("expected the library");
  }
  assert.equal(state.phase.snapshot.sunshineAvailable, false);
  assert.equal(state.phase.snapshot.modes[0]?.hdrExperimental, true);
  const playing = step(state, { kind: "play", appId: "7", video: DEFAULT_SETTINGS }, context).state;
  const offer = step(playing, {
    kind: "server",
    message: server('{"version":2,"type":"session-status","state":"starting-webrtc","sessionId":4}'),
  }, context).state;
  const applied = step(offer, {
    kind: "server",
    message: server('{"version":2,"type":"offer","sessionId":4,"sdp":"v=0"}'),
  }, context);
  const effect = applied.effects[0];
  assert.equal(effect?.kind, "apply-offer");
  if (effect?.kind === "apply-offer") {
    assert.equal(effect.openInput, true);
  }
});
