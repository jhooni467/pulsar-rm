/* =========================================================
   NOVA INTELLIGENCE — ALMACENAMIENTO PROPIO (etapa 1)
   Base de datos independiente: "pulsar-nova". NO toca "pulsar-rm" (canciones, ajustes, equalizador),
   así que el esquema de IndexedDB de Pulsar RM no cambia.
   Contiene tres almacenes:
     cache   — respuestas de proveedores con caducidad (para no repetir peticiones)
     history — cambios que Nova aplicó a la biblioteca (para poder deshacerlos)
     meta    — datos pequeños de Nova
   Es perezoso: la base de datos no se abre ni se crea hasta que algo la usa por primera vez.
   Si IndexedDB no está disponible, usa memoria (se pierde al cerrar la app) y no falla.
   ========================================================= */
"use strict";

(function () {
  if (typeof Nova === "undefined") return;

  const DB_NAME = "pulsar-nova";
  const DB_VERSION = 1;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function create(dbName) {
    const memory = { cache: new Map(), history: [], meta: new Map(), nextId: 1 };
    let db = null;
    let opening = null;
    let persistent = false;

    function open() {
      if (opening) return opening;
      opening = new Promise((resolve) => {
        if (typeof indexedDB === "undefined" || !indexedDB) return resolve(false);
        let request;
        try { request = indexedDB.open(dbName, DB_VERSION); } catch (error) { return resolve(false); }
        request.onupgradeneeded = () => {
          const target = request.result;
          if (!target.objectStoreNames.contains("cache")) target.createObjectStore("cache", { keyPath: "key" });
          if (!target.objectStoreNames.contains("history")) target.createObjectStore("history", { keyPath: "id", autoIncrement: true });
          if (!target.objectStoreNames.contains("meta")) target.createObjectStore("meta", { keyPath: "key" });
        };
        request.onsuccess = () => {
          db = request.result;
          persistent = true;
          db.onversionchange = () => { try { db.close(); } catch (error) { /* nada */ } db = null; persistent = false; opening = null; };
          resolve(true);
        };
        request.onerror = () => resolve(false);
        request.onblocked = () => resolve(false);
      });
      return opening;
    }

    // Una transacción con promesa. `work(store, done)` rellena el resultado.
    function tx(storeName, mode, work) {
      return new Promise((resolve, reject) => {
        let transaction;
        try { transaction = db.transaction(storeName, mode); } catch (error) { return reject(error); }
        let output;
        transaction.oncomplete = () => resolve(output);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Nova.Error("aborted", "Transacción cancelada"));
        work(transaction.objectStore(storeName), (value) => { output = value; });
      });
    }

    function wrap(error) {
      if (error && error.name === "QuotaExceededError") return new Nova.Error("quota", "No hay espacio suficiente para los datos de Nova");
      return error instanceof Nova.Error ? error : new Nova.Error("store", error && error.message ? error.message : String(error));
    }

    async function run(storeName, mode, work, memoryWork) {
      const ok = await open();
      if (!ok || !db) return memoryWork();
      try { return await tx(storeName, mode, work); } catch (error) { throw wrap(error); }
    }

    function ttlDefault() {
      const days = Nova.config && typeof Nova.config.get === "function" ? Number(Nova.config.get("cacheDays")) : 30;
      return (isFinite(days) && days > 0 ? days : 30) * DAY_MS;
    }

    const store = {
      name: dbName,

      // true = datos guardados de forma permanente; false = solo memoria
      async ready() { await open(); return persistent; },
      get persistent() { return persistent; },

      /* ---------- Caché con caducidad ---------- */

      async cacheGet(key) {
        const entry = await run("cache", "readonly",
          (os, done) => { const r = os.get(String(key)); r.onsuccess = () => done(r.result || null); },
          () => memory.cache.get(String(key)) || null);
        if (!entry) return null;
        if (entry.expiresAt && entry.expiresAt < Date.now()) { store.cacheDelete(key).catch(() => {}); return null; }
        return entry.value;
      },

      async cachePut(key, value, ttlMs) {
        const now = Date.now();
        const entry = { key: String(key), value, savedAt: now, expiresAt: now + (ttlMs > 0 ? ttlMs : ttlDefault()) };
        await run("cache", "readwrite", (os) => { os.put(entry); }, () => { memory.cache.set(entry.key, entry); });
        return true;
      },

      async cacheDelete(key) {
        await run("cache", "readwrite", (os) => { os.delete(String(key)); }, () => { memory.cache.delete(String(key)); });
        return true;
      },

      async cacheClear() {
        await run("cache", "readwrite", (os) => { os.clear(); }, () => { memory.cache.clear(); });
        return true;
      },

      // Borra lo caducado. Devuelve cuántas entradas quitó.
      async cachePrune() {
        const now = Date.now();
        return run("cache", "readwrite", (os, done) => {
          let removed = 0;
          const cursor = os.openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) { done(removed); return; }
            if (item.value.expiresAt && item.value.expiresAt < now) { item.delete(); removed++; }
            item.continue();
          };
        }, () => {
          let removed = 0;
          memory.cache.forEach((entry, key) => { if (entry.expiresAt && entry.expiresAt < now) { memory.cache.delete(key); removed++; } });
          return removed;
        });
      },

      /* ---------- Historial de cambios (para deshacer) ---------- */

      async historyAdd(entry) {
        const record = Object.assign({}, entry, { at: Date.now() });
        delete record.id;
        return run("history", "readwrite",
          (os, done) => { const r = os.add(record); r.onsuccess = () => done(r.result); },
          () => { record.id = memory.nextId++; memory.history.push(record); return record.id; });
      },

      // Los más recientes primero
      async historyList(limit) {
        const max = limit > 0 ? limit : 50;
        const all = await run("history", "readonly",
          (os, done) => { const r = os.getAll(); r.onsuccess = () => done(r.result || []); },
          () => memory.history.slice());
        return all.sort((a, b) => b.at - a.at || b.id - a.id).slice(0, max);
      },

      async historyRemove(id) {
        await run("history", "readwrite", (os) => { os.delete(id); }, () => { memory.history = memory.history.filter((item) => item.id !== id); });
        return true;
      },

      /* ---------- Datos pequeños ---------- */

      async metaGet(key) {
        const entry = await run("meta", "readonly",
          (os, done) => { const r = os.get(String(key)); r.onsuccess = () => done(r.result || null); },
          () => memory.meta.get(String(key)) || null);
        return entry ? entry.value : null;
      },

      async metaSet(key, value) {
        const entry = { key: String(key), value };
        await run("meta", "readwrite", (os) => { os.put(entry); }, () => { memory.meta.set(entry.key, entry); });
        return true;
      },

      async stats() {
        const count = (name, memoryCount) => run(name, "readonly",
          (os, done) => { const r = os.count(); r.onsuccess = () => done(r.result); },
          memoryCount);
        return {
          persistent: await store.ready(),
          cache: await count("cache", () => memory.cache.size),
          history: await count("history", () => memory.history.length)
        };
      },

      // Cierra la base y la borra (para "Borrar datos de Nova" y para los autotest)
      async destroy() {
        try { if (db) db.close(); } catch (error) { /* nada */ }
        db = null; opening = null; persistent = false;
        memory.cache.clear(); memory.history = []; memory.meta.clear();
        if (typeof indexedDB === "undefined" || !indexedDB) return true;
        return new Promise((resolve) => {
          let request;
          try { request = indexedDB.deleteDatabase(dbName); } catch (error) { return resolve(false); }
          request.onsuccess = () => resolve(true);
          request.onerror = () => resolve(false);
          request.onblocked = () => resolve(false);
        });
      },

      create
    };
    return store;
  }

  const main = create(DB_NAME);

  // Autotest: usa una base de prueba aparte, que borra al terminar
  main.selfTest = async function () {
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ? String(detail) : "" });
    const probe = create("pulsar-nova-autotest");
    try {
      const persistent = await probe.ready();
      check("almacén abre (" + (persistent ? "IndexedDB" : "memoria") + ")", true);
      await probe.cachePut("a", { x: 1 }, 60000);
      const hit = await probe.cacheGet("a");
      check("caché: guarda y lee", hit && hit.x === 1);
      await probe.cachePut("viejo", "v", 1);
      await new Promise((resolve) => setTimeout(resolve, 15));
      check("caché: lo caducado no se devuelve", (await probe.cacheGet("viejo")) === null);
      await probe.cachePut("viejo2", "v", 1);
      await new Promise((resolve) => setTimeout(resolve, 15));
      check("caché: limpieza de caducados", (await probe.cachePrune()) >= 1);
      const id = await probe.historyAdd({ module: "prueba", field: "lyrics" });
      const list = await probe.historyList(5);
      check("historial: añade y lista", list.length === 1 && list[0].id === id);
      await probe.historyRemove(id);
      check("historial: quita", (await probe.historyList(5)).length === 0);
      await probe.metaSet("k", 7);
      check("meta: guarda y lee", (await probe.metaGet("k")) === 7);
    } catch (error) {
      check("almacén: sin errores", false, error && error.message);
    } finally {
      try { await probe.destroy(); } catch (error) { /* nada */ }
    }
    return { checks };
  };

  Nova.use("store", main);
})();
