# G-Os Debugger

A debugging toolchain for GNOME Shell extensions, designed around DAP, GJS and Visual Studio Code.

> **Status: early development.** The DAP adapter initializes, but cannot launch or attach until a debugger engine is integrated into the GNOME Shell process. Breakpoints are not simulated.

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
- `debug-runtime`: GJS ES module intended to be imported by the extension itself; asynchronous Gio Unix-socket connection, authenticated handshake and heartbeat.
- Planned: `gnome-inspector`, `vscode-extension`, and SpiderMonkey debugging-engine integration.

## Runtime transport security

The controller creates a Unix-domain socket with mode `0600`, generates a cryptographically random 256-bit session token, enforces a 16 KiB handshake limit and rejects token or protocol-version mismatches. No TCP listener is opened. The GJS runtime uses Gio asynchronous APIs and must be loaded in the extension's own Shell context.

The runtime currently establishes transport and responds to heartbeat requests. It does **not** yet inspect extension objects, pause JavaScript, implement breakpoints, expose scopes or variables, or provide stepping.

## SpiderMonkey debugging limitation

The public GJS extension API does not expose SpiderMonkey's `Debugger` object to extension code. GJS documents `System.breakpoint()` as a native trap intended for an external debugger such as GDB; it is not a remotely controllable DAP breakpoint engine. A genuine debugger therefore requires a supported engine-level bridge in GJS/GNOME Shell, not JavaScript wrappers that imitate breakpoints.

## Development

- `npm test`: build packages and run unit/integration tests.
- `npm run typecheck`: strict TypeScript checks.
- `npm run check:runtime`: syntax-check the GJS runtime module without importing GI modules.
- `npm run debug-adapter`: start the DAP stdio endpoint.

Launch/attach remain explicitly unavailable until the in-process runtime is connected to a real engine debugger.
