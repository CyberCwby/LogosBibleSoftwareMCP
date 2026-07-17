# Cross-reference dataset

This directory holds `cross-references.tsv.gz`, the curated verse-to-verse
cross-reference dataset used by the `get_cross_references` tool. It is not
committed to the repository — generate it once with:

```bash
cd logos-mcp-server
npm run fetch-xrefs
```

The data comes from the [openbible.info cross-references project]
(https://www.openbible.info/labs/cross-references/) — roughly 340,000
community-voted cross-reference links — and is used under its Creative
Commons Attribution license. If you redistribute the generated file, keep
this attribution.

Without the dataset, `get_cross_references` falls back to keyword search
through the Biblia API (requires `BIBLIA_API_KEY`).

File format: gzipped TSV, one link per line —
`fromBook.chapter.verse<TAB>toBook.chapter.verse[-endChapter.endVerse]<TAB>votes`,
with books numbered 1–66 in Protestant canon order.
