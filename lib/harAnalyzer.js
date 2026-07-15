import { JSDOM, VirtualConsole } from 'jsdom';

// jsdom logs "Could not parse CSS stylesheet" to the console for every
// stylesheet it cannot parse. We only use jsdom to read <link> elements for
// feed discovery, so route its output to a silent VirtualConsole to keep the
// sitespeed.io run log clean.
const silentVirtualConsole = new VirtualConsole();
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSitemap } from './sitemapParser.js';

const TEST_NAME = 'standard-files';

// Same list as KNOWN_EXTENSIONS in webperf_core/tests/standard_files.py
const KNOWN_EXTENSIONS = [
  'bmp', 'css', 'doc', 'docx', 'dot', 'eot', 'exe', 'git',
  'ico', 'ics', 'jpeg', 'jpg', 'js', 'json', 'md', 'mov', 'mp3',
  'mp4', 'pdf', 'png', 'ppt', 'pptx', 'pub', 'svg', 'tif',
  'txt', 'unknown-in-download', 'webp', 'wmv', 'xls', 'xlsx', 'xml', 'zip'
];

// Mirrors ALL_RULES in standard_files.py (severity + category preserved for
// score continuity with the old Python test).
const RULES = {
  'no-robots-txt': { severity: 'error', category: 'standard' },
  'no-sitemap-in-robots-txt': { severity: 'error', category: 'standard' },
  'no-valid-sitemap-found': { severity: 'error', category: 'standard' },
  'no-same-domain-sitemap': { severity: 'warning', category: 'standard' },
  'no-https-sitemap': { severity: 'error', category: 'security' },
  'no-duplicates-sitemap': { severity: 'warning', category: 'standard' },
  'no-unknown-types-sitemap': { severity: 'warning', category: 'standard' },
  'invalid-sitemap-too-large': { severity: 'warning', category: 'standard' },
  'no-items-sitemap': { severity: 'warning', category: 'standard' },
  'no-rss-feed': { severity: 'warning', category: 'standard' },
  'no-security-txt': { severity: 'error', category: 'security' },
  'invalid-security-txt': { severity: 'error', category: 'security' },
  'no-security-txt-contact': { severity: 'warning', category: 'security' },
  'no-security-txt-expires': { severity: 'warning', category: 'security' },
  'no-network': { severity: 'warning', category: 'technical' }
};

// Safety cap so a malicious / huge sitemapindex can't make us crawl forever.
const MAX_SITEMAP_FETCHES = 50;

export class HarAnalyzer {
  constructor() {
    this.groups = {};
    this.rules = RULES;
    this.knownExtensions = KNOWN_EXTENSIONS;

    const libFolder = fileURLToPath(new URL('..', import.meta.url));
    this.pluginFolder = path.resolve(libFolder, '..');
    const packagePath = path.resolve(libFolder, 'package.json');
    this.package = JSON.parse(readFileSync(packagePath, 'utf8'));
    this.dependencies = this.package.dependencies;
    this.version = this.package.version;
  }

  // ---------------------------------------------------------------------------
  // URL classification helpers
  // ---------------------------------------------------------------------------

  getRootUrl(url) {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  }

  classify(group, navUrl) {
    const state = this.groups[group];
    if (!state) {
      return 'page';
    }
    if (navUrl === state.robotsUrl) {
      return 'robots';
    }
    if (navUrl === state.wellKnownSecurityUrl) {
      return 'security-wellknown';
    }
    if (navUrl === state.rootSecurityUrl) {
      return 'security-root';
    }
    if (state.sitemapUrls.has(navUrl)) {
      return 'sitemap';
    }
    return 'page';
  }

  // ---------------------------------------------------------------------------
  // Stage 1: enqueue the origin-level files once per group
  // ---------------------------------------------------------------------------

