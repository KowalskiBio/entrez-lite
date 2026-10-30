'use strict';

// --- Small helpers ---------------------------------------------------------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = (n) => Number(n).toLocaleString('en-US');
const main = $('#main');

const SEQ_DBS = new Set(['nuccore', 'protein']);
const BIG_RECORD = 1_000_000;

const DATABASES = [
  { id: 'nuccore', label: 'Nucleotide' },
  { id: 'protein', label: 'Protein' },
  { id: 'gene', label: 'Gene' },
  { id: 'genome', label: 'Genome' },
  { id: 'pubmed', label: 'PubMed' },
  { id: 'pmc', label: 'PubMed Central' },
  { id: 'taxonomy', label: 'Taxonomy' },
  { id: 'assembly', label: 'Assembly' },
  { id: 'bioproject', label: 'BioProject' },
  { id: 'biosample', label: 'BioSample' },
  { id: 'sra', label: 'SRA' },
  { id: 'structure', label: 'Structure' },
  { id: 'cdd', label: 'Conserved Domains' },
  { id: 'ipg', label: 'Identical Protein Groups' },
  { id: 'gds', label: 'GEO DataSets' },
  { id: 'clinvar', label: 'ClinVar' },
  { id: 'mesh', label: 'MeSH' },
];
const dbLabel = (id) => (id === 'genome' ? 'Genome' : DATABASES.find((d) => d.id === id)?.label || id);
const GENOME_ACC_RE = /^GC[AF]_\d{9}(\.\d+)?$/i;

const EXAMPLES = [
  { db: 'nuccore', term: 'nirK', f_org: 'Pseudomonas fluorescens' },
  { db: 'protein', term: 'copper-containing nitrite reductase', f_org: 'Pseudomonas', f_src: 'refseq' },
  { db: 'gene', term: 'nirK', f_org: 'Pseudomonas' },
  { db: 'genome', term: 'Pseudomonas fluorescens', f_level: 'complete_genome' },
  { db: 'nuccore', term: '16S ribosomal RNA', f_org: 'Escherichia coli', f_min: '1400', f_max: '1600' },
  { db: 'pubmed', term: 'denitrification Pseudomonas fluorescens', f_from: '2020' },
];

// --- Recent activity (per-browser convenience only) ------------------------

const Recent = {
  load() {
    try { return JSON.parse(localStorage.getItem('el.recent') || '[]'); } catch { return []; }
  },
  add(item) {
    const key = item.kind === 'search' ? `s|${item.db}|${item.label}` : `r|${item.db}|${item.id}`;
    const list = this.load().filter((x) => x.key !== key);
    list.unshift({ ...item, key, at: Date.now() });
    try { localStorage.setItem('el.recent', JSON.stringify(list.slice(0, 15))); } catch { /* ignore */ }
  },
  clear() {
    try { localStorage.removeItem('el.recent'); } catch { /* ignore */ }
  },
};

// --- Filters ---------------------------------------------------------------

// Each filter maps a form field to an Entrez query clause, mirroring NCBI's sidebar.
const FILTERS = {
  nuccore: ['org', 'gene', 'mol', 'src', 'len'],
  protein: ['org', 'gene', 'src', 'len'],
  gene: ['org', 'alive'],
  pubmed: ['date', 'free'],
  pmc: ['date'],
  default: ['org'],
};
const filterKeys = (db) => FILTERS[db] || FILTERS.default;

function readFilters(params) {
  const f = {};
  for (const [k, v] of params) if (k.startsWith('f_') && v) f[k.slice(2)] = v;
  return f;
}

function buildTerm(db, term, f) {
  const keys = filterKeys(db);
  const clauses = [];
  const has = (k) => keys.includes(k);
  if (has('org') && f.org) clauses.push(`"${f.org}"[Organism]`);
  if (has('gene') && f.gene) clauses.push(`${f.gene}[Gene Name]`);
  if (has('mol') && f.mol) clauses.push(`biomol_${f.mol}[PROP]`);
  if (has('src') && f.src) clauses.push(`${f.src}[filter]`);
  if (has('len') && (f.min || f.max)) clauses.push(`${f.min || 1}:${f.max || 999999999}[SLEN]`);
  if (has('alive') && f.alive) clauses.push('alive[prop]');
  if (has('date') && (f.from || f.to)) clauses.push(`${f.from || 1800}:${f.to || 3000}[dp]`);
  if (has('free') && f.free) clauses.push('free full text[sb]');
  if (!term) return clauses.join(' AND ');
  return clauses.length ? [`(${term})`, ...clauses].join(' AND ') : term;
}

function filtersFormHtml(db, f) {
  const keys = filterKeys(db);
  const field = (k, html) => (keys.includes(k) ? html : '');
  const opt = (val, label, cur) => `<option value="${val}"${cur === val ? ' selected' : ''}>${label}</option>`;
  return `
    <form class="filters" id="filters">
      <h3>Filters</h3>
      ${field('org', `<label>Organism<input name="org" value="${esc(f.org)}" placeholder="e.g. Pseudomonas fluorescens"></label>`)}
      ${field('gene', `<label>Gene name<input name="gene" value="${esc(f.gene)}" placeholder="e.g. nirK"></label>`)}
      ${field('mol', `<label>Molecule type<select name="mol">
        ${opt('', 'All', f.mol || '')}${opt('genomic', 'Genomic DNA/RNA', f.mol)}${opt('mrna', 'mRNA', f.mol)}${opt('rrna', 'rRNA', f.mol)}
      </select></label>`)}
      ${field('src', `<label>Source database<select name="src">
        ${opt('', 'All', f.src || '')}${opt('refseq', 'RefSeq', f.src)}${opt('insdc', 'GenBank / INSDC', f.src)}
      </select></label>`)}
      ${field('len', `<fieldset><legend>Sequence length</legend><div class="row2">
        <input name="min" type="number" min="1" value="${esc(f.min)}" placeholder="min">
        <input name="max" type="number" min="1" value="${esc(f.max)}" placeholder="max">
      </div></fieldset>`)}
      ${field('alive', `<label class="check"><input type="checkbox" name="alive" value="1"${f.alive ? ' checked' : ''}> Current records only</label>`)}
      ${field('date', `<fieldset><legend>Publication year</legend><div class="row2">
        <input name="from" type="number" value="${esc(f.from)}" placeholder="from">
        <input name="to" type="number" value="${esc(f.to)}" placeholder="to">
      </div></fieldset>`)}
      ${field('free', `<label class="check"><input type="checkbox" name="free" value="1"${f.free ? ' checked' : ''}> Free full text</label>`)}
      <div class="filters-actions">
        <button class="btn primary" type="submit">Apply</button>
        <button class="btn ghost" type="button" id="clear-filters">Clear</button>
      </div>
    </form>`;
}

// --- Summary rendering per database ---------------------------------------

function summarize(db, d) {
  const uid = d.uid;
  if (SEQ_DBS.has(db)) {
    const acc = d.accessionversion || d.caption || uid;
    const unit = db === 'protein' ? 'aa' : 'bp';
    return {
      id: acc,
      title: d.title,
      meta: [
        acc,
        d.slen ? `${fmtN(d.slen)} ${unit}` : '',
        db === 'nuccore' ? [d.biomol, d.moltype?.toUpperCase(), d.topology === 'circular' ? 'circular' : ''].filter(Boolean).join(' ') : '',
        d.organism,
        d.updatedate ? `updated ${d.updatedate}` : '',
      ],
      badges: [d.sourcedb === 'refseq' ? 'RefSeq' : '', d.genome && d.genome !== 'genomic' ? d.genome : ''],
    };
  }
  switch (db) {
    case 'gene':
      return {
        id: uid,
        title: `${d.name}${d.description ? ': ' + d.description : ''}`,
        meta: [
          `Gene ID ${uid}`,
          d.organism?.scientificname,
          d.chromosome ? `chr ${d.chromosome}` : '',
          d.maplocation,
          d.otheraliases ? `aka ${d.otheraliases}` : '',
        ],
        snippet: d.summary,
        badges: [d.status && d.status !== '0' && d.currentid ? 'replaced' : ''],
      };
    case 'pubmed':
    case 'pmc': {
      const authors = (d.authors || []).map((a) => a.name);
      const doi = (d.articleids || []).find((a) => a.idtype === 'doi')?.value;
      return {
        id: uid,
        title: d.title,
        meta: [
          authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''),
          d.fulljournalname || d.source,
          d.pubdate,
          db === 'pubmed' ? `PMID ${uid}` : `PMC${uid}`,
          doi ? `doi:${doi}` : '',
        ],
      };
    }
    case 'taxonomy':
      return {
        id: uid,
        title: d.scientificname,
        meta: [d.commonname, d.rank, d.division, `TaxID ${uid}`],
      };
    case 'assembly':
      return {
        id: uid,
        title: `${d.assemblyname || ''} · ${d.speciesname || d.organism || ''}`,
        meta: [d.assemblyaccession, d.assemblystatus, d.submitterorganization, d.coverage ? `${d.coverage}× coverage` : ''],
      };
    case 'bioproject':
      return { id: uid, title: d.project_title, meta: [d.project_acc, d.organism_name, d.project_data_type] };
    case 'biosample':
      return { id: uid, title: d.title, meta: [d.accession, d.organism, d.date] };
    case 'structure':
      return { id: uid, title: d.pdbdescr, meta: [d.pdbacc, d.expmethod, d.pdbdepositdate] };
    default:
      return {
        id: uid,
        title: d.title || d.name || d.description || d.scientificname || d.caption || d.accession || `UID ${uid}`,
        meta: [d.accession || d.caption, d.organism?.scientificname || d.organism || d.taxname, `UID ${uid}`],
      };
  }
}

