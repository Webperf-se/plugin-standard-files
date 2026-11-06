// Focused reimplementation of the parts of webperf_core's
// engines/sitemap.read_sitemap that standard_files.py relies on.
//
// In the sitespeed.io model the file has already been fetched by a real
// browser, so the content we receive here is the (already decompressed)
// response body. We therefore only need to:
//   * tell a <sitemapindex> apart from a <urlset>
//   * pull out every <loc> value
//
// Gzipped sitemaps (.xml.gz) never reach the HAR: the browser downloads them
// instead of loading them, so sitemapFetcher.js fetches and unpacks them and
// hands us text as well. Raw binary still bails out gracefully (see
// looksLikeXml).

const LOC_REGEX = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;

export function looksLikeXml(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return false;
  }
  const lower = content.toLowerCase();
  return lower.includes('<urlset') ||
    lower.includes('<sitemapindex') ||
    lower.includes('<loc>');
}

/**
 * Parse a sitemap or sitemapindex body.
 * @param {string} content raw response body
 * @returns {{type: 'sitemapindex'|'urlset'|'unknown', locs: string[]}}
 */
export function parseSitemap(content) {
  if (!looksLikeXml(content)) {
    return { type: 'unknown', locs: [] };
  }

  const lower = content.toLowerCase();
  const isIndex = lower.includes('<sitemapindex');

  const locs = [];
  let match;
  // Reset lastIndex because the regex is declared with the /g flag.
  LOC_REGEX.lastIndex = 0;
  while ((match = LOC_REGEX.exec(content)) !== null) {
    const loc = decodeXmlEntities(match[1].trim());
    if (loc.length > 0) {
      locs.push(loc);
    }
  }

  return {
    type: isIndex ? 'sitemapindex' : 'urlset',
    locs
  };
}

function decodeXmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
