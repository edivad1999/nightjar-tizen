import assert from "node:assert/strict";
import test from "node:test";

type BootListener = (event: unknown) => void;

class BootNode {
  id = "";
  className = "";
  textContent = "";
  hidden = false;
  lang = "";
  type = "";
  value = "";
  placeholder = "";
  autocomplete = "";
  role = "";
  srcObject: unknown = null;
  videoWidth = 0;
  videoHeight = 0;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: BootNode[] = [];
  parentElement: BootNode | null = null;
  readonly classList = {
    add(): void {},
    toggle(): void {},
    remove(): void {},
  };
  private readonly listeners: BootListener[] = [];

  tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...nodes: BootNode[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: BootNode[]): void {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children.length = 0;
    this.append(...nodes);
  }

  querySelector(selector: string): BootNode | null {
    return findDescendant(this, selector);
  }

  focus(): void {
    active = this;
  }

  scrollIntoView(): void {}

  setAttribute(name: string, value: string): void {
    if (name === "id") {
      this.id = value;
    }
  }

  addEventListener(type: string, listener: BootListener): void {
    this.listeners.push((event) => {
      if (type === "keydown" || type === "keyup") {
        keyEvents += 1;
      }
      listener(event);
    });
  }

  play(): Promise<void> {
    return Promise.resolve();
  }
}

class BootElement extends BootNode {}

class BootVideo extends BootElement {
  constructor() {
    super("VIDEO");
  }
}

const timers = new Set<ReturnType<typeof setInterval>>();
let active: BootNode | null = null;
let keyEvents = 0;
let keyRegistrationThrew = false;

const documentElement = new BootElement("HTML");
const body = new BootElement("BODY");
const app = new BootElement("DIV");
const video = new BootVideo();
app.id = "app";
video.id = "stream";
documentElement.append(body);
body.append(video, app);

function matches(node: BootNode, selector: string): boolean {
  if (selector.startsWith("#")) {
    return node.id === selector.slice(1);
  }
  return node.tagName === selector.toUpperCase();
}

function findDescendant(node: BootNode, selector: string): BootNode | null {
  for (const child of node.children) {
    if (matches(child, selector)) {
      return child;
    }
    const nested = findDescendant(child, selector);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function walk(node: BootNode, visit: (node: BootNode) => void): void {
  visit(node);
  for (const child of node.children) {
    walk(child, visit);
  }
}

const document = {
  documentElement,
  body,
  pointerLockElement: null as BootNode | null,
  get activeElement(): BootNode | null {
    return active;
  },
  createElement(tag: string): BootNode {
    if (tag === "video") {
      return new BootVideo();
    }
    return new BootElement(tag.toUpperCase());
  },
  createTextNode(text: string): BootNode {
    const node = new BootNode("#text");
    node.textContent = text;
    return node;
  },
  querySelector(selector: string): BootNode | null {
    if (matches(documentElement, selector)) {
      return documentElement;
    }
    return findDescendant(documentElement, selector);
  },
  getElementById(id: string): BootNode | null {
    return findDescendant(documentElement, `#${id}`);
  },
  addEventListener(type: string, listener: BootListener): void {
    documentElement.addEventListener(type, listener);
  },
  exitPointerLock(): void {},
};

const bootWindow = {
  addEventListener(): void {},
  setInterval(fn: () => void, ms?: number): ReturnType<typeof setInterval> {
    const id = globalThis.setInterval(fn, ms);
    timers.add(id);
    return id;
  },
  setTimeout(fn: () => void, ms?: number): ReturnType<typeof setTimeout> {
    const id = globalThis.setTimeout(fn, ms);
    timers.add(id);
    return id;
  },
  clearInterval(id: ReturnType<typeof setInterval>): void {
    globalThis.clearInterval(id);
    timers.delete(id);
  },
  clearTimeout(id: ReturnType<typeof setTimeout>): void {
    globalThis.clearTimeout(id);
    timers.delete(id);
  },
};

const store = new Map<string, string>();

Object.defineProperty(globalThis, "navigator", {
  value: {
    getGamepads: () => [],
    language: "en-US",
    mediaCapabilities: null,
  },
  configurable: true,
});

Object.assign(globalThis, {
  HTMLElement: BootElement,
  HTMLVideoElement: BootVideo,
  MediaStream: class MediaStream {},
  document,
  window: bootWindow,
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  },
  tizen: {
    tvinputdevice: {
      registerKeyBatch(): void {
        keyRegistrationThrew = true;
        throw new Error("SecurityError");
      },
    },
  },
});

function shown(node: BootNode | null): boolean {
  let current = node;
  while (current) {
    if (current.hidden) {
      return false;
    }
    if (current === documentElement) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function textOf(node: BootNode | null): string {
  if (!node) {
    return "";
  }
  const parts: string[] = [];
  walk(node, (item) => {
    if (item.children.length === 0 && item.textContent) {
      parts.push(item.textContent);
    }
  });
  return parts.join(" ");
}

function stopTimers(): void {
  for (const id of timers) {
    globalThis.clearInterval(id);
    globalThis.clearTimeout(id);
  }
  timers.clear();
}

test("first launch shows the PC list and focuses Add a PC with no key press", async () => {
  let bootError: unknown = null;
  try {
    await import("../src/ui/main.ts");
  } catch (error) {
    bootError = error;
  } finally {
    stopTimers();
  }

  assert.equal(bootError, null);
  assert.equal(keyEvents, 0);
  assert.equal(keyRegistrationThrew, true);
  const page = findDescendant(app, "MAIN");
  assert.equal(page?.dataset.screen, "hosts");
  assert.equal(shown(page), true);
  assert.match(textOf(page), /PCs/);
  assert.match(textOf(page), /Add a PC/);
  const focused = active;
  assert.equal(focused?.id, "add-host");
  assert.equal(focused?.textContent, "Add a PC");
  assert.equal(shown(focused), true);
  assert.notEqual(focused, video);
});