function resultItemHtml(db, d, { selectable = true } = {}) {
  const s = summarize(db, d);
  const meta = s.meta.filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('');
  const badges = (s.badges || []).filter(Boolean).map((b) => `<span class="badge">${esc(b)}</span>`).join('');
  return `
    <li class="result">
      ${selectable ? `<input type="checkbox" class="sel" value="${esc(d.uid)}" aria-label="Select">` : ''}
      <div>
        <a class="result-title" href="#/record/${db}/${encodeURIComponent(s.id)}">${esc(s.title)}</a>${badges}
        <div class="meta">${meta}</div>
        ${s.snippet ? `<p class="snippet">${esc(s.snippet.slice(0, 260))}${s.snippet.length > 260 ? '…' : ''}</p>` : ''}
      </div>
    </li>`;
}

function paginationHtml(page, pages) {
  if (pages <= 1) return '';
  return `
    <nav class="pager">
      <button class="btn small" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
      <span>Page <input type="number" class="page-input" min="1" max="${pages}" value="${page}"> of ${fmtN(pages)}</span>
      <button class="btn small" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next ›</button>
    </nav>`;
}

function errorHtml(e) {
  return `<div class="notice error"><strong>Something went wrong.</strong> ${esc(e.message || e)}</div>`;
}

const loadingHtml = (what = 'Loading') => `<div class="loading"><span class="spinner"></span>${esc(what)}…</div>`;

// --- Routing ---------------------------------------------------------------

let routeToken = 0;
const summaryCache = new Map();
const textCache = new Map();

function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [path, qs = ''] = h.split('?');
  return {
    parts: path.split('/').filter(Boolean).map(decodeURIComponent),
    params: new URLSearchParams(qs),
  };
}

function hashFor(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false),
  ).toString();
  return '#' + path + (qs ? '?' + qs : '');
}

const go = (path, params) => { location.hash = hashFor(path, params); };

function route() {
  const { parts, params } = parseHash();
  const token = ++routeToken;
  syncHeader(parts, params);
  window.scrollTo(0, 0);
  if (parts[0] === 'search') return renderSearch(params, token);
  if (parts[0] === 'record' && parts[1] && parts[2]) return renderRecord(parts[1], parts[2], params, token);
  if (parts[0] === 'links' && parts[3]) return renderLinks(parts[1], parts[2], parts[3], params, token);
  if (parts[0] === 'genome' && parts[1]) return renderGenome(parts[1], token);
  return renderHome();
}

function syncHeader(parts, params) {
  const db = parts[0] === 'search' ? params.get('db') : parts[0] === 'record' ? parts[1] : null;
  if (db) $('#db').value = db;
  $('#q').value = parts[0] === 'search' ? params.get('term') || '' : '';
}

// --- Home ------------------------------------------------------------------

function renderHome() {
  const recent = Recent.load();
  const exampleLink = (ex) => {
    const params = { db: ex.db, term: ex.term };
    for (const [k, v] of Object.entries(ex)) if (k.startsWith('f_')) params[k] = v;
    const extra = Object.entries(ex).filter(([k]) => k.startsWith('f_')).map(([, v]) => v).join(', ');
    return `<li><a href="${hashFor('/search', params)}"><span class="db-chip">${esc(dbLabel(ex.db))}</span>${esc(ex.term)}${extra ? ` <span class="muted">· ${esc(extra)}</span>` : ''}</a></li>`;
  };
  const recentLink = (r) => r.kind === 'search'
    ? `<li><a href="${hashFor('/search', r.params)}"><span class="db-chip">${esc(dbLabel(r.db))}</span>${esc(r.label)} <span class="muted">(${fmtN(r.count)})</span></a></li>`
    : `<li><a href="${r.db === 'genome' ? '#/genome/' : `#/record/${r.db}/`}${encodeURIComponent(r.id)}"><span class="db-chip">${esc(dbLabel(r.db))}</span>${esc(r.label)}</a></li>`;

  main.innerHTML = `
    <section class="home">
      <div class="hero">
        <h1>Search NCBI, straight from the API</h1>
        <p class="muted">Every search and record here comes from NCBI's E-utilities, so it keeps working when the NCBI website pages misbehave.</p>
      </div>
      <div class="home-grid">
        <div class="card">
          <h3>Try an example</h3>
          <ul class="link-list">${EXAMPLES.map(exampleLink).join('')}</ul>
        </div>
        <div class="card">
          <div class="card-head"><h3>Recent activity</h3>${recent.length ? '<button class="btn ghost small" id="clear-recent">Clear</button>' : ''}</div>
          ${recent.length ? `<ul class="link-list">${recent.map(recentLink).join('')}</ul>` : '<p class="muted">Your searches and opened records will show up here.</p>'}
        </div>
        <div class="card">
          <h3>Search tips</h3>
          <ul class="tips">
            <li>Use fields like NCBI does: <code>nirK[Gene Name]</code>, <code>"Pseudomonas fluorescens"[Organism]</code>, <code>300:2000[SLEN]</code>.</li>
            <li>Paste an accession (e.g. <code>HQ288918.1</code>) to jump to the record.</li>
            <li>On a genome or contig, open the <b>Features</b> or <b>CDS</b> tab to pull out a single gene.</li>
            <li>Add a free NCBI API key in Settings for faster requests.</li>
          </ul>
        </div>
      </div>
    </section>`;
  $('#clear-recent')?.addEventListener('click', () => { Recent.clear(); renderHome(); });
}

// --- Search ----------------------------------------------------------------

const ACCESSION_RE = /^([A-Z]{1,2}_?[A-Z0-9]*\d{5,}(\.\d+)?|[A-Z]{1,4}\d{5,8}(\.\d+)?)$/;

