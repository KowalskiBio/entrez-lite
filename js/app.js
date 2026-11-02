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
  { id: 'protfam', label: 'Protein Family Models' },
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

// --- Search history ----------------------------------------------------------

// Numbered searches, like NCBI's Advanced search history, so "#1 AND #3" works in
// the search box. Numbers are never reused, even after clearing: an old bookmark
// that says #4 then reports the search missing instead of meaning a different one.
let historyFallback = null; // used when the browser blocks storage

const SearchHistory = {
  MAX: 100,
  load() {
    try {
      const h = JSON.parse(localStorage.getItem('el.history') || 'null');
      if (h && Array.isArray(h.items)) return h;
    } catch { return historyFallback ||= { next: 1, items: [] }; }
    return { next: 1, items: [] };
  },
  save(h) {
    try { localStorage.setItem('el.history', JSON.stringify(h)); } catch { historyFallback = h; }
  },
  // Running the same query again (another page, another sort) keeps its number.
  add({ db, query, count, params }) {
    const h = this.load();
    let item = h.items.find((i) => i.db === db && i.query === query);
    if (item) h.items = h.items.filter((i) => i !== item);
    else item = { n: h.next++, db, query };
    Object.assign(item, { count, params, at: Date.now() });
    h.items = [item, ...h.items].slice(0, this.MAX);
    this.save(h);
    return item.n;
  },
  clear() {
    this.save({ next: this.load().next, items: [] });
  },
};

// --- Filters ---------------------------------------------------------------

// Each filter maps a form field to an Entrez query clause, mirroring NCBI's sidebar.
const FILTERS = {
  nuccore: ['org', 'gene', 'mol', 'src', 'len'],
  protein: ['org', 'gene', 'src', 'len'],
  gene: ['org', 'alive'],
  structure: ['org', 'expm', 'reso', 'lig'],
  ipg: ['org', 'len', 'pcount'],
  protfam: ['sym', 'meth', 'ec'],
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
  if (has('expm') && f.expm) clauses.push(`"${f.expm}"[EXPM]`);
  if (has('reso') && f.reso) clauses.push(`0:${f.reso}[RESO]`);
  if (has('lig') && f.lig) clauses.push(`${f.lig}[LCOD]`);
  if (has('ec') && f.ec) clauses.push(`${f.ec}[EC]`);
  if (has('pcount') && f.pcount) clauses.push(`${f.pcount}:100000000[ProtCount]`);
  if (has('sym') && f.sym) clauses.push(`${f.sym}[GS]`);
  if (has('meth') && f.meth) clauses.push(`${f.meth}[METH]`);
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
      ${field('expm', `<label>Experimental method<select name="expm">
        ${opt('', 'All', f.expm || '')}${opt('X-ray diffraction', 'X-ray diffraction', f.expm)}${opt('Solution NMR', 'NMR', f.expm)}${opt('Electron microscopy', 'Electron microscopy', f.expm)}
      </select></label>`)}
      ${field('reso', `<label>Resolution, at best (Å)<input name="reso" type="number" step="0.1" min="0.1" value="${esc(f.reso)}" placeholder="e.g. 2.0"></label>`)}
      ${field('lig', `<label>Ligand code<input name="lig" value="${esc(f.lig)}" placeholder="e.g. HEM"></label>`)}
      ${field('ec', `<label>EC number<input name="ec" value="${esc(f.ec)}" placeholder="e.g. 1.7.2.1"></label>`)}
      ${field('pcount', `<label>Proteins in group, at least<input name="pcount" type="number" min="1" value="${esc(f.pcount)}" placeholder="e.g. 100"></label>`)}
      ${field('sym', `<label>Gene symbol<input name="sym" value="${esc(f.sym)}" placeholder="e.g. nirK"></label>`)}
      ${field('meth', `<label>Model type<select name="meth">
        ${opt('', 'All', f.meth || '')}${opt('HMM', 'HMM', f.meth)}${opt('BlastRule', 'BlastRule', f.meth)}
      </select></label>`)}
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
    // These four are looked up by UID: E-utilities rejects their accessions.
    case 'structure': {
      const mols = [d.proteinmoleculecount && `${d.proteinmoleculecount} protein`, d.dnamoleculecount && `${d.dnamoleculecount} DNA`,
        d.rnamoleculecount && `${d.rnamoleculecount} RNA`].filter(Boolean).join(' + ');
      return {
        id: uid,
        title: d.pdbdescr,
        meta: [
          d.pdbacc,
          d.expmethod,
          d.resolution ? `${d.resolution} Å` : '',
          d.pdbclass,
          (d.organismlist || []).join(', '),
          mols,
          d.ligcount && d.ligcount !== '0' ? `${d.ligcount} ligand${d.ligcount === '1' ? '' : 's'}` : '',
          d.pdbdepositdate ? `deposited ${d.pdbdepositdate.slice(0, 10)}` : '',
        ],
        badges: [d.ec ? `EC ${d.ec}` : ''],
      };
    }
    case 'cdd':
      return {
        id: uid,
        title: `${d.accession} · ${d.title}`,
        meta: [d.subtitle, d.database, d.organism && d.organism !== 'cellular organisms' ? d.organism : '',
          d.pssmlength ? `${d.pssmlength} aa model` : '', d.pubdate ? `published ${d.pubdate.slice(0, 10)}` : ''],
        snippet: d.abstract,
        badges: [/^cl/.test(d.accession) ? 'Superfamily' : '', d.structurerepresentative ? 'Has structure' : ''],
      };
    case 'ipg': {
      const count = (n, one, many) => (Number(n) ? `${fmtN(n)} ${Number(n) === 1 ? one : many}` : '');
      return {
        id: uid,
        title: d.title,
        meta: [
          d.accession,
          count(d.proteincount, 'protein', 'proteins'),
          d.slen ? `${fmtN(d.slen)} aa` : '',
          d.organism,
          count(d.speciescount, 'species', 'species'),
          count(d.assemblycount, 'assembly', 'assemblies'),
          d.div,
          d.modificationdate ? `updated ${d.modificationdate.slice(0, 10)}` : '',
        ],
        badges: [/^WP_/.test(d.accession) ? 'RefSeq non-redundant' : ''],
      };
    }
    case 'protfam': {
      const first = (v) => (Array.isArray(v) ? v.join(', ') : v || '');
      return {
        id: uid,
        title: first(d.dispproductname) || d.dispfamilyacc,
        meta: [d.dispfamilyacc, first(d.dispgenesymbol) && `gene ${first(d.dispgenesymbol)}`, d.dispmethod, d.dispreviewlevel,
          d.disppubdate ? `updated ${d.disppubdate.slice(0, 10)}` : ''],
        snippet: first(d.dispdescription),
        badges: [(d.dispgotermlist || []).length ? 'GO terms' : ''],
      };
    }
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
  if (parts[0] === 'compare') return renderCompare(params, token);
  if (parts[0] === 'history') return renderHistory();
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
            <li>Paste an accession (e.g. <code>HQ288918.1</code>) to jump to the record, or a whole list of them, one per line, to get them all.</li>
            <li>Every search gets a number. Combine them like <code>#1 AND #3</code>, or use the <a href="#/history">History</a> page.</li>
            <li>On a genome or contig, open the <b>Features</b> or <b>CDS</b> tab to pull out a single gene.</li>
            <li>Add a free NCBI API key in Settings for faster requests.</li>
          </ul>
        </div>
      </div>
    </section>`;
  $('#clear-recent')?.addEventListener('click', () => { Recent.clear(); renderHome(); });
}

// --- History -----------------------------------------------------------------

const QUERY_SHOWN = 300;

function renderHistory() {
  const { items } = SearchHistory.load();
  const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  const shortQuery = (q) => (q.length > QUERY_SHOWN ? q.slice(0, QUERY_SHOWN) + '…' : q);
  const row = (i) => `
    <tr>
      <td class="mono"><b>#${i.n}</b></td>
      <td><span class="db-chip">${esc(dbLabel(i.db))}</span></td>
      <td class="history-query"><a href="${hashFor('/search', i.params || { db: i.db, term: i.query })}" title="Run again"><code>${esc(shortQuery(i.query))}</code></a></td>
      <td class="num">${fmtN(i.count)}</td>
      <td class="muted mono">${esc(when(i.at))}</td>
      <td class="actions"><div class="segmented">${['AND', 'OR', 'NOT'].map((op) =>
        `<button type="button" data-n="${i.n}" data-db="${esc(i.db)}" data-op="${op}" title="Add #${i.n} to the query with ${op}">${op}</button>`).join('')}</div></td>
    </tr>`;
  const startDb = items[0]?.db || 'nuccore';

  main.innerHTML = `
    <section class="history">
      <div class="results-head">
        <div><h2>Search history</h2><span class="muted">${items.length ? `${fmtN(items.length)} search${items.length === 1 ? '' : 'es'} · ` : ''}kept in this browser</span></div>
        ${items.length ? '<button class="btn ghost small" id="clear-history">Clear history</button>' : ''}
      </div>
      <p class="muted">Each search keeps its number. Combine searches from the same database with AND, OR and NOT, here or straight in the search bar.</p>
      <form class="card builder" id="builder">
        <select name="db" aria-label="Database">${DATABASES.filter((d) => d.id !== 'genome').map((d) =>
          `<option value="${d.id}"${d.id === startDb ? ' selected' : ''}>${d.label}</option>`).join('')}</select>
        <input name="q" placeholder="e.g. #1 AND #3" autocomplete="off" spellcheck="false" aria-label="Combined query">
        <button class="btn primary" type="submit">Search</button>
      </form>
      ${items.length ? `
        <div class="table-wrap"><table class="history-table">
          <thead><tr><th>#</th><th>Database</th><th>Query</th><th class="num">Results</th><th>Time</th><th class="actions">Add to query</th></tr></thead>
          <tbody>${items.map(row).join('')}</tbody>
        </table></div>` : '<p class="muted">No searches yet. Each search you run is added here with a number.</p>'}
    </section>`;

  const form = $('#builder');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (!q) return form.q.focus();
    go('/search', { db: form.db.value, term: q });
  });
  $$('[data-op]', main).forEach((b) => b.addEventListener('click', () => {
    const q = form.q.value.trim();
    const { n, db, op } = b.dataset;
    if (q && form.db.value !== db) {
      return toast(`#${n} is a ${dbLabel(db)} search; the query so far is ${dbLabel(form.db.value)}.`);
    }
    form.db.value = db;
    form.q.value = q ? `${q} ${op} #${n}` : `#${n}`;
    form.q.focus();
  }));
  $('#clear-history')?.addEventListener('click', () => { SearchHistory.clear(); renderHistory(); });
}

// --- Search ----------------------------------------------------------------

