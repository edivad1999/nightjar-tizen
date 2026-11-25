import type { BroadcastReply } from "../src/net/discover.ts";

type BootListener = (event?: { data?: string }) => void;

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
  parentElement: BootNode | null = null;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: BootNode[] = [];
  readonly classList = {
    add: () => undefined,
    remove: () => undefined,
    toggle: () => undefined,
  };
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

  focus(): void {}

  scrollIntoView(): void {}

  setAttribute(name: string, value: string): void {
    if (name === "id") {
      this.id = value;
    }
  }

  addEventListener(): void {}

  play(): Promise<void> {
    return Promise.resolve();
  }

  requestPointerLock(): Promise<void> {
    return Promise.resolve();
  }
}

class BootElement extends BootNode {}
class BootVideo extends BootElement {
  constructor() {
    super("VIDEO");
  }
}

type Listener = { type: string; listener: BootListener };

export type SavedRecord = {
  id?: string;
  address?: string;
  port?: number;
  macAddress?: string | null;
  credentials?: { clientId?: string } | null;
};

export type TvPage = {
  text(): string;
  screen(): string;
  storedHosts(): SavedRecord[];
  broadcasts(): number;
  networkListeners(): number;
  setReplies(replies: readonly BroadcastReply[]): void;
  setGreet(match: (url: string) => boolean): void;
  show(): void;
  hide(): void;
  networkUp(): void;
  stop(): void;
};

const REAL_TIMEOUT = globalThis.setTimeout;
const REAL_INTERVAL = globalThis.setInterval;
const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout;
const REAL_CLEAR_INTERVAL = globalThis.clearInterval;

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

function textOf(node: BootNode): string {
  const parts: string[] = [];
  walk(node, (item) => {
    if (item.children.length === 0 && item.textContent) {
      parts.push(item.textContent);
    }
  });
  return parts.join(" ");
}

export const SAVED_MAC = "02:00:00:00:00:0A";
export const SAVED_ADDRESS = "192.168.1.10";
export const MOVED_ADDRESS = "192.168.1.40";
const CLIENT_ID = "ab".repeat(16);
const CLIENT_SECRET = "cd".repeat(32);

export function discoveryReply(address: string, port = 8000): BroadcastReply {
  const payload = JSON.stringify({
    version: 2,
    type: "discovery",
    name: "Den",
    port,
    macAddress: SAVED_MAC,
  });
  return { address, payload: new TextEncoder().encode(payload) };
}

export function savedHostRecord(address = SAVED_ADDRESS, port = 8000) {
  return {
    id: `mac:${SAVED_MAC}`,
    name: "Den",
    address,
    port,
    macAddress: SAVED_MAC,
    credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    autoWake: true,
    nameLocked: true,
  };
}

class FakeSocket {
  url: string;
  readyState = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private closed = false;
  private readonly greet: (url: string) => boolean;

  constructor(url: string, greet: (url: string) => boolean) {
    this.url = url;
    this.greet = greet;
    queueMicrotask(() => {
      if (this.closed) {
        return;
      }
      if (this.greet(url)) {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({
          data: JSON.stringify({
            version: 2,
            type: "auth-required",
            nonce: "n",
            pairing: "client-pin",
            macAddress: SAVED_MAC,
            sunshineAvailable: true,
          }),
        });
        return;
      }
      this.readyState = 3;
      this.onerror?.();
      if (!this.closed) {
        this.onclose?.();
      }
    });
  }