async function renderSearch(params, token) {
  const db = params.get('db') || 'nuccore';
  if (db === 'genome' && !GENOME_ACC_RE.test((params.get('term') || '').trim())) return renderGenomeSearch(params, token);
  const term = (params.get('term') || '').trim();
  const size = [20, 50, 100].includes(Number(params.get('size'))) ? Number(params.get('size')) : 20;
  const page = Math.max(1, Number(params.get('page')) || 1);
  // Relevance is NCBI's own default on the website; E-utilities defaults to newest first.
  const sort = params.get('sort') === 'date' ? 'date' : '';
  const f = readFilters(params);
  const fullTerm = buildTerm(db, term, f);

  main.innerHTML = `
    <div class="search-layout">
      <aside>${filtersFormHtml(db, f)}</aside>
      <section id="results">${fullTerm ? loadingHtml('Searching ' + dbLabel(db)) : '<p class="muted">Type a search term above.</p>'}</section>
    </div>`;

  const baseParams = () => {
    const p = { db, term, size: size === 20 ? '' : size, sort };
    for (const [k, v] of Object.entries(f)) p['f_' + k] = v;
    return p;
  };

  $('#filters').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const p = { db, term, size: size === 20 ? '' : size, sort };
    for (const [k, v] of fd) if (String(v).trim()) p['f_' + k] = String(v).trim();
    go('/search', p);
  });
  $('#clear-filters').addEventListener('click', () => go('/search', { db, term }));

  if (!fullTerm) return;

  // GCF_/GCA_ accessions open the genome page whatever database is selected.
  if (GENOME_ACC_RE.test(term)) {
    history.replaceState(null, '', `#/genome/${encodeURIComponent(term.toUpperCase())}`);
    return renderGenome(term.toUpperCase(), token);
  }

  // A bare accession goes straight to its record, like on NCBI.
  if (SEQ_DBS.has(db) && ACCESSION_RE.test(term) && !Object.keys(f).length && page === 1) {
    try {
      const [doc] = await esummary(db, [term]);
      if (token !== routeToken) return;
      if (doc) {
        summaryCache.set(`${db}|${term}`, doc);
        history.replaceState(null, '', `#/record/${db}/${encodeURIComponent(term)}`);
        return renderRecord(db, term, new URLSearchParams(), token);
      }
    } catch { /* not an accession after all: fall through to a normal search */ }
  }

  const results = $('#results');
  try {
    const esort = sort ? undefined : 'relevance';
    const r = await esearch(db, fullTerm, { retstart: (page - 1) * size, retmax: size, sort: esort });
    if (token !== routeToken) return;
    const docs = await esummary(db, r.ids);
    if (token !== routeToken) return;
    const orgHint = await organismHint(db, term, f, r);
    if (token !== routeToken) return;

    Recent.add({ kind: 'search', db, label: [term, ...Object.values(f)].filter(Boolean).join(' · '), count: r.count, params: { ...baseParams() } });

    const pages = Math.min(Math.ceil(r.count / size), Math.floor(9999 / size) + 1);
    const from = r.count ? (page - 1) * size + 1 : 0;
    const to = Math.min(page * size, r.count);
    results.innerHTML = `
      <div class="results-head">
        <div><h2>${fmtN(r.count)} result${r.count === 1 ? '' : 's'}</h2><span class="muted">in ${esc(dbLabel(db))}${r.count ? ` · showing ${fmtN(from)}–${fmtN(to)}` : ''}</span></div>
        <div class="btn-row">
          <label class="inline">Sort <select id="sort"><option value="">Relevance</option><option value="date"${sort ? ' selected' : ''}>Newest</option></select></label>
          <label class="inline">Per page <select id="size">${[20, 50, 100].map((n) => `<option${n === size ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        </div>
      </div>
      ${orgHint ? `<div class="notice">Your search also matched <b>${esc(orgHint.org)}</b> as plain text, so records from other organisms that only mention it are included.
        <a href="${esc(orgHint.href)}">Show only <i>${esc(orgHint.org)}</i> (${fmtN(orgHint.count)})</a></div>` : ''}
      ${r.notFound.length ? `<div class="notice">Not found or ignored: <b>${esc(r.notFound.join(', '))}</b></div>` : ''}
      <details class="details">
        <summary>Search details</summary>
        <dl><dt>Query sent</dt><dd><code>${esc(fullTerm)}</code></dd>
        <dt>NCBI translation</dt><dd><code>${esc(r.translation || 'none')}</code></dd></dl>
      </details>
      ${r.count ? `
        <div class="toolbar">
          <label class="check"><input type="checkbox" id="sel-all"> Select page</label>
          <span class="muted" id="sel-count"></span>
          <div class="spacer"></div>
          ${downloadControlsHtml(db, r.count)}
        </div>
        <ol class="results">${docs.map((d) => resultItemHtml(db, d)).join('')}</ol>
        ${paginationHtml(page, pages)}` : '<p class="muted">No records match. Try fewer words, or check the search details above.</p>'}`;

    $('#size')?.addEventListener('change', (e) => go('/search', { ...baseParams(), size: e.target.value }));
    $('#sort')?.addEventListener('change', (e) => go('/search', { ...baseParams(), sort: e.target.value }));
    bindPager(results, (p) => go('/search', { ...baseParams(), page: p }), pages);
    bindSelection(results);
    bindDownload(results, db, docs, async () => {
      const all = await esearch(db, fullTerm, { retmax: 500, sort: esort });
      return all.ids;
    });
  } catch (e) {
    if (token === routeToken) results.innerHTML = errorHtml(e);
  }
}

// NCBI turns a free-text organism name into ("X"[Organism] OR x[All Fields]), which
// also pulls in other species whose records merely mention X. Offer the strict version.
async function organismHint(db, term, f, r) {
  if (!filterKeys(db).includes('org') || f.org) return null;
  const m = r.translation.match(/\("([^"]+)"\[Organism\] OR [^)]*\[All Fields\]\)/);
  if (!m) return null;
  const org = m[1];
  const words = org.toLowerCase().split(/\s+/);
  const rest = term.split(/\s+/).filter((w) => !words.includes(w.toLowerCase())).join(' ');
  const strict = { ...f, org };
  try {
    const { count } = await esearch(db, buildTerm(db, rest, strict), { retmax: 0 });
    if (count >= r.count) return null;
    const p = { db, term: rest };
    for (const [k, v] of Object.entries(strict)) p['f_' + k] = v;
    return { org, count, href: hashFor('/search', p) };
  } catch { return null; }
}

function bindPager(root, onPage, pages) {
  $$('.pager button', root).forEach((b) => b.addEventListener('click', () => onPage(Number(b.dataset.page))));
  $$('.page-input', root).forEach((i) => i.addEventListener('change', () => {
    onPage(Math.min(pages, Math.max(1, Number(i.value) || 1)));
  }));
}

function bindSelection(root) {
  const update = () => {
    const n = $$('.sel:checked', root).length;
    $('#sel-count', root).textContent = n ? `${n} selected` : '';
  };
  $('#sel-all', root)?.addEventListener('change', (e) => {
    $$('.sel', root).forEach((c) => { c.checked = e.target.checked; });
    update();
  });
  $$('.sel', root).forEach((c) => c.addEventListener('change', update));
}

// --- Downloads ("Send to: File") -------------------------------------------

function downloadFormats(db) {
  if (SEQ_DBS.has(db)) {
    return [['fasta', 'FASTA'], ['gb', db === 'protein' ? 'GenPept' : 'GenBank'], ['acc', 'Accession list'], ['csv', 'Summary (CSV)']];
  }
  if (db === 'pubmed') return [['abstract', 'Abstracts (text)'], ['medline', 'MEDLINE'], ['csv', 'Summary (CSV)'], ['ids', 'PMID list']];
  return [['csv', 'Summary (CSV)'], ['ids', 'ID list']];
}

function downloadControlsHtml(db, count) {
  return `
    <div class="download">
      <select id="dl-scope">
        <option value="selected">Selected</option>
        <option value="page">This page</option>
        ${count <= 500 ? `<option value="all">All ${fmtN(count)} results</option>` : ''}
      </select>
      <select id="dl-format">${downloadFormats(db).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <button class="btn" id="dl-go">Download</button>
    </div>`;
}

function bindDownload(root, db, pageDocs, getAllIds) {
  const btn = $('#dl-go', root);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const scope = $('#dl-scope', root).value;
    const format = $('#dl-format', root).value;
    let ids = scope === 'selected' ? $$('.sel:checked', root).map((c) => c.value) : pageDocs.map((d) => d.uid);
    if (scope === 'selected' && !ids.length) return toast('Select some records first, or choose "This page".');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Preparing…';
    try {
      if (scope === 'all') ids = await getAllIds();
      await downloadRecords(db, ids, format);
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

async function downloadRecords(db, ids, format) {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${db}_${ids.length}_${stamp}`;
  if (format === 'fasta') return saveFile(`${base}.fasta`, await efetch(db, ids, 'fasta'));
  if (format === 'gb') return saveFile(`${base}.${db === 'protein' ? 'gp' : 'gb'}`, await efetch(db, ids, db === 'protein' ? 'gp' : 'gb'));
  if (format === 'abstract') return saveFile(`${base}_abstracts.txt`, await efetch(db, ids, 'abstract'));
  if (format === 'medline') return saveFile(`${base}.medline.txt`, await efetch(db, ids, 'medline'));

  const docs = [];
  for (let i = 0; i < ids.length; i += 200) docs.push(...(await esummary(db, ids.slice(i, i + 200))));
  if (format === 'acc') return saveFile(`${base}_accessions.txt`, docs.map((d) => summarize(db, d).id).join('\n') + '\n');
  if (format === 'ids') return saveFile(`${base}_ids.txt`, docs.map((d) => d.uid).join('\n') + '\n');

  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = SEQ_DBS.has(db)
    ? [['accession', 'title', 'organism', 'length', 'molecule', 'updated'],
      ...docs.map((d) => [d.accessionversion || d.caption, d.title, d.organism, d.slen, d.biomol || d.moltype, d.updatedate])]
    : [['uid', 'title', 'details'], ...docs.map((d) => { const s = summarize(db, d); return [d.uid, s.title, s.meta.filter(Boolean).join('; ')]; })];
  return saveFile(`${base}.csv`, rows.map((r) => r.map(cell).join(',')).join('\n') + '\n');
}

function saveFile(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied to clipboard');
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// --- Linked records ----------------------------------------------------------

async function renderLinks(dbfrom, id, linkname, params, token) {
  const page = Math.max(1, Number(params.get('page')) || 1);
  const size = 20;
  main.innerHTML = `<section id="results">${loadingHtml('Finding linked records')}</section>`;
  const results = $('#results');
  try {
    const { dbto, ids } = await elinkNeighbor(dbfrom, id, linkname);
    if (token !== routeToken) return;
    const pageIds = ids.slice((page - 1) * size, page * size);
    const docs = await esummary(dbto, pageIds);
    if (token !== routeToken) return;
    const pages = Math.ceil(ids.length / size);
    results.innerHTML = `
      <a class="back" href="#/record/${dbfrom}/${encodeURIComponent(id)}">‹ Back to record</a>
      <div class="results-head">
        <div><h2>${fmtN(ids.length)} linked record${ids.length === 1 ? '' : 's'}</h2>
        <span class="muted">${esc(dbLabel(dbto))} · via <code>${esc(linkname)}</code> from ${esc(dbLabel(dbfrom))} ${esc(id)}</span></div>
      </div>
      ${ids.length ? `
        <div class="toolbar">
          <label class="check"><input type="checkbox" id="sel-all"> Select page</label>
          <span class="muted" id="sel-count"></span>
          <div class="spacer"></div>
          ${downloadControlsHtml(dbto, ids.length)}
        </div>
        <ol class="results">${docs.map((d) => resultItemHtml(dbto, d)).join('')}</ol>
        ${paginationHtml(page, pages)}` : '<p class="muted">No linked records.</p>'}`;
    bindPager(results, (p) => go(`/links/${dbfrom}/${encodeURIComponent(id)}/${linkname}`, { page: p }), pages);
    bindSelection(results);
    bindDownload(results, dbto, docs, async () => ids.slice(0, 500));
  } catch (e) {
    if (token === routeToken) results.innerHTML = errorHtml(e);
  }
}

// --- Record ------------------------------------------------------------------

async function getSummary(db, id) {
  const key = `${db}|${id}`;
  if (!summaryCache.has(key)) {
    const [doc] = await esummary(db, [id]);
    if (!doc) throw new Error(`No ${dbLabel(db)} record found for "${id}".`);
    summaryCache.set(key, doc);
  }
  return summaryCache.get(key);
}

async function cachedFetch(key, fn) {
  if (!textCache.has(key)) {
    const p = fn();
    textCache.set(key, p);
    p.catch(() => textCache.delete(key));
  }
  return textCache.get(key);
}

async function renderRecord(db, id, params, token) {
  main.innerHTML = loadingHtml('Loading record');
  let doc;
  try {
    doc = await getSummary(db, id);
  } catch (e) {
    if (token === routeToken) main.innerHTML = errorHtml(e);
    return;
  }
  if (token !== routeToken) return;
  const s = summarize(db, doc);
  Recent.add({ kind: 'record', db, id, label: s.title });

  const isSeq = SEQ_DBS.has(db);
  // WGS and TSA master records describe a sequencing project and hold no sequence;
  // the data is in the contigs (and scaffolds) they list.
  const isMaster = db === 'nuccore' && doc.properties?.master === '1';
  const region = {
    from: Number(params.get('from')) || '',
    to: Number(params.get('to')) || '',
    strand: params.get('strand') === '2' ? '2' : '1',
  };
  const hasRegion = isSeq && region.from && region.to;
  const shownLen = hasRegion ? Math.abs(region.to - region.from) + 1 : Number(doc.slen || 0);

  const tabs = isMaster ? [['contigs', 'Contigs'], ['genbank', 'GenBank']]
    : isSeq
    ? [['genbank', db === 'protein' ? 'GenPept' : 'GenBank'], ['fasta', 'FASTA'], ['features', 'Features'], ...(db === 'nuccore' ? [['cds', 'CDS']] : [])]
    : [['summary', 'Summary'], ...(db === 'pubmed' ? [['abstract', 'Abstract']] : [])];
  const defaultTab = isMaster ? 'contigs' : isSeq ? (shownLen > BIG_RECORD ? 'features' : 'genbank') : 'summary';
  let tab = tabs.some(([t]) => t === params.get('tab')) ? params.get('tab') : defaultTab;

  const ncbiUrl = `https://www.ncbi.nlm.nih.gov/${db}/${encodeURIComponent(s.id)}`;
  const blastProgram = db === 'protein' ? 'blastp' : 'blastn';

  main.innerHTML = `
    <article class="record">
      <header class="record-head">
        <span class="db-chip">${esc(dbLabel(db))}</span>
        <h1>${esc(s.title)}</h1>
        <div class="meta">${s.meta.filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('')}</div>
        ${hasRegion ? `<div class="notice">Showing region <b>${fmtN(region.from)}–${fmtN(region.to)}</b> (${region.strand === '2' ? 'minus' : 'plus'} strand), ${fmtN(shownLen)} bp. <a href="#/record/${db}/${encodeURIComponent(id)}">Show whole record</a></div>` : ''}
      </header>
      <div class="record-layout">
        <div class="record-main">
          <nav class="tabs" role="tablist">${tabs.map(([t, l]) => `<button role="tab" data-tab="${t}" aria-selected="${t === tab}">${l}</button>`).join('')}</nav>
          <div id="tab-body"></div>
        </div>
        <aside class="record-side">
          ${db === 'nuccore' && !isMaster ? `
            <form class="card" id="region">
              <h3>Change region shown</h3>
              <div class="row2">
                <input name="from" type="number" min="1" placeholder="from" value="${region.from}">
                <input name="to" type="number" min="1" placeholder="to" value="${region.to}">
              </div>
              <label>Strand<select name="strand"><option value="1">Plus</option><option value="2"${region.strand === '2' ? ' selected' : ''}>Minus (reverse complement)</option></select></label>
              <button class="btn small" type="submit">Update view</button>
            </form>` : ''}
          <div class="card">
            <h3>Analyze</h3>
            <ul class="link-list compact">
              ${isSeq ? `<li><a href="https://blast.ncbi.nlm.nih.gov/Blast.cgi?PROGRAM=${blastProgram}&PAGE_TYPE=BlastSearch&QUERY=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">Run BLAST ↗</a></li>` : ''}
              <li><a href="${ncbiUrl}" target="_blank" rel="noopener">Open on NCBI ↗</a></li>
            </ul>
          </div>
          ${db === 'nuccore' || db === 'assembly' ? `<div class="card" id="genome-card"><h3>Genome</h3>${loadingHtml('Finding assembly')}</div>` : ''}
          <div class="card" id="related"><h3>Related information</h3>${loadingHtml('Checking links')}</div>
        </aside>
      </div>
    </article>`;

  $('#region')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    go(`/record/${db}/${encodeURIComponent(id)}`, { from: fd.get('from'), to: fd.get('to'), strand: fd.get('strand') === '2' ? 2 : '', tab });
  });

  const showTab = (t) => {
    tab = t;
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    const p = new URLSearchParams(location.hash.split('?')[1] || '');
    p.set('tab', t);
    history.replaceState(null, '', `#/record/${db}/${encodeURIComponent(id)}?${p}`);
    renderTab(db, id, doc, t, region, hasRegion, shownLen, token);
  };
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  renderTab(db, id, doc, tab, region, hasRegion, shownLen, token);
  if ($('#genome-card')) renderGenomeCard(db, doc.uid, token);
  renderRelated(db, doc.uid, token);
}

const MAX_CONTIGS = 500;

// Expands the WGS / WGS_SCAFLD / TSA lines of a master record, e.g.
// "JCCBIC010000001-JCCBIC010000077", into individual accessions.
function masterMembers(gbText, refseq) {
  const out = { scaffolds: [], contigs: [], total: 0 };
  for (const m of gbText.matchAll(/^(WGS_SCAFLD|WGS|TSA|TLS)\s+(\S+)/gm)) {
    const [a, b = a] = m[2].split('-');
    const pa = a.match(/^([A-Z_]+)(\d+)$/);
    const pb = b.match(/^([A-Z_]+)(\d+)$/);
    if (!pa || !pb || pa[1] !== pb[1]) continue;
    const list = m[1] === 'WGS_SCAFLD' ? out.scaffolds : out.contigs;
    const prefix = refseq && !pa[1].startsWith('NZ_') && m[1] !== 'WGS_SCAFLD' ? 'NZ_' + pa[1] : pa[1];
    const start = Number(pa[2]);
    const end = Number(pb[2]);
    out.total += end - start + 1;
    for (let n = start; n <= end && list.length < MAX_CONTIGS; n++) list.push(prefix + String(n).padStart(pa[2].length, '0'));
  }
  return out;
}

async function renderContigsTab(body, id, doc, isStale) {
  const gb = await cachedFetch(`nuccore|${id}|gb|all`, () => efetch('nuccore', id, 'gbwithparts'));
  if (isStale()) return;
  const { scaffolds, contigs, total } = masterMembers(gb, doc.sourcedb === 'refseq');
  if (!total) {
    body.innerHTML = '<p class="muted">This project record lists no sequences. See the GenBank tab, or the Genome card on the right.</p>';
    return;
  }
  const accs = [...scaffolds, ...contigs].slice(0, MAX_CONTIGS);
  const docs = [];
  for (let i = 0; i < accs.length; i += 200) {
    // Some listed contigs have no RefSeq copy; NCBI rejects the whole batch for one
    // unknown accession, so drop it and ask again.
    let batch = accs.slice(i, i + 200);
    for (let tries = 0; batch.length && tries < 20; tries++) {
      try {
        docs.push(...await esummary('nuccore', batch));
        break;
      } catch (e) {
        const bad = String(e.message).match(/Invalid uid (\S+)/)?.[1];
        if (!bad) throw e;
        batch = batch.filter((a) => a !== bad);
      }
    }
  }
  if (isStale()) return;
  const n = docs.length;
  body.innerHTML = `
    <div class="notice">This is a <b>whole genome shotgun project</b> record. It describes the project and has no sequence of its own.
      ${total > accs.length ? `The genome has ${fmtN(total)} sequences; the first ${fmtN(n)} are below.` : `The genome is in the ${fmtN(n)} sequence${n === 1 ? '' : 's'} below.`}
      For FASTA of the whole genome, use the <b>Genome</b> card on the right.</div>
    <ol class="results">${docs.map((d) => resultItemHtml('nuccore', d, { selectable: false })).join('')}</ol>`;
}

// --- Genome (NCBI Datasets) ----------------------------------------------------

const genomeCache = new Map();

function getGenomeReport(acc) {
  if (!genomeCache.has(acc)) {
    const p = genomeReport(acc);
    genomeCache.set(acc, p);
    p.catch(() => genomeCache.delete(acc));
  }
  return genomeCache.get(acc);
}

const datasetsPageUrl = (acc) => `https://www.ncbi.nlm.nih.gov/datasets/genome/${encodeURIComponent(acc)}/`;

// NCBI's taxonomy check status: OK, Inconclusive or Failed.
function aniStatusHtml(ani) {
  if (!ani) return '<span class="pill">no ANI result</span>';
  const s = String(ani.taxonomy_check_status || '').toLowerCase();
  const cls = s === 'ok' ? 'ok' : s === 'failed' ? 'fail' : 'warn';
  return `<span class="pill ${cls}">Taxonomy check: ${esc(ani.taxonomy_check_status || 'unknown')}</span>`;
}

const humanize = (s) => String(s || '').replace(/_/g, ' ');

async function renderGenomeCard(db, uid, token) {
  const box = $('#genome-card');
  try {
    const acc = await assemblyAccessionFor(db, uid);
    if (token !== routeToken) return;
    if (!acc) { box.innerHTML = '<h3>Genome</h3><p class="muted">Not part of an assembly in NCBI Datasets.</p>'; return; }
    const r = await getGenomeReport(acc);
    if (token !== routeToken) return;
    const ani = r.average_nucleotide_identity;
    const best = ani?.best_ani_match;
    box.innerHTML = `
      <h3>Genome</h3>
      <a class="genome-acc" href="#/genome/${encodeURIComponent(acc)}">${esc(acc)}</a>
      <div class="muted small">${esc(r.organism?.organism_name)}${r.organism?.infraspecific_names?.strain ? ` ${esc(r.organism.infraspecific_names.strain)}` : ''} · ${esc(r.assembly_info?.assembly_level)}</div>
      ${aniStatusHtml(ani)}
      ${r.type_material ? '<div class="small">Type strain: this genome <b>defines</b> its species name.</div>' : ''}
      ${best ? `<div class="small">${r.type_material ? 'Nearest other type' : 'Best type match'}: <i>${esc(best.organism_name)}</i>, <b>${esc(best.ani)}%</b> ANI</div>` : ''}
      ${ani?.comment && ani.comment !== 'na' ? `<div class="small muted">${esc(ani.comment)}</div>` : ''}
      <div class="btn-row">
        <a class="btn small primary" href="#/genome/${encodeURIComponent(acc)}">Genome & ANI</a>
        <a class="btn small" href="${datasetsPageUrl(acc)}" target="_blank" rel="noopener">Datasets ↗</a>
      </div>`;
  } catch (e) {
    if (token === routeToken) box.innerHTML = `<h3>Genome</h3><p class="muted small">Could not load: ${esc(e.message)}</p>`;
  }
}

function statGrid(items) {
  return `<dl class="stat-grid">${items.filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

function aniMatchRow(label, m) {
  if (!m) return '';
  return `<tr>
    <th>${esc(label)}</th>
    <td><i>${esc(m.organism_name)}</i><br><a href="#/genome/${encodeURIComponent(m.assembly)}">${esc(m.assembly)}</a> <span class="muted">${esc(humanize(m.category))}</span></td>
    <td class="num"><b>${esc(m.ani)}%</b></td>
    <td class="num">${esc(m.assembly_coverage)}%</td>
    <td class="num">${esc(m.type_assembly_coverage)}%</td>
  </tr>`;
}

async function renderGenome(acc, token) {
  main.innerHTML = loadingHtml('Loading genome from NCBI Datasets');
  let r;
  try {
    r = await getGenomeReport(acc);
  } catch (e) {
    if (token === routeToken) main.innerHTML = errorHtml(e);
    return;
  }
  if (token !== routeToken) return;

  const org = r.organism || {};
  const info = r.assembly_info || {};
  const stats = r.assembly_stats || {};
  const checkm = r.checkm_info;
  const annot = r.annotation_info;
  const ani = r.average_nucleotide_identity;
  const strain = org.infraspecific_names?.strain || org.infraspecific_names?.isolate || '';
  const title = `${org.organism_name || acc}${strain && !String(org.organism_name).includes(strain) ? ' ' + strain : ''}`;
  Recent.add({ kind: 'record', db: 'genome', id: acc, label: `${acc} ${title}` });

  const n = (v) => (v === undefined || v === null || v === '' ? '' : fmtN(v));
  const genes = annot?.stats?.gene_counts;
  const bioproject = info.bioproject_accession;
  const biosample = info.biosample?.accession;

  main.innerHTML = `
    <article class="record">
      <header class="record-head">
        <span class="db-chip">Genome</span>
        <h1>${esc(title)}</h1>
        <div class="meta">${[acc, info.assembly_name, info.assembly_level, info.assembly_status, info.release_date && `released ${info.release_date}`, info.submitter]
          .filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('')}</div>
      </header>
      <div class="record-layout">
        <div class="record-main genome-main">
          <section class="card">
            <div class="card-head"><h3>Average nucleotide identity</h3>${aniStatusHtml(ani)}</div>
            ${ani ? `
              <p class="small muted">NCBI compares each prokaryotic assembly with type-strain assemblies. Two genomes are usually the same species above about 95% ANI.
              Result: <b>${esc(humanize(ani.match_status))}</b>, submitted as <i>${esc(ani.submitted_organism)}</i>.</p>
              <div class="table-wrap"><table>
                <thead><tr><th></th><th>Type assembly</th><th class="num">ANI</th><th class="num">Query coverage</th><th class="num">Type coverage</th></tr></thead>
                <tbody>
                  ${aniMatchRow('Best match', ani.best_ani_match)}
                  ${ani.submitted_ani_match && ani.submitted_ani_match.assembly !== ani.best_ani_match?.assembly ? aniMatchRow('Submitted species', ani.submitted_ani_match) : ''}
                </tbody>
              </table></div>
              ${ani.comment && ani.comment !== 'na' ? `<p class="small">${esc(ani.comment)}</p>` : ''}`
            : '<p class="muted">NCBI has no ANI result for this assembly. The check only runs on prokaryotic genomes.</p>'}
          </section>

          <div class="genome-grid">
            <section class="card">
              <h3>Assembly statistics</h3>
              ${statGrid([
                ['Total length', stats.total_sequence_length && `${n(stats.total_sequence_length)} bp`],
                ['GC', stats.gc_percent !== undefined ? `${stats.gc_percent}%` : ''],
                ['Contigs', n(stats.number_of_contigs)],
                ['Contig N50', stats.contig_n50 && `${n(stats.contig_n50)} bp`],
                ['Contig L50', n(stats.contig_l50)],
                ['Scaffolds', n(stats.number_of_scaffolds)],
                ['Scaffold N50', stats.scaffold_n50 && `${n(stats.scaffold_n50)} bp`],
                ['Coverage', stats.genome_coverage && `${esc(stats.genome_coverage)}×`],
              ])}
            </section>
            <section class="card">
              <h3>Completeness (CheckM)</h3>
              ${checkm ? statGrid([
                ['Completeness', `${checkm.completeness}%`],
                ['Contamination', `${checkm.contamination}%`],
                ['Percentile', checkm.completeness_percentile !== undefined ? `${Math.round(checkm.completeness_percentile)}th` : ''],
                ['Marker set', `<i>${esc(checkm.checkm_marker_set)}</i> <span class="muted">(${esc(checkm.checkm_marker_set_rank)})</span>`],
              ]) : '<p class="muted">No CheckM result.</p>'}
            </section>
            <section class="card">
              <h3>Annotation</h3>
              ${annot ? statGrid([
                ['Provider', esc(annot.provider)],
                ['Released', esc(annot.release_date)],
                ['Genes', n(genes?.total)],
                ['Protein coding', n(genes?.protein_coding)],
                ['Non-coding', n(genes?.non_coding)],
                ['Pseudogenes', n(genes?.pseudogene)],
              ]) : '<p class="muted">Not annotated.</p>'}
            </section>
            <section class="card">
              <h3>Sequencing</h3>
              ${statGrid([
                ['Technology', esc(info.sequencing_tech)],
                ['Assembler', esc(info.assembly_method)],
                ['Type', esc(info.assembly_type)],
                ['Tax ID', org.tax_id && `<a href="#/record/taxonomy/${org.tax_id}">${org.tax_id}</a>`],
              ])}
            </section>
          </div>

          <section>
            <div class="card-head"><h3>Sequences</h3><span class="muted small" id="seq-count"></span></div>
            <div class="table-wrap"><table>
              <thead><tr><th>Name</th><th>Accession</th><th>Role</th><th class="num">Length</th><th class="num">GC</th></tr></thead>
              <tbody id="seq-rows"></tbody>
            </table></div>
            <div id="seq-more"></div>
          </section>
        </div>

        <aside class="record-side">
          <div class="card">
            <h3>Get this genome</h3>
            <ul class="link-list compact">
              <li><a href="${genomeDownloadUrl(acc)}">Download ZIP</a> <span class="muted">FASTA, GFF, proteins, CDS</span></li>
              <li><a href="${datasetsPageUrl(acc)}" target="_blank" rel="noopener">Open in NCBI Datasets ↗</a></li>
            </ul>
          </div>
          <div class="card">
            <h3>Related information</h3>
            <ul class="link-list compact">
              ${r.paired_accession ? `<li><a href="#/genome/${encodeURIComponent(r.paired_accession)}">${esc(r.paired_accession)}</a> <span class="muted">${r.paired_accession.startsWith('GCF') ? 'RefSeq' : 'GenBank'} copy</span></li>` : ''}
              ${bioproject ? `<li><a href="${hashFor('/search', { db: 'bioproject', term: bioproject })}">BioProject ${esc(bioproject)}</a></li>` : ''}
              ${biosample ? `<li><a href="${hashFor('/search', { db: 'biosample', term: biosample })}">BioSample ${esc(biosample)}</a></li>` : ''}
              ${org.tax_id ? `<li><a href="#/record/taxonomy/${org.tax_id}">Taxonomy</a></li>` : ''}
            </ul>
          </div>
        </aside>
      </div>
    </article>`;

  loadGenomeSequences(acc, '', token);
}

const ASSEMBLY_LEVELS = [
  ['complete_genome', 'Complete genome'],
  ['chromosome', 'Chromosome'],
  ['scaffold', 'Scaffold'],
  ['contig', 'Contig'],
];

function genomeFiltersHtml(f) {
  const levels = (f.level || '').split(',');
  const check = (name, label, on) => `<label class="check"><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}> ${label}</label>`;
  return `
    <form class="filters" id="filters">
      <h3>Filters</h3>
      <label>Source<select name="src">
        <option value="">RefSeq and GenBank</option>
        <option value="refseq"${f.src === 'refseq' ? ' selected' : ''}>RefSeq only</option>
        <option value="genbank"${f.src === 'genbank' ? ' selected' : ''}>GenBank only</option>
      </select></label>
      <fieldset><legend>Assembly level</legend>
        ${ASSEMBLY_LEVELS.map(([v, l]) => `<label class="check"><input type="checkbox" name="level" value="${v}"${levels.includes(v) ? ' checked' : ''}> ${l}</label>`).join('')}
      </fieldset>
      <fieldset><legend>Only</legend>
        ${check('ref', 'Reference genomes', f.ref)}
        ${check('type', 'Type strains', f.type)}
        ${check('atypical', 'Exclude atypical', f.atypical)}
        ${check('exact', 'This taxon only, no subtaxa', f.exact)}
      </fieldset>
      <div class="filters-actions">
        <button class="btn primary" type="submit">Apply</button>
        <button class="btn ghost" type="button" id="clear-filters">Clear</button>
      </div>
    </form>`;
}

function genomeRowHtml(r) {
  const org = r.organism || {};
  const strain = org.infraspecific_names?.strain || org.infraspecific_names?.isolate || '';
  const info = r.assembly_info || {};
  const stats = r.assembly_stats || {};
  const checkm = r.checkm_info;
  const status = r.average_nucleotide_identity?.taxonomy_check_status;
  const cls = { ok: 'ok', failed: 'fail', inconclusive: 'warn' }[String(status).toLowerCase()] || '';
  const size = Number(stats.total_sequence_length);
  return `<tr>
    <td><input type="checkbox" class="sel" value="${esc(r.accession)}" aria-label="Select"></td>
    <td><a class="mono" href="#/genome/${encodeURIComponent(r.accession)}">${esc(r.accession)}</a>
      ${r.type_material ? '<span class="badge">type</span>' : ''}${info.refseq_category === 'reference genome' ? '<span class="badge">reference</span>' : ''}</td>
    <td><i>${esc(org.organism_name)}</i>${strain && !String(org.organism_name).includes(strain) ? `<br><span class="muted small">${esc(strain)}</span>` : ''}</td>
    <td>${esc(info.assembly_level)}</td>
    <td class="num">${size ? (size / 1e6).toFixed(2) + ' Mb' : ''}</td>
    <td class="num">${stats.number_of_contigs ? fmtN(stats.number_of_contigs) : ''}</td>
    <td class="num">${checkm ? `${checkm.completeness}% / ${checkm.contamination}%` : '<span class="muted">n/a</span>'}</td>
    <td>${status ? `<span class="pill ${cls}">${esc(status)}</span>` : '<span class="muted">n/a</span>'}</td>
    <td class="muted">${esc(info.release_date)}</td>
  </tr>`;
}

async function renderGenomeSearch(params, token) {
  const term = (params.get('term') || '').trim();
  const f = readFilters(params);
  main.innerHTML = `
    <div class="search-layout">
      <aside>${genomeFiltersHtml(f)}</aside>
      <section id="results">${term ? loadingHtml('Searching genomes') : '<p class="muted">Type an organism name or tax ID above, e.g. <i>Pseudomonas fluorescens</i>.</p>'}</section>
    </div>`;

  $('#filters').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    go('/search', {
      db: 'genome', term,
      f_src: fd.get('src'), f_level: fd.getAll('level').join(','),
      f_ref: fd.get('ref'), f_type: fd.get('type'), f_atypical: fd.get('atypical'), f_exact: fd.get('exact'),
    });
  });
  $('#clear-filters').addEventListener('click', () => go('/search', { db: 'genome', term }));
  if (!term) return;

  const results = $('#results');
  try {
    const first = await genomeSearch(term, f);
    if (token !== routeToken) return;

    if (!first.total) {
      // Datasets needs a full taxon name; offer what the name suggester finds.
      const hints = await taxonSuggest(term).catch(() => []);
      if (token !== routeToken) return;
      const keep = Object.fromEntries(Object.entries(f).map(([k, v]) => ['f_' + k, v]));
      results.innerHTML = `
        <h2>No genomes for "${esc(term)}"</h2>
        ${hints.length ? `<p class="muted">Genome search needs a full taxon name or tax ID. Did you mean:</p>
          <ul class="link-list">${hints.slice(0, 10).map((h) => `<li><a href="${hashFor('/search', { db: 'genome', term: h.name, ...keep })}"><i>${esc(h.name)}</i></a> <span class="muted">${esc(h.rank)} · tax ID ${esc(h.taxId)}</span></li>`).join('')}</ul>`
          : '<p class="muted">Try a full species or genus name, or a tax ID. If filters are on, try clearing them.</p>'}`;
      return;
    }

    Recent.add({ kind: 'search', db: 'genome', label: [term, ...(f.level || '').split(',').filter(Boolean).map(humanize)].join(' · '), count: first.total, params: Object.fromEntries(params) });

    results.innerHTML = `
      <div class="results-head">
        <div><h2>${fmtN(first.total)} genome${first.total === 1 ? '' : 's'}</h2><span class="muted">for <i>${esc(term)}</i> · one row per assembly, RefSeq copy preferred</span></div>
      </div>
      <div class="toolbar">
        <label class="check"><input type="checkbox" id="sel-all"> Select shown</label>
        <span class="muted" id="sel-count"></span>
        <div class="spacer"></div>
        <div class="download">
          <select id="dl-format">
            <option value="acc">Accession list</option>
            <option value="csv">Table (CSV)</option>
            <option value="zip">Genome ZIP (FASTA, GFF, proteins)</option>
          </select>
          <button class="btn" id="dl-go">Download selected</button>
        </div>
      </div>
      <div class="table-wrap genome-table"><table>
        <thead><tr><th></th><th>Assembly</th><th>Organism</th><th>Level</th><th class="num">Size</th><th class="num">Contigs</th><th class="num">CheckM compl. / contam.</th><th>ANI check</th><th>Released</th></tr></thead>
        <tbody id="genome-rows"></tbody>
      </table></div>
      <div class="pager" id="genome-more"></div>`;

    const loaded = [];
    const rows = $('#genome-rows');
    const append = (page) => {
      loaded.push(...page.reports);
      rows.insertAdjacentHTML('beforeend', page.reports.map(genomeRowHtml).join(''));
      $$('.sel', rows).forEach((c) => { c.onchange = updateCount; });
      const more = $('#genome-more');
      more.innerHTML = `<span class="muted">${fmtN(loaded.length)} of ${fmtN(first.total)} shown</span>
        ${page.next ? '<button class="btn small" id="more-btn">Load 50 more</button>' : ''}`;
      $('#more-btn')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Loading…';
        try {
          const next = await genomeSearch(term, f, page.next);
          if (token === routeToken) append(next);
        } catch (err) {
          toast(err.message);
          e.target.disabled = false;
        }
      });
    };
    const updateCount = () => {
      const n = $$('.sel:checked', rows).length;
      $('#sel-count').textContent = n ? `${n} selected` : '';
    };
    $('#sel-all').addEventListener('change', (e) => {
      $$('.sel', rows).forEach((c) => { c.checked = e.target.checked; });
      updateCount();
    });
    $('#dl-go').addEventListener('click', () => {
      const ids = $$('.sel:checked', rows).map((c) => c.value);
      if (!ids.length) return toast('Select some genomes first.');
      const format = $('#dl-format').value;
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'zip') {
        if (ids.length > 25) return toast('Pick 25 genomes or fewer for one ZIP.');
        location.href = genomeDownloadUrl(ids);
        return;
      }
      if (format === 'acc') return saveFile(`genomes_${ids.length}_${stamp}.txt`, ids.join('\n') + '\n');
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const picked = loaded.filter((r) => ids.includes(r.accession));
      const table = [['accession', 'organism', 'strain', 'level', 'length', 'contigs', 'gc_percent', 'checkm_completeness', 'checkm_contamination', 'ani_check', 'best_ani_match', 'best_ani', 'type_material', 'released'],
        ...picked.map((r) => {
          const ani = r.average_nucleotide_identity;
          return [r.accession, r.organism?.organism_name, r.organism?.infraspecific_names?.strain, r.assembly_info?.assembly_level,
            r.assembly_stats?.total_sequence_length, r.assembly_stats?.number_of_contigs, r.assembly_stats?.gc_percent,
            r.checkm_info?.completeness, r.checkm_info?.contamination, ani?.taxonomy_check_status,
            ani?.best_ani_match?.organism_name, ani?.best_ani_match?.ani, r.type_material ? 'yes' : '', r.assembly_info?.release_date];
        })];
      saveFile(`genomes_${ids.length}_${stamp}.csv`, table.map((row) => row.map(cell).join(',')).join('\n') + '\n');
    });
    append(first);
  } catch (e) {
    if (token === routeToken) results.innerHTML = errorHtml(e);
  }
}

// Organism-name suggestions for the search box while Genome is selected.
function bindTaxonSuggest() {
  const input = $('#q');
  const list = $('#taxon-suggest');
  let timer;
  let last = '';
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if ($('#db').value !== 'genome' || text.length < 3 || text === last) return;
    timer = setTimeout(async () => {
      last = text;
      try {
        const hints = await taxonSuggest(text);
        list.innerHTML = hints.slice(0, 12).map((h) => `<option value="${esc(h.name)}">${esc(h.rank)}</option>`).join('');
      } catch { /* suggestions are optional */ }
    }, 300);
  });
  const sync = () => {
    if ($('#db').value === 'genome') input.setAttribute('list', 'taxon-suggest');
    else input.removeAttribute('list');
  };
  $('#db').addEventListener('change', sync);
  sync();
}

async function loadGenomeSequences(acc, pageToken, token) {
  const rows = $('#seq-rows');
  const more = $('#seq-more');
  more.innerHTML = loadingHtml('Loading sequences');
  try {
    const page = await genomeSequences(acc, pageToken);
    if (token !== routeToken) return;
    rows.insertAdjacentHTML('beforeend', page.reports.map((s) => {
      const seqAcc = s.refseq_accession && s.refseq_accession !== 'na' ? s.refseq_accession : s.genbank_accession;
      return `<tr>
        <td>${esc(s.chr_name && s.role === 'assembled-molecule' ? s.chr_name : s.sequence_name || s.chr_name)}</td>
        <td><a href="#/record/nuccore/${encodeURIComponent(seqAcc)}">${esc(seqAcc)}</a></td>
        <td class="muted">${esc(humanize(s.role))}</td>
        <td class="num">${fmtN(s.length)}</td>
        <td class="num">${s.gc_percent !== undefined ? `${s.gc_percent}%` : ''}</td>
      </tr>`;
    }).join(''));
    const shown = rows.children.length;
    $('#seq-count').textContent = `${fmtN(shown)} of ${fmtN(page.total)}`;
    more.innerHTML = page.next ? '<button class="btn small" id="seq-more-btn">Load 100 more</button>' : '';
    $('#seq-more-btn')?.addEventListener('click', () => loadGenomeSequences(acc, page.next, token));
  } catch (e) {
    if (token === routeToken) more.innerHTML = errorHtml(e);
  }
}

async function renderRelated(db, uid, token) {
  try {
    const links = (await elinkCheck(db, uid)).filter((l) => l.dbto && l.linkname);
    if (token !== routeToken) return;
    const box = $('#related');
    if (!links.length) { box.innerHTML = '<h3>Related information</h3><p class="muted">No linked records.</p>'; return; }
    const item = (l) => {
      const target = dbLabel(l.dbto);
      const note = target.toLowerCase() === l.label.toLowerCase() ? '' : ` <span class="muted">${esc(target)}</span>`;
      return `<li><a href="#/links/${db}/${uid}/${l.linkname}">${esc(l.label)}</a>${note}</li>`;
    };
    box.innerHTML = `<h3>Related information</h3>
      <ul class="link-list compact">${links.slice(0, 10).map(item).join('')}</ul>
      ${links.length > 10 ? `<details><summary>${links.length - 10} more</summary><ul class="link-list compact">${links.slice(10).map(item).join('')}</ul></details>` : ''}`;
  } catch {
    if (token === routeToken) $('#related').innerHTML = '<h3>Related information</h3><p class="muted">Could not load links.</p>';
  }
}

function textPanelHtml(text, filename) {
  return `
    <div class="panel-actions">
      <button class="btn small" data-act="copy">Copy</button>
      <button class="btn small" data-act="save" data-name="${esc(filename)}">Download</button>
    </div>
    <pre class="seq">${esc(text)}</pre>`;
}

function bindTextPanel(root, text) {
  $('[data-act="copy"]', root)?.addEventListener('click', () => copyText(text));
  const save = $('[data-act="save"]', root);
  save?.addEventListener('click', () => saveFile(save.dataset.name, text));
}

function seqStats(seq, isProtein) {
  if (isProtein || !seq.length) return `${fmtN(seq.length)} ${isProtein ? 'aa' : 'bp'}`;
  const gc = (seq.match(/[GCgcSs]/g) || []).length;
  return `${fmtN(seq.length)} bp · GC ${(100 * gc / seq.length).toFixed(1)}%`;
}

async function renderTab(db, id, doc, tab, region, hasRegion, shownLen, token) {
  const body = $('#tab-body');
  const isStale = () => token !== routeToken || !body.isConnected;
  const regionParams = hasRegion ? { seq_start: region.from, seq_stop: region.to, strand: region.strand } : {};
  const regionKey = hasRegion ? `${region.from}-${region.to}-${region.strand}` : 'all';
  const safeId = id.replace(/[^\w.-]/g, '_');
  const suffix = hasRegion ? `_${region.from}-${region.to}${region.strand === '2' ? 'c' : ''}` : '';

  if (doc.properties?.master === '1') shownLen = 0;
  const sizeLimit = tab === 'genbank' || tab === 'fasta' ? BIG_RECORD
    : tab === 'features' || tab === 'cds' ? 20 * BIG_RECORD : Infinity;
  if (shownLen > sizeLimit && !body.dataset.force) {
    body.innerHTML = `
      <div class="notice">This ${hasRegion ? 'region' : 'record'} is <b>${fmtN(shownLen)} bp</b>. Loading it whole is slow and heavy.
      ${sizeLimit === BIG_RECORD ? 'To get one gene, use the <b>Features</b> or <b>CDS</b> tab, or set a region on the right.' : 'Set a region on the right to narrow it down.'}</div>
      <button class="btn" id="force-load">Load anyway</button>`;
    $('#force-load').addEventListener('click', () => {
      body.dataset.force = '1';
      renderTab(db, id, doc, tab, region, hasRegion, shownLen, token);
    });
    return;
  }
  body.innerHTML = loadingHtml('Fetching from NCBI');

  try {
    if (tab === 'summary') {
      body.innerHTML = summaryTabHtml(db, doc);
      return;
    }
    if (tab === 'contigs') {
      await renderContigsTab(body, id, doc, isStale);
      return;
    }
    if (tab === 'abstract') {
      const text = await cachedFetch(`${db}|${id}|abstract`, () => efetch(db, id, 'abstract'));
      if (isStale()) return;
      body.innerHTML = `<pre class="prose">${esc(text.trim())}</pre>`;
      return;
    }
    if (tab === 'genbank') {
      const rettype = db === 'protein' ? 'gp' : 'gbwithparts';
      const text = await cachedFetch(`${db}|${id}|gb|${regionKey}`, () => efetch(db, id, rettype, regionParams));
      if (isStale()) return;
      body.innerHTML = textPanelHtml(text, `${safeId}${suffix}.${db === 'protein' ? 'gp' : 'gb'}`);
      bindTextPanel(body, text);
      return;
    }
    if (tab === 'fasta') {
      const text = await cachedFetch(`${db}|${id}|fasta|${regionKey}`, () => efetch(db, id, 'fasta', regionParams));
      if (isStale()) return;
      const [rec] = parseFasta(text);
      body.innerHTML = `<p class="muted stats">${rec ? seqStats(rec.seq, db === 'protein') : ''}</p>` + textPanelHtml(text, `${safeId}${suffix}.fasta`);
      bindTextPanel(body, text);
      return;
    }
    if (tab === 'features') {
      const ftRegion = hasRegion ? { seq_start: Math.min(region.from, region.to), seq_stop: Math.max(region.from, region.to) } : {};
      const text = await cachedFetch(`${db}|${id}|ft|${regionKey}`, () => efetch(db, id, 'ft', ftRegion));
      if (isStale()) return;
      const offset = hasRegion ? ftRegion.seq_start - 1 : 0;
      renderFeatures(body, db, id, parseFeatureTable(text, offset));
      return;
    }
    if (tab === 'cds') {
      const cdsRegion = hasRegion ? { seq_start: Math.min(region.from, region.to), seq_stop: Math.max(region.from, region.to) } : {};
      renderCds(body, id, `${safeId}${suffix}`, isStale, cdsRegion, regionKey, doc.uid);
    }
  } catch (e) {
    if (!isStale()) body.innerHTML = errorHtml(e);
  }
}

function summaryTabHtml(db, doc) {
  let extra = '';
  if (db === 'gene') {
    const locs = (doc.genomicinfo || []).filter((g) => g.chraccver);
    extra = `
      ${doc.summary ? `<p class="prose">${esc(doc.summary)}</p>` : ''}
      ${locs.length ? `<h3>Genomic location</h3><ul class="link-list">${locs.map((g) => {
        const minus = g.chrstart > g.chrstop;
        const from = Math.min(g.chrstart, g.chrstop) + 1;
        const to = Math.max(g.chrstart, g.chrstop) + 1;
        const href = hashFor(`/record/nuccore/${encodeURIComponent(g.chraccver)}`, { from, to, strand: minus ? 2 : '', tab: 'fasta' });
        return `<li><a href="${href}">${esc(g.chraccver)} : ${fmtN(from)}–${fmtN(to)} (${minus ? 'minus' : 'plus'} strand), get sequence</a></li>`;
      }).join('')}</ul>` : ''}`;
  }
  const rows = Object.entries(doc)
    .filter(([k, v]) => !['uid', 'summary', 'genomicinfo', 'locationhist'].includes(k) && v !== '' && v !== null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => {
      let val;
      if (Array.isArray(v)) val = v.map((x) => (typeof x === 'object' ? Object.values(x).filter((y) => typeof y !== 'object').join(' ') : x)).join('; ');
      else if (typeof v === 'object') val = Object.entries(v).filter(([, y]) => y && typeof y !== 'object').map(([a, y]) => `${a}: ${y}`).join('; ');
      else val = v;
      if (!String(val).trim()) return '';
      return `<tr><th>${esc(k)}</th><td>${esc(String(val).slice(0, 1200))}</td></tr>`;
    }).join('');
  return `${extra}<h3>Record summary</h3><table class="kv">${rows}</table>`;
}

function renderFeatures(body, db, id, features) {
  const visible = features;
  const types = [...new Set(visible.map((f) => f.type))];
  const preferred = types.includes('CDS') ? 'CDS' : types.includes('gene') ? 'gene' : '';
  const qv = (f, k) => f.q[k]?.[0] || '';
  const LIMIT = 400;

  body.innerHTML = `
    <div class="feature-controls">
      <select id="ft-type"><option value="">All types (${visible.length})</option>
        ${types.map((t) => `<option value="${esc(t)}"${t === preferred ? ' selected' : ''}>${esc(t)} (${visible.filter((f) => f.type === t).length})</option>`).join('')}
      </select>
      <input id="ft-filter" type="search" placeholder="Filter by gene, product, locus tag…">
      <span class="muted" id="ft-count"></span>
    </div>
    <div class="table-wrap"><table class="features"><thead><tr>
      <th>Type</th><th>Location</th><th>Gene / locus</th><th>Product / note</th><th></th>
    </tr></thead><tbody></tbody></table></div>`;

  const tbody = $('tbody', body);
  const draw = () => {
    const type = $('#ft-type').value;
    const needle = $('#ft-filter').value.trim().toLowerCase();
    const rows = visible.filter((f) => (!type || f.type === type)
      && (!needle || JSON.stringify(f.q).toLowerCase().includes(needle) || f.location.toLowerCase().includes(needle)));
    $('#ft-count').textContent = rows.length > LIMIT ? `showing ${LIMIT} of ${fmtN(rows.length)}` : `${fmtN(rows.length)} shown`;
    tbody.innerHTML = rows.slice(0, LIMIT).map((f) => {
      const idx = features.indexOf(f);
      const protein = qv(f, 'protein_id');
      const geneId = (f.q.db_xref || []).find((x) => x.startsWith('GeneID:'))?.slice(7);
      const name = [qv(f, 'gene'), qv(f, 'locus_tag')].filter(Boolean);
      return `<tr>
        <td><span class="badge">${esc(f.type)}</span></td>
        <td class="mono" title="${esc(f.location)}">${f.parts.length > 1
          ? `${f.strand === '-' ? 'complement(' : ''}${f.lo}..${f.hi}${f.strand === '-' ? ')' : ''}<br><span class="muted">${f.parts.length} parts</span>`
          : esc(f.location)}</td>
        <td>${name.map((n, i) => (i === 0 ? `<b>${esc(n)}</b>` : `<span class="muted">${esc(n)}</span>`)).join('<br>')}</td>
        <td>${esc(qv(f, 'product') || qv(f, 'note') || qv(f, 'organism'))}
          ${protein ? `<br><a href="#/record/protein/${encodeURIComponent(cleanSeqId(protein))}">${esc(cleanSeqId(protein))}</a>` : ''}
          ${geneId ? ` <a href="#/record/gene/${geneId}">Gene ${esc(geneId)}</a>` : ''}</td>
        <td class="actions"><button class="btn small" data-feature="${idx}">Sequence</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No features match.</td></tr>';
    $$('[data-feature]', tbody).forEach((b) => b.addEventListener('click', () => showFeatureSequence(db, id, features[Number(b.dataset.feature)])));
  };
  $('#ft-type').addEventListener('change', draw);
  $('#ft-filter').addEventListener('input', draw);
  draw();
}

