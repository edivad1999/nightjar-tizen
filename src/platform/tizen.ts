export const TV_KEYS = ["Menu", "Info", "ColorF0Red", "ColorF1Green", "ColorF2Yellow", "ColorF3Blue"];

export type TizenKeys = {
  tvinputdevice?: {
    registerKeyBatch?: (keys: string[]) => void;
    unregisterKeyBatch?: (keys: string[]) => void;
  };
};

export type ExitDecision = {
  armed: boolean;
  action: "ask" | "exit" | "none";
};

export type StopCommand = "stop-session" | "stop-host-session";

export function registerTvKeys(tizen: TizenKeys | null | undefined): boolean {
  try {
    tizen?.tvinputdevice?.registerKeyBatch?.(TV_KEYS);
    return true;
  } catch {
    return false;
  }
}

export function releaseTvKeys(tizen: TizenKeys | null | undefined): void {
  try {
    tizen?.tvinputdevice?.unregisterKeyBatch?.(TV_KEYS);
  } catch {
    return;
  }
}

export function hideAction(streaming: boolean, quitOnDisconnect: boolean, recovering = false): StopCommand | null {
  if (!streaming && !recovering) {
    return null;
  }
  return quitOnDisconnect ? "stop-host-session" : "stop-session";
}

export function applyHide(
  input: { streaming: boolean; quitOnDisconnect: boolean; recovering?: boolean },
  tizen: TizenKeys | null | undefined,
): StopCommand | null {
  releaseTvKeys(tizen);
  return hideAction(input.streaming, input.quitOnDisconnect, input.recovering === true);
}

export function resumeAction(online: boolean): "reconnect" | "continue" {
  return online ? "continue" : "reconnect";
}

export function applyShow(online: boolean, tizen: TizenKeys | null | undefined): "reconnect" | "continue" {
  registerTvKeys(tizen);
  return resumeAction(online);
}

export function exitStep(screen: string, armed: boolean, back: boolean): ExitDecision {
  if (!back || screen !== "hosts") {
    return { armed: false, action: "none" };
  }
  if (!armed) {
    return { armed: true, action: "ask" };
  }
  return { armed: false, action: "exit" };
}

export function exitPrompt(locale: "en" | "it"): string {
  return locale === "it" ? "Premi di nuovo Indietro per uscire." : "Press Back again to exit.";
}

export function exitApp(application: { getCurrentApplication?: () => { exit?: () => void } } | null | undefined): void {
  try {
    application?.getCurrentApplication?.()?.exit?.();
  } catch {
    return;
  }
}

export function localeFromLanguage(language: string): "en" | "it" {
  const base = language.toLowerCase().split(/[-_]/)[0];
  return base === "it" ? "it" : "en";
}

export function firstRunLocale(stored: "en" | "it" | null, system: string): "en" | "it" {
  if (stored === "en" || stored === "it") {
    return stored;
  }
  return localeFromLanguage(system);
}

export function readModel(productinfo: { getRealModel?: () => string } | null | undefined): string | null {
  try {
    const model = productinfo?.getRealModel?.();
    if (typeof model !== "string") {
      return null;
    }
    const trimmed = model.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

export function clientNameFromModel(model: string | null | undefined): string {
  const trimmed = (model ?? "").trim();
  if (trimmed === "") {
    return "Nightjar TV";
  }
  return `Nightjar ${trimmed}`.slice(0, 80);
}

export function pinBound(bound: number, fill?: (bytes: Uint32Array) => void): number {
  if (!Number.isInteger(bound) || bound <= 0) {
    return 0;
  }
  const bytes = new Uint32Array(1);
  if (fill) {
    fill(bytes);
  } else {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
      cryptoApi.getRandomValues(bytes);
    } else {
      bytes[0] = Math.floor(Math.random() * 4294967296);
    }
  }
  return bytes[0] % bound;
}
