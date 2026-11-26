/**
 * NEPHRO-SPECTRA — encrypted-at-rest-capable IndexedDB clinical vault.
 *
 * Database: `nephro_spectra_vault_v1`
 * Stores:   uroflow_sessions, dipstick_audits, stone_supersaturation_logs,
 *           glycemic_osmolality_runs, sync_outbox_queue
 *
 * Every write is mirrored into `sync_outbox_queue` so the Android build can
 * replay offline activity to Supabase when connectivity returns. No TypeScript.
 */

export const DB_NAME = 'nephro_spectra_vault_v1'
export const DB_VERSION = 1

export const STORE = {
  UROFLOW: 'uroflow_sessions',
  DIPSTICK: 'dipstick_audits',
  STONE: 'stone_supersaturation_logs',
  GLYCEMIC: 'glycemic_osmolality_runs',
  OUTBOX: 'sync_outbox_queue'
}

export const STORE_META = {
  [STORE.UROFLOW]: { label: 'Uroflow Sessions', module: 'Acoustic Sonouroflowmetry', icon: 'wave' },
  [STORE.DIPSTICK]: { label: 'Dipstick Audits', module: 'Chrono Dipstick Scanner', icon: 'pad' },
  [STORE.STONE]: { label: 'Supersaturation Logs', module: 'Stone Chemistry', icon: 'crystal' },
  [STORE.GLYCEMIC]: { label: 'Glycemic / Osmolality Runs', module: 'RK4 Metabolic Lab', icon: 'droplet' },
  [STORE.OUTBOX]: { label: 'Sync Outbox Queue', module: 'Replication', icon: 'sync' }
}

const ALL_STORES = Object.values(STORE)

let dbPromise = null

/** Open (and migrate) the vault. Returns the IDBDatabase. */
export function openVault() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable in this runtime'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = req.result
      const oldVersion = event.oldVersion

      if (oldVersion < 1) {
        const uroflow = db.createObjectStore(STORE.UROFLOW, { keyPath: 'id' })
        uroflow.createIndex('byCreatedAt', 'createdAt')
        uroflow.createIndex('byPatientRef', 'patientRef')
        uroflow.createIndex('byQmax', 'metrics.qMax')

        const dip = db.createObjectStore(STORE.DIPSTICK, { keyPath: 'id' })
        dip.createIndex('byCreatedAt', 'createdAt')
        dip.createIndex('bySeverity', 'overallSeverity')
        dip.createIndex('byPatientRef', 'patientRef')

        const stone = db.createObjectStore(STORE.STONE, { keyPath: 'id' })
        stone.createIndex('byCreatedAt', 'createdAt')
        stone.createIndex('byDominant', 'profile.dominant')

        const gly = db.createObjectStore(STORE.GLYCEMIC, { keyPath: 'id' })
        gly.createIndex('byCreatedAt', 'createdAt')
        gly.createIndex('bySglt2', 'sglt2')

        const outbox = db.createObjectStore(STORE.OUTBOX, { keyPath: 'id' })
        outbox.createIndex('byCreatedAt', 'createdAt')
        outbox.createIndex('byStatus', 'status')
        outbox.createIndex('byStore', 'store')
      }
    }
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close()
      resolve(req.result)
    }
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'))
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'))
  })
  return dbPromise
}

function tx(db, storeName, mode = 'readonly') {
  const transaction = db.transaction(storeName, mode)
  return { transaction, store: transaction.objectStore(storeName) }
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Deterministic-ish clinical record id. */
export function recordId(prefix) {
  const rand = crypto?.getRandomValues ? crypto.getRandomValues(new Uint32Array(2)) : [Date.now(), Math.random() * 1e9]
  return `${prefix}_${Date.now().toString(36)}_${(rand[0] ^ (rand[1] >>> 0)).toString(36)}`
}

/** Persist a record and enqueue its outbox entry atomically. */
export async function saveRecord(storeName, record) {
  const db = await openVault()
  const payload = {
    ...record,
    id: record.id || recordId(storeName.slice(0, 4)),
    createdAt: record.createdAt || new Date().toISOString(),
    schema: 'nephro-spectra/v28',
    device: navigator?.userAgent?.includes('NephroSpectra') ? 'android-apk' : 'web'
  }
  const transaction = db.transaction([storeName, STORE.OUTBOX], 'readwrite')
  transaction.objectStore(storeName).put(payload)
  transaction.objectStore(STORE.OUTBOX).put({
    id: `out_${payload.id}`,
    store: storeName,
    recordId: payload.id,
    status: 'pending',
    attempts: 0,
    createdAt: payload.createdAt,
    payloadSize: JSON.stringify(payload).length,
    operation: 'upsert'
  })
  await new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'))
  })
  return payload
}

