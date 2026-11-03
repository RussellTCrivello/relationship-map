/* Cancellable Overpass downloads with bounded retries and no partial install. */
(function (root) {
  'use strict';
  function aborted() { const e = new Error('تم إلغاء التنزيل.'); e.name = 'AbortError'; return e; }
  function check(signal) { if (signal && signal.aborted) throw aborted(); }
  function delay(ms, signal) {
    check(signal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const stop = () => { clearTimeout(timer); cleanup(); reject(aborted()); };
      const cleanup = () => signal && signal.removeEventListener('abort', stop);
      if (signal) signal.addEventListener('abort', stop, { once: true });
    });
  }
  async function fetchBasemap({ bbox, detail, geo, mirrors, fetcher, onStatus = () => {}, signal, timeoutMs = 170000, backoff = [100, 200], wait = delay }) {
    if (!geo || !Array.isArray(mirrors) || !mirrors.length || typeof fetcher !== 'function') throw new Error('إعدادات التنزيل غير صالحة.');
    const parts = geo.splitBbox(bbox), responses = [];
    for (const part of parts) {
      check(signal); let got = null, lastError;
      for (let i = 0; i < mirrors.length; i++) {
        check(signal);
        if (i > 0) { const ms = Math.min(5000, backoff[Math.min(i - 1, backoff.length - 1)] || 0); onStatus(`تعذرت المحاولة؛ إعادة المحاولة ${i + 1} من ${mirrors.length}…`); await wait(ms, signal); check(signal); }
        const controller = new AbortController(); let timedOut = false;
        const stop = () => controller.abort(); if (signal) signal.addEventListener('abort', stop, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        try {
          const label = parts.length > 1 ? `الجزء ${part.index} من ${part.total}` : '';
          onStatus(label ? `جارٍ تنزيل بيانات الخريطة… ${label}` : 'جارٍ تنزيل بيانات الخريطة… قد يستغرق دقيقة أو أكثر');
          const r = await fetcher(mirrors[i], { method: 'POST', body: 'data=' + encodeURIComponent(geo.overpassQuery(part, { detail })), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: controller.signal });
          check(signal); if (!r.ok) throw new Error('HTTP ' + r.status);
          const json = await r.json(); check(signal);
          if (!json || !Array.isArray(json.elements)) throw new Error('استجابة خريطة غير صالحة.');
          if (json.remark && /error|timeout|too many/i.test(json.remark) && !json.elements.length) throw new Error('تعذر تجهيز بيانات الخريطة.');
          got = json; break;
        } catch (e) { if (signal && signal.aborted) throw aborted(); lastError = timedOut ? new Error('انتهت مهلة التنزيل.') : e; }
        finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', stop); }
      }
      if (!got) throw lastError || new Error('تعذر الاتصال.');
      responses.push(got);
    }
    check(signal); onStatus('جارٍ تجهيز البيانات للعمل دون اتصال…'); await wait(30, signal); check(signal);
    const merged = parts.length > 1 ? geo.mergeOverpass(responses) : responses[0];
    const raw = geo.parseOverpass(merged, bbox, { detail, clipBbox: parts.length > 1 });
    geo.validateBasemap(raw); check(signal); return raw;
  }
  const api = { fetchBasemap, delay };
  root.RelationshipGeoDownload = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
