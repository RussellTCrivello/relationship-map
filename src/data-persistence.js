(function (root) {
  'use strict';
  function saveWithBackup(storage, primaryKey, backupKey, payload, fallbackSnapshot = null) {
    const previous = storage.getItem(primaryKey) || fallbackSnapshot;
    let backupSaved = true;
    if (previous && previous !== payload) {
      try { storage.setItem(backupKey, previous); }
      catch (_) { backupSaved = false; }
    }
    storage.setItem(primaryKey, payload);
    if (storage.getItem(primaryKey) !== payload) throw new Error('لم تتطابق البيانات بعد إعادة القراءة.');
    return { backupSaved, hadPrevious: Boolean(previous && previous !== payload) };
  }
  root.RelationshipDataPersistence = { saveWithBackup };
  if (typeof module !== 'undefined' && module.exports) module.exports = { saveWithBackup };
})(typeof globalThis !== 'undefined' ? globalThis : this);
