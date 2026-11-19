# G-Os Debugger

A debugging toolchain for GNOME Shell extensions, designed around DAP, GJS and Visual Studio Code.

> **Status: early development.** The DAP adapter supports read-only stage inspection when connected to an authenticated in-process GJS runtime. JavaScript breakpoints, stepping, scopes and variables remain unavailable until a SpiderMonkey debugger engine is integrated.

## Architecture

```text
VS Code ── DAP/stdio ── Debug Adapter ── Debug Session ── private Unix socket ── GJS runtime
                                                                                  │
                                                                           GNOME Shell context
Source Map Service ── maps generated JavaScript to TypeScript
GNOME Inspector ───── read-only Clutter stage snapshots
```

A separate GJS process cannot inspect the JavaScript heap or execution context of an extension loaded into `gnome-shell`. The runtime must execute in the actual Shell process/context.

## Packages

- `protocol`: versioned private runtime contract, actor snapshot types and DAP framing.
- `debug-adapter`: DAP stdio endpoint, read-only inspection custom requests and explicit refusal of unsupported live-debugging operations.
- `source-maps`: JavaScript/TypeScript source mapping.
- `session-controller`: private Unix socket, random or externally provisioned per-session token, protocol handshake, connection state and correlated inspection requests.
- `debug-runtime`: GJS ES module intended to be imported by the extension itself; asynchronous Gio Unix-socket connection, heartbeat and bounded stage inspection.
- Planned: `vscode-extension` and SpiderMonkey debugging-engine integration.

## DAP inspector requests

The adapter accepts two custom DAP requests:

- `gOs/sessionStatus`: reports whether the configured runtime is waiting or connected.
- `gOs/inspectStage`: requests a real, bounded snapshot from the runtime.

Configure the adapter process with `GOS_DEBUG_SOCKET_PATH` and `GOS_DEBUG_RUNTIME_TOKEN`. The token must be a 256-bit hexadecimal value and must be provisioned to the extension runtime through a trusted session launcher. The adapter does not expose the token over DAP. A missing or disconnected runtime produces an explicit error; no sample or synthetic actor tree is returned.

The adapter intentionally continues to reject standard DAP `launch` and `attach`: a stage inspector is not a JavaScript debugger and must not claim support for breakpoints or execution control.

## Session lifecycle and inspection API

`createDebugSession()` owns one runtime endpoint. It exposes `waiting`, `connected` and `closed` states, `waitForRuntime()`, and `inspectStage()`. Inspection requests carry unique IDs, have bounded timeouts, and are rejected if the runtime disconnects before replying.

## Read-only GNOME Shell inspector

The GJS runtime accepts `inspectStage` and returns a `stageSnapshot` tree based on `global.stage` and Clutter.Actor methods. Each node contains a local snapshot ID, actor type, optional actor name, visibility, mapped state, child count and allocation rectangle. Depth and node count are bounded (defaults: 12 levels and 500 nodes; hard limits: 32 levels and 2,000 nodes).

The snapshot deliberately does not read text contents, arbitrary GObject properties, signal handlers, or extension JavaScript variables. The runtime must be imported by an extension in the actual GNOME Shell process; no automatic injection is implemented yet.

## Runtime transport security

The controller creates a Unix-domain socket with mode `0600`, uses a cryptographically random 256-bit token by default (or accepts a trusted externally provisioned token), enforces a 16 KiB message limit and rejects token or protocol-version mismatches. No TCP listener is opened. The GJS runtime uses Gio asynchronous APIs.

## SpiderMonkey debugging limitation

The public GJS extension API does not expose SpiderMonkey's `Debugger` object to extension code. GJS documents `System.breakpoint()` as a native trap intended for an external debugger such as GDB; it is not a remotely controllable DAP breakpoint engine. A genuine debugger therefore requires a supported engine-level bridge in GJS/GNOME Shell.

## Development

- `npm test`: build packages and run unit/integration tests.
- `npm run typecheck`: strict TypeScript checks.
- `npm run check:runtime`: syntax-check the GJS runtime module without importing GI modules.
- `npm run debug-adapter`: start the DAP stdio endpoint.

This adapter currently provides inspection only, not live JavaScript debugging.
