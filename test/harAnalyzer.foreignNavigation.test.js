import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarAnalyzer } from '../lib/harAnalyzer.js';

const entry = (url, extra = {}) => ({
  pageref: 'page_1',
  request: { url },
  response: { status: 200, content: {} },
  ...extra
});
const navigation = (url, extra = {}) =>
  entry(url, { _resourceType: 'document', _initiator_type: 'other', ...extra });
const iframe = (url) =>
  entry(url, { _resourceType: 'document', _initiator_type: 'parser' });

const har = (entries) => ({ log: { pages: [{ id: 'page_1' }], entries } });
const urls = (entries) => entries.map((e) => e.request.url);

const analyzer = new HarAnalyzer();

test('drops requests after a crossed-in navigation to another website', () => {
  const entries = [
    navigation('https://www.mucf.se/'),
    entry('https://www.mucf.se/style.css'),
    navigation('https://gambiagrupperna.org/'),
    entry('https://gambiagrupperna.org/style.css'),
    entry('https://cdnjs.cloudflare.com/owl.css')
  ];
  const result = analyzer.getFirstPageEntries('https://www.mucf.se', har(entries));
  assert.deepEqual(urls(result), ['https://www.mucf.se/', 'https://www.mucf.se/style.css']);
});

test('keeps the tested site after a redirect to another host', () => {
  const entries = [
    navigation('https://mucf.se/', { response: { status: 301, redirectURL: 'https://www.mucf.se/', content: {} } }),
    navigation('https://www.mucf.se/'),
    entry('https://www.mucf.se/style.css')
  ];
  const result = analyzer.getFirstPageEntries('https://mucf.se', har(entries));
  assert.equal(result.length, 3);
});

test('keeps third party iframes and subresources', () => {
  const entries = [
    navigation('https://www.mucf.se/'),
    iframe('https://www.google.com/recaptcha/anchor'),
    entry('https://www.gstatic.com/recaptcha/styles.css')
  ];
  const result = analyzer.getFirstPageEntries('https://www.mucf.se', har(entries));
  assert.equal(result.length, 3);
});

test('still drops entries from other pages and recordings starting elsewhere', () => {
  const other = entry('https://gambiagrupperna.org/a.css', { pageref: 'page_2' });
  const mixed = har([navigation('https://www.mucf.se/'), other]);
  assert.equal(analyzer.getFirstPageEntries('https://www.mucf.se', mixed).length, 1);

  const wrongStart = har([navigation('https://gambiagrupperna.org/')]);
  assert.deepEqual(analyzer.getFirstPageEntries('https://www.mucf.se', wrongStart), []);
});

test('HARs without initiator information behave as before', () => {
  const entries = [entry('https://www.mucf.se/'), entry('https://gambiagrupperna.org/x.css')];
  const result = analyzer.getFirstPageEntries('https://www.mucf.se', har(entries));
  assert.equal(result.length, 2);
});