  send(): void {}

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

export function installTvPage(options?: {
  address?: string;
  greet?: (url: string) => boolean;
  replies?: readonly BroadcastReply[];
  gateway?: boolean;
}): TvPage {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const documentListeners: Listener[] = [];
  const windowListeners: Listener[] = [];
  const networkListeners: Array<(state: number) => void> = [];
  let replies = [...(options?.replies ?? [])];
  let greet = options?.greet ?? (() => false);
  let gateway = options?.gateway !== false;
  let visibility = "visible";
  let broadcasts = 0;
  const store = new Map<string, string>();
  store.set("nightjar.tizen.v1", JSON.stringify({ hosts: [savedHostRecord(options?.address)] }));

  const documentElement = new BootElement("HTML");
  const body = new BootElement("BODY");
  const app = new BootElement("DIV");
  const video = new BootVideo();
  app.id = "app";
  video.id = "stream";
  documentElement.append(body);
  body.append(video, app);

  const document = {
    documentElement,
    body,
    pointerLockElement: null as BootNode | null,
    get visibilityState() {
      return visibility;
    },
    get activeElement(): BootNode | null {
      return null;
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
      documentListeners.push({ type, listener });
    },
    exitPointerLock(): void {},
  };

  function track<T extends ReturnType<typeof setTimeout>>(id: T): T {
    timers.add(id);
    return id;
  }

  const window = {
    addEventListener(type: string, listener: BootListener): void {
      windowListeners.push({ type, listener });
    },
    setInterval(fn: () => void, ms?: number): ReturnType<typeof setInterval> {
      return track(REAL_INTERVAL(fn, ms));
    },
    setTimeout(fn: () => void, ms?: number): ReturnType<typeof setTimeout> {
      return track(REAL_TIMEOUT(fn, ms));
    },
    clearInterval(id: ReturnType<typeof setInterval>): void {
      REAL_CLEAR_INTERVAL(id);
      timers.delete(id);
    },
    clearTimeout(id: ReturnType<typeof setTimeout>): void {
      REAL_CLEAR_TIMEOUT(id);
      timers.delete(id);
    },
    dispatchEvent(event: { type: string }): boolean {
      for (const item of windowListeners) {
        if (item.type === event.type) {
          item.listener();
        }
      }
      return true;
    },
  };

  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    return track(REAL_TIMEOUT(fn as () => void, ms, ...(args as [])));
  }) as typeof setTimeout;
  globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    return track(REAL_INTERVAL(fn as () => void, ms, ...(args as [])));
  }) as typeof setInterval;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    REAL_CLEAR_TIMEOUT(id);
    timers.delete(id);
  }) as typeof clearTimeout;
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    REAL_CLEAR_INTERVAL(id);
    timers.delete(id);
  }) as typeof clearInterval;

  class Socket extends FakeSocket {
    constructor(url: string) {
      super(url, (target) => greet(target));
    }
  }

  const define = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define("HTMLElement", BootElement);
  define("HTMLVideoElement", BootVideo);
  define("HTMLButtonElement", BootElement);
  define("MediaStream", class MediaStream {});
  define("document", document);
  define("window", window);
  define("WebSocket", Socket);
  define("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
  define("navigator", {
    getGamepads: () => [],
    language: "en-US",
    mediaCapabilities: null,
  });
  define("NightjarUdp", {
    broadcast: async () => {
      broadcasts += 1;
      return replies.map((reply) => ({ address: reply.address, payload: reply.payload }));
    },
    wake: () => false,
  });
  define("webapis", {
    network: {
      NetworkState: {
        INTERNET_CONNECTED: 0,
        GATEWAY_CONNECTED: 4,
        GATEWAY_DISCONNECTED: 5,
      },
      isConnectedToGateway: () => gateway,
      addNetworkStateChangeListener(listener: (state: number) => void) {
        networkListeners.push(listener);
        return networkListeners.length;
      },
    },
  });

  function emit(listeners: Listener[], type: string): void {
    for (const item of listeners) {
      if (item.type === type) {
        item.listener();
      }
    }
  }

  return {
    text: () => textOf(app),
    screen: () => {
      const page = findDescendant(app, "MAIN");
      return page?.dataset.screen ?? "";
    },
    storedHosts() {
      const raw = store.get("nightjar.tizen.v1");
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as { hosts?: SavedRecord[] };
      return parsed.hosts ?? [];
    },
    broadcasts: () => broadcasts,
    networkListeners: () => networkListeners.length,
    setReplies(next) {
      replies = [...next];
    },
    setGreet(match) {
      greet = match;
    },
    show() {
      visibility = "visible";
      emit(documentListeners, "visibilitychange");
    },
    hide() {
      visibility = "hidden";
      emit(documentListeners, "visibilitychange");
    },
    networkUp() {
      gateway = true;
      for (const listener of networkListeners) {
        listener(4);
      }
      window.dispatchEvent({ type: "online" });
    },
    stop() {
      for (const id of timers) {
        REAL_CLEAR_TIMEOUT(id);
        REAL_CLEAR_INTERVAL(id);
      }
      timers.clear();
      globalThis.setTimeout = REAL_TIMEOUT;
      globalThis.setInterval = REAL_INTERVAL;
      globalThis.clearTimeout = REAL_CLEAR_TIMEOUT;
      globalThis.clearInterval = REAL_CLEAR_INTERVAL;
    },
  };
}

export async function waitFor(check: () => boolean, label: string, ms = 1500): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) {
      throw new Error(label);
    }
    await new Promise((resolve) => REAL_TIMEOUT(resolve, 20));
  }
}
