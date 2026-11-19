import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const RUNTIME_PROTOCOL_VERSION = 1;
export const RUNTIME_VERSION = '0.1.0';
const MAX_MESSAGE_BYTES = 16 * 1024;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_NODES = 500;

/**
 * Read-only Clutter actor tree snapshot. Never reads text contents, arbitrary
 * GObject properties, signal handlers, or extension JavaScript variables.
 */
export function snapshotStage(stage, { maxDepth = DEFAULT_MAX_DEPTH, maxNodes = DEFAULT_MAX_NODES } = {}) {
    if (!stage)
        return { root: null, truncated: false };

    const depthLimit = Math.max(0, Math.min(Number.isInteger(maxDepth) ? maxDepth : DEFAULT_MAX_DEPTH, 32));
    const nodeLimit = Math.max(1, Math.min(Number.isInteger(maxNodes) ? maxNodes : DEFAULT_MAX_NODES, 2000));
    let nextId = 1;
    let truncated = false;

    const visit = (actor, depth) => {
        if (nextId > nodeLimit) {
            truncated = true;
            return null;
        }

        const id = nextId++;
        let allocation = null;
        try {
            if (actor.has_allocation()) {
                const box = actor.get_allocation_box();
                allocation = {
                    x: box.x1,
                    y: box.y1,
                    width: box.x2 - box.x1,
                    height: box.y2 - box.y1,
                };
            }
        } catch {
            // Some actors may not have a valid allocation during relayout.
        }

        let children = [];
        let childCount = 0;
        try {
            const actors = actor.get_children();
            childCount = actors.length;
            if (depth >= depthLimit) {
                if (childCount > 0)
                    truncated = true;
            } else {
                for (const child of actors) {
                    const childSnapshot = visit(child, depth + 1);
                    if (childSnapshot)
                        children.push(childSnapshot);
                    else
                        break;
                }
            }
        } catch {
            truncated = true;
        }

        let name = null;
        try {
            name = actor.get_name() ?? null;
        } catch {
            // Actor names are optional.
        }

        let visible = false;
        let mapped = false;
        try { visible = actor.is_visible(); } catch { /* actor may be disposing */ }
        try { mapped = actor.is_mapped(); } catch { /* actor may be disposing */ }

        return {
            id,
            typeName: actor.constructor?.name ?? 'Clutter.Actor',
            name,
            visible,
            mapped,
            childCount,
            allocation,
            children,
        };
    };

    return { root: visit(stage, 0), truncated };
}

/**
 * Connect from the extension's own GNOME Shell GJS context.
 * Socket operations are asynchronous and do not block the Shell main loop.
 */
export class DebugRuntime {
    constructor({ socketPath, token, adapterVersion = '0.1.0', onCommand = () => {}, stageProvider = () => global.stage }) {
        if (!socketPath || !token)
            throw new TypeError('socketPath and token are required');
        this._socketPath = socketPath;
        this._token = token;
        this._adapterVersion = adapterVersion;
        this._onCommand = onCommand;
        this._stageProvider = stageProvider;
        this._client = null;
        this._connection = null;
        this._input = null;
        this._output = null;
        this._cancellable = new Gio.Cancellable();
        this._closed = false;
        this.connected = false;
    }

    async connect() {
        if (this.connected)
            throw new Error('Runtime is already connected');
        this._client = new Gio.SocketClient();
        const address = Gio.UnixSocketAddress.new(this._socketPath);
        this._connection = await new Promise((resolve, reject) => {
            this._client.connect_async(address, this._cancellable, (client, result) => {
                try {
                    resolve(client.connect_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });
        this._input = new Gio.DataInputStream({ base_stream: this._connection.get_input_stream() });
        this._output = this._connection.get_output_stream();

        await this._writeLine({
            type: 'hello',
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            adapterVersion: this._adapterVersion,
            token: this._token,
        });
        const response = await this._readLine();
        if (!response || response.type === 'error')
            throw new Error(response?.message ?? 'Controller closed during handshake');
        if (response.type !== 'hello' || response.protocolVersion !== RUNTIME_PROTOCOL_VERSION)
            throw new Error('Controller returned an incompatible handshake');

        this.connected = true;
        this._readLoop();
        return {
            protocolVersion: response.protocolVersion,
            runtimeVersion: response.runtimeVersion,
            capabilities: Array.isArray(response.capabilities) ? response.capabilities : [],
        };
    }

    async _writeLine(message) {
        const bytes = new TextEncoder().encode(JSON.stringify(message) + '\n');
        await new Promise((resolve, reject) => {
            this._output.write_all_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable,
                (stream, result) => {
                    try {
                        stream.write_all_finish(result);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    }

    async _readLine() {
        const [line] = await new Promise((resolve, reject) => {
            this._input.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                (stream, result) => {
                    try {
                        resolve(stream.read_line_finish_utf8(result));
                    } catch (error) {
                        reject(error);
                    }
                });
        });
        if (line === null)
            return null;
        if (new TextEncoder().encode(line).length > MAX_MESSAGE_BYTES)
            throw new Error('Protocol message exceeds 16 KiB');
        try {
            return JSON.parse(line);
        } catch {
            throw new Error('Controller sent invalid JSON');
        }
    }

    async _handleCommand(message) {
        if (message.type === 'ping' && Number.isSafeInteger(message.id)) {
            await this._writeLine({ type: 'pong', id: message.id });
            return;
        }
        if (message.type === 'inspectStage' && Number.isSafeInteger(message.id)) {
            try {
                const snapshot = snapshotStage(this._stageProvider(), {
                    maxDepth: message.maxDepth,
                    maxNodes: message.maxNodes,
                });
                await this._writeLine({ type: 'stageSnapshot', id: message.id, ...snapshot });
            } catch (error) {
                await this._writeLine({
                    type: 'error',
                    id: message.id,
                    code: 'INSPECTION_FAILED',
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }
        if (message.type === 'shutdown') {
            this.close();
            return;
        }
        this._onCommand(message);
    }

    async _readLoop() {
        try {
            while (!this._closed) {
                const message = await this._readLine();
                if (message === null)
                    break;
                await this._handleCommand(message);
            }
        } catch (error) {
            if (!this._closed)
                logError(error, '[G-Os Debug] Runtime transport failed');
        } finally {
            this.close();
        }
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        this.connected = false;
        this._cancellable.cancel();
        try {
            this._connection?.close(null);
        } catch {
            // The peer may already have closed the socket.
        }
        this._connection = null;
        this._input = null;
        this._output = null;
    }
}

export async function connectDebugRuntime(options) {
    const runtime = new DebugRuntime(options);
    try {
        const session = await runtime.connect();
        return { runtime, session };
    } catch (error) {
        runtime.close();
        throw error;
    }
}