async function renderSearch(params, token) {
  const db = params.get('db') || 'nuccore';
  if (db === 'genome' && !GENOME_ACC_RE.test((params.get('term') || '').trim())) return renderGenomeSearch(params, token);
  const term = (params.get('term') || '').trim();
  const size = [20, 50, 100].includes(Number(params.get('size'))) ? Number(params.get('size')) : 20;
  const page = Math.max(1, Number(params.get('page')) || 1);
  // Relevance is NCBI's own default on the website; E-utilities defaults to newest first.
  const sort = params.get('sort') === 'date' ? 'date' : '';
  const f = readFilters(params);
  const list = idListTerm(term);
  let fullTerm = '';
  let termError = null;
  try {
    fullTerm = buildTerm(db, expandHistoryRefs(list ? list.term : term, SearchHistory.load().items, db, dbLabel), f);
  } catch (e) {
    termError = e;
  }

  main.innerHTML = `
    <div class="search-layout">
      <aside>${filtersFormHtml(db, f)}</aside>
      <section id="results">${fullTerm || termError ? loadingHtml('Searching ' + dbLabel(db)) : '<p class="muted">Type a search term above.</p>'}</section>
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

  if (termError) {
    $('#results').innerHTML = errorHtml(termError) + '<p class="muted">See your numbered searches on the <a href="#/history">History</a> page.</p>';
    return;
  }
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

    const label = [list ? `List of ${fmtN(list.count)} IDs` : term, ...Object.values(f)].filter(Boolean).join(' · ');
    Recent.add({ kind: 'search', db, label, count: r.count, params: { ...baseParams() } });
    const historyN = SearchHistory.add({ db, query: fullTerm, count: r.count, params: { ...baseParams() } });
    // For a pasted list, report the IDs themselves rather than NCBI's "X[accn]" phrases.
    const missing = list ? r.notFound.map((p) => p.replace(/\[(accn|uid)\]$/i, '')) : r.notFound;

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
      ${missing.length ? `<div class="notice">${list ? `${fmtN(missing.length)} of ${fmtN(list.count)} IDs not found` : 'Not found or ignored'}: <b>${esc(missing.join(', '))}</b></div>` : ''}
      <details class="details">
        <summary>Search details</summary>
        <dl><dt>Query sent</dt><dd><code>${esc(fullTerm)}</code></dd>
        <dt>NCBI translation</dt><dd><code>${esc(r.translation || 'none')}</code></dd>
        <dt>History</dt><dd>Saved as <b>#${historyN}</b>. Combine it with other searches on the <a href="#/history">History</a> page.</dd></dl>
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
      const saved = await esearchHistory(db, fullTerm, { sort: esort });
      return { ...saved, count: Math.min(saved.count, MAX_DOWNLOAD) };
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

// "All results" reads a search saved on NCBI's history server in batches, so it is
// not held to esearch's 10,000-ID limit. This cap only stops a tab from building a
// file of several gigabytes by accident; it is about 100 requests without a key.
const MAX_DOWNLOAD = 50_000;

function downloadControlsHtml(db, count) {
  return `
    <div class="download">
      <select id="dl-scope">
        <option value="selected">Selected</option>
        <option value="page">This page</option>
        <option value="all">${count > MAX_DOWNLOAD ? `First ${fmtN(MAX_DOWNLOAD)}` : `All ${fmtN(count)}`} results</option>
      </select>
      <select id="dl-format">${downloadFormats(db).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <button class="btn" id="dl-go">Download</button>
    </div>`;
}

class DownloadCancelled extends Error {}

// getAll() returns the record source for "All results": { ids } or a saved search.
function bindDownload(root, db, pageDocs, getAll) {
  const btn = $('#dl-go', root);
  if (!btn) return;
  let job = null;
  btn.addEventListener('click', async () => {
    // While a download runs, the same button cancels it after the current batch.
    if (job) { job.cancelled = true; btn.textContent = 'Cancelling…'; return; }
    const scope = $('#dl-scope', root).value;
    const format = $('#dl-format', root).value;
    const ids = scope === 'selected' ? $$('.sel:checked', root).map((c) => c.value) : pageDocs.map((d) => d.uid);
    if (scope === 'selected' && !ids.length) return toast('Select some records first, or choose "This page".');
    const label = btn.textContent;
    const mine = job = { cancelled: false };
    btn.textContent = 'Preparing…';
    try {
      const source = scope === 'all' ? await getAll() : { ids };
      if (mine.cancelled) throw new DownloadCancelled();
      await downloadRecords(db, source, format, (done, total) => {
        if (mine.cancelled) throw new DownloadCancelled();
        if (done < total) btn.textContent = `Cancel · ${fmtN(done)} of ${fmtN(total)}`;
      });
    } catch (e) {
      toast(e instanceof DownloadCancelled ? 'Download cancelled.' : e.message);
    } finally {
      job = null;
      btn.textContent = label;
    }
  });
}

async function downloadRecords(db, source, format, onProgress) {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${db}_${sourceSize(source)}_${stamp}`;
  const text = (rettype, batch = 500) => efetchAll(db, source, rettype, { batch, onProgress });
  if (format === 'fasta') return saveFile(`${base}.fasta`, await text('fasta'));
  // A GenBank flat file can be a whole genome, so these go in smaller batches.
  if (format === 'gb') return saveFile(`${base}.${db === 'protein' ? 'gp' : 'gb'}`, await text(db === 'protein' ? 'gp' : 'gb', 100));
  if (format === 'abstract') return saveFile(`${base}_abstracts.txt`, await text('abstract'));
  if (format === 'medline') return saveFile(`${base}.medline.txt`, await text('medline'));
  if (format === 'acc') return saveFile(`${base}_accessions.txt`, await text('acc'));
  if (format === 'ids' && source.ids) return saveFile(`${base}_ids.txt`, source.ids.join('\n') + '\n');

  const docs = await esummaryAll(db, source, { onProgress });
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
    bindDownload(results, dbto, docs, async () => ({ ids: ids.slice(0, MAX_DOWNLOAD) }));
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
    ? [['genbank', db === 'protein' ? 'GenPept' : 'GenBank'], ['fasta', 'FASTA'], ['features', 'Features'], ...(db === 'nuccore' ? [['cds', 'CDS']] : [['map', 'Map']])]
    : [['summary', 'Summary'], ...(db === 'pubmed' ? [['abstract', 'Abstract']] : [])];
  const defaultTab = isMaster ? 'contigs' : isSeq ? (shownLen > BIG_RECORD ? 'features' : 'genbank') : 'summary';
  let tab = tabs.some(([t]) => t === params.get('tab')) ? params.get('tab') : defaultTab;

  const ncbiUrl = {
    structure: `https://www.ncbi.nlm.nih.gov/Structure/pdb/${encodeURIComponent(doc.pdbacc || '')}`,
    cdd: `https://www.ncbi.nlm.nih.gov/Structure/cdd/${encodeURIComponent(doc.accession || '')}`,
    protfam: `https://www.ncbi.nlm.nih.gov/protfam/?term=${encodeURIComponent(doc.dispfamilyacc || '')}`,
  }[db] || `https://www.ncbi.nlm.nih.gov/${db}/${encodeURIComponent(s.id)}`;
  const extraLinks = {
    structure: doc.pdbacc ? [[`RCSB PDB ${doc.pdbacc}`, `https://www.rcsb.org/structure/${encodeURIComponent(doc.pdbacc)}`]] : [],
    ipg: doc.accession ? [['Open in Identical Protein Groups', `https://www.ncbi.nlm.nih.gov/ipg/?term=${encodeURIComponent(doc.accession)}`]] : [],
  }[db] || [];
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
              ${extraLinks.map(([l, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(l)} ↗</a></li>`).join('')}
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
          <form class="card" id="compare-form">
            <h3>Compare this genome</h3>
            <textarea name="with" rows="2" placeholder="GCF_…, GCA_… or NC_… accessions" aria-label="Genomes to compare with" required></textarea>
            <div class="btn-row"><button class="btn small primary">Compare</button></div>
            <p class="muted small">Up to ${MAX_COMPARE - 1} assembly or sequence accessions. Sequencing, size, contigs, quality and gene content side by side.</p>
            ${ani?.best_ani_match && ani.best_ani_match.assembly !== acc ? `<a class="small" href="${compareHref([acc, ani.best_ani_match.assembly])}">Compare with the best type match, ${esc(ani.best_ani_match.assembly)}</a>` : ''}
          </form>
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

  $('#compare-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const others = parseAccessionList(new FormData(e.target).get('with'));
    if (others.length) location.hash = compareHref([acc, ...others]);
  });
  loadGenomeSequences(acc, '', token);
}

// --- Compare genomes -----------------------------------------------------------

const MAX_COMPARE = 6;
const compareHref = (accs) => hashFor('/compare', { ids: accs.join(',') });

const strainOf = (r) => r.organism?.infraspecific_names?.strain || r.organism?.infraspecific_names?.isolate || '';
const sourceLabel = (acc) => (String(acc).startsWith('GCF') ? 'RefSeq' : 'GenBank');
const numOrNull = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Rows of the overview table. `get` returns the value compared between genomes,
// `fmt` how it is shown; numeric rows also show the difference from the first genome.
const COMPARE_ROWS = [
  ['Identity', [
    { label: 'Organism', get: (r) => r.organism?.organism_name, fmt: (v) => `<i>${esc(v)}</i>` },
    { label: 'Strain / isolate', get: strainOf },
    { label: 'Tax ID', get: (r) => r.organism?.tax_id, fmt: (v) => `<a href="#/record/taxonomy/${esc(v)}">${esc(v)}</a>` },
    { label: 'Type material', get: (r) => (r.type_material ? 'yes' : 'no') },
    { label: 'BioProject', get: (r) => r.assembly_info?.bioproject_accession, fmt: (v) => `<a href="${hashFor('/search', { db: 'bioproject', term: v })}">${esc(v)}</a>` },
    { label: 'BioSample', get: (r) => r.assembly_info?.biosample?.accession, fmt: (v) => `<a href="${hashFor('/search', { db: 'biosample', term: v })}">${esc(v)}</a>` },
  ]],
  ['Assembly', [
    { label: 'Source', get: (r) => sourceLabel(r.accession) },
    { label: 'Assembly name', get: (r) => r.assembly_info?.assembly_name },
    { label: 'Level', get: (r) => r.assembly_info?.assembly_level },
    { label: 'Status', get: (r) => r.assembly_info?.assembly_status },
    { label: 'RefSeq category', get: (r) => r.assembly_info?.refseq_category },
    { label: 'Released', get: (r) => r.assembly_info?.release_date },
    { label: 'Submitter', get: (r) => r.assembly_info?.submitter },
  ]],
  ['Sequencing', [
    { label: 'Technology', get: (r) => r.assembly_info?.sequencing_tech },
    { label: 'Assembler', get: (r) => r.assembly_info?.assembly_method },
    { label: 'Coverage', get: (r) => numOrNull(String(r.assembly_stats?.genome_coverage ?? '').replace(/x$/i, '')), num: true, unit: '×', digits: 1 },
  ]],
  ['Statistics', [
    { label: 'Total length', get: (r) => numOrNull(r.assembly_stats?.total_sequence_length), num: true, unit: ' bp' },
    { label: 'Ungapped length', get: (r) => numOrNull(r.assembly_stats?.total_ungapped_length), num: true, unit: ' bp' },
    { label: 'GC', get: (r) => numOrNull(r.assembly_stats?.gc_percent), num: true, unit: '%', digits: 1, points: true },
    { label: 'Chromosomes', get: (r) => numOrNull(r.assembly_stats?.total_number_of_chromosomes), num: true },
    { label: 'Contigs', get: (r) => numOrNull(r.assembly_stats?.number_of_contigs), num: true },
    { label: 'Contig N50', get: (r) => numOrNull(r.assembly_stats?.contig_n50), num: true, unit: ' bp' },
    { label: 'Contig L50', get: (r) => numOrNull(r.assembly_stats?.contig_l50), num: true },
    { label: 'Scaffolds', get: (r) => numOrNull(r.assembly_stats?.number_of_scaffolds), num: true },
    { label: 'Scaffold N50', get: (r) => numOrNull(r.assembly_stats?.scaffold_n50), num: true, unit: ' bp' },
  ]],
  ['Quality', [
    { label: 'CheckM completeness', get: (r) => numOrNull(r.checkm_info?.completeness), num: true, unit: '%', digits: 2, points: true },
    { label: 'CheckM contamination', get: (r) => numOrNull(r.checkm_info?.contamination), num: true, unit: '%', digits: 2, points: true },
    { label: 'Taxonomy check', get: (r) => r.average_nucleotide_identity?.taxonomy_check_status, fmt: (v, r) => aniStatusHtml(r.average_nucleotide_identity) },
    { label: 'Best type match', get: (r) => { const m = r.average_nucleotide_identity?.best_ani_match; return m ? `${m.organism_name} ${m.ani}%` : ''; },
      fmt: (v, r) => { const m = r.average_nucleotide_identity.best_ani_match; return `<i>${esc(m.organism_name)}</i>, <b>${esc(m.ani)}%</b><br><a class="small" href="#/genome/${encodeURIComponent(m.assembly)}">${esc(m.assembly)}</a>`; } },
  ]],
  ['Annotation', [
    { label: 'Provider', get: (r) => r.annotation_info?.provider },
    { label: 'Annotated', get: (r) => r.annotation_info?.release_date },
    { label: 'Genes', get: (r) => numOrNull(r.annotation_info?.stats?.gene_counts?.total), num: true },
    { label: 'Protein coding', get: (r) => numOrNull(r.annotation_info?.stats?.gene_counts?.protein_coding), num: true },
    { label: 'Non-coding', get: (r) => numOrNull(r.annotation_info?.stats?.gene_counts?.non_coding), num: true },
    { label: 'Pseudogenes', get: (r) => numOrNull(r.annotation_info?.stats?.gene_counts?.pseudogene), num: true },
  ]],
];

function fmtNum(v, row) {
  return row.digits ? v.toFixed(row.digits) : fmtN(v);
}

// "+1,234 bp (+0.4%)" against the first genome; GC and CheckM differ in points.
function deltaHtml(v, ref, row) {
  if (v === null || ref === null || v === ref) return '';
  const d = v - ref;
  const sign = d > 0 ? '+' : '−';
  const abs = Math.abs(d);
  const main = `${sign}${row.digits ? abs.toFixed(row.digits) : fmtN(abs)}${row.points ? ' pt' : row.unit || ''}`;
  const p = ref ? Math.abs((d / ref) * 100) : 0;
  const pct = !row.points && ref ? ` (${sign}${p.toFixed(p < 0.1 ? 2 : 1)}%)` : '';
  return `<div class="delta">${main}${pct}</div>`;
}

function compareTableHtml(genomes, diffOnly) {
  const body = COMPARE_ROWS.map(([group, rows]) => {
    const trs = rows.map((row) => {
      const vals = genomes.map((g) => row.get(g.r));
      const shown = vals.map((v) => (v === undefined || v === null || v === '' ? '' : String(v)));
      if (shown.every((v) => !v)) return '';
      const differs = new Set(shown).size > 1;
      if (diffOnly && !differs) return '';
      const cells = genomes.map((g, i) => {
        const v = vals[i];
        if (!shown[i]) return '<td class="muted">—</td>';
        if (row.num) return `<td class="num">${fmtNum(v, row)}${row.unit || ''}${i ? deltaHtml(v, vals[0], row) : ''}</td>`;
        return `<td>${row.fmt ? row.fmt(v, g.r) : esc(v)}</td>`;
      }).join('');
      return `<tr class="${differs ? 'differs' : ''}"><th>${esc(row.label)}</th>${cells}</tr>`;
    }).join('');
    return trs ? `<tr class="group"><th colspan="${genomes.length + 1}">${esc(group)}</th></tr>${trs}` : '';
  }).join('');
  return body || `<tr><td colspan="${genomes.length + 1}" class="muted">These genomes do not differ in any field shown.</td></tr>`;
}

function compareHeadHtml(genomes, { removable = true } = {}) {
  return `<tr><th></th>${genomes.map((g, i) => {
    const strain = strainOf(g.r);
    const name = g.r.organism?.organism_name || '';
    return `<th class="genome-col">
      <div class="genome-col-head">
        <a class="mono" href="#/genome/${encodeURIComponent(g.acc)}">${esc(g.acc)}</a>
        ${removable ? `<button class="icon-x" type="button" data-remove="${esc(g.acc)}" title="Remove from comparison" aria-label="Remove ${esc(g.acc)}">×</button>` : ''}
      </div>
      <div class="genome-col-name"><i>${esc(name)}</i>${strain && !name.includes(strain) ? ` ${esc(strain)}` : ''}</div>
      ${i === 0 ? '<span class="badge">reference</span>' : ''}
    </th>`;
  }).join('')}</tr>`;
}

async function renderCompare(params, token) {
  const inputs = parseAccessionList(params.get('ids') || '');
  const formHtml = (value = '') => `
    <form class="compare-add" id="compare-add">
      <textarea name="ids" rows="1" placeholder="Add GCF_, GCA_ or sequence accessions…" aria-label="Accessions to add">${esc(value)}</textarea>
      <button class="btn primary">${inputs.length ? 'Add' : 'Compare'}</button>
    </form>`;
  const bindAdd = (current) => $('#compare-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const added = parseAccessionList(new FormData(e.target).get('ids'));
    if (added.length) location.hash = compareHref([...new Set([...current, ...added])]);
  });

  if (inputs.length < 2) {
    main.innerHTML = `
      <article class="record compare">
        <header class="record-head"><span class="db-chip">Compare</span><h1>Compare genomes</h1></header>
        <p class="muted">Give two to ${MAX_COMPARE} assemblies (GCF_ or GCA_) or sequence accessions such as NC_002516.2, which stand for the assembly they belong to.</p>
        ${formHtml(inputs.join(' '))}
      </article>`;
    bindAdd([]);
    return;
  }

  main.innerHTML = loadingHtml(`Loading ${inputs.length} genomes`);
  const wanted = inputs.slice(0, MAX_COMPARE);
  const settled = await Promise.allSettled(wanted.map(async (input) => {
    const acc = await resolveGenomeAccession(input);
    const r = await getGenomeReport(acc);
    return { input, acc: r.accession || acc, r };
  }));
  if (token !== routeToken) return;

  const genomes = [];
  const problems = [];
  settled.forEach((s, i) => {
    if (s.status === 'rejected') problems.push(`${wanted[i]}: ${s.reason?.message || s.reason}`);
    else if (genomes.some((g) => g.acc === s.value.acc)) problems.push(`${wanted[i]} is ${s.value.acc}, already in the comparison.`);
    else genomes.push(s.value);
  });
  if (inputs.length > MAX_COMPARE) problems.push(`Only the first ${MAX_COMPARE} accessions are compared.`);
  const accs = genomes.map((g) => g.acc);

  const notices = problems.map((p) => `<div class="notice">${esc(p)}</div>`).join('');
  if (genomes.length < 2) {
    main.innerHTML = `
      <article class="record compare">
        <header class="record-head"><span class="db-chip">Compare</span><h1>Compare genomes</h1></header>
        ${notices}
        <p class="muted">At least two genomes are needed.</p>
        ${formHtml()}
      </article>`;
    bindAdd(accs);
    return;
  }

  let diffOnly = false;
  try { diffOnly = localStorage.getItem('el.compareDiffOnly') === '1'; } catch { /* storage blocked */ }

  main.innerHTML = `
    <article class="record compare">
      <header class="record-head">
        <span class="db-chip">Compare</span>
        <h1>${genomes.length} genomes</h1>
        <div class="meta">${[...new Set(genomes.map((g) => g.r.organism?.organism_name).filter(Boolean))].slice(0, 4).map((o) => `<span><i>${esc(o)}</i></span>`).join('')}</div>
      </header>
      ${notices}
      <div class="compare-main">
        <div class="compare-tools">
          ${genomes.length < MAX_COMPARE ? formHtml() : ''}
          <div class="spacer"></div>
          <label class="check"><input type="checkbox" id="diff-only" ${diffOnly ? 'checked' : ''}> Only rows that differ</label>
          <a class="btn small" href="${genomeDownloadUrl(accs)}">Download all (ZIP)</a>
        </div>

        <section>
          <div class="card-head"><h3>Overview</h3><span class="muted small">Differences are measured against the first genome.</span></div>
          <div class="table-wrap"><table class="compare-table">
            <thead>${compareHeadHtml(genomes)}</thead>
            <tbody id="compare-rows">${compareTableHtml(genomes, diffOnly)}</tbody>
          </table></div>
        </section>

        <section>
          <div class="card-head"><h3>Sequences</h3><span class="muted small">Chromosomes and plasmids, then the remaining contigs together</span></div>
          <div class="table-wrap"><table class="compare-table">
            <thead>${compareHeadHtml(genomes, { removable: false })}</thead>
            <tbody id="compare-seqs"><tr><td colspan="${genomes.length + 1}">${loadingHtml('Loading sequences')}</td></tr></tbody>
          </table></div>
        </section>

        <section class="card" id="gene-content">
          <div class="card-head"><h3>Gene content</h3></div>
          <p class="small muted">Reads every annotated gene of each genome from NCBI Datasets (about one request per 1,000 genes) and matches them by product name, gene symbol or identical protein.</p>
          <div class="btn-row"><button class="btn primary" id="gene-go">Compare gene content</button></div>
        </section>
      </div>
    </article>`;

  $('#diff-only').addEventListener('change', (e) => {
    try { localStorage.setItem('el.compareDiffOnly', e.target.checked ? '1' : ''); } catch { /* storage blocked */ }
    $('#compare-rows').innerHTML = compareTableHtml(genomes, e.target.checked);
  });
  main.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    const rest = accs.filter((a) => a !== b.dataset.remove);
    location.hash = rest.length > 1 ? compareHref(rest) : `#/genome/${encodeURIComponent(rest[0])}`;
  }));
  if ($('#compare-add')) bindAdd(accs);
  $('#gene-go').addEventListener('click', () => loadGeneContent(genomes, token));

  loadCompareSequences(genomes, token);
}

async function loadCompareSequences(genomes, token) {
  const pages = await Promise.allSettled(genomes.map((g) => genomeSequences(g.acc)));
  if (token !== routeToken) return;
  const cols = pages.map((p, i) => {
    if (p.status === 'rejected') return { error: p.reason?.message || 'Could not load.' };
    const placed = p.value.reports.filter((s) => s.role === 'assembled-molecule');
    const total = Number(genomes[i].r.assembly_stats?.total_sequence_length) || 0;
    const placedLen = placed.reduce((a, s) => a + (s.length || 0), 0);
    return { placed, rest: p.value.total - placed.length, restLen: Math.max(0, total - placedLen) };
  });
  const depth = Math.max(0, ...cols.map((c) => c.placed?.length || 0));
  const rows = [];
  for (let k = 0; k < Math.min(depth, 30); k++) {
    rows.push(`<tr><th>${k === 0 ? 'Molecules' : ''}</th>${cols.map((c) => {
      const s = c.placed?.[k];
      if (!s) return '<td></td>';
      const acc = s.refseq_accession && s.refseq_accession !== 'na' ? s.refseq_accession : s.genbank_accession;
      return `<td><div>${esc(s.chr_name || s.sequence_name || 'molecule')} ${s.assigned_molecule_location_type && s.assigned_molecule_location_type.toLowerCase() !== String(s.chr_name || s.sequence_name).toLowerCase() ? `<span class="muted small">${esc(s.assigned_molecule_location_type)}</span>` : ''}</div>
        <a class="mono small" href="#/record/nuccore/${encodeURIComponent(acc)}">${esc(acc)}</a>
        <div class="num-inline">${fmtN(s.length)} bp${s.gc_percent !== undefined ? ` · ${s.gc_percent}% GC` : ''}</div></td>`;
    }).join('')}</tr>`);
  }
  rows.push(`<tr><th>Other sequences</th>${cols.map((c) => (c.error ? `<td class="muted small">${esc(c.error)}</td>`
    : c.rest > 0 ? `<td>${fmtN(c.rest)} contig${c.rest === 1 ? '' : 's'} / scaffold${c.rest === 1 ? '' : 's'}<div class="num-inline">${fmtN(c.restLen)} bp</div></td>`
      : '<td class="muted">none</td>')).join('')}</tr>`);
  $('#compare-seqs').innerHTML = rows.join('');
}

const annotationCache = new Map();

function getAnnotation(acc, onProgress) {
  if (!annotationCache.has(acc)) {
    const p = annotationReport(acc, { onProgress });
    annotationCache.set(acc, p);
    p.catch(() => annotationCache.delete(acc));
  }
  return annotationCache.get(acc);
}

const GENE_ROWS_SHOWN = 300;

const annotatedGeneCount = (r) => Number(r.annotation_info?.stats?.gene_counts?.total) || 0;

async function loadGeneContent(genomes, token) {
  const box = $('#gene-content');
  const status = (html) => { box.innerHTML = `<div class="card-head"><h3>Gene content</h3></div>${html}`; };
  const lists = [];
  try {
    for (const [i, g] of genomes.entries()) {
      status(loadingHtml(`Reading genes of ${g.acc} (${i + 1} of ${genomes.length})`));
      // The dataset report says whether there are genes at all; an unannotated
      // assembly needs no annotation report requests.
      if (!annotatedGeneCount(g.r)) { lists.push([]); continue; }
      lists.push(await getAnnotation(g.acc, (done, total) => {
        if (token === routeToken && done < total) status(loadingHtml(`Reading genes of ${g.acc} (${i + 1} of ${genomes.length}): ${fmtN(done)} of ${fmtN(total)}`));
      }));
      if (token !== routeToken) return;
    }
  } catch (e) {
    if (token === routeToken) status(`${errorHtml(e)}<div class="btn-row"><button class="btn" id="gene-go">Try again</button></div>`);
    $('#gene-go')?.addEventListener('click', () => loadGeneContent(genomes, token));
    return;
  }
  renderGeneContent(box, genomes, lists);
}

function renderGeneContent(box, genomes, lists) {
  const state = { key: 'product', filter: 'differs', q: '', shown: GENE_ROWS_SHOWN };
  const n = genomes.length;
  const types = [...new Set(lists.flatMap((genes) => genes.map((g) => g.type)))].sort();
  const typeCounts = lists.map((genes) => genes.reduce((m, g) => m.set(g.type, (m.get(g.type) || 0) + 1), new Map()));
  const blank = genomes.filter((_, i) => !lists[i].length);
  // Annotated per the dataset report, yet the annotation report has no rows.
  const unserved = blank.filter((g) => annotatedGeneCount(g.r));
  const unannotated = blank.filter((g) => !annotatedGeneCount(g.r)).map((g) => g.acc);
  const notWp = genomes.filter((_, i) => {
    const prots = lists[i].filter((g) => g.protein);
    return prots.length && prots.filter((g) => g.protein.startsWith('WP_')).length / prots.length < 0.5;
  }).map((g) => g.acc);

  box.innerHTML = `
    <div class="card-head"><h3>Gene content</h3></div>
    ${unannotated.length ? `<div class="notice">${esc(unannotated.join(', '))} ${unannotated.length === 1 ? 'has' : 'have'} no gene annotation in NCBI Datasets${unannotated.some((a) => a.startsWith('GCA')) ? '; the RefSeq (GCF_) copy is often annotated' : ''}.</div>` : ''}
    ${unserved.map((g) => `<div class="notice">${esc(g.acc)} is annotated (${fmtN(annotatedGeneCount(g.r))} genes${g.r.annotation_info?.provider ? ` by ${esc(g.r.annotation_info.provider)}` : ''}), but NCBI Datasets does not serve its gene list, so its column is empty.</div>`).join('')}
    <div class="table-wrap"><table class="compare-table">
      <thead>${compareHeadHtml(genomes, { removable: false })}</thead>
      <tbody>
        <tr class="group"><th colspan="${n + 1}">Genes by type</th></tr>
        ${types.map((t) => `<tr><th>${esc(humanize(t))}</th>${typeCounts.map((m) => `<td class="num">${m.has(t) ? fmtN(m.get(t)) : '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}
        <tr><th>All genes</th>${lists.map((g) => `<td class="num">${g.length ? `<b>${fmtN(g.length)}</b>` : '<span class="muted">—</span>'}</td>`).join('')}</tr>
      </tbody>
      <tbody id="gene-summary"></tbody>
    </table></div>

    <div class="gene-controls">
      <span class="small muted">Match genes by</span>
      <div class="segmented" id="gene-key">${Object.entries(GENE_KEYS).map(([k, v]) => `<button type="button" data-key="${k}" aria-pressed="${k === state.key}">${esc(v.label)}</button>`).join('')}</div>
      <select id="gene-filter" aria-label="Which groups to show">
        <option value="differs">Count differs</option>
        <option value="missing">Missing from some</option>
        <option value="core">In every genome</option>
        ${genomes.map((g, i) => `<option value="only:${i}">Only in ${esc(g.acc)}</option>`).join('')}
        ${genomes.map((g, i) => `<option value="lacks:${i}">Missing from ${esc(g.acc)}</option>`).join('')}
        <option value="all">All groups</option>
      </select>
      <input type="search" id="gene-q" placeholder="Filter by name, symbol, locus tag…" aria-label="Filter genes">
      <button class="btn small" type="button" id="gene-dl">Download table (TSV)</button>
    </div>
    <p class="small muted" id="gene-note"></p>
    <div class="table-wrap gene-matrix"><table>
      <thead>${compareHeadHtml(genomes, { removable: false })}</thead>
      <tbody id="gene-rows"></tbody>
    </table></div>
    <div class="pager" id="gene-more"></div>`;

  let content;
  const matches = (row) => {
    const c = row.counts;
    const f = state.filter;
    if (f === 'differs' && c.every((x) => x === c[0])) return false;
    if (f === 'missing' && c.every(Boolean)) return false;
    if (f === 'core' && !c.every(Boolean)) return false;
    if (f.startsWith('only:')) { const i = +f.slice(5); if (!c[i] || c.some((x, j) => j !== i && x)) return false; }
    if (f.startsWith('lacks:')) { const i = +f.slice(6); if (c[i] || !c.some(Boolean)) return false; }
    if (state.q) {
      const q = state.q;
      if (!row.label.toLowerCase().includes(q)
        && !row.genes.some((gs) => gs.some((g) => g.symbol.toLowerCase().includes(q) || g.locus.toLowerCase().includes(q)
          || g.product.toLowerCase().includes(q) || g.protein.toLowerCase().includes(q)))) return false;
    }
    return true;
  };

  const subtitle = (row) => {
    const all = row.genes.flat();
    if (state.key === 'product') return [...new Set(all.map((g) => g.symbol).filter(Boolean))].slice(0, 6).join(', ');
    return [...new Set(all.map((g) => g.product || g.name).filter(Boolean))].slice(0, 2).join(' / ');
  };
  const labelHtml = (row) => (state.key === 'protein'
    ? `<a class="mono" href="#/record/protein/${encodeURIComponent(row.key)}">${esc(row.key)}</a>`
    : state.key === 'symbol' ? `<i>${esc(row.label)}</i>` : esc(row.label));

  const draw = () => {
    const rows = content.rows.filter(matches);
    const shown = rows.slice(0, state.shown);
    $('#gene-rows').innerHTML = shown.map((row) => {
      const sub = subtitle(row);
      const max = Math.max(...row.counts);
      return `<tr><th class="gene-label">${labelHtml(row)}${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</th>${row.counts.map((c, i) => {
        if (!c) return '<td class="num absent">—</td>';
        const tags = row.genes[i].map((g) => g.locus || g.protein || `${g.seq}:${g.start}`).filter(Boolean);
        return `<td class="num${c < max ? ' fewer' : ''}" title="${esc(tags.slice(0, 20).join(', ') + (tags.length > 20 ? ` and ${tags.length - 20} more` : ''))}">${fmtN(c)}</td>`;
      }).join('')}</tr>`;
    }).join('') || `<tr><td colspan="${n + 1}" class="muted">No groups match.</td></tr>`;
    $('#gene-more').innerHTML = `<span class="muted">${fmtN(shown.length)} of ${fmtN(rows.length)} groups shown</span>
      ${rows.length > shown.length ? `<button class="btn small" id="gene-more-btn">Show ${fmtN(Math.min(GENE_ROWS_SHOWN, rows.length - shown.length))} more</button>` : ''}`;
    $('#gene-more-btn')?.addEventListener('click', () => { state.shown += GENE_ROWS_SHOWN; draw(); });
  };

  const regroup = () => {
    content = geneContent(lists, state.key);
    state.shown = GENE_ROWS_SHOWN;
    $('#gene-summary').innerHTML = `
      <tr class="group"><th colspan="${n + 1}">Matched by ${esc(GENE_KEYS[state.key].label.toLowerCase())}: ${fmtN(content.core)} groups in every genome</th></tr>
      <tr><th>Groups present</th>${content.summary.map((s) => `<td class="num">${fmtN(s.present)}</td>`).join('')}</tr>
      <tr><th>Only in this genome</th>${content.summary.map((s) => `<td class="num">${fmtN(s.unique)}</td>`).join('')}</tr>
      ${content.unkeyed.some(Boolean) ? `<tr><th>Genes without a ${state.key === 'symbol' ? 'symbol' : 'protein'}</th>${content.unkeyed.map((u) => `<td class="num muted">${fmtN(u)}</td>`).join('')}</tr>` : ''}`;
    const notes = {
      product: 'Genes are grouped by product name, ignoring case. Names differ between annotation pipelines, so compare genomes annotated by the same provider for the cleanest result. Hover a count for locus tags.',
      symbol: 'Only genes with a symbol are grouped; many prokaryote genes have none. Hover a count for locus tags.',
      protein: `Proteins are grouped by accession. RefSeq gives each distinct prokaryote protein sequence one WP_ accession, so a shared WP_ means an identical protein.${notWp.length ? ` ${notWp.join(', ')} ${notWp.length === 1 ? 'uses' : 'use'} other protein accessions, which are never shared between genomes.` : ''}`,
    };
    $('#gene-note').textContent = notes[state.key];
    $$('#gene-key button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === state.key)));
    draw();
  };

  $$('#gene-key button').forEach((b) => b.addEventListener('click', () => { state.key = b.dataset.key; regroup(); }));
  $('#gene-filter').addEventListener('change', (e) => { state.filter = e.target.value; state.shown = GENE_ROWS_SHOWN; draw(); });
  let timer;
  $('#gene-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); state.shown = GENE_ROWS_SHOWN; draw(); }, 200);
  });
  $('#gene-dl').addEventListener('click', () => {
    const rows = content.rows.filter(matches);
    const cell = (v) => String(v ?? '').replace(/[\t\n]/g, ' ');
    const head = ['group', 'symbols_or_products', ...genomes.map((g) => g.acc), ...genomes.map((g) => `${g.acc}_genes`)];
    const lines = rows.map((row) => [row.label, subtitle(row), ...row.counts,
      ...row.genes.map((gs) => gs.map((g) => g.locus || g.protein).join(','))].map(cell).join('\t'));
    const stamp = new Date().toISOString().slice(0, 10);
    saveFile(`gene_content_${state.key}_${n}genomes_${stamp}.tsv`, [head.join('\t'), ...lines].join('\n') + '\n', 'text/tab-separated-values');
  });
  regroup();
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
          <button class="btn primary" id="compare-go">Compare selected</button>
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
    $('#compare-go').addEventListener('click', () => {
      const ids = $$('.sel:checked', rows).map((c) => c.value);
      if (ids.length < 2) return toast('Select two or more genomes to compare.');
      if (ids.length > MAX_COMPARE) return toast(`Pick ${MAX_COMPARE} genomes or fewer to compare.`);
      // The reports are already here; save the compare page from fetching them again.
      for (const r of loaded) if (ids.includes(r.accession) && !genomeCache.has(r.accession)) genomeCache.set(r.accession, Promise.resolve(r));
      location.hash = compareHref(ids);
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
    if (tab === 'map') {
      await renderMap(body, id, safeId, isStale);
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
      const own = { load: async () => ({ text, filename: `${safeId}${suffix}.fasta`, stats: rec ? seqStats(rec.seq, db === 'protein') : '' }) };
      let views = null;
      if (db === 'protein') {
        views = [{ label: 'Protein', ...own }, ...proteinNucleotideViews(id, safeId)];
      } else if (db === 'nuccore' && !doc.properties?.master) {
        const cdsRegion = hasRegion ? { seq_start: Math.min(region.from, region.to), seq_stop: Math.max(region.from, region.to) } : {};
        views = [{ label: 'Nucleotide', ...own }, { label: 'Encoded proteins', load: async () => {
          const aa = await cachedFetch(`nuccore|${id}|cds_aa|${regionKey}`, () => efetch('nuccore', id, 'fasta_cds_aa', cdsRegion));
          const recs = parseFasta(aa);
          if (!recs.length) return { notice: 'No protein-coding sequences are annotated in this record.' };
          const shown = recs.length > 300 ? toFasta(recs.slice(0, 300)) + `\n… ${recs.length - 300} more (the Download button saves all of them)\n` : toFasta(recs);
          return { text: shown, full: toFasta(recs), filename: `${safeId}${suffix}_proteins.fasta`, stats: `${fmtN(recs.length)} proteins, one per annotated CDS` };
        } }];
      }
      if (views) { viewSwitcher(body, views); return; }
      body.innerHTML = `<p class="muted stats">${rec ? seqStats(rec.seq, db === 'protein') : ''}</p>` + textPanelHtml(text, `${safeId}${suffix}.fasta`);
      bindTextPanel(body, text);
      return;
    }
    if (tab === 'features') {
      const ftRegion = hasRegion ? { seq_start: Math.min(region.from, region.to), seq_stop: Math.max(region.from, region.to) } : {};
      const text = await cachedFetch(`${db}|${id}|ft|${regionKey}`, () => efetch(db, id, 'ft', ftRegion));
      if (isStale()) return;
      const offset = hasRegion ? ftRegion.seq_start - 1 : 0;
      renderFeatures(body, db, id, parseFeatureTable(text, offset), isStale, doc.uid);
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

// A readable fact sheet for the protein-side databases, whose raw esummary fields
// (ligcode, speciescount, dispmethod…) mean little on their own.
function proteinFactsHtml(db, doc) {
  const list = (v) => (Array.isArray(v) ? v.join(', ') : v || '');
  const date = (v) => String(v || '').slice(0, 10);
  const n = (v) => (v !== '' && v != null && !Number.isNaN(Number(v)) ? fmtN(v) : '');
  const seqLink = (acc, db2 = 'protein') => (acc ? `<a class="mono" href="#/record/${db2}/${encodeURIComponent(acc)}">${esc(acc)}</a>` : '');
  let intro = '';
  let rows;
  if (db === 'structure') {
    const mols = [['protein', doc.proteinmoleculecount], ['DNA', doc.dnamoleculecount], ['RNA', doc.rnamoleculecount], ['other', doc.othermoleculecount]]
      .filter(([, c]) => Number(c)).map(([t, c]) => `${c} ${t}`).join(', ');
    const ligands = String(doc.ligcode || '').split('|').filter(Boolean);
    rows = [
      ['PDB ID', `<a href="https://www.rcsb.org/structure/${esc(doc.pdbacc)}" target="_blank" rel="noopener">${esc(doc.pdbacc)} ↗</a>`],
      ['Method', esc(doc.expmethod)],
      ['Resolution', doc.resolution ? `${esc(doc.resolution)} Å` : ''],
      ['Classification', esc(doc.pdbclass)],
      ['Organism', esc(list(doc.organismlist))],
      ['EC number', esc(doc.ec)],
      ['Molecules', esc(mols)],
      ['Modified residues', esc([['protein', doc.modproteinrescount], ['DNA', doc.moddnarescount], ['RNA', doc.modrnarescount]]
        .filter(([, c]) => Number(c)).map(([t, c]) => `${c} ${t}`).join(', '))],
      ['Ligands', ligands.length ? `${ligands.map((l) => `<a href="https://www.rcsb.org/ligand/${esc(l)}" target="_blank" rel="noopener">${esc(l)}</a>`).join(' ')} <span class="muted">(${ligands.length} distinct${Number(doc.ligcount) > ligands.length ? `, ${esc(doc.ligcount)} in all` : ''})</span>` : ''],
      ['Deposited', date(doc.pdbdepositdate)],
      ['In MMDB', date(doc.mmdbentrydate)],
      ['Last modified', date(doc.mmdbmodifydate)],
      ['Other IDs', esc(list(doc.pdbaccsynlist))],
    ];
  } else if (db === 'cdd') {
    intro = doc.abstract ? `<p class="prose">${esc(doc.abstract)}</p>` : '';
    rows = [
      ['Accession', esc(doc.accession)],
      ['Name', esc(doc.title)],
      ['Description', esc(doc.subtitle)],
      ['Type', /^cl/.test(doc.accession) ? 'Superfamily (a cluster of related domain models)' : 'Domain model'],
      ['Source', esc(doc.database)],
      ['Organism', esc(doc.organism)],
      ['Model length', doc.pssmlength ? `${esc(doc.pssmlength)} aa` : ''],
      ['Functional sites', n(doc.numbersites) && esc(n(doc.numbersites))],
      ['Site descriptions', esc(list(doc.sitedescriptions))],
      ['Published', date(doc.pubdate)],
      ['Added to Entrez', date(doc.entrezdate)],
    ];
  } else if (db === 'ipg') {
    rows = [
      ['Representative', seqLink(doc.accession)],
      ['Product', esc(doc.title)],
      ['Length', doc.slen ? `${fmtN(doc.slen)} aa` : ''],
      ['Organism', esc(doc.organism)],
      ['Taxonomic group', esc([doc.blastname, doc.div].filter(Boolean).join(' · '))],
      ['Proteins in group', n(doc.proteincount)],
      ['Records (rows)', n(doc.rowcount)],
      ['Assemblies', n(doc.assemblycount)],
      ['Species', n(doc.speciescount)],
      ['Genera', n(doc.generacount)],
      ['Taxa', n(doc.taxidcount)],
      ['Kingdoms', n(doc.kingdomcount)],
      ['Genomes', n(doc.genomecount)],
      ['Group updated', date(doc.modificationdate)],
    ];
  } else if (db === 'protfam') {
    intro = doc.dispdescription?.length ? `<p class="prose">${esc(list(doc.dispdescription))}</p>` : '';
    const go = (doc.dispgotermlist || []).map((t) => (typeof t === 'object' ? Object.values(t).filter((x) => typeof x !== 'object').join(' ') : t));
    rows = [
      ['Family accession', esc(doc.dispfamilyacc)],
      ['Product name', esc(list(doc.dispproductname))],
      ['Gene symbol', esc(list(doc.dispgenesymbol))],
      ['Method', esc(doc.dispmethod)],
      ['Review level', esc(doc.dispreviewlevel)],
      ['GO terms', esc(go.join('; '))],
      ['Updated', date(doc.disppubdate)],
    ];
  } else {
    return '';
  }
  const body = rows.filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  return `${intro}<h3>Details</h3><table class="kv">${body}</table>`;
}

// One record in several forms (protein, coding sequence, mRNA…) behind a switch.
// Each view's `load` runs on first use and returns { text, filename, stats } to show
// as FASTA, or { notice } to explain why that form is not available.
function viewSwitcher(box, views) {
  box.innerHTML = `
    <div class="segmented view-switch" role="group">
      ${views.map((v, i) => `<button data-i="${i}" aria-pressed="${i === 0}">${esc(v.label)}</button>`).join('')}
    </div>
    <div class="view-out"></div>`;
  const out = $('.view-out', box);
  const cache = [];
  let latest = 0;
  const show = async (i) => {
    const mine = ++latest;
    $$('.view-switch button', box).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.i) === i)));
    out.innerHTML = loadingHtml('Fetching from NCBI');
    try {
      cache[i] ||= views[i].load();
      const r = await cache[i];
      if (mine !== latest || !box.isConnected) return;
      if (r.notice) { out.innerHTML = `<div class="notice">${esc(r.notice)}</div>`; return; }
      out.innerHTML = (r.stats ? `<p class="muted stats">${esc(r.stats)}</p>` : '') + textPanelHtml(r.text, r.filename);
      bindTextPanel(out, r.full || r.text);
    } catch (e) {
      cache[i] = null;
      if (mine === latest && box.isConnected) out.innerHTML = errorHtml(e);
    }
  };
  $$('.view-switch button', box).forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.i))));
  show(0);
}

