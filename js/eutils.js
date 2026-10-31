'use strict';

// Thin client for NCBI E-utilities. Everything here talks to eutils.ncbi.nlm.nih.gov,
// which sends `Access-Control-Allow-Origin: *`, so the browser can call it directly.

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const TOOL_NAME = 'entrez-lite';

const Settings = {
  get(key) {
    try { return localStorage.getItem('el.' + key) || ''; } catch { return ''; }
  },
  set(key, value) {
    try {
      if (value) localStorage.setItem('el.' + key, value);
      else localStorage.removeItem('el.' + key);
    } catch { /* storage unavailable: settings last for this page only */ }
  },
};

class EutilsError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// NCBI allows 3 requests/s without an API key and 10/s with one.
const throttle = (() => {
  let next = 0;
  return async () => {
    const gap = Settings.get('apiKey') ? 110 : 350;
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await sleep(at - now);
  };
})();

async function eutilsRequest(endpoint, params, { json = true } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
  }
  body.set('tool', TOOL_NAME);
  const email = Settings.get('email');
  if (email) body.set('email', email);
  const apiKey = Settings.get('apiKey');
  if (apiKey) body.set('api_key', apiKey);
  if (json) body.set('retmode', 'json');

  const url = EUTILS_BASE + endpoint;
  const qs = body.toString();

  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res;
    try {
      // Long ID lists go as a form POST (still a "simple" CORS request, no preflight).
      res = qs.length > 1800
        ? await fetch(url, { method: 'POST', body })
        : await fetch(url + '?' + qs);
    } catch {
      // NCBI's 429 replies carry no CORS header, so a rate limit looks like a network error.
      if (attempt < 3) { await sleep(800 * 2 ** attempt); continue; }
      throw new EutilsError('Network error: could not reach NCBI.');
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(800 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (/^\s*(<!doctype html|<html)/i.test(text)) {
      throw new EutilsError(`NCBI returned a web page instead of data (HTTP ${res.status}). It may be a bot check or an outage; try again shortly or add an API key in Settings.`);
    }
    if (!res.ok) {
      throw new EutilsError(`NCBI returned HTTP ${res.status}: ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 240)}`);
    }
    if (json) {
      let data;
      try { data = JSON.parse(text); } catch { throw new EutilsError('NCBI returned malformed JSON.'); }
      const err = data.error || data.ERROR || data.esearchresult?.ERROR;
      if (err) throw new EutilsError(typeof err === 'string' ? err : JSON.stringify(err));
      return data;
    }
    const head = text.slice(0, 300);
    if (/^\s*Error\b|<ERROR>/i.test(head)) {
      let msg = head.replace(/<[^>]+>/g, ' ').trim();
      // efetch sometimes letter-spaces its errors ("F a i l e d  t o ..."); undo that.
      if (/(\S \S ){3}/.test(msg)) msg = msg.replace(/(\S) (?=\S)/g, '$1').replace(/ {2,}/g, ' ').replace(/^Error:(?=\S)/, 'Error: ');
      throw new EutilsError(msg.split('\n')[0]);
    }
    return text;
  }
}

async function esearch(db, term, { retstart = 0, retmax = 20, sort } = {}) {
  const data = await eutilsRequest('esearch.fcgi', { db, term, retstart, retmax, sort });
  const r = data.esearchresult || {};
  return {
    count: Number(r.count || 0),
    ids: r.idlist || [],
    translation: r.querytranslation || '',
    notFound: [
      ...(r.errorlist?.phrasesnotfound || []),
      ...(r.warninglist?.phrasesignored || []),
    ],
    warnings: r.warninglist?.outputmessages || [],
  };
}

function summaryDocs(data) {
  const result = data.result || {};
  return (result.uids || []).map((uid) => result[uid]).filter((d) => d && !d.error);
}

async function esummary(db, ids) {
  if (!ids.length) return [];
  return summaryDocs(await eutilsRequest('esummary.fcgi', { db, id: ids.join(',') }));
}

