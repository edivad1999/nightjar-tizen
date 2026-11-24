import { isPin, type Pin } from "../domain/ids.ts";
import { STEREO_EXTENSIONS, type HostExtensions } from "../domain/settings.ts";
import { initialLink, type HostSnapshot } from "../protocol/machine.ts";
import type { AppEntry } from "../protocol/parse.ts";
import type { Credentials } from "../protocol/parse.ts";
import type { SavedHost } from "../storage/persist.ts";
import { initialShell, reduceShell, type Shell } from "./model.ts";

const credentials: Credentials = { clientId: "ab".repeat(16), clientSecret: "cd".repeat(32) };

const library: AppEntry[] = [
  { id: "celeste", title: "Celeste", artworkAvailable: false, running: true },
  { id: "hades", title: "Hades", artworkAvailable: false, running: false },
  { id: "stardew", title: "Stardew Valley", artworkAvailable: false, running: false },
  { id: "hollow", title: "Hollow Knight", artworkAvailable: false, running: false },
  { id: "portal", title: "Portal", artworkAvailable: false, running: false },
  { id: "desktop", title: "Desktop", artworkAvailable: false, running: false },
];

function pin(value: string): Pin {
  if (!isPin(value)) {
    throw new Error(`not a pin: ${value}`);
  }
  return value;
}

function host(name: string, address: string, paired: boolean, macAddress: string | null = null): SavedHost {
  return {
    name,
    address,
    port: 8000,
    macAddress,
    credentials: paired ? credentials : null,
  };
}

function snapshot(apps: AppEntry[], extensions: HostExtensions, stream: HostSnapshot["stream"]): HostSnapshot {
  return {
    hostName: "Living room",
    sessionActive: stream.kind !== "none",
    runningAppId: apps.find((app) => app.running)?.id ?? null,
    modes: [],
    extensions,
    audioChannels: 2,
    apps,
    artwork: {},
    stream,
    banner: null,
    mouseMode: false,
  };
}

function online(apps: AppEntry[], stream: HostSnapshot["stream"] = { kind: "none" }, extensions: HostExtensions = STEREO_EXTENSIONS): Shell {
  let shell = reduceShell(initialShell(), {
    kind: "hosts",
    hosts: [host("Living room", "192.168.1.20", true, "02:00:00:00:00:0A")],
  });
  shell = reduceShell(shell, { kind: "select-host", address: "192.168.1.20" });
  return reduceShell(shell, {
    kind: "link",
    link: {
      ...initialLink(credentials),
      phase: { kind: "online", snapshot: snapshot(apps, extensions, stream) },
    },
  });
}

