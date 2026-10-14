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

test('sitemapindex on other hosts -> not fetched, reported as critical', async () => {
  const analyzer = new HarAnalyzer();
  analyzer.getInitialUrls(PAGE, GROUP);

  const index = 'https://example.com/sitemapindex.xml';
  const own = 'https://www.example.com/sv/sitemap.xml';
  const foreign = ['https://example.dk/da/sitemap.xml', 'https://other.example.org/sitemap.xml'];
  const indexXml =
    '<?xml version="1.0"?><sitemapindex>' +
    [own, ...foreign].map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('') +
    '</sitemapindex>';
  const robotsTxt = `User-agent: *\nDisallow:\nSitemap: ${index}\n`;

  await analyzer.analyzeData(PAGE, har(PAGE, '<html><body>hi</body></html>', 'text/html'), GROUP);
  await analyzer.analyzeData(ROBOTS, har(ROBOTS, robotsTxt), GROUP);
  assert.deepEqual(analyzer.getNextUrls(GROUP), [index]);

  await analyzer.analyzeData(index, har(index, indexXml, 'application/xml'), GROUP);
  // Only the same-site (www-insensitive) child is queued
  assert.deepEqual(analyzer.getNextUrls(GROUP), [own]);

  const issue = analyzer.finalize(GROUP).knowledgeData.issues['no-same-host-sitemapindex'];
  assert.equal(issue.severity, 'critical');
  assert.deepEqual(issue.subIssues.map((s) => s.text.split(': ')[1]), foreign);
});

// Drive a healthy page, robots.txt pointing at a single sitemapindex, and
// security.txt. Returns the analyzer so each test can feed the sitemaps.
async function siteWithSitemapIndex() {
  const analyzer = new HarAnalyzer();
  analyzer.getInitialUrls(PAGE, GROUP);
  const pageHtml =
    '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>hi</body></html>';
  await analyzer.analyzeData(PAGE, har(PAGE, pageHtml, 'text/html'), GROUP);
  await analyzer.analyzeData(ROBOTS,
    har(ROBOTS, 'User-agent: *\nDisallow:\nSitemap: https://example.com/siteindex.xml\n'), GROUP);
  await analyzer.analyzeData(WELLKNOWN,
    har(WELLKNOWN, 'Contact: mailto:security@example.com\nExpires: 2030-01-01T00:00:00.000Z\n'), GROUP);
  return analyzer;
}

const SITEINDEX = 'https://example.com/siteindex.xml';
const CHILDREN = ['sitemap.xml', 'sitemap-posts.xml', 'sitemap-pages.xml']
  .map((name) => `https://example.com/${name}`);
const SITEINDEX_XML = '<?xml version="1.0" encoding="UTF-8"?>' +
  '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  CHILDREN.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join('') +
  '</sitemapindex>';

function urlsetXml(paths) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    paths.map((p) => `<url><loc>https://example.com/${p}</loc></url>`).join('') +
    '</urlset>';
}

const ERROR_PAGE = '<!DOCTYPE html><html><head><title>Too Many Requests</title></head>' +
  '<body><h1>429</h1></body></html>';

test('sitemap child answering with an html page is not reported as empty', async () => {
  const analyzer = await siteWithSitemapIndex();
  assert.deepEqual(analyzer.getNextUrls(GROUP), [SITEINDEX]);
  await analyzer.analyzeData(SITEINDEX, har(SITEINDEX, SITEINDEX_XML, 'text/xml'), GROUP);
  assert.deepEqual(analyzer.getNextUrls(GROUP), CHILDREN);

  await analyzer.analyzeData(CHILDREN[0], har(CHILDREN[0], urlsetXml(['a', 'b']), 'text/xml'), GROUP);
  await analyzer.analyzeData(CHILDREN[1], har(CHILDREN[1], ERROR_PAGE, 'text/html'), GROUP);
  await analyzer.analyzeData(CHILDREN[2], har(CHILDREN[2], urlsetXml(['c']), 'text/xml'), GROUP);

  const issues = analyzer.finalize(GROUP).knowledgeData.issues;
  assert.equal(issues['no-items-sitemap'].severity, 'resolved');
  assert.equal(issues['unreadable-sitemap'].severity, 'warning');
  assert.equal(issues['unreadable-sitemap'].category, 'standard');
  assert.deepEqual(issues['unreadable-sitemap'].subIssues.map((s) => s.url), [CHILDREN[1]]);
});

