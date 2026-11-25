import { normalizeMac, signallingUrl } from "../domain/ids.ts";

export const PRESENCE_RETRY_MS = 5_000;
export const PRESENCE_GREETING_MS = 2_500;
export const PRESENCE_MAX_WATCHES = 8;

export type PresenceHost = {
  id: string;
  address: string;
  port: number;
};

export type PresenceUpdate = {
  id: string;
  online: boolean;
  macAddress: string | null;
  sunshineAvailable: boolean | null;
};

export type PresenceSocket = {
  send: (data: string) => void;
  close: () => void;
  onMessage: (handler: (data: unknown) => void) => void;
  onClose: (handler: () => void) => void;
  onError: (handler: () => void) => void;
};

export type PresenceNotice = {
  macAddress: string | null;
  sunshineAvailable: boolean | null;
};

export function readPresenceMessage(payload: string): PresenceNotice | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 2) {
    return null;
  }
  if (record.type !== "auth-required" && record.type !== "sunshine-availability") {
    return null;
  }
  const macAddress = typeof record.macAddress === "string" ? normalizeMac(record.macAddress) : null;
  const sunshineAvailable = typeof record.sunshineAvailable === "boolean" ? record.sunshineAvailable : null;
  return { macAddress, sunshineAvailable };
}

type Watch = {
  id: string;
  url: string;
  address: string;
  port: number;
  socket: PresenceSocket | null;
  cancelRetry: (() => void) | null;
  cancelGreeting: (() => void) | null;
  suppress: boolean;
  attempt: number;
  answered: boolean;
  epoch: number;
};

export function browserWatchSocket(url: string): PresenceSocket {
  const socket = new WebSocket(url);
  return {
    send: (data) => {
      socket.send(data);
    },
    close: () => {
      socket.close();
    },
    onMessage: (handler) => {
      socket.onmessage = (event) => {
        handler(event.data);
      };
    },
    onClose: (handler) => {
      socket.onclose = () => {
        handler();
      };
    },
    onError: (handler) => {
      socket.onerror = () => {
        handler();
      };
    },
  };
}

