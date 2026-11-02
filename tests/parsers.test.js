'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEutils, fixture } = require('./load');

const { parseFeatureTable, parseFasta, toFasta, cleanSeqId } = loadEutils();

// Fixtures are real efetch responses:
//   tp53-region.ft       NC_000017.11, rettype=ft, seq_start=7668402 seq_stop=7687550
//   cp027720-1-6000.ft   NZ_CP027720.1, rettype=ft, seq_start=1 seq_stop=6000
//   np_000537.fasta      NP_000537.3, rettype=fasta

const TP53_OFFSET = 7668402 - 1;
const tp53 = () => parseFeatureTable(fixture('tp53-region.ft'), TP53_OFFSET)
  .find((f) => f.type === 'CDS' && f.q.protein_id?.[0] === 'ref|NP_000537.3|');

test('a region feature table is shifted back to positions on the whole chromosome', () => {
  const cds = tp53();
  assert.ok(cds, 'NP_000537.3 CDS is in the table');
  // NCBI numbers the region from 1; the table says 8193..8120 for the first exon.
  assert.deepEqual(cds.parts[0], { from: 8120 + TP53_OFFSET, to: 8193 + TP53_OFFSET });
  assert.equal(cds.lo, 1208 + TP53_OFFSET);
  assert.equal(cds.hi, 8193 + TP53_OFFSET);
});

test('a spliced minus-strand CDS keeps its exons in transcript order', () => {
  const cds = tp53();
  assert.equal(cds.strand, '-');
  assert.equal(cds.parts.length, 10);
  // Transcript order on the minus strand runs from high coordinates to low.
  for (let i = 1; i < cds.parts.length; i++) assert.ok(cds.parts[i].to < cds.parts[i - 1].from);
  // 393 residues plus the stop codon.
  const length = cds.parts.reduce((n, p) => n + p.to - p.from + 1, 0);
  assert.equal(length, (393 + 1) * 3);
  assert.match(cds.location, /^complement\(join\(7669609\.\.7669690,.*,7676521\.\.7676594\)\)$/);
});

test('gene names and locus tags are copied from gene features onto their CDS', () => {
  const features = parseFeatureTable(fixture('cp027720-1-6000.ft'));
  const cds = features.find((f) => f.type === 'CDS' && f.lo === 1);
  assert.deepEqual(cds.q.gene, ['dnaA']);
  assert.deepEqual(cds.q.locus_tag, ['C4K13_RS00005']);
  assert.deepEqual(cds.q.product, ['chromosomal replication initiator protein DnaA']);
  // The CDS has no old_locus_tag of its own and none is copied.
  assert.equal(cds.q.old_locus_tag, undefined);
  assert.equal(cds.location, '1..1521');
});

test('an unshifted table keeps its own numbering', () => {
  const features = parseFeatureTable(fixture('cp027720-1-6000.ft'));
  const dnaN = features.find((f) => f.type === 'CDS' && f.q.gene?.[0] === 'dnaN');
  assert.deepEqual([dnaN.lo, dnaN.hi, dnaN.strand], [1560, 2663, '+']);
});

test('FASTA parses and writes back with 70-column lines', () => {
  const [rec] = parseFasta(fixture('np_000537.fasta'));
  assert.match(rec.header, /^NP_000537\.3 /);
  assert.equal(rec.seq.length, 393);
  assert.ok(rec.seq.startsWith('MEEPQSDPSV'));
  const out = toFasta([rec]);
  assert.deepEqual(parseFasta(out), [rec]);
  assert.ok(out.split('\n').slice(1).every((line) => line.length <= 70));
});

test('cleanSeqId strips database prefixes', () => {
  assert.equal(cleanSeqId('ref|WP_047306321.1|'), 'WP_047306321.1');
  assert.equal(cleanSeqId('gb|AAA12345.1|'), 'AAA12345.1');
  assert.equal(cleanSeqId('XP_1.1'), 'XP_1.1');
});

const { parseCodedBy, translateDna, reverseComplement, proteinRegions } = loadEutils();

test('coded_by places a protein on its mRNA, on the minus strand, or across exons', () => {
  assert.deepEqual(parseCodedBy('NM_000546.6:143..1324'),
    { acc: 'NM_000546.6', strand: '+', parts: [{ from: 143, to: 1324 }] });
  assert.deepEqual(parseCodedBy('complement(NZ_CP027720.1:<100..>400)'),
    { acc: 'NZ_CP027720.1', strand: '-', parts: [{ from: 100, to: 400 }] });
  // A minus-strand join is written in ascending order; transcript order is the reverse.
  assert.deepEqual(parseCodedBy('complement(join(NC_1.1:10..20,\n NC_1.1:30..40))').parts,
    [{ from: 30, to: 40 }, { from: 10, to: 20 }]);
  assert.equal(parseCodedBy('join(AB1.1:1..5,CD2.1:1..5)'), null);
  assert.equal(parseCodedBy(''), null);
});

test('a coding sequence translates to its protein, and a reverse complement round-trips', () => {
  assert.equal(translateDna('ATGGAGGAGCCGCAGTAA'), 'MEEPQ*');
  assert.equal(reverseComplement('ATGC'), 'GCAT');
});

test('GenPept regions split into CDD domains and propagated functional regions', () => {
  const gp = `FEATURES             Location/Qualifiers
     Protein         1..595
                     /product="estrogen receptor"
     Region          251..310
                     /region_name="Hinge"
                     /note="propagated from UniProtKB/Swiss-Prot (P03372.2)"
     Region          310..547
                     /region_name="NR_LBD_ER"
                     /note="Ligand binding domain of Estrogen receptor"
                     /db_xref="CDD:132747"
     Region          1..184
                     /region_name="Modulating (transactivation AF-1), mediates
                     interaction with MACROD1. /evidence=ECO:0000269|PubMed:1"
     Site            order(5,9)
ORIGIN
        1 mkk`;
  const r = proteinRegions(gp);
  assert.deepEqual(r.map((x) => [x.name, x.from, x.to, x.cdd]), [
    ['Modulating (transactivation AF-1), mediates interaction with MACROD1', 1, 184, ''],
    ['Hinge', 251, 310, ''],
    ['NR_LBD_ER', 310, 547, '132747'],
  ]);
});
