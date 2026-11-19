# G-Os Debugger

A reusable debugging toolchain for GNOME Shell extensions, designed around the
Debug Adapter Protocol (DAP), GJS and Visual Studio Code.

> **Status: early development.** The adapter can speak DAP framing and initialize
> a client, but cannot launch or attach until a compatible debugger runtime is
> integrated into the GNOME Shell process. Breakpoints are not simulated.

## Architecture

```text
VS Code ── DAP/stdio ── Debug Adapter ── private local transport ── GJS runtime
                                                                      │
                                                               GNOME Shell context

Session Controller ── launches and supervises isolated GNOME Shell
Source Map Service ── maps generated JavaScript locations to TypeScript
GNOME Inspector ───── exposes safe actor-tree snapshots and properties
```

A separate `gjs` process cannot inspect the JavaScript heap or execution context
of an extension loaded into `gnome-shell`. The runtime must execute in the actual
Shell process/context. Until then, launch/attach requests fail explicitly.

## Packages

- `packages/protocol`: versioned adapter/runtime contracts and DAP framing.
- `packages/debug-adapter`: DAP stdio endpoint and capability negotiation.
- `packages/source-maps`: bidirectional JavaScript/TypeScript source mapping.
- Planned: `session-controller`, `debug-runtime`, `gnome-inspector`,
  `vscode-extension`.

## Security and reliability

- Runtime endpoint disabled outside explicit development sessions.
- Private Unix-domain socket with restrictive permissions; no public TCP listener.
- Runtime handshake validates protocol version and an unpredictable session token.
- Pausing the Shell freezes the nested desktop; terminate/restart must remain
  available even when execution is paused.

## Development

- `npm test`: build packages and run unit/integration tests.
- `npm run typecheck`: strict TypeScript checks.
- `npm run debug-adapter`: start the DAP stdio endpoint.

The current adapter deliberately rejects launch/attach while no runtime is
connected. This is an honest boundary, not a limitation hidden behind fake
breakpoint responses.