function efetch(db, ids, rettype, extra = {}) {
  const id = Array.isArray(ids) ? ids.join(',') : ids;
  return eutilsRequest('efetch.fcgi', { db, id, rettype, retmode: 'text', ...extra }, { json: false });
}

async function elinkCheck(dbfrom, id) {
  const data = await eutilsRequest('elink.fcgi', { dbfrom, id, cmd: 'acheck' });
  const infos = data.linksets?.[0]?.idchecklist?.idlinksets?.[0]?.linkinfos || [];
  return infos.map((i) => ({
    dbto: i.dbto,
    linkname: i.linkname,
    label: i.htmltag || i.menutag || i.linkname,
    priority: Number(i.priority || 999),
  })).sort((a, b) => a.priority - b.priority);
}

async function elinkNeighbor(dbfrom, id, linkname) {
  const data = await eutilsRequest('elink.fcgi', { dbfrom, id, linkname, cmd: 'neighbor' });
  const set = (data.linksets?.[0]?.linksetdbs || []).find((s) => s.linkname === linkname);
  return { dbto: set?.dbto || linkname.split('_')[1], ids: set?.links || [] };
}

// --- Large result sets -------------------------------------------------------

// A search saved on NCBI's history server. esearch will not page past 10,000 IDs,
// but efetch and esummary read a saved search in batches with no such ceiling.
async function esearchHistory(db, term, { sort } = {}) {
  const data = await eutilsRequest('esearch.fcgi', { db, term, sort, usehistory: 'y', retmax: 0 });
  const r = data.esearchresult || {};
  return { count: Number(r.count || 0), webenv: r.webenv || '', key: r.querykey || '' };
}

// A record source is either { ids } or a saved search { webenv, key, count }.
const sourceSize = (source) => (source.ids ? source.ids.length : source.count);

function batchParams(source, start, size) {
  return source.ids
    ? { id: source.ids.slice(start, start + size).join(',') }
    : { WebEnv: source.webenv, query_key: source.key, retstart: start, retmax: size };
}

// Batches run one after another through the shared throttle. onProgress(done, total)
// runs after each batch and may throw to stop before the next one.
async function inBatches(source, batch, onProgress, fetchOne) {
  const total = sourceSize(source);
  const out = [];
  for (let start = 0; start < total; start += batch) {
    const size = Math.min(batch, total - start);
    out.push(await fetchOne(batchParams(source, start, size)));
    onProgress?.(start + size, total);
  }
  return out;
}

async function efetchAll(db, source, rettype, { batch = 500, onProgress } = {}) {
  const parts = await inBatches(source, batch, onProgress, (p) =>
    eutilsRequest('efetch.fcgi', { db, rettype, retmode: 'text', ...p }, { json: false }));
  // Abstracts and MEDLINE records are separated by a blank line, so keep one between batches.
  const gap = rettype === 'abstract' || rettype === 'medline' ? '\n' : '';
  return parts.map((t) => t.replace(/\s*$/, '\n')).join(gap);
}

async function esummaryAll(db, source, { batch = 200, onProgress } = {}) {
  const parts = await inBatches(source, batch, onProgress, async (p) =>
    summaryDocs(await eutilsRequest('esummary.fcgi', { db, ...p })));
  return parts.flat();
}

// --- Query helpers -----------------------------------------------------------

// Accessions such as HQ288918.1, NZ_CP027720.1, WP_047306321.1, PRJNA224116,
// SAMN02604091 and SRR390728.
const ACCESSION_RE = /^([A-Z]{1,2}_?[A-Z0-9]*\d{5,}(\.\d+)?|[A-Z]{1,4}\d{5,8}(\.\d+)?)$/;

