# Implementation notes (read me before reviewing)

This is the **first batch**. It is behaviourally validated against fake HARs
(`npm test` passes with the three scenarios), syntax-checked, and modelled on
`plugin-pagenotfound` / `plugin-html` / `plugin-css` from the project knowledge.
A few things still need a real-world sitespeed.io run to confirm.

## Decisions made

- **Logic in JS** (`lib/harAnalyzer.js`), matching every sibling plugin. The
  Python in those repos is only `tools/release.py` (version automation), which
  is included verbatim.
- **Rule parity**: `RULES` in `harAnalyzer.js` is a 1:1 copy of `ALL_RULES`
  from `standard_files.py` (same ids, severities, categories). Missing rules are
  padded as `resolved` (excluding `no-network`), exactly like
  `addResolvedIssues`. Score continuity is then handled centrally by
  `plugin-webperf-core`'s `scoreHelper.calculateScore`.
- **Real browser fetches** (the point of this rewrite vs PR #1471): the plugin
  asks sitespeed to navigate to each standard file via `this.make('url', ...)`
  and reads the result from `browsertime.har`. No `urllib`/Node `fetch`.
- **Once per site**: `getInitialUrls` guards on `this.groups[group]` so origin
  files are enqueued only once, and finalization happens at
  `sitespeedio.summarize`.
- **Sequential discovery**: robots.txt → sitemaps → sitemapindex children, and
  `.well-known/security.txt` → `/security.txt` fallback only when the first is
  missing/wrong (mirrors the Python `check_root` logic).

## Open questions / things to verify on a live run

1. **Message shape for the aggregator.** I emit the same object shape as the
   sibling plugins (`{version, dependencies, url, analyzedData, knowledgeData}`
   with issues under `knowledgeData.issues`). Confirm `plugin-webperf-core`
   reads `knowledgeData.issues` for the standalone tab vs the webPerfCoreSummary
   path on a real run.
2. **Emitting at `summarize` instead of per `browsertime.har`.** This matches
   `plugin-accessibility-statement`'s "finalize at summarize" pattern, but I
   want to confirm the standalone HTML tab still renders (the `run`/`pageSummary`
   pug paths).
3. **Gzipped sitemaps (`.xml.gz`).** Assumed to be transparently decompressed by
   the browser before reaching the HAR. `sitemapParser.looksLikeXml` bails out
   gracefully if we ever receive binary; needs a real `.xml.gz` test.
4. **Locale strings.** The issue text shown by `webperf_core` comes from its own
   translation files keyed by the test name (`standard-files`). We will need to
   add those keys in webperf_core (or a `locale/` folder if the plugin owns
   them). Not included in this batch.
5. **`.github` release workflow.** I included a safe test/lint CI workflow only.
   The npm-publish/release workflow (which uses `tools/release.py` + repo
   secrets) should be copied from `plugin-pagenotfound/.github` rather than
   guessed at here.

## Transition plan for webperf_core (`standard_files.py` + PR #1471)

Nothing drastic in this batch. Suggested sequence once the plugin is published:

1. Add `plugin-standard-files` to `webperf_core`'s `package.json` dependencies
   and to the default sitespeed.io `--plugins.add` set (next to
   `plugin-pagenotfound`).
2. Reduce `tests/standard_files.py` to a thin shim that reads the plugin output
   from `webperf-core.json` instead of doing its own HTTP fetches (keeps the
   test id/translations working).
3. Close PR #1471 in favour of this approach, referencing the reviewer's concern
   that the fix should use a real browser.

## File map

```
lib/index.js          sitespeed.io plugin (message routing, multi-stage crawl)
lib/harAnalyzer.js    the port of standard_files.py (checks, rules, issues)
lib/sitemapParser.js  urlset/sitemapindex parsing
pug/index.pug         HTML report tab
tools/release.py      version automation (unchanged from upload)
test/                 network-free unit tests + fixtures for a manual run
```
