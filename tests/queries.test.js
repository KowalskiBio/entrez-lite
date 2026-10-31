'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEutils } = require('./load');

const { idListTerm, expandHistoryRefs, domainRank, ACCESSION_RE } = loadEutils();

test('a pasted list of accessions becomes one [accn] query', () => {
  const r = idListTerm('HQ288918.1\nNZ_CP027720.1\r\nwp_047306321.1');
  assert.deepEqual({ ...r }, {
    count: 3,
    term: 'HQ288918.1[accn] OR NZ_CP027720.1[accn] OR WP_047306321.1[accn]',
  });
});

test('commas, semicolons and spaces all separate IDs, and repeats are dropped', () => {
  assert.equal(idListTerm('HQ288918.1, HQ288919.1;HQ288918.1  HQ288920').term,
    'HQ288918.1[accn] OR HQ288919.1[accn] OR HQ288920[accn]');
});

test('bare numbers match on [uid], mixed with accessions', () => {
  assert.equal(idListTerm('31452104 7157 PRJNA224116').term,
    '31452104[uid] OR 7157[uid] OR PRJNA224116[accn]');
});

test('ordinary searches are not mistaken for a list', () => {
  assert.equal(idListTerm('HQ288918.1'), null); // a single accession opens the record instead
  assert.equal(idListTerm('nirK nosZ'), null);
  assert.equal(idListTerm('16S ribosomal RNA'), null);
  assert.equal(idListTerm('HQ288918.1 OR HQ288919.1'), null); // already a query
  assert.equal(idListTerm('HQ288918.1[accn] HQ288919.1'), null);
  assert.equal(idListTerm(''), null);
});

test('accession pattern covers the common kinds', () => {
  for (const acc of ['HQ288918.1', 'NZ_CP027720.1', 'WP_047306321.1', 'NC_000017.11', 'PRJNA224116', 'SAMN02604091', 'SRR390728', 'AAA12345']) {
    assert.ok(ACCESSION_RE.test(acc), acc);
  }
  for (const word of ['NIRK', 'TP53', 'ABC']) assert.ok(!ACCESSION_RE.test(word), word);
});

const history = [
  { n: 1, db: 'protein', query: 'nirK[Gene Name]' },
  { n: 3, db: 'protein', query: '"Pseudomonas"[Organism]' },
  { n: 4, db: 'nuccore', query: '16S' },
];

test('#n references expand into the saved queries', () => {
  assert.equal(expandHistoryRefs('#1 AND #3', history, 'protein'),
    '(nirK[Gene Name]) AND ("Pseudomonas"[Organism])');
  assert.equal(expandHistoryRefs('#1 NOT refseq[filter]', history, 'protein'),
    '(nirK[Gene Name]) NOT refseq[filter]');
  assert.equal(expandHistoryRefs('nirK', history, 'protein'), 'nirK');
});

test('a missing search number is an error, not a silent empty match', () => {
  assert.throws(() => expandHistoryRefs('#1 AND #2', history, 'protein'), /no search #2/);
});

test('searches from different databases cannot be combined', () => {
  const label = (db) => ({ protein: 'Protein', nuccore: 'Nucleotide' }[db]);
  assert.throws(() => expandHistoryRefs('#1 AND #4', history, 'protein', label),
    /Search #4 was in Nucleotide, so it can't be combined with a Protein search/);
});

test('gene-level domain models rank above single domains and superfamilies', () => {
  const order = ['cl21534', 'cd04080', 'pfam00394', 'COG3256']
    .sort((a, b) => domainRank(a, 'x', 'norB') - domainRank(b, 'x', 'norB'));
  assert.deepEqual(order, ['COG3256', 'pfam00394', 'cd04080', 'cl21534']);
  // A short name equal to the search term goes first whatever its family.
  assert.ok(domainRank('cd00001', 'NorB', 'norb') < domainRank('COG3256', 'other', 'norb'));
});