// A pasted list of identifiers as one query: accessions match on [accn] and bare
// numbers (PMIDs, Gene IDs, UIDs) on [uid]. Returns null unless the text is two or
// more identifiers and nothing else, so ordinary searches are left alone.
function idListTerm(text) {
  const tokens = String(text).split(/[\s,;]+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const clauses = new Set();
  for (const token of tokens) {
    const t = token.toUpperCase();
    const field = /^\d+$/.test(t) ? 'uid' : ACCESSION_RE.test(t) ? 'accn' : null;
    if (!field) return null;
    clauses.add(`${t}[${field}]`);
  }
  return { count: clauses.size, term: [...clauses].join(' OR ') };
}

// "#3 AND #5" names searches in the history list. NCBI resolves these against a
// server session that expires within hours, so they are expanded here into the
// saved queries instead, which keeps them working on any later visit.
function expandHistoryRefs(term, items, db, label = (d) => d) {
  return String(term).replace(/#(\d+)\b/g, (_, n) => {
    const item = items.find((i) => i.n === Number(n));
    if (!item) throw new EutilsError(`There is no search #${n} in your history.`);
    if (item.db !== db) {
      throw new EutilsError(`Search #${n} was in ${label(item.db)}, so it can't be combined with a ${label(db)} search.`);
    }
    return `(${item.query})`;
  });
}

// --- Conserved domains -------------------------------------------------------

// Product names are often wrong. NCBI's own annotation pipeline calls many NorB
// proteins "cbb3-type cytochrome c oxidase subunit I", so filtering a record's CDS
// by name misses them entirely. The conserved-domain assignment is computed from
// sequence rather than copied from a neighbour, and it gets those cases right, so
// these two calls search a record by domain instead of by annotation text.

// CDD search is a text search over the whole record, so a domain matches when the
// gene is merely mentioned in its abstract: "norB" returns three heme-d1 propellers
// that belong to the nirS branch and are not NorB at all. Rank the gene-level models
// (COG, TIGR, PRK) above single domains and superfamily clusters above nothing, and
// put a short name equal to the search term first.
const DOMAIN_FAMILY_RANK = { COG: 0, TIGR: 0, PRK: 0, pfam: 1, smart: 1, cd: 2, cl: 3 };

function domainRank(accession, title, term) {
  const family = DOMAIN_FAMILY_RANK[(accession.match(/^[A-Za-z]+/) || [''])[0]] ?? 2;
  return (title.toLowerCase() === term.toLowerCase() ? 0 : 4) + family;
}

async function cddSearch(term, { retmax = 20 } = {}) {
  const { ids } = await esearch('cdd', term, { retmax });
  if (!ids.length) return [];
  const docs = await esummary('cdd', ids);
  return docs.map((d) => ({
    uid: String(d.uid),
    accession: d.accession || '',
    title: d.title || d.accession || String(d.uid),
    // What the domain actually is, in words. The short name alone cannot be trusted.
    definition: d.subtitle || '',
  })).sort((a, b) => domainRank(a.accession, a.title, term) - domainRank(b.accession, b.title, term));
}

function historyKey(data, linkname) {
  const set = data.linksets?.[0] || {};
  return {
    webenv: set.webenv || '',
    key: (set.linksetdbhistories || []).find((h) => h.linkname === linkname)?.querykey || '',
  };
}

// The proteins of one nucleotide record that carry one conserved domain. Both sides
// are put into the same Entrez history session and intersected on the server, so the
// cost is four requests whatever the genome's size — listing a bacterial proteome and
// asking for each protein's domains would be hundreds.
async function proteinsWithDomain(nuccoreUid, cddUid, { limit = 500 } = {}) {
  const all = historyKey(
    await eutilsRequest('elink.fcgi', { dbfrom: 'nuccore', db: 'protein', linkname: 'nuccore_protein', id: nuccoreUid, cmd: 'neighbor_history' }),
    'nuccore_protein');
  if (!all.webenv || !all.key) return [];
  const dom = historyKey(
    await eutilsRequest('elink.fcgi', { dbfrom: 'cdd', db: 'protein', id: cddUid, cmd: 'neighbor_history', WebEnv: all.webenv }),
    'cdd_protein');
  if (!dom.key) return [];
  const data = await eutilsRequest('esearch.fcgi', {
    db: 'protein', term: `#${all.key} AND #${dom.key}`, WebEnv: all.webenv, usehistory: 'y', retmax: limit,
  });
  const ids = data.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const docs = await esummary('protein', ids);
  return docs.map((d) => ({ accession: d.accessionversion || d.caption || '', title: d.title || '' }))
    .filter((p) => p.accession);
}

