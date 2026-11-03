(function (root) {
  'use strict';

  function apiError(message, props) {
    return Object.assign(new Error(message), props);
  }

  // Thin client for the Express/PostgreSQL API. `fetchImpl` is injectable for tests.
  function createApiClient(fetchImpl, options) {
    const f = fetchImpl || (root.fetch && root.fetch.bind(root));
    const timeoutMs = (options && options.timeoutMs) || 8000;

    async function request(path, init) {
      if (!f) throw apiError('fetch is not available', { code: 'unavailable' });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), (init && init.timeoutMs) || timeoutMs) : null;
      let response;
      try {
        response = await f(path, Object.assign({ headers: { 'Content-Type': 'application/json' }, cache: 'no-store' }, Object.assign({}, init, { timeoutMs: undefined }), controller ? { signal: controller.signal } : {}));
      } catch (err) {
        throw apiError('تعذر الاتصال بالخادم', { code: 'network', cause: err });
      } finally {
        if (timer) clearTimeout(timer);
      }
      let body = null;
      try { body = await response.json(); } catch (_) { /* non-JSON body (e.g. static server 404 page) */ }
      return { status: response.status, ok: response.ok, body };
    }

    // A 401 means the sign-in expired. It is retried like any other failure, so once the person signs
    // in again the pending save goes through without losing anything.
    function guard(r) {
      if (r.status === 401) throw apiError('انتهت الجلسة؛ سجّل الدخول من جديد', { code: 'unauthorized', status: 401 });
    }

    // Sign-in state. 'unavailable' = no API here (static server), so the app runs without login.
    async function me() {
      let r;
      try { r = await request('/api/auth/me'); } catch (_) { return { status: 'unavailable' }; }
      if (r.status === 401 && r.body && r.body.authenticated === false) return { status: 'unauthorized' };
      if (r.ok && r.body && r.body.authenticated) return { status: 'ok', username: r.body.username };
      return { status: 'unavailable' };
    }
    async function authCall(path, body, fallbackMessage) {
      const r = await request(path, { method: 'POST', body: JSON.stringify(body || {}) });
      if (!r.ok) throw apiError((r.body && r.body.message) || fallbackMessage, { code: 'auth', status: r.status });
      return r.body || {};
    }
    const login = (username, password) => authCall('/api/auth/login', { username, password }, 'تعذر تسجيل الدخول');
    const logout = () => authCall('/api/auth/logout', {}, 'تعذر تسجيل الخروج');
    const changePassword = (currentPassword, newPassword) => authCall('/api/auth/password', { currentPassword, newPassword }, 'تعذر تغيير كلمة المرور');

    // Returns { revision, nodes, edges }. Throws code 'unavailable' when the API is not there
    // (static server, database down) so callers can fall back to browser storage.
    async function loadGraph() {
      const r = await request('/api/graph');
      guard(r);
      if (!r.ok || !r.body || !Array.isArray(r.body.nodes) || !Array.isArray(r.body.edges)) {
        throw apiError('الخادم لا يوفّر واجهة البيانات', { code: 'unavailable', status: r.status });
      }
      return { revision: Number(r.body.revision) || 0, nodes: r.body.nodes, edges: r.body.edges, ...(Array.isArray(r.body.zones) ? { zones: r.body.zones } : {}) };
    }

    // Replaces the stored graph. `baseRevision` guards against overwriting someone else's save.
    // `requestId` identifies this attempt (a retry reuses it); `ackRequestId` names an earlier
    // attempt of ours whose outcome is unknown, so the server can tell it was our own write.
    async function saveGraph(graph, baseRevision, requestId, ackRequestId) {
      const payload = { nodes: graph.nodes, edges: graph.edges };
      if (Array.isArray(graph.zones)) payload.zones = graph.zones;
      if (baseRevision !== undefined && baseRevision !== null) payload.baseRevision = baseRevision;
      if (requestId) payload.requestId = requestId;
      if (ackRequestId) payload.ackRequestId = ackRequestId;
      const r = await request('/api/graph', { method: 'PUT', body: JSON.stringify(payload) });
      guard(r);
      if (r.status === 409) throw apiError('تغيّرت البيانات في مكان آخر', { code: 'conflict', status: 409, revision: r.body && r.body.revision });
      if (r.status === 400) throw apiError((r.body && r.body.message) || 'بيانات غير صالحة', { code: 'invalid', status: 400 });
      if (!r.ok || !r.body || typeof r.body.revision !== 'number') throw apiError('فشل الحفظ في قاعدة البيانات', { code: 'server', status: r.status });
      return { revision: r.body.revision };
    }

    // Map arrangement (positions + view). Returns null when nothing has been saved yet.
    async function loadLayout() {
      const r = await request('/api/layout');
      guard(r);
      if (!r.ok || !r.body) throw apiError('الخادم لا يوفّر ترتيب الخريطة', { code: 'unavailable', status: r.status });
      if (r.body.empty || !r.body.positions) return null;
      return r.body;
    }

    async function saveLayout(layout) {
      const r = await request('/api/layout', { method: 'PUT', body: JSON.stringify(layout) });
      guard(r);
      if (r.status === 400) throw apiError((r.body && r.body.message) || 'ترتيب غير صالح', { code: 'invalid', status: 400 });
      if (!r.ok) throw apiError('فشل حفظ ترتيب الخريطة', { code: 'server', status: r.status });
      return { savedAt: r.body && r.body.savedAt };
    }

    // Asks the server to download a remote image (browsers cannot, for lack of CORS). Returns a data URL.
    async function fetchImage(url) {
      const r = await request('/api/images/fetch', { method: 'POST', body: JSON.stringify({ url }), timeoutMs: 20000 });
      guard(r);
      if (!r.ok || !r.body || typeof r.body.dataUrl !== 'string') throw apiError((r.body && r.body.message) || 'تعذر تنزيل الصورة', { code: 'image', status: r.status });
      return r.body.dataUrl;
    }

    return { loadGraph, saveGraph, loadLayout, saveLayout, me, login, logout, changePassword, fetchImage };
  }

  // Debounced, single-flight save queue. Rapid edits collapse into one request carrying the
  // latest data; failed saves are retried with backoff; a revision conflict stops further
  // writes so a stale tab can never overwrite newer data.
  function createSaveQueue(saveFn, onState, options) {
    const o = Object.assign({ delay: 400, retryDelays: [2000, 5000, 15000] }, options);
    let pending = null;       // latest payload not yet confirmed saved
    let pendingId = null;     // request id for `pending`; reused across retries of the same payload
    let unknownId = null;     // id of an earlier attempt that may or may not have been applied
    let inFlight = false;
    let timer = null;
    let failures = 0;
    let stopped = false;      // set on conflict / invalid data: no more writes
    let seq = 0;

    const emit = (state, detail) => { if (onState) onState(state, detail); };
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const arm = ms => { clear(); timer = setTimeout(run, ms); };

    async function run() {
      clear();
      if (stopped || inFlight || pending === null) return;
      const payload = pending;
      const requestId = pendingId || (pendingId = `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      const ackId = unknownId && unknownId !== requestId ? unknownId : null;
      inFlight = true;
      emit('saving');
      try {
        await saveFn(payload, requestId, ackId);
        if (pending === payload) { pending = null; pendingId = null; }
        unknownId = null;
        failures = 0;
        inFlight = false;
        if (pending !== null) arm(o.delay); else emit('saved');
      } catch (err) {
        inFlight = false;
        if (err && (err.code === 'conflict' || err.code === 'invalid')) {
          stopped = true;
          emit(err.code, err);
          return;
        }
        unknownId = requestId;  // may have been applied even though we saw an error
        const wait = o.retryDelays[Math.min(failures, o.retryDelays.length - 1)];
        failures += 1;
        emit('error', err);
        arm(wait);
      }
    }

    return {
      schedule(payload) { if (stopped) return; pending = payload; pendingId = null; if (!inFlight) arm(o.delay); },
      flush() { return run(); },
      isDirty() { return pending !== null || inFlight; },
      isStopped() { return stopped; },
    };
  }

  const api = { createApiClient, createSaveQueue };
  root.RelationshipApi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