export function shellForShot(name: string): Shell | null {
  if (name === "hosts-empty") {
    return initialShell();
  }
  if (name === "hosts-list" || name === "hosts-it") {
    let shell = online(library);
    shell = reduceShell(shell, {
      kind: "hosts",
      hosts: [
        host("Living room", "192.168.1.20", true, "02:00:00:00:00:0A"),
        host("Den", "192.168.1.30", false),
      ],
    });
    shell = reduceShell(shell, { kind: "open-hosts" });
    if (name === "hosts-it") {
      shell = reduceShell(shell, { kind: "toggle-locale" });
    }
    return shell;
  }
  if (name === "hosts-disabled") {
    let shell = online(library);
    shell = reduceShell(shell, {
      kind: "link",
      link: {
        ...initialLink(credentials),
        phase: { kind: "disabled", message: "This TV is disabled in Rubylight" },
      },
    });
    return reduceShell(shell, { kind: "open-hosts" });
  }
  if (name === "pair-rejected") {
    return reduceShell(online(library), {
      kind: "link",
      link: {
        ...initialLink(credentials),
        phase: { kind: "disabled", message: "This TV is disabled in Rubylight" },
      },
    });
  }
  if (name === "add-address") {
    return reduceShell(initialShell(), { kind: "open-add" });
  }
  if (name === "pair-waiting") {
    return reduceShell(initialShell(), {
      kind: "link",
      link: { ...initialLink(null), phase: { kind: "pairing", pin: pin("4821") } },
    });
  }
  if (name === "pair-issue") {
    return reduceShell(initialShell(), {
      kind: "link",
      link: { ...initialLink(null), phase: { kind: "need-pair" } },
    });
  }
  if (name === "library-empty") {
    return online([]);
  }
  if (name === "confirm-switch") {
    let shell = online(library);
    shell = reduceShell(shell, { kind: "open-game", appId: "hades" });
    return reduceShell(shell, { kind: "request-play" });
  }
  if (name === "settings-more") {
    const extensions: HostExtensions = { audioChannels: [2, 6, 8], input: null, codecFrameRates: [] };
    let shell = online(library, { kind: "none" }, extensions);
    shell = reduceShell(shell, { kind: "open-settings" });
    return reduceShell(shell, { kind: "toggle-more" });
  }
  if (name === "stream-menu" || name === "stream-hint" || name === "overlay") {
    let shell = online(library, { kind: "live", appId: "celeste", state: "streaming", sessionId: 4 });
    if (name === "stream-menu") {
      shell = reduceShell(shell, { kind: "back" });
    }
    return shell;
  }
  if (name === "banner") {
    return reduceShell(initialShell(), { kind: "toast", toast: { kind: "error", text: "No Rubylight PC answered." } });
  }
  if (name === "toast-waking") {
    let shell = reduceShell(initialShell(), {
      kind: "hosts",
      hosts: [host("Living room", "192.168.1.20", true, "02:00:00:00:00:0A")],
    });
    return reduceShell(shell, { kind: "toast", toast: { kind: "waking", name: "Living room" } });
  }
  if (name === "address-invalid" || name === "address-letters") {
    let shell = reduceShell(initialShell(), { kind: "open-add" });
    if (name === "address-letters") {
      shell = reduceShell(shell, { kind: "address-board", board: "letters" });
      for (const key of "livingroom") {
        shell = reduceShell(shell, { kind: "address-key", key });
      }
      return shell;
    }
    shell = reduceShell(shell, { kind: "address-key", key: "9" });
    shell = reduceShell(shell, { kind: "address-key", key: "9" });
    return reduceShell(shell, { kind: "address-problem", problem: "invalid" });
  }
  if (name === "discover-searching") {
    return reduceShell(initialShell(), { kind: "discover-start" });
  }
  if (name === "discover-none" || name === "discover-blocked" || name === "discover-results") {
    let shell = reduceShell(initialShell(), {
      kind: "hosts",
      hosts: [
        host("Living room", "192.168.1.20", false, "02:00:00:00:00:0A"),
        host("Den", "192.168.1.30", false),
      ],
    });
    if (name === "discover-blocked") {
      return reduceShell(shell, { kind: "discover-blocked" });
    }
    return reduceShell(shell, {
      kind: "discover-finish",
      addresses: name === "discover-none" ? [] : ["192.168.1.20", "192.168.1.30"],
    });
  }
  if (name === "pair-checking" || name === "pair-paired" || name === "pair-failed" || name === "pair-timeout" || name === "pair-retry" || name === "pair-it") {
    let shell = reduceShell(initialShell(), {
      kind: "link",
      link: { ...initialLink(null), phase: { kind: "pairing", pin: pin("4821") } },
    });
    if (name === "pair-it") {
      return reduceShell(shell, { kind: "toggle-locale" });
    }
    if (name === "pair-checking") {
      return reduceShell(shell, {
        kind: "link",
        link: { ...initialLink(null), phase: { kind: "authenticating" } },
      });
    }
    if (name === "pair-timeout") {
      return reduceShell(shell, {
        kind: "link",
        link: { ...initialLink(null), phase: { kind: "pairing", pin: pin("9033") } },
        notice: { kind: "timed-out" },
      });
    }
    if (name === "pair-retry") {
      return reduceShell(shell, {
        kind: "link",
        link: { ...initialLink(null), phase: { kind: "pairing", pin: pin("1140") } },
        notice: { kind: "retry" },
      });
    }
    if (name === "pair-failed") {
      return reduceShell(shell, {
        kind: "link",
        link: { ...initialLink(null), phase: { kind: "need-pair" } },
        notice: { kind: "failed", message: "The PC cancelled pairing." },
      });
    }
    shell = reduceShell(shell, {
      kind: "link",
      link: {
        ...initialLink(credentials),
        phase: { kind: "online", snapshot: snapshot(library, STEREO_EXTENSIONS, { kind: "none" }) },
      },
    });
    return shell;
  }
  if (name === "forget-confirm") {
    let shell = reduceShell(initialShell(), {
      kind: "hosts",
      hosts: [host("Den", "192.168.1.30", false)],
    });
    return reduceShell(shell, { kind: "ask-forget", address: "192.168.1.30" });
  }
  if (name === "help" || name === "help-it") {
    let shell = reduceShell(initialShell(), { kind: "open-help" });
    if (name === "help-it") {
      shell = reduceShell(shell, { kind: "toggle-locale" });
    }
    return shell;
  }
  return null;
}