async function showFeatureSequence(db, id, f) {
  const qv = (k) => f.q[k]?.[0] || '';
  const name = qv('gene') || qv('locus_tag') || f.type;
  openModal(`${name} · ${f.type}`, loadingHtml('Fetching sequence'));
  try {
    // The feature table lists intervals in transcript order, so fetching each one on the
    // feature's strand and joining them gives the right spliced sequence.
    let seq = '';
    for (const p of f.parts.slice(0, 50)) {
      const strand = db === 'nuccore' ? (f.strand === '-' ? 2 : 1) : undefined;
      const text = await efetch(db, id, 'fasta', { seq_start: p.from, seq_stop: p.to, strand });
      seq += parseFasta(text)[0]?.seq || '';
    }
    const header = `${id}:${f.location} ${name}${qv('product') ? ' ' + qv('product') : ''}`;
    const fasta = toFasta([{ header, seq }]);
    const body = $('#modal-body');
    body.innerHTML = `<p class="muted stats">${seqStats(seq, db === 'protein')} · ${esc(f.location)}</p>` + textPanelHtml(fasta, `${name.replace(/[^\w.-]/g, '_')}.fasta`);
    bindTextPanel(body, fasta);
  } catch (e) {
    $('#modal-body').innerHTML = errorHtml(e);
  }
}

