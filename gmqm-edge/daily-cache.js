import { readExport } from "./sop.js";

const storeName = "exports";

function openCache() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("gmqm-daily-exports", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: ["day", "site"] }).createIndex("day", "day");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(mode, action) {
  const database = await openCache();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error);
      transaction.onerror = () => reject(transaction.error ?? request.error);
    });
  } finally {
    database.close();
  }
}

export async function dailyExports(day) {
  const entries = await transaction("readonly", store => store.index("day").getAll(day));
  return Promise.allSettled(entries.map(async entry => {
    const record = entry.source ? readExport(new Uint8Array(await entry.source.arrayBuffer()),
      entry.site, entry.filename, day) : { total: 0, outside: 0, missing: 0, films: [], rows: [] };
    if (record.total !== entry.total || record.outside) throw new Error("每日原表缓存校验失败");
    return { ...entry, ...record, daily: true };
  }));
}

export function saveDailyExport(day, { site, filename, total, source, production }) {
  return transaction("readwrite", store => store.put({ day, site, filename, total, source, production }));
}

export function deleteDailyExport(day, site) {
  return transaction("readwrite", store => store.delete([day, site]));
}
