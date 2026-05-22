# plugin-standard-files

Standard files plugin for [sitespeed.io](https://www.sitespeed.io/).

## Overview

`plugin-standard-files` is a plugin for sitespeed.io that checks for the
presence and validity of common "standard files" on a site, using a **real
browser** to fetch them. It is the sitespeed.io port of the `standard_files`
test previously implemented in Python in
[webperf_core](https://github.com/Webperf-se/webperf_core/blob/main/tests/standard_files.py).

It checks:

- **robots.txt** – exists and contains directives (not an HTML 404 page).
- **sitemap(s)** – declared in robots.txt, reachable, HTTPS-only, same-domain,
  free of duplicates, of known content types, not empty and not over 50 000
  items. `sitemapindex` files are followed.
- **RSS/Atom/JSON feed** – discovered from `<link>` elements on the page.
- **security.txt** – `/.well-known/security.txt` (falling back to
  `/security.txt`) exists and declares `Contact:` and `Expires:`.

The rule ids, severities and categories are kept identical to the original
Python test so that scores stay continuous.

## How it works

Standard files are origin-level, so the plugin runs once per site (group):

1. On the first `url` for a group it enqueues `robots.txt` and
   `/.well-known/security.txt`.
2. When `robots.txt` comes back it discovers `Sitemap:` entries and enqueues
   them; `sitemapindex` files enqueue their children.
3. If `/.well-known/security.txt` is missing/wrong it enqueues `/security.txt`.
4. The page itself is used for the RSS/Atom feed check.
5. At `sitespeedio.summarize` the findings are finalized and published once per
   group.

When [plugin-webperf-core](https://github.com/Webperf-se/plugin-webperf-core)
is present, results are sent as `webPerfCoreSummary` and aggregated into the
combined Webperf Core tab; otherwise they render in their own "Standard files"
tab.

## Installation

```sh
npm install plugin-standard-files
```

## Usage

### Command Line

```sh
sitespeed.io https://www.example.com --plugins.add plugin-standard-files
```

With the aggregator:

```sh
sitespeed.io --plugins.add plugin-webperf-core --plugins.add plugin-standard-files https://www.example.com
```

### Configuration

```json
{
  "plugins": {
    "plugin-standard-files": {
      "enabled": true
    }
  }
}
```

## Development

### Running tests

```sh
npm install
npm test
```

The tests feed pre-built HAR objects through the analyzer, so they need no
network.

### Local manual run

```sh
npm run start-server   # serves test/data/ on http://localhost:3000
sitespeed.io -n 1 --plugins.add ./lib/index.js --browsertime.chrome.includeResponseBodies all http://localhost:3000/
```

### Linting

```sh
npm run lint
npm run lint:fix
```

## License

MIT. See [LICENSE](./LICENSE).

## Acknowledgements

- [sitespeed.io](https://www.sitespeed.io/)
- [webperf_core](https://github.com/Webperf-se/webperf_core)
- [plugin-webperf-core](https://github.com/Webperf-se/plugin-webperf-core)
- [plugin-pagenotfound](https://github.com/Webperf-se/plugin-pagenotfound) (template)
