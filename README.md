# G-Os Debugger

A debugging toolchain for GNOME Shell extensions, designed around DAP, GJS and Visual Studio Code.

> **Status: early development.** The DAP adapter initializes, but cannot launch or attach until a debugger runtime is integrated into the GNOME Shell process. Breakpoints are not simulated.

## Architecture

```text
VS Code ── DAP/stdio ── Debug Adapter ── private Unix socket ── GJS runtime
                                                                  │
                                                           GNOME Shell context
Session Controller ── owns socket, token and runtime handshake
Source Map Service ── maps generated JavaScript to TypeScript
GNOME Inspector ───── planned safe actor-tree snapshots and properties
```

A separate GJS process cannot inspect the JavaScript heap or execution context of an extension loaded into `gnome-shell`. The runtime must execute in the actual Shell process/context.

## Packages

- `protocol`: versioned runtime contract and DAP framing.
- `debug-adapter`: DAP stdio endpoint.
- `source-maps`: JavaScript/TypeScript source mapping.
- `session-controller`: private Unix socket, random per-session token, protocol handshake, socket permissions and timeout.
- Planned: `debug-runtime`, `gnome-inspector`, `vscode-extension`.

## Runtime transport security

The controller creates a Unix-domain socket with mode `0600`, generates a cryptographically random 256-bit session token, enforces a 16 KiB handshake limit and rejects token or protocol-version mismatches. No TCP listener is opened. The current transport is a handshake foundation; it does not yet carry debugger commands or inspect GNOME Shell.

## Development

- `npm test`: build packages and run unit/integration tests.
- `npm run typecheck`: strict TypeScript checks.
- `npm run debug-adapter`: start the DAP stdio endpoint.

Launch/attach remain explicitly unavailable until the in-process GJS runtime is implemented.
