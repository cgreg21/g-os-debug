# G-Os Debugger

A reusable debugging toolchain for GNOME Shell extensions, designed around the
Debug Adapter Protocol (DAP), GJS and Visual Studio Code.

> **Status: early development.** This repository is being bootstrapped. It does
> not yet provide live breakpoints inside GNOME Shell. The runtime bridge and
> Shell-side integration are explicit milestones, not simulated features.

## Goals

- Debug extension TypeScript sources from VS Code.
- Support breakpoints, stepping, call stacks, scopes, variables and exceptions
  through a real GJS debugger runtime.
- Resolve generated JavaScript locations to original TypeScript using source maps.
- Launch and manage isolated GNOME Shell DevKit sessions.
- Inspect the GNOME actor/widget tree and selected actor properties.
- Keep the debugger reusable by extensions other than G-Os.

## Architecture

```text
VS Code Debug UI
      │ DAP
      ▼
G-Os Debug Adapter
      │ private local transport
      ▼
GJS debugger runtime (same Shell process/context)
      │
      ▼
GNOME Shell extension manager / extension code

Session Controller ── launches and supervises isolated GNOME Shell
Source Map Service ── maps generated JS locations to TypeScript
GNOME Inspector ───── exposes safe actor-tree snapshots and properties
```

A separate `gjs` process cannot debug the JavaScript heap and execution context
of an extension loaded into `gnome-shell`. The runtime must be integrated into
the actual Shell process/context. Until that integration exists, this project
must not claim that extension breakpoints work.

## Planned packages

- `packages/protocol`: shared DAP/runtime message contracts.
- `packages/source-maps`: source-map loading and bidirectional location mapping.
- `packages/session-controller`: isolated Shell process lifecycle.
- `packages/debug-adapter`: VS Code DAP server.
- `packages/gnome-inspector`: actor tree and property inspection.
- `packages/vscode-extension`: VS Code extension and launch configuration.

## Development principles

1. Prefer upstream GJS/SpiderMonkey debugging facilities over a custom JS engine.
2. Never expose a debugger socket on a public network interface.
3. Keep the runtime endpoint disabled outside explicit development sessions.
4. Use a private Unix-domain socket with restrictive filesystem permissions.
5. Make pause/terminate/restart reliable: a paused Shell freezes the whole
   nested desktop.
6. Test source mapping independently, then test DAP transport, then test against
   a real nested GNOME Shell session.

## Current milestone

The initial bootstrap establishes the package layout, build/test pipeline and
source-map service. Subsequent milestones will add a real runtime transport and
the Shell integration required for actual breakpoints.