// The nucleotide forms of a protein: its coding sequence, and the whole mRNA when the
// source record is small enough to have been loaded whole.
function proteinNucleotideViews(id, safeId) {
  const cds = async () => {
    const m = await loadProteinMap(id);
    if (m.error) return { notice: m.error };
    const seq = m.dna.slice(m.cdsStart, m.cdsStart + m.protein.length * 3 + (m.hasStop ? 3 : 0));
    return {
      text: toFasta([{ header: `${m.cb.acc} coding sequence for ${id}`, seq }]),
      filename: `${safeId}_cds.fasta`,
      stats: `${fmtN(seq.length)} nt · ${m.protein.length} aa + ${m.hasStop ? 'stop codon' : 'no stop codon in the record'}`,
    };
  };
  const mrna = async () => {
    const m = await loadProteinMap(id);
    if (m.error) return { notice: m.error };
    if (!m.whole) return { notice: `${m.cb.acc} is a large record (a genome or chromosome), so there is no separate mRNA to show. Use Coding sequence, or the Map tab to take a stretch of flanking sequence too.` };
    return {
      text: toFasta([{ header: `${m.cb.acc} (CDS ${m.cb.parts[0].from}..${m.cb.parts[0].to})`, seq: m.dna }]),
      filename: `${m.cb.acc}.fasta`,
      stats: `${fmtN(m.dna.length)} nt · coding sequence at ${fmtN(m.cb.parts[0].from)}..${fmtN(m.cb.parts[0].to)}`,
    };
  };
  return [{ label: 'Coding sequence (CDS)', load: cds }, { label: 'mRNA with UTRs', load: mrna }];
}

