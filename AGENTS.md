# sitedrift for agents

sitedrift compares a local site with production and keeps a shared review-note
channel for humans and AI tools. Prefer the packaged MCP server. Use the JSON CLI
only when the host cannot run MCP.

## Fast path

1. Install once: `npm install --global sitedrift`
2. In the project, create `sitedrift.config.json`:

   ```json
   {
     "dev": "http://localhost:4321",
     "live": "https://example.com",
     "open": true
   }
   ```

3. Start the app: `sitedrift`
4. Configure the AI host to run:

   ```json
   {
     "command": "sitedrift-mcp",
     "args": []
   }
   ```

   No global install: use `"command": "npx"` and
   `"args": ["-y", "sitedrift", "mcp"]`.

   Common one-command setup:

   ```bash
   codex mcp add sitedrift -- sitedrift-mcp
   claude mcp add sitedrift -- sitedrift-mcp
   ```

   For Cursor and other JSON-configured hosts, put this in the host's MCP
   configuration under `mcpServers`:

   ```json
   {
     "sitedrift": {
       "command": "sitedrift-mcp",
       "args": []
     }
   }
   ```

## Agent workflow

1. Call `sitedrift_context` first. Do not guess the URLs or active session.
2. Inspect the requested route in the viewer or with the host's browser tools.
3. Call `sitedrift_notes_list` before adding notes to avoid duplicates.
4. Add one concrete finding per `sitedrift_note_add` call. Always provide
   `route`; provide `side` when the issue belongs specifically to DEV or LIVE.
5. Re-list notes after code changes. Resolve only findings you verified.
6. Remove or clear notes only when the user explicitly requests it.

Hosted Cloudflare preview deployments are a different mode: their notes are
browser-local and intentionally unavailable to MCP. Use browser inspection for
those URLs. Do not claim that a hosted note was shared with an agent or written
to the project. Setup is two project changes and is documented in
`docs/CLOUDFLARE-PAGES.md`; do not instruct users to change Cloudflare dashboard
settings or bindings.

## MCP tools

- `sitedrift_context`: active targets, viewer URL, and capabilities.
- `sitedrift_notes_list`: shared findings.
- `sitedrift_note_add`: add one actionable finding.
- `sitedrift_note_resolve`: mark a verified finding complete.
- `sitedrift_note_reopen`: reopen a regressed or incomplete finding.
- `sitedrift_note_remove`: permanently remove one finding.
- `sitedrift_notes_clear`: permanently remove all findings.
- `sitedrift_setup`: return install, config, HTTPS, and MCP setup instructions.

Default port is `4178`. Pass `port` to every tool when the user runs another
session port.

## CLI fallback

```bash
sitedrift context
sitedrift notes list
sitedrift notes add "CTA differs" --route /pricing --side live --author agent
sitedrift notes resolve <id>
```

All CLI output is JSON. The MCP server communicates over stdio and writes no
logs to stdout.

## HTTPS

Loopback HTTP is normally sufficient. When the compared site requires HTTPS:

```bash
sitedrift --setup-https
sitedrift --https
```

## Security

sitedrift accepts loopback hosts only. The control API uses a random bearer
token stored in `~/.sitedrift/sessions/<port>.json` with mode `0600`. DEV and
LIVE render on separate origins. Never expose sitedrift through a public proxy.

The optional Cloudflare Pages addon is intentionally public-preview safe: it is
installed only on non-production builds, exposes only `/__sitedrift/*`, permits
only `GET` and `HEAD`, and allowlists one configured live origin. Hosted frames
execute the compared site's scripts and must be used only with trusted preview
code. Production output and existing API Functions are unchanged.
