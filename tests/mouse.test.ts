import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptPointerSource,
  localPointer,
  mouseMode,
  mouseStatusLine,
  pointerEdge,
} from "../src/input/local-input.ts";
import { encodeInputMessage, nextButtonMask } from "../src/protocol/input.ts";

const still = {
  movementX: 0,
  movementY: 0,
  clientX: 0,
  clientY: 0,
  buttons: 0,
  previousButtons: 0,
  previousPoint: null as { x: number; y: number } | null,
  swapButtons: false,
};

test("pointer lock sends Nightjar's relative move, and a refused lock sends the same move from later positions", () => {
  const locked = localPointer({
    ...still,
    locked: true,
    movementX: -3,
    movementY: 5,
    clientX: 400,
    clientY: 300,
    previousPoint: { x: 10, y: 10 },
  });
  assert.deepEqual(locked.messages.map(encodeInputMessage), [
    '{"v":1,"type":"mouse-move","dx":-3,"dy":5}',
  ]);
  assert.equal(locked.point, null);

  const parked = localPointer({
    ...still,
    locked: false,
    clientX: 100,
    clientY: 40,
  });
  assert.deepEqual(parked.messages, []);
  const step = localPointer({
    ...still,
    locked: false,
    clientX: 112,
    clientY: 31,
    previousPoint: parked.point,
  });
  assert.deepEqual(step.messages.map(encodeInputMessage), [
    '{"v":1,"type":"mouse-move","dx":12,"dy":-9}',
  ]);
  assert.equal(step.messages.some((message) => message.type === "mouse-position"), false);
});

test("a runtime without MouseEvent.buttons still presses and releases the button index", () => {
  const down = nextButtonMask(0, false, { edge: "down", button: 0, buttons: 0 });
  assert.deepEqual(down, { mask: 1, live: false });
  const held = nextButtonMask(down.mask, down.live, { edge: "move", button: null, buttons: 0 });
  assert.deepEqual(held, { mask: 1, live: false });
  const click = localPointer({
    ...still,
    locked: false,
    buttons: down.mask,
    clientX: 8,
    clientY: 8,
  });
  assert.deepEqual(click.messages.map(encodeInputMessage), [
    '{"v":1,"type":"mouse-button","button":0,"down":true}',
  ]);
  const right = nextButtonMask(0, false, { edge: "down", button: 2, buttons: null });
  assert.equal(right.mask, 2);
  const middle = nextButtonMask(0, false, { edge: "down", button: 1, buttons: null });
  assert.equal(middle.mask, 4);
  const up = nextButtonMask(held.mask, held.live, { edge: "up", button: 0, buttons: 0 });
  assert.equal(up.mask, 0);
  const cancel = nextButtonMask(down.mask, down.live, { edge: "cancel", button: null, buttons: null });
  assert.equal(cancel.mask, 0);
});

test("a live buttons mask reports a chord that arrives as a move, then a release", () => {
  const down = nextButtonMask(0, false, { edge: "down", button: 0, buttons: 1 });
  assert.deepEqual(down, { mask: 1, live: true });
  const chord = nextButtonMask(down.mask, down.live, { edge: "move", button: null, buttons: 3 });
  assert.equal(chord.mask, 3);
  const up = nextButtonMask(chord.mask, chord.live, { edge: "up", button: 0, buttons: 0 });
  assert.deepEqual(up, { mask: 0, live: true });
});

test("mouse mode is locked, fallback, or none, and the debug line counts events", () => {
  assert.equal(mouseMode({ enabled: true, capturing: true, locked: true }), "locked");
  assert.equal(mouseMode({ enabled: true, capturing: true, locked: false }), "fallback");
  assert.equal(mouseMode({ enabled: false, capturing: true, locked: true }), "none");
  assert.equal(mouseMode({ enabled: true, capturing: false, locked: false }), "none");
  assert.equal(mouseStatusLine("fallback", 4, 3), "mouse fallback in 4 sent 3");
  assert.equal(mouseStatusLine("none", 0, 0), "mouse none in 0 sent 0");
  assert.equal(pointerEdge("mousedown"), "down");
  assert.equal(pointerEdge("pointermove"), "move");
  assert.equal(pointerEdge("mouseup"), "up");
  assert.equal(pointerEdge("pointercancel"), "cancel");
  assert.equal(pointerEdge("click"), null);
});

test("a mouse event is ignored when the pointer event for that turn was already taken", () => {
  assert.equal(acceptPointerSource("pointer", false), true);
  assert.equal(acceptPointerSource("pointer", true), true);
  assert.equal(acceptPointerSource("mouse", true), false);
  assert.equal(acceptPointerSource("mouse", false), true);
});