// --- Protein <-> nucleotide map ------------------------------------------------

// Sequence kept either side of a gene that sits inside a larger record.
const MAP_FLANK = 3000;
const DOMAIN_COLORS = [200, 30, 140, 280, 340, 60, 170, 250];

// Where a protein sits on the sequence that encodes it. Reads the CDS feature of the
// GenPept record (coded_by), fetches that nucleotide sequence, and returns it with the
// coding start inside it. A small record (an mRNA) comes whole, so the UTRs are there
// to cut from; a large one (a genome) comes as the coding pieces only.
async function loadProteinMap(id, doc) {
  const gp = await cachedFetch(`protein|${id}|gb|all`, () => efetch('protein', id, 'gp'));
  const codedBy = gp.match(/\/coded_by="([^"]*)"/)?.[1];
  if (!codedBy) return { error: 'This protein record does not say which nucleotide sequence encodes it (records from UniProt or PDB do not).' };
  const cb = parseCodedBy(codedBy);
  if (!cb) return { error: `The coding location “${codedBy.replace(/\s+/g, '')}” cannot be placed on one sequence.` };
  const frame = Number(gp.match(/\/codon_start=(\d)/)?.[1] || 1) - 1;

  const fa = await cachedFetch(`protein|${id}|fasta|all`, () => efetch('protein', id, 'fasta'));
  const protein = parseFasta(fa)[0]?.seq || '';
  const regions = proteinRegions(gp);
  const domains = regions.filter((r) => r.cdd);
  const others = regions.filter((r) => !r.cdd);

  let whole = false;
  if (cb.parts.length === 1 && cb.strand === '+') {
    try { whole = Number((await getSummary('nuccore', cb.acc)).slen) <= 100_000; } catch { /* fall back to the coding piece */ }
  }
  let dna;
  let cdsStart;
  // Record coordinate of dna[0] and the direction it runs; null when the pieces of a
  // spliced CDS were joined and no single numbering applies.
  let origin = null;
  let dir = 1;
  let hasFlank = false;
  if (whole) {
    dna = parseFasta(await cachedFetch(`nuccore|${cb.acc}|fasta|all`, () => efetch('nuccore', cb.acc, 'fasta')))[0]?.seq || '';
    cdsStart = cb.parts[0].from - 1 + frame;
    origin = 1;
    hasFlank = true;
  } else if (cb.parts.length === 1) {
    // A gene inside a genome: take the coding piece with some sequence either side, so
    // the map can be moved over the neighbourhood.
    const q = cb.parts[0];
    let recLen = Infinity;
    try { recLen = Number((await getSummary('nuccore', cb.acc)).slen) || Infinity; } catch { /* no clamp */ }
    const a = Math.max(1, q.from - MAP_FLANK);
    const b = Math.min(recLen, q.to + MAP_FLANK);
    dna = parseFasta(await cachedFetch(`nuccore|${cb.acc}|fasta|${a}-${b}-${cb.strand}`,
      () => efetch('nuccore', cb.acc, 'fasta', { seq_start: a, seq_stop: b, strand: cb.strand === '-' ? 2 : 1 })))[0]?.seq || '';
    if (cb.strand === '-') { cdsStart = b - q.to + frame; origin = b; dir = -1; } else { cdsStart = q.from - a + frame; origin = a; }
    hasFlank = true;
  } else {
    const pieces = await Promise.all(cb.parts.map((q) => cachedFetch(`nuccore|${cb.acc}|fasta|${q.from}-${q.to}-${cb.strand}`,
      () => efetch('nuccore', cb.acc, 'fasta', { seq_start: q.from, seq_stop: q.to, strand: cb.strand === '-' ? 2 : 1 }))));
    dna = pieces.map((t) => parseFasta(t)[0]?.seq || '').join('');
    cdsStart = frame;
  }
  const coding = dna.slice(cdsStart, cdsStart + protein.length * 3 + 3);
  const table = Number(gp.match(/\/transl_table=(\d+)/)?.[1] || 1);
  const translated = translateDna(coding).replace(/\*$/, '');
  // A GTG or TTG start is still translated as M in the protein, so skip the first residue.
  let mismatches = 0;
  for (let i = 1; i < protein.length; i++) if (translated[i] !== protein[i] && protein[i] !== 'X') mismatches++;
  return {
    protein, domains, others, dna, cdsStart, cb, whole, table, mismatches, origin, dir, hasFlank,
    hasStop: /^(TAA|TAG|TGA)$/i.test(dna.slice(cdsStart + protein.length * 3, cdsStart + protein.length * 3 + 3)),
    checked: dna.length >= cdsStart + protein.length * 3 && table !== 4 && !/^(2|3|5|9|13|14|16|21|22|23|24|25)$/.test(String(table)),
  };
}

