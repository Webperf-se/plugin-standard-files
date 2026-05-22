import { SitespeedioPlugin } from '@sitespeed.io/plugin';
import { HarAnalyzer } from './harAnalyzer.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const fsp = fs.promises;

// https://www.sitespeed.io/documentation/sitespeed.io/plugins/#create-your-own-plugin
// node bin/sitespeed.js -n 1 --plugins.add ../../../plugin-standard-files/lib/index.js --browsertime.chrome.includeResponseBodies all https://webperf.se
// With the aggregator:
// node bin/sitespeed.js -n 1 --plugins.add ../../../plugin-webperf-core/lib/index.js --plugins.add ../../../plugin-standard-files/lib/index.js https://webperf.se

const pluginname = 'webperf-plugin-standard-files';

export default class StandardFilesPlugin extends SitespeedioPlugin {
  constructor(options, context, queue) {
    super({ name: pluginname, options, context, queue });
  }

  async open(context, options) {
    this.make = context.messageMaker(pluginname).make;
    this.harAnalyzer = new HarAnalyzer();
    this.isWebperfCorePluginPresent = false;
    const libFolder = fileURLToPath(new URL('..', import.meta.url));
    this.pluginFolder = path.resolve(libFolder);
    this.options = options;
    this.version = this.harAnalyzer.version;
    this.dependencies = this.harAnalyzer.dependencies;

    this.pug = await fsp.readFile(
      path.resolve(this.pluginFolder, 'pug', 'index.pug'),
      'utf8'
    );
  }

  async processMessage(message, queue) {
    switch (message.type) {
      case 'browsertime.setup': {
        // We need full response bodies to read robots.txt / sitemap.xml /
        // security.txt content from the HAR.
        queue.postMessage(this.make('browsertime.config', {
          chrome: { includeResponseBodies: 'all' },
          firefox: { includeResponseBodies: 'all' }
        }));
        break;
      }
      case 'sitespeedio.setup': {
        // Let other plugins know that our plugin is alive
        queue.postMessage(this.make(pluginname + '.setup', {
          version: this.version,
          dependencies: this.dependencies
        }));
        // Add the HTML report tab
        queue.postMessage(
          this.make('html.pug', {
            id: pluginname,
            name: 'Standard files',
            pug: this.pug,
            type: 'pageSummary'
          })
        );
        queue.postMessage(
          this.make('html.pug', {
            id: pluginname,
            name: 'Standard files',
            pug: this.pug,
            type: 'run'
          })
        );
        break;
      }
      case 'plugin-webperf-core.setup': {
        this.isWebperfCorePluginPresent = true;
        break;
      }
      case 'url': {
        const url = message.url;
        const group = message.group;
        // Avoid acting on the urls we inject ourselves.
        if (message.source !== pluginname) {
          // Enqueue the origin-level files once per group/site.
          const initialUrls = this.harAnalyzer.getInitialUrls(url, group);
          for (const next of initialUrls) {
            queue.postMessage(this.make('url', {}, { url: next, group }));
          }
        }
        break;
      }
      case 'browsertime.har': {
        const url = message.url;
        const group = message.group;
        const harData = message.data;

        await this.harAnalyzer.analyzeData(url, harData, group);

        // Discover-as-you-go: robots.txt -> sitemaps -> sitemapindex children,
        // and .well-known/security.txt -> /security.txt fallback.
        const nextUrls = this.harAnalyzer.getNextUrls(group);
        for (const next of nextUrls) {
          queue.postMessage(this.make('url', {}, { url: next, group }));
        }
        break;
      }
      case 'sitespeedio.summarize': {
        const summary = this.harAnalyzer.getSummary();
        for (const group of Object.keys(summary.groups)) {
          // Standard files are origin-level and discovered across several
          // fetches, so we finalize and publish once per group here.
          const data = this.harAnalyzer.finalize(group);

          if (this.isWebperfCorePluginPresent) {
            super.sendMessage(pluginname + '.webPerfCoreSummary', data, {
              url: data.url,
              group
            });
          } else {
            // The HTML plugin picks up every *.pageSummary message and
            // publishes it under pageInfo.data.<id>.pageSummary
            super.sendMessage(pluginname + '.pageSummary', data, {
              url: data.url,
              group
            });
          }

          super.sendMessage(pluginname + '.summary', summary.groups[group], {
            group
          });
        }
        break;
      }
    }
  }
  // close(options, errors) {
  //   // Cleanup if necessary
  // }
}
