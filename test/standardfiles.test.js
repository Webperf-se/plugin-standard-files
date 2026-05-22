import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarAnalyzer } from '../lib/harAnalyzer.js';

// Build a minimal HAR with a single document entry for `url`.
function har(url, content, mimeType = 'text/plain', status = 200) {
  return {
    log: {
      entries: [
        {
          request: { url },
          response: {
            status,
            content: { text: content, mimeType, size: content ? content.length : 0 }
          }
        }
      ]
    }
  };
}

const GROUP = 'example.com';
const PAGE = 'https://example.com/';
const ROBOTS = 'https://example.com/robots.txt';
const WELLKNOWN = 'https://example.com/.well-known/security.txt';
const SITEMAP = 'https://example.com/sitemap.xml';

async function drive(analyzer, fetches) {
  // fetches: array of [url, har]
  for (const [url, harData] of fetches) {
    await analyzer.analyzeData(url, harData, GROUP);
  }
}

test('healthy site -> all rules resolved', async () => {
  const analyzer = new HarAnalyzer();

  const initial = analyzer.getInitialUrls(PAGE, GROUP);
  assert.deepEqual(initial, [ROBOTS, WELLKNOWN]);

  const pageHtml =
    '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>hi</body></html>';
  const robotsTxt = 'User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\n';
  const sitemapXml =
    '<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>';
  const securityTxt = 'Contact: mailto:security@example.com\nExpires: 2030-01-01T00:00:00.000Z\n';

  await analyzer.analyzeData(PAGE, har(PAGE, pageHtml, 'text/html'), GROUP);
  await analyzer.analyzeData(ROBOTS, har(ROBOTS, robotsTxt), GROUP);

  // robots.txt should have queued the sitemap
  assert.deepEqual(analyzer.getNextUrls(GROUP), [SITEMAP]);

  await analyzer.analyzeData(SITEMAP, har(SITEMAP, sitemapXml, 'application/xml'), GROUP);
  await analyzer.analyzeData(WELLKNOWN, har(WELLKNOWN, securityTxt), GROUP);

  const result = analyzer.finalize(GROUP);
  const issues = result.knowledgeData.issues;

  for (const rule of Object.keys(issues)) {
    assert.equal(issues[rule].severity, 'resolved', `${rule} should be resolved`);
  }
  // no-network should never be padded in
  assert.ok(!('no-network' in issues));
});

test('bare site -> expected issues raised', async () => {
  const analyzer = new HarAnalyzer();
  analyzer.getInitialUrls(PAGE, GROUP);

  // Page with no feed link
  await analyzer.analyzeData(PAGE, har(PAGE, '<html><head></head><body>hi</body></html>', 'text/html'), GROUP);
  // robots.txt returns a 404 HTML page
  await analyzer.analyzeData(ROBOTS, har(ROBOTS, '<html><body>Not found</body></html>', 'text/html', 404), GROUP);
  // .well-known/security.txt returns a 404 HTML page
  await analyzer.analyzeData(WELLKNOWN, har(WELLKNOWN, '<html><body>Not found</body></html>', 'text/html', 404), GROUP);

  // wrong content on well-known should trigger a fallback to /security.txt
  assert.deepEqual(analyzer.getNextUrls(GROUP), ['https://example.com/security.txt']);
  await analyzer.analyzeData('https://example.com/security.txt', har('https://example.com/security.txt', '<html><body>Not found</body></html>', 'text/html', 404), GROUP);

  const issues = analyzer.finalize(GROUP).knowledgeData.issues;

  assert.equal(issues['no-robots-txt'].severity, 'error');
  assert.equal(issues['no-sitemap-in-robots-txt'].severity, 'error');
  assert.equal(issues['no-rss-feed'].severity, 'warning');
  assert.equal(issues['invalid-security-txt'].severity, 'error');
  assert.equal(issues['no-security-txt-contact'].severity, 'warning');
});

test('network failure -> only no-network', async () => {
  const analyzer = new HarAnalyzer();
  analyzer.getInitialUrls(PAGE, GROUP);
  // Empty HAR for the page = no content fetched
  await analyzer.analyzeData(PAGE, { log: { entries: [] } }, GROUP);

  const issues = analyzer.finalize(GROUP).knowledgeData.issues;
  assert.deepEqual(Object.keys(issues), ['no-network']);
  assert.equal(issues['no-network'].category, 'technical');
});
