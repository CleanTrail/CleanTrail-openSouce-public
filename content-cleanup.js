// content-cleanup.js
(async () => {
  try {
    const [opts] = arguments; // deleteLocalStorage, deleteSessionStorage, deleteIndexedDB
    if (opts.deleteLocalStorage) localStorage.clear();
    if (opts.deleteSessionStorage) sessionStorage.clear();
    if (opts.deleteIndexedDB) {
      const dbs = await indexedDB.databases();
      for (const db of dbs) indexedDB.deleteDatabase(db.name);
    }
    console.log("[CleanTrail] Tab cleanup complete:", location.hostname);
  } catch (e) {
    console.warn("[CleanTrail] Cleanup failed:", e);
  }
})();