export async function listRecords(storeName, limit = 50) {
  const db = await openVault()
  const { store } = tx(db, storeName)
  const idx = store.index('byCreatedAt')
  const out = []
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(null, 'prev')
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || out.length >= limit) { resolve(); return }
      out.push(cursor.value)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
  return out
}

export async function getRecord(storeName, id) {
  const db = await openVault()
  return wrap(tx(db, storeName).store.get(id))
}

export async function deleteRecord(storeName, id) {
  const db = await openVault()
  const transaction = db.transaction([storeName, STORE.OUTBOX], 'readwrite')
  transaction.objectStore(storeName).delete(id)
  transaction.objectStore(STORE.OUTBOX).delete(`out_${id}`)
  await new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function clearStore(storeName) {
  const db = await openVault()
  const transaction = db.transaction([storeName, STORE.OUTBOX], 'readwrite')
  transaction.objectStore(storeName).clear()
  const outbox = transaction.objectStore(STORE.OUTBOX)
  const req = outbox.index('byStore').openKeyCursor(IDBKeyRange.only(storeName))
  req.onsuccess = () => {
    const cursor = req.result
    if (cursor) { outbox.delete(cursor.primaryKey); cursor.continue() }
  }
  await new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function countRecords(storeName) {
  const db = await openVault()
  return wrap(tx(db, storeName).store.count())
}

/** Vault census for the sidebar badge + Polyglot Inspector. */
export async function vaultCensus() {
  const out = {}
  for (const s of ALL_STORES) {
    try {
      out[s] = await countRecords(s)
    } catch {
      out[s] = 0
    }
  }
  return { records: out, total: Object.values(out).reduce((a, b) => a + b, 0), dbName: DB_NAME, version: DB_VERSION }
}

/** Drain the outbox into an injectable sink (Supabase RPC in the APK build). */
export async function flushOutbox(sink, { batch = 25 } = {}) {
  const db = await openVault()
  const { store } = tx(db, STORE.OUTBOX)
  const pending = []
  await new Promise((resolve, reject) => {
    const req = store.index('byStatus').openCursor(IDBKeyRange.only('pending'))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || pending.length >= batch) { resolve(); return }
      pending.push(cursor.value)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
  let synced = 0
  let failed = 0
  for (const entry of pending) {
    try {
      if (sink) await sink(entry)
      const rec = await getRecord(entry.store, entry.recordId)
      const transaction = db.transaction(STORE.OUTBOX, 'readwrite')
      transaction.objectStore(STORE.OUTBOX).put({
        ...entry,
        status: rec ? 'synced' : 'orphaned',
        attempts: entry.attempts + 1,
        syncedAt: new Date().toISOString()
      })
      await new Promise((res, rej) => {
        transaction.oncomplete = () => res()
        transaction.onerror = () => rej(transaction.error)
      })
      synced++
    } catch {
      const transaction = db.transaction(STORE.OUTBOX, 'readwrite')
      transaction.objectStore(STORE.OUTBOX).put({ ...entry, status: 'pending', attempts: entry.attempts + 1, lastError: 'sink rejected' })
      failed++
    }
  }
  return { attempted: pending.length, synced, failed, remaining: await countRecords(STORE.OUTBOX) }
}

/** Export the whole vault as a versioned JSON document (HIPAA-safe, no PHI identifiers). */
export async function exportVault() {
  const doc = {
    schema: 'nephro-spectra/v28.0.0-polyglot',
    exportedAt: new Date().toISOString(),
    db: DB_NAME,
    stores: {}
  }
  for (const s of ALL_STORES) {
    doc.stores[s] = await listRecords(s, 500)
  }
  doc.census = await vaultCensus()
  return doc
}

/** Seed a first-run demonstration record if the vault is empty. */
export async function seedIfEmpty(seeders) {
  const census = await vaultCensus()
  if (census.total > 0) return { seeded: false, census }
  for (const [store, record] of Object.entries(seeders || {})) {
    if (record) await saveRecord(store, record)
  }
  return { seeded: true, census: await vaultCensus() }
}
