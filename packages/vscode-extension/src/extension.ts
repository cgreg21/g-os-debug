import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { mkdir, chmod, writeFile, rename, unlink, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDebugSession, type DebugSession } from '@g-os-debug/session-controller';

interface ActorNode {
    id: number;
    typeName: string;
    name: string | null;
    visible: boolean;
    mapped: boolean;
    childCount: number;
    allocation: { x: number; y: number; width: number; height: number } | null;
    children: ActorNode[];
}

class ActorItem extends vscode.TreeItem {
    constructor(readonly actor: ActorNode, readonly depth: number) {
        super(actor.name ? `${actor.name} (${actor.typeName})` : actor.typeName,
            actor.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = String(actor.id);
        this.description = `#${actor.id} · ${actor.visible ? 'visible' : 'hidden'} · ${actor.mapped ? 'mapped' : 'unmapped'}`;
        this.contextValue = 'gOsActor';
        this.tooltip = [
            `Actor #${actor.id}`,
            `Type: ${actor.typeName}`,
            `Name: ${actor.name ?? '—'}`,
            `Visible: ${actor.visible}`,
            `Mapped: ${actor.mapped}`,
            `Children: ${actor.childCount}`,
            actor.allocation ? `Allocation: x=${actor.allocation.x}, y=${actor.allocation.y}, ${actor.allocation.width}×${actor.allocation.height}` : 'Allocation: unavailable'
        ].join('\n');
        this.iconPath = new vscode.ThemeIcon('symbol-class');
        this.command = { command: 'gOsDebug.selectActor', title: 'Show actor details', arguments: [actor] };
    }
}

class ActorTree implements vscode.TreeDataProvider<ActorItem> {
    private readonly changed = new vscode.EventEmitter<ActorItem | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private root: ActorNode | null = null;
    setSnapshot(root: ActorNode | null): void { this.root = root; this.changed.fire(undefined); }
    refresh(): void { this.changed.fire(undefined); }
    getTreeItem(element: ActorItem): vscode.TreeItem { return element; }
    getChildren(element?: ActorItem): ActorItem[] {
        const nodes = element ? element.actor.children : this.root ? [this.root] : [];
        return nodes.map(node => new ActorItem(node, (element?.depth ?? -1) + 1));
    }
    dispose(): void { this.changed.dispose(); }
}

export function activate(context: vscode.ExtensionContext): void {
    const tree = new ActorTree();
    const view = vscode.window.createTreeView('gOsActors', { treeDataProvider: tree, showCollapseAll: true });
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    status.text = '$(debug-disconnect) G-Os Inspector: stopped';
    status.show();
    let session: DebugSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let starting = false;
    let sessionDescriptorPath: string | undefined;

    const setState = (state: string): void => {
        status.text = state === 'connected' ? '$(debug-alt) G-Os Inspector: connected'
            : state === 'waiting' ? '$(debug-clock) G-Os Inspector: waiting for GNOME Shell'
            : '$(debug-disconnect) G-Os Inspector: stopped';
        status.tooltip = `G-Os read-only stage inspector — ${state}`;
    };

    const refresh = async (): Promise<void> => {
        if (!session || session.state !== 'connected') {
            tree.setSnapshot(null);
            return;
        }
        try {
            const snapshot = await session.inspectStage({ maxDepth: 12, maxNodes: 500 });
            tree.setSnapshot(snapshot.root as ActorNode | null);
            status.text = snapshot.truncated ? '$(warning) G-Os Inspector: snapshot truncated' : '$(debug-alt) G-Os Inspector: connected';
        } catch (error) {
            vscode.window.showErrorMessage(`G-Os inspection failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const start = async (): Promise<void> => {
        if (starting || session) return;
        starting = true;
        try {
            const config = vscode.workspace.getConfiguration('gOsDebug');
            const configuredSocketPath = config.get<string>('socketPath', '');
            const socketPath = configuredSocketPath.replace('${userHome}', homedir()).replace(/^~/, homedir());
            const token = await context.secrets.get('gOsDebug.runtimeToken') ?? '';
            const runtimeVersion = config.get<string>('runtimeVersion', '0.1.0');
            if (!socketPath || !/^[a-f0-9]{64}$/i.test(token)) {
                const action = 'Configure Runtime Token';
                const choice = await vscode.window.showErrorMessage(
                    'Configure gOsDebug.socketPath and a 64-character hexadecimal gOsDebug.runtimeToken shared with the GJS runtime.',
                    action
                );
                if (choice === action) await vscode.commands.executeCommand('gOsDebug.configureRuntimeToken');
                return;
            }
            session = await createDebugSession({ socketPath, token, runtimeVersion, handshakeTimeoutMs: 30000, requestTimeoutMs: 5000 });
            const descriptorDirectory = join(homedir(), '.cache', 'g-os-debug');
            sessionDescriptorPath = join(descriptorDirectory, 'session.json');
            await mkdir(descriptorDirectory, { recursive: true, mode: 0o700 });
            await chmod(descriptorDirectory, 0o700);
            const temporaryDescriptor = `${sessionDescriptorPath}.${process.pid}.tmp`;
            await rm(temporaryDescriptor, { force: true });
            await writeFile(temporaryDescriptor, JSON.stringify({
                version: 1,
                socketPath: session.socketPath,
                token: session.token
            }), { mode: 0o600, flag: 'wx' });
            await chmod(temporaryDescriptor, 0o600);
            await rename(temporaryDescriptor, sessionDescriptorPath);
            unsubscribe = session.onStateChanged(state => {
                setState(state);
                if (state !== 'connected') tree.setSnapshot(null);
            });
            setState(session.state);
            vscode.window.showInformationMessage('G-Os inspector endpoint started. Waiting for the GNOME Shell runtime.');
            await refresh();
        } catch (error) {
            const failedSession = session;
            session = undefined;
            if (sessionDescriptorPath) {
                await unlink(sessionDescriptorPath).catch(() => undefined);
                sessionDescriptorPath = undefined;
            }
            await failedSession?.close().catch(() => undefined);
            setState('closed');
            vscode.window.showErrorMessage(`Could not start G-Os inspector: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            starting = false;
        }
    };

    const stop = async (): Promise<void> => {
        unsubscribe?.();
        unsubscribe = undefined;
        const stoppedSession = session;
        if (sessionDescriptorPath && stoppedSession) {
            try {
                const descriptor = JSON.parse(await readFile(sessionDescriptorPath, 'utf8')) as { token?: string; socketPath?: string };
                if (descriptor.token === stoppedSession.token && descriptor.socketPath === stoppedSession.socketPath)
                    await unlink(sessionDescriptorPath);
            } catch { /* The G-Os extension may already have removed the descriptor. */ }
        }
        sessionDescriptorPath = undefined;
        if (stoppedSession) await stoppedSession.close();
        session = undefined;
        tree.setSnapshot(null);
        setState('closed');
    };

    context.subscriptions.push(
        view, status, tree,
        vscode.commands.registerCommand('gOsDebug.startInspector', start),
        vscode.commands.registerCommand('gOsDebug.refreshActors', refresh),
        vscode.commands.registerCommand('gOsDebug.stopInspector', stop),
        vscode.commands.registerCommand('gOsDebug.configureRuntimeToken', async () => {
            const token = await vscode.window.showInputBox({
                title: 'G-Os Runtime Authentication',
                prompt: 'Enter the 256-bit hexadecimal token provisioned to the GNOME Shell runtime',
                password: true,
                ignoreFocusOut: true,
                validateInput: value => /^[a-f0-9]{64}$/i.test(value) ? undefined : 'Enter exactly 64 hexadecimal characters.'
            });
            if (token === undefined) return;
            await context.secrets.store('gOsDebug.runtimeToken', token.toLowerCase());
            vscode.window.showInformationMessage('G-Os runtime token saved in VS Code SecretStorage.');
        }),
        vscode.commands.registerCommand('gOsDebug.selectActor', (actor: ActorNode) => {
            const lines = [
                `#${actor.id} ${actor.typeName}`,
                `Name: ${actor.name ?? '—'}`,
                `Visible: ${actor.visible}`,
                `Mapped: ${actor.mapped}`,
                `Children: ${actor.childCount}`,
                actor.allocation ? `Allocation: x=${actor.allocation.x}, y=${actor.allocation.y}, width=${actor.allocation.width}, height=${actor.allocation.height}` : 'Allocation: unavailable'
            ];
            const channel = vscode.window.createOutputChannel('G-Os Actor');
            channel.appendLine(lines.join('\n'));
            channel.show(true);
            context.subscriptions.push(channel);
        })
    );
    context.subscriptions.push({ dispose: () => { void stop(); } });
    // Explicit start avoids opening configuration prompts on every VS Code launch.
}

export function deactivate(): void { /* Session is closed by the extension subscription. */ }
