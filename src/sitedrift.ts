#!/usr/bin/env node
import { parseCommand, requireLiveBase, resolveCloudflareCommand, resolveConfig, printHelp, readVersion } from './cli.ts';
import type { ParsedCommand, ResolvedConfig } from './cli.ts';
import { createServer } from './server.ts';
import { resolveTls, setupHttps } from './tls.ts';
import { openBrowser } from './browser.ts';
import { runAgentCommand } from './agent.ts';
import { createSession, removeSession, writeSession } from './session.ts';
import { runMcpServer } from './mcp.ts';
import { installCloudflarePreview, scaffoldCloudflarePreview } from './cloudflare.ts';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function fail(message: string, code: number): never {
  console.error(`sitedrift: ${message}`);
  return process.exit(code);
}

let parsed: ParsedCommand | null;
try {
  parsed = parseCommand();
} catch (error) {
  fail(errorMessage(error), 2);
}
const command = parsed?.command;

if (command?.name === 'mcp') {
  runMcpServer();
} else if (command?.name === 'cloudflare') {
  try {
    const options = resolveCloudflareCommand(command);
    if (options.action === 'init') {
      const result = scaffoldCloudflarePreview(options);
      console.log(result.created
        ? `sitedrift: created ${result.functionFile}`
        : `sitedrift: ${result.functionFile} already exists, leaving it as is`);
      console.log('Next, add this to your package.json "build" script, after the framework build:');
      console.log(`    ${result.buildLine}`);
      console.log('Then commit both changes and push a preview branch.');
    } else {
      const result = installCloudflarePreview(options);
      if (result.installed) {
        console.log(`sitedrift: wrapped ${result.files} HTML files for Cloudflare preview ${result.branch}`);
      } else {
        console.log(`sitedrift: unchanged (${result.reason})`);
      }
    }
  } catch (error) {
    fail(errorMessage(error), 1);
  }
} else {
  let config: ResolvedConfig;
  try {
    config = resolveConfig(parsed?.argv ?? process.argv.slice(2), { requireLive: !command });
  } catch (error) {
    fail(errorMessage(error), 2);
  }

  if (config.help) { printHelp(); process.exit(0); }
  if (config.version) { console.log(readVersion()); process.exit(0); }
  if (config.setupHttps) { process.exit(setupHttps()); }
  if (command) {
    try {
      process.exit(await runAgentCommand(command, config));
    } catch (error) {
      console.error(JSON.stringify({ error: errorMessage(error) }));
      process.exit(1);
    }
  }

  let tls;
  try {
    tls = resolveTls(config);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }

  const serverConfig = requireLiveBase(config);
  const scheme = tls ? 'https' : 'http';
  const session = createSession(serverConfig, scheme, tls);
  const server = createServer(serverConfig, tls, session);
  const devFrameServer = createServer(serverConfig, tls, session, { control: false, side: 'dev' });
  const liveFrameServer = createServer(serverConfig, tls, session, { control: false, side: 'live' });
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
        console.log(`  DEV  ${serverConfig.devBase.href}`);
        console.log(`  LIVE ${serverConfig.liveBase.href}`);
        console.log('  API  sitedrift context');
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
