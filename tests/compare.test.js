'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEutils, fakeFetch } = require('./load');

const gene = (over) => ({
  symbol: '', name: '', type: 'protein-coding', locus: '', seq: '', start: 0, end: 0,
  strand: '+', protein: '', product: '', length: 0, ...over,
});

test('genes are read from the annotation report one page after another', async () => {
  const { fetch, calls } = fakeFetch(({ params }) => ({
    body: params.page_token
      ? { reports: [{ annotation: { symbol: 'rpoB', gene_type: 'protein-coding', locus_tag: 'A_2',
        genomic_regions: [{ gene_range: { accession_version: 'NC_1.1', range: [{ begin: '10', end: '90', orientation: 'minus' }] } }],
        proteins: [{ accession_version: 'WP_2.1', name: 'DNA-directed RNA polymerase subunit beta', length: 1342 }] } }], total_count: 2 }
      : { reports: [{ annotation: { name: 'tRNA-Ala', gene_type: 'tRNA', locus_tag: 'A_1' } }], total_count: 2, next_page_token: 'p2' },
  }));
  const { annotationReport } = loadEutils({ fetch });
  const progress = [];
  const genes = await annotationReport('GCF_000006765.1', { onProgress: (d, t) => progress.push([d, t]) });
  assert.deepEqual(calls.map((c) => [c.endpoint, c.params.page_size, c.params.page_token]),
    [['annotation_report', '1000', undefined], ['annotation_report', '1000', 'p2']]);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.equal(genes[0].type, 'tRNA');
  assert.deepEqual(genes[1], {
    symbol: 'rpoB', name: '', type: 'protein-coding', locus: 'A_2', seq: 'NC_1.1', start: 10, end: 90,
    strand: '-', protein: 'WP_2.1', product: 'DNA-directed RNA polymerase subunit beta', length: 1342,
  });
});

test('gene content groups by product name across genomes, ignoring case', () => {
  const { geneContent } = loadEutils();
  const a = [gene({ product: 'Catalase', locus: 'a1' }), gene({ product: 'hypothetical protein' }), gene({ product: 'hypothetical protein' })];
  const b = [gene({ product: 'catalase' }), gene({ product: 'hypothetical protein' }), gene({ product: 'Nitrite reductase' })];
  const c = geneContent([a, b], 'product');
  const byKey = Object.fromEntries(c.rows.map((r) => [r.key, r.counts]));
  assert.deepEqual(byKey, { catalase: [1, 1], 'hypothetical protein': [2, 1], 'nitrite reductase': [0, 1] });
  assert.equal(c.rows.find((r) => r.key === 'catalase').label, 'Catalase');
  assert.equal(c.core, 2);
  assert.deepEqual(c.summary, [{ present: 2, unique: 0 }, { present: 3, unique: 1 }]);
});

test('genes without a symbol or protein are counted apart, not grouped', () => {
  const { geneContent } = loadEutils();
  const a = [gene({ symbol: 'dnaA', protein: 'WP_1.1' }), gene({ type: 'tRNA', name: 'tRNA-Ala' })];
  const b = [gene({ symbol: 'dnaA', protein: 'WP_9.1' })];
  const bySymbol = geneContent([a, b], 'symbol');
  assert.deepEqual(bySymbol.rows.map((r) => [r.key, r.counts]), [['dnaA', [1, 1]]]);
  assert.deepEqual(bySymbol.unkeyed, [1, 0]);
  const byProtein = geneContent([a, b], 'protein');
  assert.deepEqual(byProtein.rows.map((r) => [r.key, r.counts]), [['WP_1.1', [1, 0]], ['WP_9.1', [0, 1]]]);
  assert.equal(byProtein.core, 0);
});

test('a pasted accession list is split, upper-cased and deduplicated', () => {
  const { parseAccessionList } = loadEutils();
  assert.deepEqual(parseAccessionList('gcf_000006765.1, NC_002516.2\nGCF_000006765.1;  GCA_1'),
    ['GCF_000006765.1', 'NC_002516.2', 'GCA_1']);
});

test('a sequence accession stands for the assembly it belongs to', async () => {
  const { fetch, calls } = fakeFetch(({ endpoint }) => ({
    body: endpoint === 'esearch.fcgi' ? { esearchresult: { count: '1', idlist: ['110645304'] } }
      : endpoint === 'elink.fcgi' ? { linksets: [{ linksetdbs: [{ linkname: 'nuccore_assembly', dbto: 'assembly', links: ['30128'] }] }] }
        : { result: { uids: ['30128'], 30128: { uid: '30128', assemblyaccession: 'GCA_000006765.1', synonym: { refseq: 'GCF_000006765.1' } } } },
  }));
  const { resolveGenomeAccession } = loadEutils({ fetch });
  assert.equal(await resolveGenomeAccession('gcf_000006765'), 'GCF_000006765');
  assert.equal(calls.length, 0);
  assert.equal(await resolveGenomeAccession('NC_002516.2'), 'GCF_000006765.1');
  assert.equal(calls[0].params.term, 'NC_002516.2[accn]');
  await assert.rejects(resolveGenomeAccession('not an accession'), /is not an accession/);
});
