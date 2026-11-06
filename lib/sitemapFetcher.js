// Direct (non-browser) fetch for gzipped sitemaps.
//
// Everything else in this plugin is fetched by the browser and read from the
// HAR. A sitemap in the .xml.gz format can't be: it is normally served as the
// gzip file itself (Content-Type: application/x-gzip, no Content-Encoding),
// which Chrome treats as a download. No page loads, browsertime retries for
// minutes and the sitemap ends up as unreadable even though it is valid
// (https://www.sitemaps.org/protocol.html#index).

import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';

const gunzipAsync = promisify(gunzip);

const TIMEOUT_MS = 60_000;
// The sitemap protocol caps an uncompressed sitemap at 50 MB; anything that
// unpacks to more is not a sitemap (or is a gzip bomb).
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export function isGzipSitemapUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.gz');
  } catch {
    return false;
  }
}

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Fetch a sitemap and return it in the same shape as a HAR-derived entry.
 * fetch already undoes Content-Encoding: gzip, so the body is only unpacked
 * here when it still is a gzip file.
 * @param {string} url
 * @param {{userAgent?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{url: string, status: number, mimeType: string, content: string}>}
 */
export async function fetchSitemap(url, options = {}) {
  const headers = {};
  if (options.userAgent) {
    headers['User-Agent'] = options.userAgent;
  }
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)
  });

  let bytes = Buffer.from(await response.arrayBuffer());
  if (isGzip(bytes)) {
    bytes = await gunzipAsync(bytes, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  }

  return {
    url: response.url || url,
    status: response.status,
    mimeType: response.headers.get('content-type') || '',
    content: bytes.toString('utf8')
  };
}