export function createPresenceWatcher(options: {
  connect: (url: string) => PresenceSocket;
  hosts: () => readonly PresenceHost[];
  activeId: () => string | null;
  paused: () => boolean;
  onUpdate: (update: PresenceUpdate) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
  maxWatches?: number;
  greetingMs?: number;
  retryMs?: number;
  pulse?: boolean;
  onProbe?: (probe: { address: string; port: number; attempt: number; result: "open" | "online" | "offline" }) => void;
}): { sync: () => void; stop: () => void; nextEpoch: () => number; reopenStale: (mark: number) => void } {
  const schedule = options.schedule ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => {
      clearTimeout(timer);
    };
  });
  const maxWatches = options.maxWatches ?? PRESENCE_MAX_WATCHES;
  const greetingMs = options.greetingMs ?? PRESENCE_GREETING_MS;
  const retryMs = options.retryMs ?? PRESENCE_RETRY_MS;
  const watches = new Map<string, Watch>();
  let stopped = false;
  let probeEpoch = 0;

  function report(watch: Watch, result: "open" | "online" | "offline"): void {
    options.onProbe?.({
      address: watch.address,
      port: watch.port,
      attempt: watch.attempt,
      result,
    });
  }

  function clearTimers(watch: Watch): void {
    watch.cancelRetry?.();
    watch.cancelRetry = null;
    watch.cancelGreeting?.();
    watch.cancelGreeting = null;
  }

  function detach(watch: Watch): void {
    const socket = watch.socket;
    watch.socket = null;
    if (!socket) {
      return;
    }
    socket.onMessage(() => undefined);
    socket.onClose(() => undefined);
    socket.onError(() => undefined);
    socket.close();
  }

  function scheduleRetry(watch: Watch): void {
    watch.cancelRetry?.();
    watch.cancelRetry = schedule(() => {
      watch.cancelRetry = null;
      if (stopped || watches.get(watch.id) !== watch) {
        return;
      }
      if (options.paused() || options.activeId() === watch.id) {
        scheduleRetry(watch);
        return;
      }
      open(watch);
    }, retryMs);
  }

  function drop(watch: Watch): void {
    if (stopped || watch.suppress || watches.get(watch.id) !== watch) {
      return;
    }
    if (watch.socket === null && watch.cancelRetry) {
      return;
    }
    watch.cancelGreeting?.();
    watch.cancelGreeting = null;
    detach(watch);
    watch.answered = false;
    options.onUpdate({ id: watch.id, online: false, macAddress: null, sunshineAvailable: null });
    report(watch, "offline");
    scheduleRetry(watch);
  }

  function open(watch: Watch): void {
    if (stopped || watches.get(watch.id) !== watch) {
      return;
    }
    if (options.paused() || options.activeId() === watch.id) {
      watch.suppress = true;
      clearTimers(watch);
      detach(watch);
      watch.suppress = false;
      return;
    }
    if (watch.socket) {
      return;
    }
    clearTimers(watch);
    watch.attempt += 1;
    watch.answered = false;
    watch.epoch = probeEpoch;
    let socket: PresenceSocket;
    try {
      socket = options.connect(watch.url);
    } catch {
      drop(watch);
      return;
    }
    watch.socket = socket;
    report(watch, "open");
    watch.cancelGreeting = schedule(() => {
      watch.cancelGreeting = null;
      if (watch.socket === socket) {
        drop(watch);
      }
    }, greetingMs);
    socket.onMessage((data) => {
      if (watch.socket !== socket || typeof data !== "string") {
        return;
      }
      const notice = readPresenceMessage(data);
      if (!notice) {
        return;
      }
      watch.cancelGreeting?.();
      watch.cancelGreeting = null;
      watch.answered = true;
      report(watch, "online");
      options.onUpdate({
        id: watch.id,
        online: true,
        macAddress: notice.macAddress,
        sunshineAvailable: notice.sunshineAvailable,
      });
    });
    const fail = () => {
      if (watch.socket === socket) {
        drop(watch);
      }
    };
    socket.onClose(fail);
    socket.onError(fail);
  }

  function wanted(): PresenceHost[] {
    if (options.paused()) {
      return [];
    }
    const active = options.activeId();
    return options.hosts().filter((host) => host.id !== active).slice(0, maxWatches);
  }

  function sync(): void {
    if (stopped) {
      return;
    }
    const next = wanted();
    const ids = new Set(next.map((host) => host.id));
    for (const [id, watch] of watches) {
      if (ids.has(id)) {
        continue;
      }
      watch.suppress = true;
      clearTimers(watch);
      detach(watch);
      watches.delete(id);
    }
    for (const host of next) {
      const url = signallingUrl(host.address, host.port);
      const existing = watches.get(host.id);
      if (!existing) {
        const watch: Watch = {
          id: host.id,
          url,
          address: host.address,
          port: host.port,
          socket: null,
          cancelRetry: null,
          cancelGreeting: null,
          suppress: false,
          attempt: 0,
          answered: false,
          epoch: probeEpoch,
        };
        watches.set(host.id, watch);
        open(watch);
        continue;
      }
      if (existing.url !== url) {
        existing.suppress = true;
        clearTimers(existing);
        detach(existing);
        existing.suppress = false;
        existing.url = url;
        existing.address = host.address;
        existing.port = host.port;
        open(existing);
        continue;
      }
      if (!existing.socket && !existing.cancelRetry) {
        open(existing);
      }
    }
  }

  let pulse: ReturnType<typeof setInterval> | null = null;
  if (options.pulse !== false && !options.schedule) {
    pulse = setInterval(() => {
      sync();
    }, 1000);
    if (typeof pulse === "object" && pulse && "unref" in pulse) {
      pulse.unref();
    }
  }

  return {
    sync,
    nextEpoch() {
      probeEpoch += 1;
      return probeEpoch;
    },
    reopenStale(mark: number) {
      if (stopped) {
        return;
      }
      for (const watch of watches.values()) {
        if (watch.answered) {
          continue;
        }
        if (watch.socket && watch.epoch >= mark) {
          continue;
        }
        watch.suppress = true;
        clearTimers(watch);
        detach(watch);
        watch.suppress = false;
        open(watch);
      }
    },
    stop() {
      stopped = true;
      if (pulse !== null) {
        clearInterval(pulse);
      }
      for (const watch of watches.values()) {
        watch.suppress = true;
        clearTimers(watch);
        detach(watch);
      }
      watches.clear();
    },
  };
}
