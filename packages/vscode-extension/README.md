# G-Os GNOME Shell Inspector (VS Code)

This package provides a VS Code sidebar tree for the live Clutter stage snapshot exposed by the authenticated GJS runtime.

## Setup

1. Build/install this workspace and package `@g-os-debug/vscode-extension` as a VS Code extension.
2. Run **G-Os: Configure Runtime Token** and enter the 64-character hexadecimal token provisioned to the GJS runtime by G-Os. The value is stored in VS Code SecretStorage, not workspace settings.
3. Set `gOsDebug.socketPath` if the default location is not suitable.
4. Run **G-Os: Start GNOME Shell Inspector**. The extension creates the private Unix socket endpoint and waits for GNOME Shell.
5. Once G-Os loads the debug runtime into the actual GNOME Shell process, run **G-Os: Refresh Actor Tree**.

The view displays actor type/name, visibility, mapped state, child count and allocation. Selecting an actor opens its details in the **G-Os Actor** output channel.

The extension is an inspector, not a JavaScript debugger. It does not claim breakpoints, stepping, scopes, variables or source-map execution support. A GNOME Shell runtime must connect; no synthetic tree is shown when disconnected.

## Security

The socket is private (mode 0600) and the controller authenticates the runtime with the configured per-session 256-bit token. The token is stored using VS Code SecretStorage. G-Os must provision the same token to the extension runtime through a protected channel. The extension does not yet automate that provisioning.