async function renderMap(body, id, safeId, isStale) {
  let m;
  try {
    m = await loadProteinMap(id);
  } catch (e) {
    if (!isStale()) body.innerHTML = errorHtml(e);
    return;
  }
  if (isStale()) return;
  if (m.error) { body.innerHTML = `<div class="notice">${esc(m.error)}</div>`; return; }

  const { protein, domains, others, dna, cdsStart, cb } = m;
  const L = protein.length;
  // Record coordinates of dna[lo, hi) as "a-b", lowest first, or coding-relative when the
  // CDS was joined from several pieces and the record has no single numbering.
  const coords = (lo, hi) => (m.origin == null
    ? `${lo - cdsStart + 1}-${hi - cdsStart}`
    : m.dir > 0 ? `${m.origin + lo}-${m.origin + hi - 1}` : `${m.origin - (hi - 1)}-${m.origin - lo}`);
  const strandNote = cb.strand === '-' ? ', reverse complement' : '';
  const sel = { from: 1, to: L, flank: 0, unit: 'nt', stop: false };
  // Extension in nucleotides, whichever unit was chosen; in aa the protein grows by whole residues too.
  const flankAa = () => (sel.unit === 'aa' ? sel.flank : 0);

  body.innerHTML = `
    <p class="muted stats">${esc(id)} · ${fmtN(L)} aa, encoded by
      <a href="#/record/nuccore/${encodeURIComponent(cb.acc)}">${esc(cb.acc)}</a>
      at ${cb.parts.map((q) => `${fmtN(q.from)}..${fmtN(q.to)}`).join(', ')}
      (${cb.strand === '-' ? 'minus' : 'plus'} strand${cb.parts.length > 1 ? `, ${cb.parts.length} exons joined` : ''}).
      ${m.whole ? `The whole ${fmtN(dna.length)} nt record is loaded.`
        : m.hasFlank ? `The source record is large, so ${fmtN(MAP_FLANK)} nt either side of the gene is loaded${cb.strand === '-' ? ', read as the reverse complement so the gene runs left to right' : ''}.`
        : 'Only the coding sequence is shown; the source record is too large to show whole.'}</p>
    ${m.checked && m.mismatches > Math.max(2, L * 0.02)
      ? `<div class="notice">Translating this sequence gives ${m.mismatches} residues that differ from the protein. The genetic code or the coding location may not match, so check before ordering anything.</div>` : ''}
    <div class="map-toolbar" id="map-toolbar">
      <button class="btn small" data-v="left" title="Move left (←)" aria-label="Move left">◀</button>
      <button class="btn small" data-v="right" title="Move right (→)" aria-label="Move right">▶</button>
      <button class="btn small" data-v="out" title="Zoom out (−)" aria-label="Zoom out">−</button>
      <button class="btn small" data-v="in" title="Zoom in (+)" aria-label="Zoom in">+</button>
      <button class="btn small" data-v="sel" title="Zoom to the selection">Zoom to selection</button>
      <button class="btn small" data-v="reset" title="Show the whole sequence">Reset</button>
      <span class="muted small" id="map-view"></span>
      <span class="muted small map-hint">⌘/Ctrl + scroll or pinch zooms at the pointer · scroll sideways or drag the nucleotide bar to move · drag the protein bar to select · right-drag zooms to a region</span>
    </div>
    <div id="map-svg" class="map-wrap"></div>
    <div class="panel-actions whole-actions">
      <b>Whole ${esc(id)}:</b>
      ${m.whole ? '<button class="btn small" data-whole="rec">mRNA with UTRs</button>' : ''}
      <button class="btn small" data-whole="cds">Coding sequence (CDS)</button>
      <button class="btn small" data-whole="aa">Protein</button>
    </div>
    <form class="map-controls" id="map-form">
      <label>From aa <input name="from" type="number" min="1" max="${L}" value="1"></label>
      <label>to aa <input name="to" type="number" min="1" max="${L}" value="${L}"></label>
      <label>Extend each end by <input name="flank" type="number" min="0" max="2000" value="0"></label>
      <label>unit <select name="unit"><option value="nt">nt</option><option value="aa">aa</option></select></label>
      <label class="check"><input type="checkbox" name="stop"> include stop codon</label>
      <button class="btn small" type="button" data-act="all">Whole protein</button>
    </form>
    <div id="map-out"></div>
    <h3>Domains</h3>
    <div id="map-domains"></div>`;

  const W = 900;
  const MIN_VIEW = 12; // nt; close enough to read every base
  const ntOf = (aa) => cdsStart + (aa - 1) * 3; // dna index where residue aa starts
  const clampAa = (n) => Math.max(1, Math.min(L, Math.round(n) || 1));
  const overview = () => (m.hasFlank
    ? { s: 0, e: dna.length }
    : { s: 0, e: L * 3 + (m.hasStop ? 3 : 0) });
  let view = overview();
  const span = () => view.e - view.s;
  const x = (nt) => ((nt - view.s) / span()) * W;

  // Lay overlapping domains on separate rows.
  const lanes = [];
  const placed = domains.map((d, i) => {
    let lane = lanes.findIndex((end) => end < d.from);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = d.to;
    return { ...d, lane, hue: DOMAIN_COLORS[i % DOMAIN_COLORS.length] };
  });

  const niceStep = (range, want) => {
    const raw = Math.max(1e-9, range / want);
    const pow = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((k) => k * pow).find((v) => v >= raw) || raw;
  };

  const nuY = 38;
  const proY = 38 + 78;
  const laneH = 22;
  const H = proY + 26 + Math.max(1, lanes.length) * laneH + 28;
  const svgHost = $('#map-svg', body);
  svgHost.innerHTML = `<svg viewBox="0 0 ${W + 20} ${H}" class="map-svg" tabindex="0" role="img" aria-label="Map of ${esc(id)} on ${esc(cb.acc)}">
    <defs><clipPath id="map-clip"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>
    <g transform="translate(10,0)" id="map-g"></g></svg>`;
  const svgEl = $('svg', svgHost);
  const gEl = $('#map-g', svgEl);

  const setView = (s0, e0) => {
    const full = dna.length;
    const lo = m.hasFlank ? 0 : overview().s;
    const hi = m.hasFlank ? full : overview().e;
    let len = Math.max(MIN_VIEW, Math.min(hi - lo, e0 - s0));
    let a = s0;
    if (a < lo) a = lo;
    if (a + len > hi) a = hi - len;
    view = { s: a, e: a + len };
    drawMap();
  };
  const zoomAt = (factor, anchorNt) => {
    const len = Math.max(MIN_VIEW, span() * factor);
    const frac = (anchorNt - view.s) / span();
    setView(anchorNt - frac * len, anchorNt - frac * len + len);
  };
  const pan = (nt) => setView(view.s + nt, view.e + nt);

  const drawMap = () => {
    const sp = span();
    const px = W / sp; // pixels per nt
    const showBases = px >= 6.5;
    const showResidues = px * 3 >= 11;
    const first = Math.max(0, Math.floor(view.s));
    const last = Math.min(dna.length, Math.ceil(view.e));
    const cdsEnd = cdsStart + L * 3 + (m.hasStop ? 3 : 0);
    const ext = selection();
    const a0 = x(ext.lo);
    const a1 = x(ext.hi);
    const dnaBar = m.hasFlank ? { s: 0, e: dna.length } : { s: 0, e: cdsEnd };
    let g = '<g clip-path="url(#map-clip)">';

    // Nucleotide track
    g += `<text class="map-label" x="0" y="14">Nucleotide · ${esc(cb.acc)}${cb.strand === '-' && m.hasFlank ? ' (reverse complement)' : ''}</text>`;
    g += `<rect x="${x(dnaBar.s)}" y="${nuY}" width="${x(dnaBar.e) - x(dnaBar.s)}" height="16" class="map-utr"/>`;
    g += `<rect x="${x(cdsStart)}" y="${nuY}" width="${Math.max(1, x(cdsEnd) - x(cdsStart))}" height="16" class="map-cds"/>`;
    const nStep = niceStep(sp, 9);
    const tickLabel = (i) => (m.origin == null ? i - cdsStart + 1 : m.origin + m.dir * i);
    for (let n = Math.ceil(view.s / nStep) * nStep; n <= view.e; n += nStep) {
      g += `<line x1="${x(n)}" x2="${x(n)}" y1="${nuY - 4}" y2="${nuY}" class="map-tick"/><text class="map-tl" x="${x(n)}" y="${nuY - 7}" text-anchor="middle">${fmtN(tickLabel(n))}</text>`;
    }
    if (showBases) {
      for (let i = first; i < last; i++) {
        const inCds = i >= cdsStart && i < cdsEnd;
        g += `<text class="map-base${inCds ? ' in-cds' : ''}" x="${x(i + 0.5)}" y="${nuY + 12.5}" text-anchor="middle">${dna[i]}</text>`;
      }
    }

    // Protein track
    g += `<text class="map-label" x="0" y="${proY - 14}">Protein · ${fmtN(L)} aa</text>`;
    g += `<rect x="${x(cdsStart)}" y="${proY}" width="${x(cdsStart + L * 3) - x(cdsStart)}" height="16" class="map-prot" id="map-prot"/>`;
    const aaPer = 1 / 3;
    const aStep = Math.max(1, Math.round(niceStep(sp * aaPer, 9)));
    const aaFirst = Math.max(0, Math.ceil((view.s - cdsStart) / 3 / aStep) * aStep);
    for (let a = aaFirst; a <= L && cdsStart + a * 3 <= view.e; a += aStep) {
      const tx = x(cdsStart + a * 3);
      g += `<line x1="${tx}" x2="${tx}" y1="${proY + 16}" y2="${proY + 20}" class="map-tick"/><text class="map-tl" x="${tx}" y="${proY + 30}" text-anchor="middle">${a || 1}</text>`;
    }
    if (showResidues) {
      const aFrom = Math.max(1, Math.floor((view.s - cdsStart) / 3) + 1);
      const aTo = Math.min(L, Math.ceil((view.e - cdsStart) / 3));
      for (let a = aFrom; a <= aTo; a++) {
        g += `<text class="map-aa" x="${x(ntOf(a) + 1.5)}" y="${proY + 12.5}" text-anchor="middle">${protein[a - 1]}</text>`;
      }
    }
    for (const d of placed) {
      const dx = x(cdsStart + (d.from - 1) * 3);
      const dw = Math.max(2, x(cdsStart + d.to * 3) - dx);
      if (dx > W || dx + dw < 0) continue;
      const dy = proY + 36 + d.lane * laneH;
      const lx = Math.max(dx, 0) + 4;
      g += `<g class="map-dom" data-from="${d.from}" data-to="${d.to}" tabindex="0" role="button" aria-label="Select ${esc(d.name)}">
        <rect x="${dx}" y="${dy}" width="${dw}" height="${laneH - 4}" rx="3" style="fill:hsl(${d.hue} 60% 72%);stroke:hsl(${d.hue} 50% 40%)"/>
        ${dx + dw - lx > 50 ? `<text x="${lx}" y="${dy + 12}" class="map-dl">${esc(d.name)}</text>` : ''}
        <title>${esc(d.name)} · aa ${d.from}–${d.to}</title></g>`;
    }

    // Selection, joined across both tracks
    g += `<polygon class="map-link" points="${a0},${nuY + 16} ${a1},${nuY + 16} ${a1},${proY} ${a0},${proY}"/>`;
    g += `<rect class="map-sel" x="${a0}" y="${nuY}" width="${Math.max(1.5, a1 - a0)}" height="16"/>`;
    g += `<rect class="map-sel" x="${a0}" y="${proY}" width="${Math.max(1.5, a1 - a0)}" height="16"/>`;
    if (zoomDrag) {
      const za = x(Math.min(zoomDrag.a, zoomDrag.b));
      const zb = x(Math.max(zoomDrag.a, zoomDrag.b));
      g += `<rect class="map-zoombox" x="${za}" y="${nuY - 20}" width="${Math.max(1, zb - za)}" height="${H - nuY}"/>`;
    }
    g += '</g>';
    gEl.innerHTML = g;

    $('#map-view', body).textContent = `${m.origin == null ? 'coding nt' : 'nt'} ${fmtN(Math.round(tickLabel(Math.max(0, view.s))))}–${fmtN(Math.round(tickLabel(Math.min(dna.length - 1, view.e - 1))))} · ${fmtN(Math.round(sp))} nt shown`
      + (showBases ? '' : px >= 3 ? ' · zoom in further to read the bases' : '');
    $('[data-v="in"]', body).disabled = sp <= MIN_VIEW;
    $('[data-v="out"]', body).disabled = sp >= overview().e - overview().s - 0.5;
    $('[data-v="left"]', body).disabled = view.s <= (m.hasFlank ? 0 : overview().s);
    $('[data-v="right"]', body).disabled = view.e >= (m.hasFlank ? dna.length : overview().e);
  };

  // --- Pointer handling, bound once on the persistent svg ------------------------
  let zoomDrag = null;
  const ntAtClient = (ev) => {
    const r = svgEl.getBoundingClientRect();
    return view.s + (((ev.clientX - r.left) / r.width * (W + 20) - 10) / W) * span();
  };
  const yAtClient = (ev) => {
    const r = svgEl.getBoundingClientRect();
    return (ev.clientY - r.top) / r.height * H;
  };
  const aaAt = (ev) => clampAa((ntAtClient(ev) - cdsStart) / 3 + 0.5);

  // Scrolling the page must keep working, so only ⌘/Ctrl + wheel (and pinch, which the
  // browser reports the same way) zooms; sideways scrolling moves the view.
  svgEl.addEventListener('wheel', (ev) => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      zoomAt(Math.exp(ev.deltaY * 0.01), ntAtClient(ev));
    } else if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || ev.shiftKey) {
      ev.preventDefault();
      pan(((ev.deltaX || ev.deltaY) / W) * span());
    }
  }, { passive: false });
  svgEl.addEventListener('contextmenu', (ev) => ev.preventDefault());

  let gesture = null;
  svgEl.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('.map-dom')) return;
    svgEl.setPointerCapture(ev.pointerId);
    if (ev.button === 2) {
      const n = ntAtClient(ev);
      gesture = { kind: 'zoom' };
      zoomDrag = { a: n, b: n };
    } else if (ev.button === 0 && Math.abs(yAtClient(ev) - (proY + 8)) <= 14) {
      gesture = { kind: 'select', anchor: aaAt(ev) };
      setSel(gesture.anchor, gesture.anchor);
    } else if (ev.button === 0) {
      gesture = { kind: 'pan', lastX: ev.clientX };
      svgEl.classList.add('grabbing');
    }
  });
  svgEl.addEventListener('pointermove', (ev) => {
    if (!gesture) return;
    if (gesture.kind === 'select') {
      const here = aaAt(ev);
      setSel(Math.min(gesture.anchor, here), Math.max(gesture.anchor, here));
    } else if (gesture.kind === 'pan') {
      const r = svgEl.getBoundingClientRect();
      pan(-((ev.clientX - gesture.lastX) / r.width * (W + 20) / W) * span());
      gesture.lastX = ev.clientX;
    } else if (gesture.kind === 'zoom') {
      zoomDrag.b = ntAtClient(ev);
      drawMap();
    }
  });
  const endGesture = () => {
    if (gesture?.kind === 'zoom' && zoomDrag) {
      const lo = Math.min(zoomDrag.a, zoomDrag.b);
      const hi = Math.max(zoomDrag.a, zoomDrag.b);
      zoomDrag = null;
      if (hi - lo >= 3) setView(lo, hi); else drawMap();
    }
    gesture = null;
    svgEl.classList.remove('grabbing');
  };
  svgEl.addEventListener('pointerup', endGesture);
  svgEl.addEventListener('pointercancel', endGesture);
  svgEl.addEventListener('click', (ev) => {
    const dom = ev.target.closest('.map-dom');
    if (dom) setSel(Number(dom.dataset.from), Number(dom.dataset.to));
  });
  svgEl.addEventListener('keydown', (ev) => {
    const dom = ev.target.closest?.('.map-dom');
    if (dom && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); setSel(Number(dom.dataset.from), Number(dom.dataset.to)); return; }
    const mid = (view.s + view.e) / 2;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); pan(-span() * 0.2); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); pan(span() * 0.2); }
    else if (ev.key === '+' || ev.key === '=') zoomAt(1 / 2, mid);
    else if (ev.key === '-') zoomAt(2, mid);
    else if (ev.key === '0') setView(overview().s, overview().e);
  });

  $('#map-toolbar', body).addEventListener('click', (ev) => {
    const v = ev.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    const mid = (view.s + view.e) / 2;
    if (v === 'left') pan(-span() * 0.5);
    else if (v === 'right') pan(span() * 0.5);
    else if (v === 'in') zoomAt(1 / 2.5, mid);
    else if (v === 'out') zoomAt(2.5, mid);
    else if (v === 'reset') setView(overview().s, overview().e);
    else if (v === 'sel') {
      const { lo, hi } = selection();
      const pad = Math.max(6, (hi - lo) * 0.08);
      setView(lo - pad, hi + pad);
    }
  });

  // A range with the chosen extension: whole residues (and their codons) when the unit
  // is aa, extra bases either side when it is nt. Residues stop at the protein's ends.
  const extend = (from, to, stop = false) => {
    const aFrom = Math.max(1, from - flankAa());
    const aTo = Math.min(L, to + flankAa());
    const lo = Math.max(0, ntOf(aFrom) - (sel.unit === 'nt' ? sel.flank : 0));
    const hi = Math.min(dna.length, ntOf(aTo) + 3 + (stop ? 3 : 0) + (sel.unit === 'nt' ? sel.flank : 0));
    return { aFrom, aTo, lo, hi, nt: dna.slice(lo, hi), aa: protein.slice(aFrom - 1, aTo) };
  };
  const selection = () => extend(sel.from, sel.to, sel.stop && sel.to === L && m.hasStop);
  const flankText = () => (sel.flank ? `${fmtN(sel.flank)} ${sel.unit}` : '');

  const drawOut = () => {
    const { nt, lo, hi, aa, aFrom, aTo } = selection();
    const range = `${aFrom}–${aTo}`;
    const ntRange = m.origin != null ? `${coords(lo, hi).replace('-', '–')} of ${esc(cb.acc)}` : `${fmtN(lo - cdsStart + 1)}–${fmtN(hi - cdsStart)} of the coding sequence`;
    // Codons beneath their residues, in rows of 20.
    let grid = '';
    if (aa.length <= 900) {
      const first = ntOf(aFrom);
      for (let i = 0; i < aa.length; i += 20) {
        const chunk = aa.slice(i, i + 20);
        const codons = [...chunk].map((_, k) => dna.slice(first + (i + k) * 3, first + (i + k) * 3 + 3));
        grid += `<div class="cg-row"><span class="cg-n">${aFrom + i}</span><span class="cg-seq">`
          + `<span class="cg-aa">${[...chunk].map((c) => ` ${c} `).join('')}</span>\n`
          + `<span class="cg-nt">${codons.join('')}</span></span></div>`;
      }
    } else {
      grid = '<p class="muted">The codon view is shown for up to 900 residues; the downloads still cover the whole selection.</p>';
    }
    $('#map-out', body).innerHTML = `
      <div class="map-summary">
        <b>aa ${range}</b> (${fmtN(aa.length)} aa) ↔ <b>nt ${ntRange}</b> (${fmtN(nt.length)} nt${sel.flank ? `; selection ${sel.from}–${sel.to} extended by ${flankText()} each end` : ''})
      </div>
      <div class="panel-actions">
        <button class="btn small" data-act="copy-nt">Copy nucleotides</button>
        <button class="btn small" data-act="save-nt">Download nucleotide FASTA</button>
        <button class="btn small" data-act="copy-aa">Copy protein</button>
        <button class="btn small" data-act="save-aa">Download protein FASTA</button>
        <button class="btn small" data-act="save-both">Download both</button>
        <button class="btn small" data-act="save-cds">Whole coding sequence</button>
        ${m.whole ? '<button class="btn small" data-act="save-rec">Whole mRNA record</button>' : ''}
      </div>
      <div class="codon-grid">${grid}</div>`;
    const ntHeader = `${cb.acc}:${coords(lo, hi)} (coding sequence for ${id} aa ${range}${strandNote})`;
    const aaHeader = `${id}:${range} aa`;
    const ntFa = toFasta([{ header: ntHeader, seq: nt }]);
    const aaFa = toFasta([{ header: aaHeader, seq: aa }]);
    const act = (name, fn) => $(`[data-act="${name}"]`, body)?.addEventListener('click', fn);
    const tag = `${safeId}_${aFrom}-${aTo}`;
    act('copy-nt', () => copyText(nt));
    act('copy-aa', () => copyText(aa));
    act('save-nt', () => saveFile(`${tag}_nt.fasta`, ntFa));
    act('save-aa', () => saveFile(`${tag}_aa.fasta`, aaFa));
    act('save-both', () => saveFile(`${tag}_nt_aa.fasta`, ntFa + aaFa));
    act('save-cds', () => saveFile(`${safeId}_cds.fasta`, toFasta([{ header: `${cb.acc} coding sequence for ${id}`, seq: dna.slice(cdsStart, cdsStart + L * 3 + (m.hasStop ? 3 : 0)) }])));
    act('save-rec', () => saveFile(`${cb.acc}.fasta`, toFasta([{ header: cb.acc, seq: dna }])));
  };

  // One domain (or any aa range) as nucleotide and protein FASTA records. The flank
  // setting applies, so a domain can be cut with a few bases of context.
  const rangeRecords = (from, to, name) => {
    const e = extend(from, to);
    const note = sel.flank ? `, extended by ${flankText()}` : '';
    return {
      nt: { header: `${cb.acc}:${coords(e.lo, e.hi)} ${name} (${id} aa ${e.aFrom}-${e.aTo}${note}${strandNote})`, seq: e.nt },
      aa: { header: `${id}:${e.aFrom}-${e.aTo} ${name}${note}`, seq: e.aa },
    };
  };
  const slug = (t) => t.replace(/[^\w.-]+/g, '_').slice(0, 40);

  const otherRegions = others.map((r) => ({ ...r, hue: 215 }));
  const allRows = [...placed, ...otherRegions];
  const regionRow = (d) => `<tr>
        <td><span class="swatch" style="background:hsl(${d.hue} 60% 72%);border-color:hsl(${d.hue} 50% 40%)"></span>
          ${d.cdd ? `<a href="#/record/cdd/${esc(d.cdd)}">${esc(d.name)}</a>` : esc(d.name)}${d.cdd && d.note && d.note !== d.name ? `<div class="muted small">${esc(d.note)}</div>` : ''}</td>
        <td class="num">aa ${d.from}–${d.to}</td>
        <td class="num muted">${fmtN((d.to - d.from + 1) * 3)} nt</td>
        <td class="dom-actions">
          <button class="btn small" data-from="${d.from}" data-to="${d.to}">Select</button>
          <button class="btn small" data-dl="nt" data-i="${allRows.indexOf(d)}">nt FASTA</button>
          <button class="btn small" data-dl="aa" data-i="${allRows.indexOf(d)}">aa FASTA</button>
        </td></tr>`;

  const drawDomains = () => {
    $('#map-domains', body).innerHTML = (placed.length ? `
      <table class="kv"><tbody>${placed.map(regionRow).join('')}</tbody></table>
      <div class="panel-actions">
        <button class="btn small" data-all="nt">All domains: nucleotide FASTA</button>
        <button class="btn small" data-all="aa">All domains: protein FASTA</button>
        <button class="btn small" data-all="both">All domains: both</button>
      </div>` : '<p class="muted">NCBI assigns no conserved domains to this protein.</p>')
      + (otherRegions.length ? `
      <details class="other-regions"${placed.length ? '' : ' open'}><summary>Other annotated regions (${otherRegions.length}) — functional regions from UniProt, such as hinge or activation function segments</summary>
        <table class="kv"><tbody>${otherRegions.map(regionRow).join('')}</tbody></table></details>` : '');
    $$('#map-domains [data-dl]', body).forEach((b) => b.addEventListener('click', () => {
      const d = allRows[Number(b.dataset.i)];
      const r = rangeRecords(d.from, d.to, d.name)[b.dataset.dl];
      saveFile(`${safeId}_${slug(d.name)}_${d.from}-${d.to}_${b.dataset.dl}.fasta`, toFasta([r]));
    }));
    $$('#map-domains [data-all]', body).forEach((b) => b.addEventListener('click', () => {
      const recs = placed.map((d) => rangeRecords(d.from, d.to, d.name));
      const kind = b.dataset.all;
      const list = kind === 'both' ? recs.flatMap((r) => [r.nt, r.aa]) : recs.map((r) => r[kind]);
      saveFile(`${safeId}_domains_${kind}.fasta`, toFasta(list));
    }));
    $$('#map-domains [data-from]', body).forEach((b) =>
      b.addEventListener('click', () => { setSel(Number(b.dataset.from), Number(b.dataset.to)); window.scrollTo({ top: body.offsetTop - 60, behavior: 'smooth' }); }));
  };

  $$('[data-whole]', body).forEach((b) => b.addEventListener('click', () => {
    const end = cdsStart + L * 3 + (m.hasStop ? 3 : 0);
    const files = {
      rec: [`${cb.acc}.fasta`, { header: `${cb.acc} (mRNA, CDS at ${cb.parts[0].from}..${cb.parts[0].to})`, seq: dna }],
      cds: [`${safeId}_cds.fasta`, { header: `${cb.acc} coding sequence for ${id}`, seq: dna.slice(cdsStart, end) }],
      aa: [`${safeId}.fasta`, { header: `${id} ${L} aa`, seq: protein }],
    };
    const [name, rec] = files[b.dataset.whole];
    saveFile(name, toFasta([rec]));
  }));

  const form = $('#map-form', body);
  function setSel(from, to) {
    sel.from = clampAa(from);
    sel.to = Math.max(sel.from, clampAa(to));
    form.elements.from.value = sel.from;
    form.elements.to.value = sel.to;
    drawMap();
    drawOut();
  }
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', () => {
    sel.from = clampAa(form.elements.from.value);
    sel.to = Math.max(sel.from, clampAa(form.elements.to.value));
    sel.flank = Math.max(0, Math.min(2000, Number(form.elements.flank.value) || 0));
    sel.unit = form.elements.unit.value;
    sel.stop = form.elements.stop.checked;
    drawMap();
    drawOut();
  });
  $('[data-act="all"]', form).addEventListener('click', () => setSel(1, L));

  drawMap();
  drawOut();
  drawDomains();
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
  const facts = proteinFactsHtml(db, doc);
  if (facts) return `${extra}${facts}`;
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

