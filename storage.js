/**
 * storage.js
 * ------------------------------------------------------------------------
 * Thin promise wrapper around IndexedDB. This is the system's "document
 * memory": once a teacher has defined a test/template/answer key, it is
 * saved here so future sheets for the same test never need
 * reconfiguring. Nothing in this file knows about grading or UI — it
 * only persists and retrieves the model objects defined in js/models/.
 * ------------------------------------------------------------------------
 */

const DB_NAME = 'omr-magic';
const DB_VERSION = 1;

const STORES = Object.freeze({
  TESTS: 'tests',
  TEMPLATES: 'templates',
  ANSWER_KEYS: 'answerKeys',
  SHEETS: 'sheets'
});

export { STORES };

let _dbPromise = null;

/** @returns {Promise<IDBDatabase>} */
function openDatabase() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORES.TESTS)) {
        db.createObjectStore(STORES.TESTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.TEMPLATES)) {
        db.createObjectStore(STORES.TEMPLATES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.ANSWER_KEYS)) {
        const keyStore = db.createObjectStore(STORES.ANSWER_KEYS, { keyPath: 'id' });
        keyStore.createIndex('by_testId', 'testId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.SHEETS)) {
        const sheetStore = db.createObjectStore(STORES.SHEETS, { keyPath: 'id' });
        sheetStore.createIndex('by_testId', 'testId', { unique: false });
        sheetStore.createIndex('by_fingerprint', 'scanFingerprint', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return _dbPromise;
}

function tx(storeName, mode) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        resolve({ store, transaction });
      })
  );
}

function wrapRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Generic put (insert or update) into any store. Resolves once the
 * transaction has durably committed, not just once the request queued. */
async function put(storeName, value) {
  const { store, transaction } = await tx(storeName, 'readwrite');
  store.put(value);
  await transactionAsRequest(transaction);
  return value;
}

// IDBTransaction doesn't expose a promise-friendly "done" the same way
// a request does; adapt it minimally so callers can `await` a put/delete
// completing durably rather than just being queued.
function transactionAsRequest(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

async function get(storeName, id) {
  const { store } = await tx(storeName, 'readonly');
  return wrapRequest(store.get(id));
}

async function getAll(storeName) {
  const { store } = await tx(storeName, 'readonly');
  return wrapRequest(store.getAll());
}

async function getAllByIndex(storeName, indexName, value) {
  const { store } = await tx(storeName, 'readonly');
  return wrapRequest(store.index(indexName).getAll(value));
}

async function remove(storeName, id) {
  const { store, transaction } = await tx(storeName, 'readwrite');
  store.delete(id);
  return transactionAsRequest(transaction);
}

// ---- Tests ----------------------------------------------------------
export const saveTest = (test) => put(STORES.TESTS, test);
export const getTest = (id) => get(STORES.TESTS, id);
export const getAllTests = () => getAll(STORES.TESTS);
export const deleteTest = (id) => remove(STORES.TESTS, id);

// ---- Templates --------------------------------------------------------
export const saveTemplate = (template) => put(STORES.TEMPLATES, template);
export const getTemplate = (id) => get(STORES.TEMPLATES, id);
export const getAllTemplates = () => getAll(STORES.TEMPLATES);
export const deleteTemplate = (id) => remove(STORES.TEMPLATES, id);

// ---- Answer keys --------------------------------------------------------
export const saveAnswerKey = (key) => put(STORES.ANSWER_KEYS, key);
export const getAnswerKey = (id) => get(STORES.ANSWER_KEYS, id);
export const getAnswerKeysForTest = (testId) => getAllByIndex(STORES.ANSWER_KEYS, 'by_testId', testId);
export const deleteAnswerKey = (id) => remove(STORES.ANSWER_KEYS, id);

// ---- Sheets --------------------------------------------------------
export const saveSheet = (sheet) => put(STORES.SHEETS, sheet);
export const getSheet = (id) => get(STORES.SHEETS, id);
export const getSheetsForTest = (testId) => getAllByIndex(STORES.SHEETS, 'by_testId', testId);
export const deleteSheet = (id) => remove(STORES.SHEETS, id);

/**
 * Find sheets that share a fingerprint with the given one — i.e. likely
 * re-scans of the same physical paper, so the UI can warn the teacher
 * before silently creating a duplicate grade.
 * @param {string} fingerprint
 * @returns {Promise<import('../models/sheet-model.js').ScannedSheet[]>}
 */
export const getSheetsByFingerprint = (fingerprint) =>
  getAllByIndex(STORES.SHEETS, 'by_fingerprint', fingerprint);

/**
 * Compute a stable fingerprint for a sheet's content so re-processing
 * the same physical paper can be detected. Part 1 fingerprints the
 * structured data entered so far (identity + answers); Part 2 should
 * extend this to hash actual image bytes for a true "same paper"
 * signature.
 * @param {object} data - any JSON-serializable payload
 * @returns {Promise<string>} hex-encoded SHA-256
 */
export async function computeFingerprint(data) {
  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
