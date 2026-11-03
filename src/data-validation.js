(function (root) {
  'use strict';
  function validateDataset(data) {
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      throw new Error('يجب أن يحتوي الملف على مصفوفتَي nodes وedges.');
    }
    const nodeIds = new Set();
    const edgeIds = new Set();
    for (const node of data.nodes) {
      if (!node || node.id === undefined || node.id === null || String(node.id).trim() === '') {
        throw new Error('كل كيان يحتاج إلى معرّف غير فارغ.');
      }
      if (typeof node.label !== 'string' || !node.label.trim()) {
        throw new Error(`اسم الكيان ذي المعرّف ${node.id} غير صالح.`);
      }
      const id = String(node.id);
      if (nodeIds.has(id)) throw new Error(`معرّف كيان مكرر: ${id}`);
      nodeIds.add(id);
    }
    for (const edge of data.edges) {
      if (!edge || edge.id === undefined || edge.id === null || String(edge.id).trim() === '') {
        throw new Error('كل علاقة تحتاج إلى معرّف غير فارغ.');
      }
      const id = String(edge.id);
      if (edgeIds.has(id)) throw new Error(`معرّف علاقة مكرر: ${id}`);
      edgeIds.add(id);
      if (!nodeIds.has(String(edge.source)) || !nodeIds.has(String(edge.target))) {
        throw new Error(`العلاقة ${id} تشير إلى كيان غير موجود.`);
      }
      if (String(edge.source) === String(edge.target)) {
        throw new Error(`العلاقة ${id} تربط الكيان بنفسه؛ راجع البيانات قبل الاستيراد.`);
      }
    }
    if (data.zones !== undefined) {
      if (!Array.isArray(data.zones) || data.zones.length > 10000) throw new Error('قائمة المناطق غير صالحة.');
      const zoneIds = new Set();
      const validPoint = p => p && typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && typeof p.lng === 'number' && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180;
      for (const z of data.zones) {
        if (!z || z.id === undefined || z.id === null || !String(z.id).trim() || zoneIds.has(String(z.id))) throw new Error('معرّف المنطقة فارغ أو مكرر.');
        zoneIds.add(String(z.id));
        if (typeof z.name !== 'string' || !z.name.trim() || z.name.length > 200) throw new Error('اسم المنطقة غير صالح.');
        if (typeof z.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(z.color)) throw new Error('لون المنطقة غير صالح.');
        if (z.note !== undefined && (typeof z.note !== 'string' || z.note.length > 10000)) throw new Error('ملاحظة المنطقة غير صالحة.');
        if (z.shape === 'circle') {
          if (!validPoint(z.center) || typeof z.radius !== 'number' || !Number.isFinite(z.radius) || z.radius <= 0 || z.radius > 20000000) throw new Error('دائرة المنطقة غير صالحة.');
        } else if (z.shape === 'polygon' || z.shape === 'rectangle') {
          if (!Array.isArray(z.points) || z.points.length < (z.shape === 'polygon' ? 3 : 2) || z.points.length > 10000 || !z.points.every(validPoint)) throw new Error('نقاط المنطقة غير صالحة.');
        } else throw new Error('شكل المنطقة غير صالح.');
        if (z.photos !== undefined && (!Array.isArray(z.photos) || z.photos.length > 12 || z.photos.some(p => !p || typeof p.src !== 'string' || !/^(https?:\/\/|data:image\/)/i.test(p.src) || (p.caption !== undefined && typeof p.caption !== 'string')))) throw new Error('صور المنطقة غير صالحة.');
        if (z.link !== undefined && z.link !== null && (typeof z.link !== 'object' || Array.isArray(z.link))) throw new Error('رابط المنطقة غير صالح.');
      }
    }
    return data;
  }
  root.RelationshipDataValidation = { validateDataset };
  if (typeof module !== 'undefined' && module.exports) module.exports = { validateDataset };
})(typeof globalThis !== 'undefined' ? globalThis : this);
