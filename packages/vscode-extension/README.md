# G-Os GNOME Shell Inspector (VS Code)

This package provides a VS Code sidebar tree for the live Clutter stage snapshot exposed by the authenticated GJS runtime.

## Setup

1. Install/build this workspace and package `@g-os-debug/vscode-extension` as a VS Code extension.
2. Set `gOsDebug.socketPath` and `gOsDebug.runtimeToken` in VS Code settings. The token must be exactly 64 hexadecimal characters and must be provisioned to the GJS runtime by G-Os. Do not commit or share the token.
3. Start the extension. It creates the private Unix socket endpoint and waits for GNOME Shell.
4. Once G-Os loads the debug runtime into the actual GNOME Shell process, use **G-Os: Refresh Actor Tree**.

The view displays actor type/name, visibility, mapped state, child count and allocation. Selecting an actor opens its details in the **G-Os Actor** output channel.

The extension is an inspector, not a JavaScript debugger. It does not claim breakpoints, stepping, scopes, variables or source-map execution support. A GNOME Shell runtime must connect; no synthetic tree is shown when disconnected.

## Security

The socket is private (mode 0600) and the controller authenticates the runtime with the configured per-session 256-bit token. The token is stored in VS Code user settings by this initial integration; use user-level settings only, never workspace settings committed to source control. A future G-Os launcher should provision the token through a protected channel or VS Code SecretStorage integration.
