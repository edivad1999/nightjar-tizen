export const ARTWORK_BYTE_CAP = 6 * 1024 * 1024;

export type CachedApp = {
  id: string;
  title: string;
  artwork: string | null;
  savedAt: number;
};

export type ArtworkCache = {
  read(hostId: string): Promise<CachedApp[]>;
  write(hostId: string, apps: CachedApp[]): Promise<void>;
};

type Row = CachedApp & { hostId: string; bytes: number };

export function coverBytes(app: Pick<CachedApp, "title" | "artwork">): number {
  return (app.artwork ?? app.title).length;
}

export function evictCovers(rows: readonly Row[], cap = ARTWORK_BYTE_CAP): Row[] {
  const sorted = [...rows].sort((left, right) => right.savedAt - left.savedAt || left.id.localeCompare(right.id));
  const kept: Row[] = [];
  let used = 0;
  for (const row of sorted) {
    if (kept.length > 0 && used + row.bytes > cap) {
      continue;
    }
    kept.push(row);
    used += row.bytes;
  }
  return kept;
}

export function memoryArtworkCache(): ArtworkCache {
  const rows: Row[] = [];
  return {
    async read(hostId) {
      return rows.filter((row) => row.hostId === hostId).map(storedApp);
    },
    async write(hostId, apps) {
      const next = rows.filter((row) => row.hostId !== hostId);
      const savedAt = Date.now();
      for (const app of apps) {
        next.push({ ...app, hostId, savedAt: app.savedAt || savedAt, bytes: coverBytes(app) });
      }
      rows.splice(0, rows.length, ...evictCovers(next));
    },
  };
}

function storedApp(row: Row): CachedApp {
  return { id: row.id, title: row.title, artwork: row.artwork, savedAt: row.savedAt };
}

type StoreRequest<T> = {
  result: T;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
};

function requestToPromise<T>(request: StoreRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("artwork cache request failed"));
  });
}

export function indexedDbArtworkCache(factory: IDBFactory): ArtworkCache {
  let opened: Promise<IDBDatabase> | null = null;

  function database(): Promise<IDBDatabase> {
    opened ??= new Promise((resolve, reject) => {
      const request = factory.open("nightjar-artwork", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("covers")) {
          const store = db.createObjectStore("covers", { keyPath: "key" });
          store.createIndex("hostId", "hostId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("artwork cache did not open"));
    });
    return opened;
  }

  return {
    async read(hostId) {
      const db = await database();
      const rows = await readHost(db, hostId);
      return rows.map(storedApp);
    },
    async write(hostId, apps) {
      const db = await database();
      const existing = await readAll(db);
      const savedAt = Date.now();
      const incoming: Row[] = apps.map((app) => ({
        ...app,
        hostId,
        savedAt: app.savedAt || savedAt,
        bytes: coverBytes(app),
      }));
      const next = evictCovers([...existing.filter((row) => row.hostId !== hostId), ...incoming]);
      await replaceAll(db, next);
    },
  };
}

type StoredRow = Row & { key: string };

function rowKey(row: Pick<Row, "hostId" | "id">): string {
  return `${row.hostId}\u0000${row.id}`;
}

function readHost(db: IDBDatabase, hostId: string): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("covers", "readonly");
    const index = tx.objectStore("covers").index("hostId");
    const request = index.getAll(hostId) as StoreRequest<StoredRow[]>;
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(new Error("artwork cache read failed"));
  });
}

function readAll(db: IDBDatabase): Promise<Row[]> {
  const request = db.transaction("covers", "readonly").objectStore("covers").getAll() as StoreRequest<StoredRow[]>;
  return requestToPromise(request).then((rows) => rows ?? []);
}

function replaceAll(db: IDBDatabase, rows: readonly Row[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("covers", "readwrite");
    const store = tx.objectStore("covers");
    store.clear();
    for (const row of rows) {
      store.put({ ...row, key: rowKey(row) });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("artwork cache write failed"));
  });
}

export function openArtworkCache(): ArtworkCache {
  if (typeof indexedDB === "undefined") {
    return memoryArtworkCache();
  }
  return indexedDbArtworkCache(indexedDB);
}
