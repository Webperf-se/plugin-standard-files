import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { HarAnalyzer } from '../lib/harAnalyzer.js';
import { fetchSitemap, isGzipSitemapUrl } from '../lib/sitemapFetcher.js';

const URLSET = '<?xml version="1.0" encoding="UTF-8"?>' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  '<url><loc>https://example.com/a</loc></url>' +
  '<url><loc>https://example.com/b</loc></url>' +
  '</urlset>';

// ---------------------------------------------------------------------------
// fetchSitemap against a local server
// ---------------------------------------------------------------------------

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case '/as-file.xml.gz':
        // How sitemaps.org-style .xml.gz files are normally served: the body
        // is the gzip file itself, the browser would download it.
        res.writeHead(200, { 'Content-Type': 'application/x-gzip' });
        res.end(gzipSync(URLSET));
        break;
      case '/as-encoding.xml.gz':
        res.writeHead(200, {
          'Content-Type': 'application/xml',
          'Content-Encoding': 'gzip'
        });
        res.end(gzipSync(URLSET));
        break;
      case '/plain.xml.gz':
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(URLSET);
        break;
      case '/broken.xml.gz':
        res.writeHead(200, { 'Content-Type': 'application/x-gzip' });
        res.end(Buffer.concat([gzipSync(URLSET).subarray(0, 12)]));
        break;
      default:
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body>Not found</body></html>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('isGzipSitemapUrl matches .gz paths only', () => {
  assert.equal(isGzipSitemapUrl('https://example.com/sitemap1.xml.gz'), true);
  assert.equal(isGzipSitemapUrl('https://example.com/SITEMAP.XML.GZ'), true);
  assert.equal(isGzipSitemapUrl('https://example.com/sitemap.xml.gz?v=2'), true);
  assert.equal(isGzipSitemapUrl('https://example.com/sitemap.xml'), false);
  assert.equal(isGzipSitemapUrl('https://example.com/gz/sitemap.xml'), false);
  assert.equal(isGzipSitemapUrl('not a url'), false);
});

test('fetchSitemap unpacks a gzip file served as application/x-gzip', async () => {
  const res = await fetchSitemap(`${base}/as-file.xml.gz`);
  assert.equal(res.status, 200);
  assert.equal(res.mimeType, 'application/x-gzip');
  assert.equal(res.content, URLSET);
});

test('fetchSitemap reads a sitemap served with Content-Encoding: gzip', async () => {
  const res = await fetchSitemap(`${base}/as-encoding.xml.gz`);
  assert.equal(res.status, 200);
  assert.equal(res.content, URLSET);
});

test('fetchSitemap reads an uncompressed body behind a .gz url', async () => {
  const res = await fetchSitemap(`${base}/plain.xml.gz`);
  assert.equal(res.content, URLSET);
});

test('fetchSitemap returns the status of an error page', async () => {
  const res = await fetchSitemap(`${base}/missing.xml.gz`);
  assert.equal(res.status, 404);
});

test('fetchSitemap rejects a truncated gzip file', async () => {
  await assert.rejects(fetchSitemap(`${base}/broken.xml.gz`));
});

// ---------------------------------------------------------------------------
// HarAnalyzer: .gz sitemaps bypass the browser
// ---------------------------------------------------------------------------

const GROUP = 'example.com';
const PAGE = 'https://example.com/';
const ROBOTS = 'https://example.com/robots.txt';
const INDEX = 'https://example.com/sitemapindex.xml';
const GZ_CHILD = 'https://example.com/sitemap1.xml.gz';

function har(url, content, mimeType = 'text/plain', status = 200) {
  return {
    log: {
      entries: [{
        request: { url },
        response: { status, content: { text: content, mimeType } }
      }]
    }
  };
}

async function siteWithGzipChild() {
  const analyzer = new HarAnalyzer();
  analyzer.getInitialUrls(PAGE, GROUP);
  await analyzer.analyzeData(PAGE, har(PAGE, '<html><body>hi</body></html>', 'text/html'), GROUP);
  await analyzer.analyzeData(ROBOTS,
    har(ROBOTS, `User-agent: *\nDisallow:\nSitemap: ${INDEX}\n`), GROUP);
  analyzer.getNextUrls(GROUP);
  await analyzer.analyzeData(INDEX, har(INDEX,
    `<?xml version="1.0"?><sitemapindex><sitemap><loc>${GZ_CHILD}</loc></sitemap></sitemapindex>`,
    'application/xml'), GROUP);
  return analyzer;
}

test('a .gz sitemap is fetched directly and never sent to the browser', async () => {
  const analyzer = await siteWithGzipChild();
  const browserUrls = [];
  const fetched = [];
  await analyzer.dispatchNextUrls(GROUP, (url) => browserUrls.push(url), async (url) => {
    fetched.push(url);
    return { url, status: 200, mimeType: 'application/x-gzip', content: URLSET };
  });

  assert.deepEqual(browserUrls, []);
  assert.deepEqual(fetched, [GZ_CHILD]);

  const issues = analyzer.finalize(GROUP).knowledgeData.issues;
  assert.equal(issues['unreadable-sitemap'].severity, 'resolved');
  assert.equal(issues['no-items-sitemap'].severity, 'resolved');
});

test('a .gz sitemapindex queues its plain children for the browser', async () => {
  const analyzer = new HarAnalyzer();
  analyzer.getInitialUrls(PAGE, GROUP);
  const gzIndex = 'https://example.com/sitemap_index.xml.gz';
  const child = 'https://example.com/sitemap-pages.xml';
  await analyzer.analyzeData(ROBOTS,
    har(ROBOTS, `User-agent: *\nDisallow:\nSitemap: ${gzIndex}\n`), GROUP);

  const browserUrls = [];
  await analyzer.dispatchNextUrls(GROUP, (url) => browserUrls.push(url), async (url) => ({
    url,
    status: 200,
    mimeType: 'application/x-gzip',
    content: `<?xml version="1.0"?><sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`
  }));

  assert.ok(browserUrls.includes(child));
  assert.ok(!browserUrls.includes(gzIndex));
});

test('a failed .gz fetch is reported as unreadable with the reason', async () => {
  const analyzer = await siteWithGzipChild();
  await analyzer.dispatchNextUrls(GROUP, () => {}, async () => {
    throw new Error('incorrect header check');
  });

  const issue = analyzer.finalize(GROUP).knowledgeData.issues['unreadable-sitemap'];
  assert.equal(issue.severity, 'warning');
  assert.equal(issue.subIssues[0].url, GZ_CHILD);
  assert.match(issue.subIssues[0].text, /incorrect header check/);
});