test('sitemap child answering with an error status is not reported as empty', async () => {
  const analyzer = await siteWithSitemapIndex();
  analyzer.getNextUrls(GROUP);
  await analyzer.analyzeData(SITEINDEX, har(SITEINDEX, SITEINDEX_XML, 'text/xml'), GROUP);
  analyzer.getNextUrls(GROUP);

  await analyzer.analyzeData(CHILDREN[0], har(CHILDREN[0], urlsetXml(['a']), 'text/xml'), GROUP);
  // An error page that happens to mention <loc> must not be parsed as a sitemap.
  await analyzer.analyzeData(CHILDREN[1],
    har(CHILDREN[1], '<html><body>Error, try <code>&lt;loc&gt;</code><loc></loc></body></html>', 'text/html', 503), GROUP);
  await analyzer.analyzeData(CHILDREN[2], har(CHILDREN[2], urlsetXml(['c']), 'text/xml'), GROUP);

  const issues = analyzer.finalize(GROUP).knowledgeData.issues;
  assert.equal(issues['no-items-sitemap'].severity, 'resolved');
  assert.deepEqual(issues['unreadable-sitemap'].subIssues.map((s) => s.url), [CHILDREN[1]]);
});

test('sitemapindex answering with an html page is not reported as empty', async () => {
  const analyzer = await siteWithSitemapIndex();
  analyzer.getNextUrls(GROUP);
  await analyzer.analyzeData(SITEINDEX, har(SITEINDEX, ERROR_PAGE, 'text/html'), GROUP);

  const issues = analyzer.finalize(GROUP).knowledgeData.issues;
  assert.equal(issues['no-items-sitemap'].severity, 'resolved');
  assert.deepEqual(issues['unreadable-sitemap'].subIssues.map((s) => s.url), [SITEINDEX]);
});

test('sitemap that never returned a body is not reported as empty', async () => {
  const analyzer = await siteWithSitemapIndex();
  analyzer.getNextUrls(GROUP);
  // e.g. the body was not captured in the HAR, or the navigation failed
  await analyzer.analyzeData(SITEINDEX, { log: { entries: [] } }, GROUP);

  const issues = analyzer.finalize(GROUP).knowledgeData.issues;
  assert.equal(issues['no-items-sitemap'].severity, 'resolved');
  assert.equal(issues['unreadable-sitemap'].severity, 'warning');
});

test('genuinely empty sitemap is still reported as no-items-sitemap', async () => {
  const analyzer = await siteWithSitemapIndex();
  analyzer.getNextUrls(GROUP);
  await analyzer.analyzeData(SITEINDEX, har(SITEINDEX, SITEINDEX_XML, 'text/xml'), GROUP);
  analyzer.getNextUrls(GROUP);

  await analyzer.analyzeData(CHILDREN[0], har(CHILDREN[0], urlsetXml(['a']), 'text/xml'), GROUP);
  await analyzer.analyzeData(CHILDREN[1], har(CHILDREN[1], urlsetXml([]), 'text/xml'), GROUP);
  await analyzer.analyzeData(CHILDREN[2], har(CHILDREN[2], urlsetXml(['c']), 'text/xml'), GROUP);

  const issues = analyzer.finalize(GROUP).knowledgeData.issues;
  assert.equal(issues['no-items-sitemap'].severity, 'warning');
  assert.equal(issues['no-items-sitemap'].category, 'standard');
  assert.equal(issues['unreadable-sitemap'].severity, 'resolved');
});

test('sitemapindex listing only other hosts is not reported as unreadable', async () => {
  const analyzer = await siteWithSitemapIndex();
  analyzer.getNextUrls(GROUP);
  const foreignOnly = '<?xml version="1.0"?><sitemapindex>' +
    '<sitemap><loc>https://example.dk/sitemap.xml</loc></sitemap></sitemapindex>';
  await analyzer.analyzeData(SITEINDEX, har(SITEINDEX, foreignOnly, 'text/xml'), GROUP);
  assert.deepEqual(analyzer.getNextUrls(GROUP), []);

  const issues = analyzer.finalize(GROUP).knowledgeData.issues;
  assert.equal(issues['no-same-host-sitemapindex'].severity, 'critical');
  assert.equal(issues['unreadable-sitemap'].severity, 'resolved');
});
