export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type TvPreference = {
  exists?: (key: string) => boolean;
  getValue?: (key: string) => string;
  setValue?: (key: string, value: string) => void;
  remove?: (key: string) => void;
};

export type FileHandle = {
  readString?: () => string;
  writeString?: (value: string) => void;
  close?: () => void;
  sync?: () => void;
};

export type TvFilesystem = {
  pathExists?: (path: string) => boolean;
  openFile?: (path: string, mode: "r" | "w") => FileHandle;
  deleteFile?: (path: string) => void;
};

export type TvStorageHost = {
  preference?: TvPreference | null;
  filesystem?: TvFilesystem | null;
  localStorage?: KeyValueStore | null;
};

type StorageBackend = {
  read(key: string): string | null;
  write(key: string, value: string): void;
};

function filePath(key: string): string {
  const name = key.replace(/[^A-Za-z0-9._-]/g, "_");
  return `wgt-private/${name}.json`;
}

function preferenceBackend(preference: TvPreference): StorageBackend | null {
  if (typeof preference.exists !== "function" || typeof preference.getValue !== "function" || typeof preference.setValue !== "function") {
    return null;
  }
  const exists = preference.exists.bind(preference);
  const getValue = preference.getValue.bind(preference);
  const setValue = preference.setValue.bind(preference);
  return {
    read(key) {
      if (!exists(key)) {
        return null;
      }
      const value = getValue(key);
      return typeof value === "string" ? value : null;
    },
    write(key, value) {
      setValue(key, value);
    },
  };
}

function fileBackend(filesystem: TvFilesystem): StorageBackend | null {
  if (typeof filesystem.pathExists !== "function" || typeof filesystem.openFile !== "function") {
    return null;
  }
  const pathExists = filesystem.pathExists.bind(filesystem);
  const openFile = filesystem.openFile.bind(filesystem);
  return {
    read(key) {
      const path = filePath(key);
      if (!pathExists(path)) {
        return null;
      }
      const handle = openFile(path, "r");
      try {
        const text = handle.readString?.();
        if (typeof text !== "string") {
          return null;
        }
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return null;
        }
        const value = (parsed as { value?: unknown }).value;
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      } finally {
        handle.close?.();
      }
    },
    write(key, value) {
      const handle = openFile(filePath(key), "w");
      try {
        if (typeof handle.writeString !== "function") {
          throw new Error("filesystem write unavailable");
        }
        handle.writeString(JSON.stringify({ value }));
        handle.sync?.();
      } finally {
        handle.close?.();
      }
    },
  };
}

function localBackend(storage: KeyValueStore): StorageBackend {
  return {
    read(key) {
      return storage.getItem(key);
    },
    write(key, value) {
      storage.setItem(key, value);
    },
  };
}

export function createDurableStore(backends: readonly StorageBackend[]): KeyValueStore {
  return {
    getItem(key) {
      let found: string | null = null;
      const stale: StorageBackend[] = [];
      for (const backend of backends) {
        try {
          const value = backend.read(key);
          if (value !== null) {
            found = value;
            break;
          }
          stale.push(backend);
        } catch {
          continue;
        }
      }
      if (found !== null) {
        for (const backend of stale) {
          try {
            backend.write(key, found);
          } catch {
            continue;
          }
        }
      }
      return found;
    },
    setItem(key, value) {
      let wrote = false;
      for (const backend of backends) {
        try {
          backend.write(key, value);
          wrote = true;
        } catch {
          continue;
        }
      }
      if (!wrote) {
        throw new Error("storage unavailable");
      }
    },
  };
}

export function openTvStore(host: TvStorageHost): KeyValueStore {
  const backends: StorageBackend[] = [];
  if (host.preference) {
    const preference = preferenceBackend(host.preference);
    if (preference) {
      backends.push(preference);
    }
  }
  if (host.filesystem) {
    const files = fileBackend(host.filesystem);
    if (files) {
      backends.push(files);
    }
  }
  if (host.localStorage) {
    backends.push(localBackend(host.localStorage));
  }
  return createDurableStore(backends);
}