// --- NCBI Datasets v2 --------------------------------------------------------

// Genome reports (assembly stats, CheckM, ANI taxonomy check) come from the Datasets
// API, which also allows cross-origin calls and shares the E-utilities API key.
const DATASETS_BASE = 'https://api.ncbi.nlm.nih.gov/datasets/v2/';

async function datasetsRequest(path) {
  const apiKey = Settings.get('apiKey');
  const headers = apiKey ? { 'api-key': apiKey } : {};
  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(DATASETS_BASE + path, { headers });
    } catch {
      // NCBI's 429 replies carry no CORS header, so a rate limit looks like a network error.
      if (attempt < 3) { await sleep(800 * 2 ** attempt); continue; }
      throw new EutilsError('Network error: could not reach the NCBI Datasets API.');
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(800 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw new EutilsError(`NCBI Datasets returned HTTP ${res.status} without data.`);
    }
    if (!res.ok) throw new EutilsError(data.message || data.error || `NCBI Datasets returned HTTP ${res.status}.`);
    return data;
  }
}

async function genomeReport(accession) {
  const data = await datasetsRequest(`genome/accession/${encodeURIComponent(accession)}/dataset_report`);
  const report = data.reports?.[0];
  if (!report) throw new EutilsError(`No genome found for "${accession}".`);
  return report;
}

async function genomeSequences(accession, pageToken = '') {
  const qs = new URLSearchParams({ page_size: '100' });
  if (pageToken) qs.set('page_token', pageToken);
  const data = await datasetsRequest(`genome/accession/${encodeURIComponent(accession)}/sequence_reports?${qs}`);
  return { reports: data.reports || [], total: data.total_count || 0, next: data.next_page_token || '' };
}

function genomeDownloadUrl(accessions) {
  const ids = [].concat(accessions).map(encodeURIComponent).join(',');
  const qs = ['GENOME_FASTA', 'GENOME_GFF', 'PROT_FASTA', 'CDS_FASTA']
    .map((t) => `include_annotation_type=${t}`).join('&');
  return `${DATASETS_BASE}genome/accession/${ids}/download?${qs}`;
}

// Genomes for a taxon name or tax ID. `taxon` must be a full name ("Pseudomonas
// fluorescens") or a tax ID; use taxonSuggest() to turn partial input into one.
async function genomeSearch(taxon, f = {}, pageToken = '') {
  const qs = new URLSearchParams({ page_size: '50', 'filters.exclude_paired_reports': 'true' });
  if (f.src) qs.set('filters.assembly_source', f.src);
  for (const level of (f.level || '').split(',').filter(Boolean)) qs.append('filters.assembly_level', level);
  if (f.ref) qs.set('filters.reference_only', 'true');
  if (f.type) qs.set('filters.is_type_material', 'true');
  if (f.atypical) qs.set('filters.exclude_atypical', 'true');
  if (f.exact) qs.set('tax_exact_match', 'true');
  if (pageToken) qs.set('page_token', pageToken);
  const data = await datasetsRequest(`genome/taxon/${encodeURIComponent(taxon)}/dataset_report?${qs}`);
  return { reports: data.reports || [], total: data.total_count || 0, next: data.next_page_token || '' };
}

async function taxonSuggest(text) {
  const data = await datasetsRequest(`taxonomy/taxon_suggest/${encodeURIComponent(text)}`);
  return (data.sci_name_and_ids || []).map((t) => ({
    name: t.sci_name, taxId: t.tax_id, rank: (t.rank || '').toLowerCase().replace(/_/g, ' '), matched: t.matched_term,
  }));
}