  getInitialUrls(pageUrl, group) {
    if (this.groups[group] !== undefined) {
      // Only set up the origin-level checks once per group/site.
      return [];
    }

    const rootUrl = this.getRootUrl(pageUrl);
    const robotsUrl = rootUrl + 'robots.txt';
    const wellKnownSecurityUrl = rootUrl + '.well-known/security.txt';
    const rootSecurityUrl = rootUrl + 'security.txt';

    this.groups[group] = {
      mainUrl: pageUrl,
      rootUrl,
      robotsDomain: new URL(rootUrl).hostname,
      robotsUrl,
      wellKnownSecurityUrl,
      rootSecurityUrl,

      failed: false,

      robots: { url: robotsUrl, status: 'missing content', content: null },
      robotsSitemapUrls: [],

      sitemapUrls: new Set(),     // every sitemap url we have enqueued
      fetchedSitemaps: new Set(), // sitemaps we have already parsed
      sitemaps: {},               // url -> per-sitemap dict
      sitemapindexes: new Set(),

      feedChecked: false,
      feeds: [],

      security: { txts: {} },

      pendingUrls: [],
      analyzedData: [],
      knowledgeData: null
    };

    // Fetch robots.txt and .well-known/security.txt first. The root
    // security.txt is only fetched if .well-known is missing/wrong (matches
    // standard_files.py), and sitemap urls are discovered from robots.txt.
    return [robotsUrl, wellKnownSecurityUrl];
  }

  getNextUrls(group) {
    const state = this.groups[group];
    if (!state) {
      return [];
    }
    const next = state.pendingUrls;
    state.pendingUrls = [];
    return next;
  }

  // ---------------------------------------------------------------------------
  // HAR -> simplified data
  // ---------------------------------------------------------------------------

