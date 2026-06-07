#!/usr/bin/env node
import { parseCommand, resolveConfig, printHelp, readVersion } from './src/cli.mjs';
import { createServer } from './src/server.mjs';
import { resolveTls, setupHttps } from './src/tls.mjs';
import { openBrowser } from './src/browser.mjs';
import { runAgentCommand } from './src/agent.mjs';
import { createSession, removeSession, writeSession } from './src/session.mjs';
import { runMcpServer } from './src/mcp.mjs';
import { installCloudflarePreview } from './src/cloudflare.mjs';

let command;
let config;
try {
  const parsed = parseCommand();
  command = parsed?.command;
} catch (error) {
  console.error(`sitedrift: ${error.message}`);
  process.exit(2);
}

if (command?.name === 'mcp') {
  runMcpServer();
} else if (command?.name === 'cloudflare') {
  try {
    const result = installCloudflarePreview(command);
    console.log(result.installed
      ? `sitedrift: wrapped ${result.files} HTML files for Cloudflare preview ${result.branch}`
      : `sitedrift: unchanged (${result.reason})`);
  } catch (error) {
    console.error(`sitedrift: ${error.message}`);
    process.exit(1);
  }
} else {
  try {
    const parsed = parseCommand();
    config = resolveConfig(parsed?.argv ?? process.argv.slice(2), { requireLive: !command });
  } catch (error) {
    console.error(`sitedrift: ${error.message}`);
    process.exit(2);
  }

  if (config.help) { printHelp(); process.exit(0); }
  if (config.version) { console.log(readVersion()); process.exit(0); }
  if (config.setupHttps) { process.exit(setupHttps()); }
  if (command) {
    try {
      process.exit(await runAgentCommand(command, config));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exit(1);
    }
  }

  let tls;
  try {
    tls = resolveTls(config);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const scheme = tls ? 'https' : 'http';
  const session = createSession(config, scheme);
  const server = createServer(config, tls, session);
  const devFrameServer = createServer(config, tls, session, { control: false, side: 'dev' });
  const liveFrameServer = createServer(config, tls, session, { control: false, side: 'live' });
  const servers = [server, devFrameServer, liveFrameServer];
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      removeSession(config);
      devFrameServer.close();
      liveFrameServer.close();
      server.close(() => process.exit(0));
    });
  }
  process.once('exit', () => removeSession(config));

  devFrameServer.listen(config.port + 1, config.host, () => {
    liveFrameServer.listen(config.port + 2, config.host, () => {
      server.listen(config.port, config.host, () => {
        writeSession(config, session);
        const startUrl = `${session.url}/`
          + (config.initialPath ? `?path=${encodeURIComponent(config.initialPath)}` : '');
        console.log(`sitedrift: ${startUrl}`);
        console.log(`  DEV  ${config.devBase.href}`);
        console.log(`  LIVE ${config.liveBase.href}`);
        console.log(`  API  sitedrift context`);
        if (config.open) openBrowser(startUrl);
      });
    });
  });

  for (const current of servers) {
    current.on('error', (error) => {
      removeSession(config);
      for (const other of servers) other.close();
      console.error(`sitedrift: ${error.message}`);
      process.exit(1);
    });
  }
}
