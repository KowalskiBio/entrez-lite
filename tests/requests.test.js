'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEutils, fakeFetch } = require('./load');

const range = (n) => Array.from({ length: n }, (_, i) => String(1000 + i));

test('an ID list is fetched in batches, the long ones as form POSTs', async () => {
  const { fetch, calls } = fakeFetch(({ params }) => ({
    body: params.id.split(',').map((id) => `>${id}\nACGT\n`).join(''),
  }));
  const { efetchAll } = loadEutils({ fetch });
  const progress = [];
  const text = await efetchAll('nuccore', { ids: range(1200) }, 'fasta', {
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.params.id.split(',').length), [500, 500, 200]);
  // Only a request too long for a URL goes as a POST.
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'POST', 'GET']);
  assert.deepEqual(progress, [[500, 1200], [1000, 1200], [1200, 1200]]);
  assert.equal(text.match(/^>/gm).length, 1200);
  assert.ok(text.startsWith('>1000\n') && text.endsWith('>2199\nACGT\n'));
});

test('a saved search is read with WebEnv and retstart, past 10,000 records', async () => {
  const { fetch, calls } = fakeFetch(({ endpoint, params }) => (endpoint === 'esearch.fcgi'
    ? { body: { esearchresult: { count: '10700', webenv: 'MCID_x', querykey: '1' } } }
    : { body: `ACC${params.retstart}\n` }));
  const { esearchHistory, efetchAll } = loadEutils({ fetch });
  const saved = await esearchHistory('protein', 'nirK[Gene Name]', { sort: 'relevance' });
  assert.deepEqual({ ...saved }, { count: 10700, webenv: 'MCID_x', key: '1' });
  assert.equal(calls[0].params.usehistory, 'y');
  assert.equal(calls[0].params.retmax, '0');

  const text = await efetchAll('protein', saved, 'acc', { batch: 5000 });
  const fetches = calls.slice(1).map((c) => c.params);
  assert.deepEqual(fetches.map((p) => [p.retstart, p.retmax]), [['0', '5000'], ['5000', '5000'], ['10000', '700']]);
  assert.ok(fetches.every((p) => p.WebEnv === 'MCID_x' && p.query_key === '1' && !p.id));
  assert.equal(text, 'ACC0\nACC5000\nACC10000\n');
});

test('abstracts from different batches stay separated by a blank line', async () => {
  const { fetch } = fakeFetch(({ params }) => ({ body: `abstract ${params.id}\n\n\n` }));
  const { efetchAll } = loadEutils({ fetch });
  const text = await efetchAll('pubmed', { ids: ['1', '2'] }, 'abstract', { batch: 1 });
  assert.equal(text, 'abstract 1\n\nabstract 2\n');
});

test('throwing from onProgress stops before the next batch', async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: 'x\n' }));
  const { efetchAll } = loadEutils({ fetch });
  await assert.rejects(
    efetchAll('protein', { ids: range(1500) }, 'acc', { onProgress: () => { throw new Error('cancelled'); } }),
    /cancelled/);
  assert.equal(calls.length, 1);
});

test('esummary batches are merged into one list, skipping error entries', async () => {
  const { fetch, calls } = fakeFetch(({ params }) => {
    const ids = params.id.split(',');
    const result = { uids: ids };
    for (const id of ids) result[id] = id === '1003' ? { error: 'cannot get document summary' } : { uid: id };
    return { body: { result } };
  });
  const { esummaryAll } = loadEutils({ fetch });
  const docs = await esummaryAll('protein', { ids: range(5) }, { batch: 2 });
  assert.equal(calls.length, 3);
  assert.deepEqual(docs.map((d) => d.uid), ['1000', '1001', '1002', '1004']);
});

test('a 429 or 5xx is retried, then the answer comes through', async () => {
  const { fetch, calls } = fakeFetch((_, n) => (n < 3 ? { status: n === 1 ? 429 : 503 } : { body: { esearchresult: { count: '1' } } }));
  const { eutilsRequest } = loadEutils({ fetch });
  const data = await eutilsRequest('esearch.fcgi', { db: 'nuccore', term: 'x' });
  assert.equal(data.esearchresult.count, '1');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].params.tool, 'entrez-lite');
});

test('an HTML bot-check page is reported as such, not as bad JSON', async () => {
  const { fetch } = fakeFetch(() => ({ body: '<!DOCTYPE html><html><body>Are you a robot?</body></html>' }));
  const { eutilsRequest } = loadEutils({ fetch });
  await assert.rejects(eutilsRequest('esearch.fcgi', { db: 'nuccore', term: 'x' }), /web page instead of data/);
});

test('letter-spaced efetch errors are put back together', async () => {
  const { fetch } = fakeFetch(() => ({ body: 'Error: F a i l e d  t o  u n d e r s t a n d  i d :  X X 1\n' }));
  const { eutilsRequest } = loadEutils({ fetch });
  await assert.rejects(eutilsRequest('efetch.fcgi', { db: 'nuccore', id: 'XX1' }, { json: false }),
    (e) => e.message === 'Error: Failed to understand id: XX1');
});
