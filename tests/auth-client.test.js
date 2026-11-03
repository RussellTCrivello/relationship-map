const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiClient } = require('../src/api-client.js');

test('me() reports sign-in state; a 401 on data calls is a retryable unauthorized error', async () => {
  const mk = (status, body) => createApiClient(async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }));
  assert.deepEqual(await mk(200, { authenticated: true, username: 'admin' }).me(), { status: 'ok', username: 'admin' });
  assert.deepEqual(await mk(401, { authenticated: false }).me(), { status: 'unauthorized' });
  assert.deepEqual(await mk(404, null).me(), { status: 'unavailable' });
  await assert.rejects(mk(401, { error: 'unauthorized' }).loadGraph(), e => e.code === 'unauthorized');
  await assert.rejects(mk(401, { error: 'unauthorized' }).saveGraph({ nodes: [], edges: [] }), e => e.code === 'unauthorized');
  await assert.rejects(mk(401, { message: 'خطأ' }).login('a', 'b'), e => e.code === 'auth' && e.message === 'خطأ');
});