function renderFeatures(body, db, id, features, isStale = () => false, uid = '') {
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
    <div id="ft-domain"></div>
    <div class="table-wrap"><table class="features"><thead><tr>
      <th>Type</th><th>Location</th><th>Gene / locus</th><th>Product / note</th><th></th>
    </tr></thead><tbody></tbody></table></div>`;

  const tbody = $('tbody', body);
  // Set once a conserved domain has been picked. It replaces the text filter rather
  // than narrowing it: the point of the domain search is that the text matched nothing.
  let domainWant = null;
  const draw = () => {
    const type = $('#ft-type').value;
    const needle = $('#ft-filter').value.trim().toLowerCase();
    const rows = domainWant
      ? visible.filter((f) => domainWant.has(cleanSeqId(qv(f, 'protein_id'))))
      : visible.filter((f) => (!type || f.type === type)
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
          ${protein ? `<br><a href="#/record/protein/${encodeURIComponent(cleanSeqId(protein))}">${esc(cleanSeqId(protein))}</a> · <a href="#/record/protein/${encodeURIComponent(cleanSeqId(protein))}?tab=map">map</a>` : ''}
          ${geneId ? ` <a href="#/record/gene/${geneId}">Gene ${esc(geneId)}</a>` : ''}</td>
        <td class="actions"><button class="btn small" data-feature="${idx}">Sequence</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No features match.</td></tr>';
    $$('[data-feature]', tbody).forEach((b) => b.addEventListener('click', () => showFeatureSequence(db, id, features[Number(b.dataset.feature)], features)));
    if (domainWant) return;
    if (needle && !rows.length && canSearchDomains) domains.offer(needle);
    else domains.clear();
  };

  // Domains are looked up through the proteins of a nucleotide record, so the offer
  // only makes sense there.
  const canSearchDomains = db === 'nuccore' && uid;
  const domains = domainFinder({
    box: $('#ft-domain', body),
    uid,
    isStale,
    apply: (want) => {
      // Nothing found: leave the table as it was rather than emptying it.
      domainWant = want.size ? want : null;
      draw();
      const rows = visible.filter((f) => want.has(cleanSeqId(qv(f, 'protein_id'))));
      return {
        shown: rows.length,
        names: [...new Set(rows.map((f) => qv(f, 'product')).filter(Boolean))],
      };
    },
    reset: () => { domainWant = null; },
  });
  $('#ft-type').addEventListener('change', () => { domainWant = null; draw(); });
  $('#ft-filter').addEventListener('input', () => { domainWant = null; draw(); });
  draw();
}

async function showFeatureSequence(db, id, f, features = []) {
  const qv = (k) => f.q[k]?.[0] || '';
  const name = qv('gene') || qv('locus_tag') || f.type;
  const title = `${name}${qv('product') ? ' ' + qv('product') : ''}`;
  const safe = name.replace(/[^\w.-]/g, '_');
  openModal(`${name} · ${f.type}`, '<div id="feature-views"></div>');

  const views = [];
  if (db === 'protein') {
    // A protein feature is a stretch of residues; the nucleotides behind it come from the coding sequence.
    views.push({ label: 'Protein', load: async () => {
      let seq = '';
      for (const p of f.parts.slice(0, 50)) seq += parseFasta(await efetch(db, id, 'fasta', { seq_start: p.from, seq_stop: p.to }))[0]?.seq || '';
      return { text: toFasta([{ header: `${id}:${f.location} ${title}`, seq }]), filename: `${safe}_aa.fasta`, stats: `${seqStats(seq, true)} · ${f.location}` };
    } });
    views.push({ label: 'Nucleotide', load: async () => {
      const m = await loadProteinMap(id);
      if (m.error) return { notice: m.error };
      const seq = f.parts.map((p) => m.dna.slice(m.cdsStart + (p.from - 1) * 3, m.cdsStart + p.to * 3)).join('');
      return { text: toFasta([{ header: `${m.cb.acc} coding sequence for ${id}:${f.location} ${title}`, seq }]), filename: `${safe}_nt.fasta`, stats: `${fmtN(seq.length)} nt · ${f.location}` };
    } });
  } else {
    views.push({ label: 'Nucleotide', load: async () => {
      // The feature table lists intervals in transcript order, so fetching each one on the
      // feature's strand and joining them gives the right spliced sequence.
      let seq = '';
      for (const p of f.parts.slice(0, 50)) {
        const strand = db === 'nuccore' ? (f.strand === '-' ? 2 : 1) : undefined;
        seq += parseFasta(await efetch(db, id, 'fasta', { seq_start: p.from, seq_stop: p.to, strand }))[0]?.seq || '';
      }
      return { text: toFasta([{ header: `${id}:${f.location} ${title}`, seq }]), filename: `${safe}.fasta`, stats: `${seqStats(seq, false)} · ${f.location}` };
    } });
    if (db === 'nuccore') {
      // The CDS itself, or for a gene / mRNA the CDS entries of the same locus inside it.
      const key = (g) => g.q.locus_tag?.[0] || g.q.gene?.[0] || '';
      const cds = f.type === 'CDS' ? [f]
        : key(f) ? features.filter((c) => c.type === 'CDS' && c.q.protein_id && key(c) === key(f) && c.lo >= f.lo && c.hi <= f.hi && c.strand === f.strand) : [];
      const ids = [...new Set(cds.map((c) => cleanSeqId(c.q.protein_id?.[0] || '')).filter(Boolean))].slice(0, 20);
      if (ids.length) {
        views.push({ label: ids.length > 1 ? `Proteins (${ids.length})` : 'Protein', load: async () => {
          const text = await efetch('protein', ids, 'fasta');
          return { text, filename: `${safe}_aa.fasta`, stats: ids.map((p) => `${p}`).join(', ') };
        } });
      }
    }
  }
  viewSwitcher($('#feature-views'), views);
}

// "lcl|NZ_CP027720.1_cds_WP_041989327.1_2 [locus_tag=...] [protein_id=WP_041989327.1] ..."
const cdsProteinId = (header) => header.match(/\[protein_id=([^\]]+)\]/)?.[1] || '';

// A name search found nothing. Annotation text is the weakest thing about a record,
// so offer the sequence-derived answer instead: domains whose name matches, then the
// proteins of this record that carry the one you pick. Both the CDS and the Features
// tab use this; they differ only in what `apply` does with the accessions it is given,
// and each returns the names its own rows show so the box can report them back.
function domainFinder({ box, uid, isStale, apply, reset }) {
  const search = async (needle) => {
    if (reset) reset();
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
          <p>Conserved domains matching “${esc(needle)}”. This searches text, so a domain can match
          because its description merely mentions the gene — read the definition, and prefer a gene-level
          <code>COG</code>, <code>TIGR</code> or <code>PRK</code> model over a <code>cl</code> superfamily.</p>
          <ul class="link-list domains">
            ${domains.map((d) => `
              <li><button class="domain-pick" data-cdd="${esc(d.uid)}" data-label="${esc(d.accession)} · ${esc(d.title)}">
                <b>${esc(d.accession)} · ${esc(d.title)}</b>
                ${d.definition ? `<span class="muted">${esc(d.definition)}</span>` : ''}
              </button></li>`).join('')}
          </ul>
        </div>`;
      $$('[data-cdd]', box).forEach((b) =>
        b.addEventListener('click', () => run(b.dataset.cdd, b.dataset.label, needle)));
    } catch (e) {
      if (!isStale()) box.innerHTML = errorHtml(e);
    }
  };

  const run = async (cddUid, label, needle) => {
    box.innerHTML = loadingHtml(`Finding proteins with ${label}`);
    try {
      const prots = await proteinsWithDomain(uid, cddUid);
      if (isStale()) return;
      const { shown, names } = apply(new Set(prots.map((p) => p.accession)), label);
      // No hit here is weak evidence: NCBI has not computed a domain assignment for
      // every protein, so the gene can be present and still not be found this way.
      box.innerHTML = prots.length ? `
        <div class="notice">
          <b>${esc(label)}</b> — ${fmtN(prots.length)} protein${prots.length === 1 ? '' : 's'} in this record,
          ${fmtN(shown)} shown below.
          ${names.length ? `<div class="small muted">Named in the record as: ${names.map((p) => `<i>${esc(p)}</i>`).join(', ')}</div>` : ''}
          <button class="btn small" data-act="back">Other domains</button>
        </div>` : `
        <div class="notice">
          No protein in this record is assigned <b>${esc(label)}</b>. That is not proof the gene is missing:
          NCBI has not computed domains for every protein, and a gene can be present with no assignment at all.
          To settle it, BLAST a characterised protein against this record.
          <button class="btn small" data-act="back">Other domains</button>
        </div>`;
      $('[data-act="back"]', box).addEventListener('click', () => search(needle));
    } catch (e) {
      if (!isStale()) box.innerHTML = errorHtml(e);
    }
  };

  return {
    clear: () => { box.innerHTML = ''; },
    offer: (needle) => {
      box.innerHTML = `
        <div class="notice">
          Nothing here is <b>named</b> “${esc(needle)}”, which does not mean the gene is absent — product
          names are assigned automatically and are often wrong.
          <button class="btn small" data-act="go">Search conserved domains instead</button>
        </div>`;
      $('[data-act="go"]', box).addEventListener('click', () => search(needle));
    },
  };
}

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

  const domains = domainFinder({
    box: domBox(),
    uid,
    isStale,
    apply: (want, label) => {
      const list = records.filter((r) => want.has(cdsProteinId(r.header)));
      $('#cds-count', body).textContent = `${fmtN(list.length)} of ${fmtN(records.length)} CDS`;
      show(list, `_${label.split(' ')[0].replace(/[^\w.-]/g, '_')}`);
      return {
        shown: list.length,
        names: [...new Set(list.map((r) => r.header.match(/\[protein=([^\]]+)\]/)?.[1]).filter(Boolean))],
      };
    },
  });

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
        if (needle && !hits.length && uid) domains.offer(needleNow());
        else domains.clear();
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
  // Browsers treat line breaks pasted into a one-line input differently, and some
  // drop them, so a column of accessions copied from a spreadsheet would arrive as
  // one long word. Turn them into spaces first.
  $('#q').addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (!/[\r\n]/.test(text.trim())) return;
    e.preventDefault();
    const q = e.target;
    q.setRangeText(text.trim().split(/\s+/).join(' '), q.selectionStart, q.selectionEnd, 'end');
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