// "lcl|NZ_CP027720.1_cds_WP_041989327.1_2 [locus_tag=...] [protein_id=WP_041989327.1] ..."
const cdsProteinId = (header) => header.match(/\[protein_id=([^\]]+)\]/)?.[1] || '';

async function renderCds(body, id, safeId, isStale, regionParams, regionKey, uid) {
  let kind = 'na';
  let records = [];
  body.innerHTML = `
    <div class="feature-controls">
      <div class="segmented" role="group">
        <button data-kind="na" aria-pressed="true">Nucleotide</button>
        <button data-kind="aa" aria-pressed="false">Protein</button>
      </div>
      <input id="cds-filter" type="search" placeholder="Filter, e.g. nirK or nitrite reductase">
      <span class="muted" id="cds-count"></span>
    </div>
    <div id="cds-domain"></div>
    <div id="cds-out">${loadingHtml('Fetching coding sequences')}</div>`;

  const outBox = () => $('#cds-out', body);
  const domBox = () => $('#cds-domain', body);
  const needleNow = () => $('#cds-filter', body).value.trim();

  const show = (list, suffix) => {
    const out = outBox();
    const fasta = list.length ? toFasta(list) : '';
    const shown = list.length > 300 ? toFasta(list.slice(0, 300)) + `\n… ${list.length - 300} more (included in Download)\n` : fasta;
    out.innerHTML = list.length
      ? textPanelHtml(shown, `${safeId}_cds_${kind}${suffix}.fasta`)
      : '<p class="muted">No coding sequences match.</p>';
    bindTextPanel(out, fasta);
  };

  // A name search found nothing. Annotation text is the weakest thing about a record,
  // so offer the sequence-derived answer instead: domains that match the name, then the
  // proteins in this record that carry one.
  const searchDomains = async (needle) => {
    const box = domBox();
    box.innerHTML = loadingHtml('Searching conserved domains');
    try {
      const domains = await cddSearch(needle);
      if (isStale()) return;
      if (!domains.length) {
        box.innerHTML = `<div class="notice">No conserved domain matches “${esc(needle)}” either.</div>`;
        return;
      }
      box.innerHTML = `
        <div class="notice">
          <p>Conserved domains matching “${esc(needle)}”. Pick one to find the proteins in this record that carry it, whatever their product name says.</p>
          <ul class="link-list compact">
            ${domains.map((d) => `<li><button class="btn small" data-cdd="${esc(d.uid)}" data-label="${esc(d.accession)} · ${esc(d.title)}">${esc(d.accession)} · ${esc(d.title)}</button></li>`).join('')}
          </ul>
        </div>`;
      $$('[data-cdd]', box).forEach((b) =>
        b.addEventListener('click', () => runDomain(b.dataset.cdd, b.dataset.label)));
    } catch (e) {
      if (!isStale()) box.innerHTML = errorHtml(e);
    }
  };

  const runDomain = async (cddUid, label) => {
    const box = domBox();
    box.innerHTML = loadingHtml(`Finding proteins with ${label}`);
    try {
      const prots = await proteinsWithDomain(uid, cddUid);
      if (isStale()) return;
      const want = new Set(prots.map((p) => p.accession));
      const list = records.filter((r) => want.has(cdsProteinId(r.header)));
      // No hit here is weak evidence: NCBI has not computed a domain assignment for
      // every protein, so the gene can be present and still not be found this way.
      box.innerHTML = prots.length ? `
        <div class="notice">
          <b>${esc(label)}</b> — ${fmtN(prots.length)} protein${prots.length === 1 ? '' : 's'} in this record,
          ${fmtN(list.length)} matched to a coding sequence shown here.
          ${list.length ? `<div class="small muted">Named in the record as: ${[...new Set(list.map((r) => r.header.match(/\[protein=([^\]]+)\]/)?.[1]).filter(Boolean))].map((p) => `<i>${esc(p)}</i>`).join(', ')}</div>` : ''}
          <button class="btn small" data-act="back">Other domains</button>
        </div>` : `
        <div class="notice">
          No protein in this record is assigned <b>${esc(label)}</b>. That is not proof the gene is missing:
          NCBI has not computed domains for every protein, and a gene can be present with no assignment at all.
          To settle it, BLAST a characterised protein against this record.
          <button class="btn small" data-act="back">Other domains</button>
        </div>`;
      $('[data-act="back"]', box).addEventListener('click', () => searchDomains(needleNow()));
      $('#cds-count', body).textContent = `${fmtN(list.length)} of ${fmtN(records.length)} CDS`;
      show(list, `_${label.split(' ')[0].replace(/[^\w.-]/g, '_')}`);
    } catch (e) {
      if (!isStale()) box.innerHTML = errorHtml(e);
    }
  };

  const load = async () => {
    const out = outBox();
    out.innerHTML = loadingHtml('Fetching coding sequences');
    try {
      const text = await cachedFetch(`nuccore|${id}|cds_${kind}|${regionKey}`, () => efetch('nuccore', id, `fasta_cds_${kind}`, regionParams));
      if (isStale()) return;
      records = parseFasta(text);
      const draw = () => {
        const needle = needleNow().toLowerCase();
        const hits = needle ? records.filter((r) => r.header.toLowerCase().includes(needle)) : records;
        $('#cds-count', body).textContent = `${fmtN(hits.length)} of ${fmtN(records.length)} CDS`;
        show(hits, needle ? '_' + needle.replace(/[^\w.-]/g, '_') : '');
        const box = domBox();
        if (needle && !hits.length && uid) {
          box.innerHTML = `
            <div class="notice">
              Nothing here is <b>named</b> “${esc(needle)}”, which does not mean the gene is absent — product names are assigned automatically and are often wrong.
              <button class="btn small" id="cds-dom-go">Search conserved domains instead</button>
            </div>`;
          $('#cds-dom-go', box).addEventListener('click', () => searchDomains(needleNow()));
        } else {
          box.innerHTML = '';
        }
      };
      $('#cds-filter', body).oninput = draw;
      draw();
    } catch (e) {
      if (!isStale()) out.innerHTML = errorHtml(e);
    }
  };
  $$('.segmented button', body).forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.kind;
    $$('.segmented button', body).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    load();
  }));
  load();
}

