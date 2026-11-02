'use strict';

// js/eutils.js is a classic browser script, not a module, so it is run in a fresh
// context and the functions under test are handed back. `fetch` is whatever the test
// supplies; by default any network call fails the test. Timers fire at once, so the
// request throttle and retry back-off add no waiting.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'eutils.js'), 'utf8');

const EXPORTS = [
  'parseFeatureTable', 'parseFasta', 'toFasta', 'cleanSeqId', 'domainRank',
  'idListTerm', 'expandHistoryRefs', 'ACCESSION_RE',
  'eutilsRequest', 'esearchHistory', 'efetchAll', 'esummaryAll', 'sourceSize',
  'annotationReport', 'parseCodedBy', 'translateDna', 'reverseComplement', 'proteinDomains', 'geneContent', 'parseAccessionList', 'resolveGenomeAccession',
];

// Values made inside the context have its own Array, Object and Error, which strict
// deepEqual and assert.rejects do not accept as equal to the test's own. Results are
// copied out and errors rethrown so the tests compare plain local values.
const toHost = (v) => (v && typeof v === 'object' ? structuredClone(v) : v);
const hostError = (e) => Object.assign(new Error(e?.message ?? String(e)), { name: e?.name || 'Error' });

function wrap(fn) {
  return (...args) => {
    let r;
    try { r = fn(...args); } catch (e) { throw hostError(e); }
    return r && typeof r.then === 'function'
      ? Promise.resolve(r).then(toHost, (e) => { throw hostError(e); })
      : toHost(r);
  };
}

function loadEutils({ fetch } = {}) {
  const context = vm.createContext({
    URLSearchParams,
    console,
    setTimeout: (fn) => queueMicrotask(fn),
    fetch: fetch || (() => { throw new Error('unexpected network call'); }),
  });
  const exports = vm.runInContext(`${SOURCE}\n;({ ${EXPORTS.join(', ')} })`, context, { filename: 'eutils.js' });
  return Object.fromEntries(Object.entries(exports).map(([k, v]) => [k, typeof v === 'function' ? wrap(v) : v]));
}

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// A stand-in for fetch that records each request's endpoint and parameters, from the
// query string or a form POST body, and answers with reply(request).
function fakeFetch(reply) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const params = Object.fromEntries(opts.body ? new URLSearchParams(opts.body) : u.searchParams);
    const call = { endpoint: u.pathname.split('/').pop(), method: opts.method || 'GET', params };
    calls.push(call);
    const { status = 200, body = '' } = await reply(call, calls.length);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, ok: status >= 200 && status < 300, text: async () => text };
  };
  return { fetch, calls };
}

module.exports = { loadEutils, fixture, fakeFetch };