// The assembly a sequence record belongs to, as a GCF_ (RefSeq) or GCA_ accession.
async function assemblyAccessionFor(db, uid) {
  let ids = [uid];
  if (db !== 'assembly') {
    ({ ids } = await elinkNeighbor(db, uid, `${db}_assembly`));
    if (!ids.length && db === 'nuccore') {
      // WGS master records have no assembly link, but their DBLINK names it.
      // A 1 bp fetch returns the full header without the sequence.
      const head = await efetch(db, uid, 'gb', { seq_start: 1, seq_stop: 1 });
      return head.match(/^\s+Assembly:\s*(GC[AF]_\d+\.\d+)/m)?.[1] || null;
    }
    if (!ids.length) return null;
  }
  const [doc] = await esummary('assembly', ids.slice(0, 1));
  if (!doc) return null;
  return doc.synonym?.refseq || doc.assemblyaccession || doc.synonym?.genbank || null;
}

// --- Parsers ---------------------------------------------------------------

// Parses NCBI's five-column feature table (efetch rettype=ft). A table fetched for a
// region (seq_start) is numbered from that region's start, so `offset` shifts it back.
function parseFeatureTable(text, offset = 0) {
  const shift = (s) => s.replace(/\d+/, (n) => String(Number(n) + offset));
  const features = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('>')) continue;
    const cols = line.split('\t');
    if (cols[0] !== '') {
      const iv = { start: shift(cols[0]), stop: shift(cols[1]) };
      if (cols[2]) {
        cur = { type: cols[2].trim(), intervals: [iv], q: {} };
        features.push(cur);
      } else if (cur) {
        cur.intervals.push(iv);
      }
    } else if (cur && cols[3]) {
      (cur.q[cols[3]] ||= []).push(cols[4] ?? '');
    }
  }
  const parsed = features.map((f) => {
    const nums = f.intervals.map((iv) => ({
      a: parseInt(iv.start.replace(/[<>^]/g, ''), 10),
      b: parseInt(iv.stop.replace(/[<>^]/g, ''), 10),
    }));
    const minus = nums[0].a > nums[0].b;
    const all = nums.flatMap((n) => [n.a, n.b]);
    const spans = f.intervals.map((iv) =>
      minus ? `${iv.stop}..${iv.start}` : `${iv.start}..${iv.stop}`);
    const ordered = minus ? [...spans].reverse() : spans;
    const inner = ordered.length > 1 ? `join(${ordered.join(',')})` : ordered[0];
    return {
      type: f.type,
      q: f.q,
      strand: minus ? '-' : '+',
      lo: Math.min(...all),
      hi: Math.max(...all),
      // Intervals in transcript order, as plain numbers, for fetching spliced sequence.
      parts: nums.map((n) => ({ from: Math.min(n.a, n.b), to: Math.max(n.a, n.b) })),
      location: minus ? `complement(${inner})` : inner,
    };
  });

  // In RefSeq tables the gene name and locus tag sit on the `gene` feature only;
  // copy them onto the CDS/RNA features that span the same region.
  const genes = new Map();
  for (const f of parsed) if (f.type === 'gene') genes.set(`${f.lo}|${f.hi}|${f.strand}`, f);
  for (const f of parsed) {
    const gene = f.type !== 'gene' && genes.get(`${f.lo}|${f.hi}|${f.strand}`);
    if (!gene) continue;
    for (const k of ['gene', 'locus_tag']) if (!f.q[k] && gene.q[k]) f.q[k] = gene.q[k];
  }
  return parsed;
}

function parseFasta(text) {
  const records = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      cur = { header: line.slice(1).trim(), seq: '' };
      records.push(cur);
    } else if (cur) {
      cur.seq += line.trim();
    }
  }
  return records;
}

function toFasta(records, width = 70) {
  return records.map((r) => {
    const lines = [];
    for (let i = 0; i < r.seq.length; i += width) lines.push(r.seq.slice(i, i + width));
    return `>${r.header}\n${lines.join('\n')}`;
  }).join('\n') + '\n';
}

// "ref|WP_047306321.1|" -> "WP_047306321.1"
function cleanSeqId(value) {
  return String(value).split('|').filter(Boolean).pop() || value;
}
