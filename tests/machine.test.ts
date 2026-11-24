import assert from "node:assert/strict";
import test from "node:test";
import { authenticationProof } from "../src/protocol/auth.ts";
import { initialLink, step, type StepContext } from "../src/protocol/machine.ts";
import { parseServerMessage, type ServerMessage } from "../src/protocol/parse.ts";
import { DEFAULT_SETTINGS } from "../src/domain/settings.ts";

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
});