// --- Modal & settings ----------------------------------------------------------

function openModal(title, html) {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  if (!dlg.open) dlg.showModal();
}

function openSettings() {
  openModal('Settings', `
    <form id="settings-form" class="settings">
      <label>NCBI API key <span class="muted">(optional, raises the limit from 3 to 10 requests/s)</span>
        <input name="apiKey" value="${esc(Settings.get('apiKey'))}" autocomplete="off" spellcheck="false"></label>
      <p class="muted small">Get one free under <a href="https://account.ncbi.nlm.nih.gov/settings/" target="_blank" rel="noopener">NCBI account settings ↗</a> → API Key Management.</p>
      <label>Contact email <span class="muted">(optional, NCBI asks scripts to identify themselves)</span>
        <input name="email" type="email" value="${esc(Settings.get('email'))}"></label>
      <p class="muted small">Both are stored only in this browser.</p>
      <div class="filters-actions"><button class="btn primary" type="submit">Save</button></div>
    </form>`);
  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    Settings.set('apiKey', String(fd.get('apiKey')).trim());
    Settings.set('email', String(fd.get('email')).trim());
    $('#modal').close();
    toast('Settings saved');
  });
}

// --- Theme -------------------------------------------------------------------

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  Settings.set('theme', next);
  applyTheme(next);
}

// --- Boot --------------------------------------------------------------------

function init() {
  applyTheme(Settings.get('theme'));
  $('#db').innerHTML = DATABASES.map((d) => `<option value="${d.id}">${d.label}</option>`).join('');
  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const db = $('#db').value;
    const term = $('#q').value.trim();
    if (!term) return $('#q').focus();
    // Keep organism filter when searching again from a results page of the same db.
    const { parts, params } = parseHash();
    const keep = {};
    if (parts[0] === 'search' && params.get('db') === db) {
      for (const [k, v] of params) if (k.startsWith('f_')) keep[k] = v;
    }
    go('/search', { db, term, ...keep });
  });
  bindTaxonSuggest();
  $('#settings-btn').addEventListener('click', openSettings);
  $('#theme-btn').addEventListener('click', toggleTheme);
  $('#modal-close').addEventListener('click', () => $('#modal').close());
  $('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  window.addEventListener('hashchange', route);
  route();
}

init();
