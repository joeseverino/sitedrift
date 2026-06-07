#!/usr/bin/env node
import { resolveConfig, printHelp, readVersion } from './src/cli.mjs';
import { createServer } from './src/server.mjs';
import { openBrowser } from './src/browser.mjs';

const config = resolveConfig();

if (config.help) { printHelp(); process.exit(0); }
if (config.version) { console.log(readVersion()); process.exit(0); }

const server = createServer(config);

server.listen(config.port, config.host, () => {
  const scheme = config.certFile && config.keyFile ? 'https' : 'http';
  const startUrl = `${scheme}://${config.host}:${config.port}/`
    + (config.initialPath ? `?path=${encodeURIComponent(config.initialPath)}` : '');
  console.log(`sitedrift: ${startUrl}`);
  console.log(`  DEV  ${config.devBase.href}`);
  console.log(`  LIVE ${config.liveBase.href}`);
  if (config.open) openBrowser(startUrl);
});
