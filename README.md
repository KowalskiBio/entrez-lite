<div align="center">

<img src="docs/images/logo.svg" alt="" width="72" />

# Entrez Lite

**NCBI search that still works when NCBI's website doesn't.**

[![Live app](https://img.shields.io/badge/open-kowalskibio.github.io%2Fentrez--lite-0e7490?style=for-the-badge&logo=googlechrome&logoColor=white)](https://kowalskibio.github.io/entrez-lite/)

[![Vanilla JS](https://img.shields.io/badge/JavaScript-no_framework-f7df1e?style=flat-square&logo=javascript&logoColor=black)](js)
[![No build](https://img.shields.io/badge/build_step-none-555?style=flat-square)](#run-it)
[![NCBI E-utilities](https://img.shields.io/badge/data-NCBI_E--utilities-20558a?style=flat-square)](https://www.ncbi.nlm.nih.gov/books/NBK25501/)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](LICENSE)

[**What it does**](#what-it-does) · [**Run it**](#run-it) · [**Recipes**](#recipes) · [**How it works**](#how-it-works) · [**Limits**](#limits)

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/search-dark.png" />
  <img src="docs/images/search-light.png" alt="Searching Nucleotide for nirK in Pseudomonas fluorescens, with the filter sidebar on the left" width="100%" />
</picture>

</div>

<br />

You search NCBI for a gene, and half the result counts say `error`. You open a GenBank record and the page is empty except for the sidebar. You hit a 500 three times in a row. NCBI's API is usually fine while this happens, so Entrez Lite talks only to the API.

It's three files and a stylesheet. Open `index.html` and search.

## What it does

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>Search like NCBI</h3>
      Nucleotide, Protein, Gene, PubMed, PMC, Taxonomy, Assembly, BioProject, BioSample, SRA, Structure and more. Full Entrez syntax works, plus a filter sidebar for organism, gene name, molecule type, RefSeq vs. GenBank and sequence length. Results come sorted by relevance, like on NCBI. Type a species name as plain text and you get a one-click link to that organism only.
    </td>
    <td width="33%" valign="top">
      <h3>Get the gene out</h3>
      A hit is often a 150 kb contig with your gene somewhere inside it. The <b>CDS</b> tab lists every coding sequence in the record and filters as you type, so <code>nirK</code> gives you one FASTA entry. When a name matches nothing, it searches <b>conserved domains</b> instead.
    </td>
    <td width="33%" valign="top">
      <h3>Exons included</h3>
      Click <b>Sequence</b> on any row of the feature table. Each interval is fetched on the right strand and joined in transcript order. Tested on human TP53: the 10-exon CDS translates to NP_000537.3 residue for residue.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Any region, either strand</h3>
      Set a range under <b>Change region shown</b> and the GenBank, FASTA, feature and CDS views all follow it. A Gene record links its genomic location straight to that region of the chromosome. A WGS project record (the ones ending in <code>000000000</code>) has no sequence of its own, so it opens on a <b>Contigs</b> tab that lists its sequences.
    </td>
    <td valign="top">
      <h3>Follow the links</h3>
      <b>Related information</b> uses ELink, the same link data NCBI's own sidebar uses. Jump from a contig to its proteins, assembly, BioSample or papers, and from a gene to its RefSeq transcripts.
    </td>
    <td valign="top">
      <h3>Take it with you</h3>
      Download selected records, the current page or all results (up to 50,000) as FASTA, GenBank, an accession list or CSV. Paste a list of accessions to get them all at once. Every search gets a number in your <b>History</b>, so <code>#1 AND #3</code> combines two of them. Every view has its own URL, so you can bookmark it or send it to someone.
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/features.png" alt="Feature table for the TP53 region of human chromosome 17, minus strand, with spliced CDS entries" width="49%" />
  <img src="docs/images/cds.png" alt="CDS tab listing all coding sequences of a Pseudomonas fluorescens contig" width="49%" />
</p>

### When the gene is there but the name isn't

Product names are assigned automatically, and they are wrong often enough to matter. NCBI's pipeline calls most *norB* genes `cbb3-type cytochrome c oxidase subunit I` — a different enzyme — and gives them no `gene=` qualifier. Filter the CDS tab of `NZ_CP027720.1` for `norB` and you get nothing, from 6252 coding sequences, for a gene that is right there.

So when a filter matches nothing, the **CDS** and **Features** tabs both offer to search **conserved domains** instead. These are computed from sequence, not copied from a neighbour, and in that record the protein's domain is `COG3256 — NorB` while its product name still says cbb3 oxidase. NCBI's own data disagrees with itself, and the domain is the half that's right.

Pick a domain and you get the coding sequences, or the feature rows, whose proteins carry it — with the name the record uses shown next to them. It costs four requests no matter how large the genome: both sides of the comparison go into an Entrez history session and the intersection happens on the server.

The catch is that CDD searches *text*, so a domain can match because its description merely mentions your gene. Searching `norB` returns three eight-bladed propellers from the *nirS* branch whose abstracts contain the sentence "the integral membrane proteins NorC, **NorB**, and NosR…". So each match is listed with its definition underneath — `COG3256` reads *Nitric oxide reductase large subunit*, the propellers read *heme d₁-binding β-propeller* — and gene-level `COG`, `TIGR` and `PRK` models sort above single `cd` domains and `cl` superfamily clusters.

One more limit: not every protein has a domain assignment. Several *nosZ* proteins have none at all, so an empty result is not evidence of absence, and the app says so rather than implying otherwise.

### Is it really the species it says?

Every contig and assembly record gets a **Genome** card in the sidebar. It finds the assembly the sequence belongs to (`GCF_` if there is a RefSeq copy, `GCA_` otherwise) and shows NCBI's ANI taxonomy check right there. A type strain is labelled as one: it *defines* its species, so NCBI compares it with the nearest **other** species and the card says so, instead of naming a different organism as if that were a problem. **Genome & ANI** opens the full genome page:

- **ANI** against the best type-strain match and against the type strain of the submitted species, with ANI and coverage for both
- **CheckM** completeness and contamination
- **Assembly statistics:** length, GC, contigs, N50, L50, coverage
- **Annotation** gene counts and the **sequencing** details
- **Every sequence** in the assembly, each linked to its record
- **A ZIP download** with genome FASTA, GFF, proteins and CDS

You can also paste a `GCF_` or `GCA_` accession into the search box, or pick **Genome** in the database menu and search by organism. Genome search lists every assembly for a taxon with its level, size, contig count, CheckM score and ANI check, and filters by RefSeq or GenBank, assembly level, reference genomes, type strains and atypical assemblies. Partial names get suggestions as you type. Tick some rows to download an accession list, a CSV or a ZIP of the genomes. Each type-strain match links to that genome's page, so you can follow a misassigned strain to the species it actually matches.

<p align="center">
  <img src="docs/images/genome.png" alt="Genome page for Pseudomonas fluorescens AU11706: taxonomy check inconclusive, best type match Pseudomonas saponiphila at 94.17% ANI" width="100%" />
</p>

### Side by side

**Compare this genome** in the genome sidebar takes up to five more assemblies. Paste `GCF_` or `GCA_` accessions, or a contig or chromosome accession such as `NC_008463.1`, which stands for the assembly it belongs to. You can also tick genomes in a Genome search and press **Compare selected**. The comparison puts organism, tax ID, BioSample, release date, sequencing technology, assembler, coverage, length, GC, contigs, N50, CheckM and the ANI check in one table, with each number's difference from the first genome. One switch hides the rows where they all agree. The chromosomes and plasmids are listed below that.

**Compare gene content** reads every annotated gene of each genome and groups them by product name, gene symbol or identical protein. A shared `WP_` accession means the same protein sequence. Filter for what one genome has and the others lack, or the reverse, and download the table as TSV.

## Run it

**Online:** [kowalskibio.github.io/entrez-lite](https://kowalskibio.github.io/entrez-lite/)

**Locally:** clone the repo and open `index.html`. Your browser is the only requirement.

```bash
git clone https://github.com/KowalskiBio/entrez-lite.git
xdg-open entrez-lite/index.html     # macOS: open, Windows: start
```

NCBI allows 3 requests per second without an API key. Paste a free key into **Settings** (the gear icon) to get 10. You can make one under [NCBI account settings](https://account.ncbi.nlm.nih.gov/settings/). The key stays in your browser's local storage and is only ever sent to NCBI.

## Recipes

| You want | Do this |
|---|---|
| One gene from a bacterial genome | Open the genome or contig, go to **CDS**, type the gene name, then **Download** |
| The same gene when the name finds nothing | On **CDS** or **Features**, use **Search conserved domains instead**, then pick the domain whose definition names your enzyme |
| The same gene from many strains | Search Protein for `nirK[Gene Name] AND "Pseudomonas"[Organism]`, choose **All results** and **FASTA** |
| Every accession from a paper's table | Copy the column and paste it into the search box. Any that don't exist are listed above the results |
| Two searches combined | Run both, then search `#1 AND #2` (or `OR`, `NOT`), or build it on the **History** page |
| A human gene with its introns | Search Gene, open the record, click the genomic location link |
| Just the mature CDS of that gene | From the same region, go to **Features**, pick the CDS row, click **Sequence** |
| A record you already know | Paste the accession (`HQ288918.1`) into the search box |
| Complete genomes of a species | Pick **Genome**, search `Pseudomonas fluorescens`, tick **Complete genome** |
| What sets two strains apart | Open one genome, paste the other's `GCF_` under **Compare this genome**, then **Compare gene content** |
| To check a strain's species | Open any of its contigs and look at the **Genome** card, or paste the `GCF_` accession |
| To see what NCBI did with your query | Open **Search details** above the results |

## How it works

```
index.html        page shell
css/styles.css    light and dark theme, one set of tokens
js/eutils.js      E-utilities and Datasets clients: throttling, retries, parsers
js/app.js         hash router and all the views
tests/            node --test suite, with saved NCBI responses as fixtures
```

Everything goes through [E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/): `esearch` for hits, `esummary` for the result list, `efetch` for GenBank, FASTA, feature tables and CDS, and `elink` for related records. Genome pages come from the [Datasets v2 API](https://www.ncbi.nlm.nih.gov/datasets/docs/v2/api/), which provides the assembly report, CheckM, ANI, the sequence list and, for comparisons, the gene annotation report. Both services allow cross-origin requests, so the browser calls them directly and no proxy is needed.

A few details that took some testing:

- **Rate limits.** Requests go through a queue spaced at 350 ms, or 110 ms with an API key. On a `429` or `5xx` the client waits and retries up to three times.
- **Bot checks.** When NCBI answers with an HTML challenge page instead of data, you get an error that says so, not a JSON parse error.
- **Region feature tables.** When you fetch a feature table for a sub-range, NCBI numbers it from the start of that range. The parser shifts the coordinates back to positions on the full sequence.
- **Locus tags.** In RefSeq tables, the gene name and locus tag sit only on the `gene` feature. They're copied onto the CDS and RNA features that span the same coordinates, so every row has a name.
- **Long ID lists.** These go as form-encoded POSTs, which still count as simple CORS requests and skip the preflight.
- **Big downloads.** **All results** saves the search on NCBI's history server and reads it back in batches of 500, so it isn't held to the 10,000 IDs that `esearch` will page through. The button shows progress and cancels the download if you click it again.
- **Search history.** `#3` is expanded into the saved query in your browser before the search goes out, rather than left for NCBI to resolve against a session that expires within hours. Old bookmarks with `#3` in them keep working, and searches from different databases can't be mixed by accident.

### Tests

The parsers and the request code have a test suite. It needs Node 20 or newer and nothing else:

```bash
node --test
```

The feature-table and FASTA tests run against real `efetch` responses saved in `tests/fixtures/`. The request tests stand in for the network, so the suite runs offline.

## Limits

- **BLAST.** **Run BLAST** and **Open on NCBI** go to the NCBI website, so they break when it does.
- **No Graphics view.** There's no graphical sequence viewer like NCBI's.
- **10,000 results.** Paging through the list stops there because the API stops there. **All results** downloads go further, up to 50,000 records.
- **History is per browser.** It lives in this browser's local storage, like your settings, so it doesn't follow you to another computer.
- **Large records.** Anything over 1 Mb asks before loading in full. Over 20 Mb, set a region first.

## License

[AGPL-3.0](LICENSE). Not affiliated with NCBI. The data comes from NCBI's public E-utilities service, which has its own [usage guidelines](https://www.ncbi.nlm.nih.gov/books/NBK25497/).