  getFirstPageEntries(navUrl, harData) {
    let log = harData;
    if (log && 'log' in log) {
      log = log.log;
    }
    if (!log || !Array.isArray(log.entries)) {
      return [];
    }
    const entries = log.entries;

    // A HAR can contain more than one page, for example when a concurrent
    // browsertime run ends up in the same browser session (crossed DevTools
    // port) and navigates to another website mid-recording. Requests made
    // by other pages must not be attributed to the tested website, and if
    // the recording doesn't even start with the navigated url's host nothing
    // in it can be trusted.
    if (navUrl && entries.length > 0) {
      const firstUrl = entries[0].request && entries[0].request.url;
      if (firstUrl) {
        try {
          if (new URL(firstUrl).hostname !== new URL(navUrl).hostname) {
            return [];
          }
        } catch {
          // Unparsable URLs are handled by the entry loops as before
        }
      }
    }

    const pages = log.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      return entries;
    }
    const firstPageId = pages[0].id;
    if (firstPageId === undefined) {
      return entries;
    }
    return entries.filter(entry =>
      entry.pageref === undefined || entry.pageref === firstPageId);
  }

  transform2SimplifiedData(harData, navUrl) {
    const data = { url: navUrl, primary: null, htmls: [] };

    for (const entry of this.getFirstPageEntries(navUrl, harData)) {
      const req = entry.request || {};
      const res = entry.response || {};
      const content = res.content || {};
      const reqUrl = req.url;

      if (!content.text || !content.mimeType || !res.status) {
        continue;
      }

      const obj = {
        url: reqUrl,
        status: res.status,
        mimeType: content.mimeType,
        content: content.text
      };

      // The first entry whose url matches the navigated url is the document
      // we asked the browser to load.
      if (data.primary === null && reqUrl === navUrl) {
        data.primary = obj;
      }
      if (content.mimeType.includes('html')) {
        data.htmls.push(obj);
      }
    }

    // Fallback: some setups report the document under a slightly different
    // url (trailing slash, redirect). Use the first html as primary.
    if (data.primary === null && data.htmls.length > 0) {
      data.primary = data.htmls[0];
    }

    return data;
  }

  // ---------------------------------------------------------------------------
  // Stage 2..n: accumulate as each fetched file comes back
  // ---------------------------------------------------------------------------

  async analyzeData(navUrl, harData, group) {
    const state = this.groups[group];
    if (!state) {
      // We never saw the originating page url for this group; nothing to do.
      return this.emptyResult(navUrl, group);
    }

    const analyzed = this.transform2SimplifiedData(harData, navUrl);
    state.analyzedData.push(analyzed);

    const kind = this.classify(group, navUrl);
    switch (kind) {
      case 'robots':
        this.handleRobots(state, analyzed);
        break;
      case 'security-wellknown':
        this.handleSecurity(state, analyzed, state.wellKnownSecurityUrl, true);
        break;
      case 'security-root':
        this.handleSecurity(state, analyzed, state.rootSecurityUrl, false);
        break;
      case 'sitemap':
        this.handleSitemap(state, analyzed, navUrl);
        break;
      case 'page':
      default:
        this.handlePage(state, analyzed);
        break;
    }

    return {
      version: this.version,
      dependencies: this.dependencies,
      url: navUrl,
      analyzedData: analyzed,
      knowledgeData: null // finalized at summarize time
    };
  }

  handlePage(state, analyzed) {
    // The main page drives the RSS/Atom feed check and the no-network check.
    if (!state.feedChecked) {
      const html = analyzed.primary && analyzed.primary.content
        ? analyzed.primary.content
        : (analyzed.htmls[0] ? analyzed.htmls[0].content : null);

      if (!html) {
        state.failed = true;
      } else {
        state.feeds = this.findFeeds(html);
      }
      state.feedChecked = true;
    }
  }

  handleRobots(state, analyzed) {
    const content = analyzed.primary ? analyzed.primary.content : null;
    const lower = (content || '').toLowerCase();

    const looksLikeHtml = lower.includes('</html>');
    const hasDirectives =
      lower.includes('user-agent') ||
      lower.includes('disallow') ||
      lower.includes('allow');

    if (!content || looksLikeHtml || !hasDirectives) {
      state.robots = { url: state.robotsUrl, status: 'missing content', content: null };
      return;
    }

    state.robots = { url: state.robotsUrl, status: 'ok', content };

    // Discover sitemaps declared in robots.txt: `Sitemap: <url>`
    const regex = /^sitemap:([^\n]+)/gim;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const sitemapUrl = match[1].trim();
      if (sitemapUrl && !state.sitemapUrls.has(sitemapUrl)) {
        state.robotsSitemapUrls.push(sitemapUrl);
        state.sitemapUrls.add(sitemapUrl);
        state.pendingUrls.push(sitemapUrl);
      }
    }
  }

  handleSitemap(state, analyzed, navUrl) {
    state.fetchedSitemaps.add(navUrl);
    const content = analyzed.primary ? analyzed.primary.content : null;
    if (!content) {
      return;
    }

    const parsed = parseSitemap(content);

    if (parsed.type === 'sitemapindex') {
      state.sitemapindexes.add(navUrl);
      for (const childUrl of parsed.locs) {
        if (state.sitemapUrls.has(childUrl)) {
          continue;
        }
        if (state.sitemapUrls.size >= MAX_SITEMAP_FETCHES) {
          break;
        }
        state.sitemapUrls.add(childUrl);
        state.pendingUrls.push(childUrl);
      }
      return;
    }

    // urlset (or unknown but with <loc> entries)
    if (state.sitemaps[navUrl]) {
      // duplicate sitemap url
      state.sitemaps[navUrl].is_duplicate = true;
      return;
    }
    state.sitemaps[navUrl] = this.createSitemapDict(parsed.locs, state.robotsDomain);
  }

  handleSecurity(state, analyzed, url, isWellKnown) {
    const content = analyzed.primary ? analyzed.primary.content : null;
    const status = this.validateSecurityTxt(content);
    state.security.txts[url] = { url, status };

    // Only fall back to /security.txt when .well-known is missing or wrong,
    // matching standard_files.py.
    if (isWellKnown && (status === 'wrong content' || status === 'missing')) {
      if (!state.sitemapUrls.has(state.rootSecurityUrl)) {
        state.pendingUrls.push(state.rootSecurityUrl);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-check helpers (ported from standard_files.py)
  // ---------------------------------------------------------------------------

  findFeeds(html) {
    const feeds = [];
    try {
      const dom = new JSDOM(html, { virtualConsole: silentVirtualConsole });
      const links = dom.window.document.querySelectorAll('link');
      links.forEach((link) => {
        const type = (link.getAttribute('type') || '').toLowerCase();
        if (
          type.includes('application/rss+xml') ||
          type.includes('application/atom+xml') ||
          type.includes('application/feed+json')
        ) {
          feeds.push(link.getAttribute('href'));
        }
      });
    } catch {
      // Malformed HTML -> treat as no feeds discovered.
    }
    return feeds;
  }

  validateSecurityTxt(content) {
    const lower = (content || '').toLowerCase();
    if (!content || content === '' || lower.includes('<html')) {
      return 'wrong content';
    }
    const hasContact = lower.includes('contact:');
    const hasExpires = lower.includes('expires:');
    if (hasContact && hasExpires) {
      return 'ok';
    }
    if (!hasContact && !hasExpires) {
      return 'wrong content, no contact or expires';
    }
    if (!hasContact) {
      return 'required contact missing';
    }
    // has contact, missing expires
    return 'required expires missing';
  }

  createSitemapDict(items, robotsDomain) {
    const nofItems = items.length;
    const nofNoDuplicates = new Set(items).size;

    const dict = {
      use_https_only: true,
      use_same_domain: true,
      known_types: {},
      has_duplicates_items: nofItems > nofNoDuplicates,
      is_duplicate: false,
      nof_items: nofItems,
      nof_items_no_duplicates: nofNoDuplicates
    };

    const itemTypes = {};
    for (const itemUrl of items) {
      let itemType = 'webpage';

      if (!itemUrl.toLowerCase().startsWith('https://')) {
        dict.use_https_only = false;
      }

      let parsed;
      try {
        parsed = new URL(itemUrl);
      } catch {
        parsed = null;
      }

      if (parsed) {
        if (robotsDomain !== parsed.hostname) {
          dict.use_same_domain = false;
        }
        const ext = this.extOf(parsed.pathname);
        if (ext.length >= 2 && ext.length <= 4) {
          if (this.knownExtensions.includes(ext)) {
            itemType = ext;
          }
        } else if (parsed.pathname.startsWith('/download/')) {
          itemType = 'unknown-in-download';
        }
      }

      if (!itemTypes[itemType]) {
        itemTypes[itemType] = [];
      }
      itemTypes[itemType].push(itemUrl);
    }

    for (const key of Object.keys(itemTypes).sort()) {
      dict.known_types[key] = itemTypes[key].length;
    }
    return dict;
  }

  extOf(pathname) {
    const base = pathname.split('/').pop() || '';
    const idx = base.lastIndexOf('.');
    if (idx < 0) {
      return '';
    }
    return base.substring(idx + 1).toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Finalize: build knowledgeData.issues for the group
  // ---------------------------------------------------------------------------

  finalize(group) {
    const state = this.groups[group];
    if (!state) {
      return this.emptyResult(group, group);
    }

    const knowledgeData = {
      url: state.mainUrl,
      group,
      issues: {}
    };

    if (state.failed) {
      // Mirror standard_files.py: on a network failure only emit no-network.
      this.addIssue(knowledgeData, 'no-network', state.mainUrl,
        'No HTML content found in the HAR file.');
      state.knowledgeData = knowledgeData;
      return this.wrap(state, knowledgeData);
    }

    this.addRobotsIssues(knowledgeData, state);
    this.addSitemapIssues(knowledgeData, state);
    this.addFeedIssues(knowledgeData, state);
    this.addSecurityIssues(knowledgeData, state);

    // Pad every non-triggered rule as "resolved" (no-network excluded, exactly
    // like addResolvedIssues in standard_files.py).
    for (const rule of Object.keys(this.rules)) {
      if (rule === 'no-network') {
        continue;
      }
      if (!knowledgeData.issues[rule]) {
        knowledgeData.issues[rule] = {
          test: TEST_NAME,
          rule,
          category: this.rules[rule].category,
          severity: 'resolved',
          subIssues: []
        };
      }
    }

    state.knowledgeData = knowledgeData;
    return this.wrap(state, knowledgeData);
  }

  addRobotsIssues(knowledgeData, state) {
    if (state.robots.status !== 'ok') {
      this.addIssue(knowledgeData, 'no-robots-txt', state.robotsUrl);
    }
  }

  addSitemapIssues(knowledgeData, state) {
    const robotsOk = state.robots.status === 'ok';
    const robotsHasSitemap = robotsOk &&
      state.robots.content.toLowerCase().includes('sitemap:');

    if (!robotsOk || !robotsHasSitemap) {
      this.addIssue(knowledgeData, 'no-sitemap-in-robots-txt', state.mainUrl);
      return;
    }

    if (state.robotsSitemapUrls.length === 0) {
      this.addIssue(knowledgeData, 'no-valid-sitemap-found', state.mainUrl);
      return;
    }

    const sitemaps = Object.entries(state.sitemaps);
    let totalItems = 0;
    let totalNoDup = 0;
    let useHttpsOnly = true;
    let useSameDomain = true;
    let isDuplicate = false;
    const knownTypes = {};

    for (const [, sm] of sitemaps) {
      totalItems += sm.nof_items;
      totalNoDup += sm.nof_items_no_duplicates;
      if (!sm.use_https_only) { useHttpsOnly = false; }
      if (!sm.use_same_domain) { useSameDomain = false; }
      if (sm.is_duplicate) { isDuplicate = true; }
      // Per-sitemap internal duplicates already make totalItems !== totalNoDup,
      // which triggers no-duplicates-sitemap below.
      Object.assign(knownTypes, sm.known_types);
    }

    if (totalItems > 0) {
      if (!useHttpsOnly) {
        this.addIssue(knowledgeData, 'no-https-sitemap', state.mainUrl);
      }
      if (!useSameDomain) {
        this.addIssue(knowledgeData, 'no-same-domain-sitemap', state.mainUrl);
      }
      if (totalItems !== totalNoDup) {
        this.addIssue(knowledgeData, 'no-duplicates-sitemap', state.mainUrl);
      }
      if (Object.keys(knownTypes).length > 1) {
        this.addIssue(knowledgeData, 'no-unknown-types-sitemap', state.mainUrl);
      }
    }

    if (isDuplicate) {
      this.addIssue(knowledgeData, 'no-duplicates-sitemap', state.mainUrl);
    }

    for (const [, sm] of sitemaps) {
      if (sm.nof_items > 50000) {
        this.addIssue(knowledgeData, 'invalid-sitemap-too-large', state.mainUrl);
      } else if (sm.nof_items === 0) {
        this.addIssue(knowledgeData, 'no-items-sitemap', state.mainUrl);
      }
    }

    if (totalItems === 0) {
      this.addIssue(knowledgeData, 'no-items-sitemap', state.mainUrl);
    }
  }

  addFeedIssues(knowledgeData, state) {
    if (state.feeds.length === 0) {
      this.addIssue(knowledgeData, 'no-rss-feed', state.mainUrl);
    }
  }

  addSecurityIssues(knowledgeData, state) {
    const txts = Object.values(state.security.txts);
    const anyOk = txts.some((t) => t.status === 'ok');
    if (anyOk) {
      return; // resolved padding handles the rest
    }

    for (const txt of txts) {
      switch (txt.status) {
        case 'missing':
          this.addIssue(knowledgeData, 'no-security-txt', txt.url);
          this.addIssue(knowledgeData, 'invalid-security-txt', txt.url);
          this.addIssue(knowledgeData, 'no-security-txt-contact', txt.url);
          this.addIssue(knowledgeData, 'no-security-txt-expires', txt.url);
          break;
        case 'wrong content':
          this.addIssue(knowledgeData, 'invalid-security-txt', txt.url);
          this.addIssue(knowledgeData, 'no-security-txt-contact', txt.url);
          this.addIssue(knowledgeData, 'no-security-txt-expires', txt.url);
          break;
        case 'required contact missing':
          this.addIssue(knowledgeData, 'no-security-txt-contact', txt.url);
          break;
        case 'required expires missing':
          this.addIssue(knowledgeData, 'no-security-txt-expires', txt.url);
          break;
        case 'wrong content, no contact or expires':
          this.addIssue(knowledgeData, 'no-security-txt-expires', txt.url);
          this.addIssue(knowledgeData, 'no-security-txt-contact', txt.url);
          break;
        default:
          break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Issue + result helpers
  // ---------------------------------------------------------------------------

  addIssue(knowledgeData, rule, url, text) {
    const rule_def = this.rules[rule];
    const subIssue = {
      url,
      rule,
      category: rule_def.category,
      severity: rule_def.severity
    };
    if (text !== undefined) {
      subIssue.text = text;
    }

    if (!knowledgeData.issues[rule]) {
      knowledgeData.issues[rule] = {
        test: TEST_NAME,
        rule,
        category: rule_def.category,
        severity: rule_def.severity,
        subIssues: [subIssue]
      };
    } else {
      knowledgeData.issues[rule].subIssues.push(subIssue);
    }
  }

  wrap(state, knowledgeData) {
    return {
      version: this.version,
      dependencies: this.dependencies,
      url: knowledgeData.url,
      analyzedData: state.analyzedData,
      knowledgeData
    };
  }

  emptyResult(url, group) {
    return {
      version: this.version,
      dependencies: this.dependencies,
      url,
      analyzedData: [],
      knowledgeData: { url, group, issues: {} }
    };
  }

  getSummary() {
    return this;
  }
}
