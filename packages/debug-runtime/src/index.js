import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

export const RUNTIME_PROTOCOL_VERSION = 1;
export const RUNTIME_VERSION = '0.1.0';
const MAX_MESSAGE_BYTES = 16 * 1024;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_NODES = 500;

/**
 * Read-only Clutter actor tree snapshot. Never reads text contents, arbitrary
 * GObject properties, signal handlers, or extension JavaScript variables.
 */
export function snapshotStage(stage, { maxDepth = DEFAULT_MAX_DEPTH, maxNodes = DEFAULT_MAX_NODES, getActorId = actor => actor, actorMap = new Map() } = {}) {
    if (!stage)
        return { root: null, truncated: false };

    const depthLimit = Math.max(0, Math.min(Number.isInteger(maxDepth) ? maxDepth : DEFAULT_MAX_DEPTH, 32));
    const nodeLimit = Math.max(1, Math.min(Number.isInteger(maxNodes) ? maxNodes : DEFAULT_MAX_NODES, 2000));
    let visited = 0;
    let truncated = false;

    const visit = (actor, depth) => {
        if (visited >= nodeLimit) {
            truncated = true;
            return null;
        }

        visited++;
        let id;
        try { id = getActorId(actor); } catch { id = visited; }
        actorMap.set(id, actor);
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
                    try { if (child.get_name?.() === 'g-os-debug-highlight-overlay') continue; } catch { /* actor may be disposing */ }
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
        this._actorIds = new WeakMap();
        this._nextActorId = 1;
        this._actorsById = new Map();
        this._highlightOverlay = null;
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
                this._actorsById.clear();
                const snapshot = snapshotStage(this._stageProvider(), {
                    maxDepth: message.maxDepth,
                    maxNodes: message.maxNodes,
                    actorMap: this._actorsById,
                    getActorId: actor => {
                        let id = this._actorIds.get(actor);
                        if (!id) { id = this._nextActorId++; this._actorIds.set(actor, id); }
                        return id;
                    },
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
        if (message.type === 'highlightActor' && Number.isSafeInteger(message.id) && Number.isSafeInteger(message.actorId)) {
            try {
                this._highlightActor(message.actorId);
                await this._writeLine({ type: 'highlightResult', id: message.id, actorId: message.actorId, success: true });
            } catch (error) {
                await this._writeLine({
                    type: 'error',
                    id: message.id,
                    code: 'HIGHLIGHT_FAILED',
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }
        if (message.type === 'clearHighlight' && Number.isSafeInteger(message.id)) {
            this._clearHighlight();
            await this._writeLine({ type: 'highlightResult', id: message.id, actorId: null, success: true });
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

    _clearHighlight() {
        const overlay = this._highlightOverlay;
        this._highlightOverlay = null;
        if (!overlay) return;
        try {
            const parent = overlay.get_parent();
            if (parent) parent.remove_child(overlay);
            overlay.destroy();
        } catch {
            // The stage may already be disposing.
        }
    }

    _highlightActor(actorId) {
        this._clearHighlight();
        const actor = this._actorsById.get(actorId);
        if (!actor)
            throw new Error('Actor is no longer present in the latest stage snapshot');
        const stage = this._stageProvider();
        if (!stage || actor === stage)
            throw new Error('The stage itself cannot be highlighted');
        try {
            if (actor.get_stage() !== stage || !actor.is_visible())
                throw new Error('Actor is no longer visible on the GNOME Shell stage');
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
                throw new Error('Actor has no visible on-screen allocation');
            const overlay = new St.Widget({
                name: 'g-os-debug-highlight-overlay',
                reactive: false,
                can_focus: false,
                track_hover: false,
                style: 'border: 2px solid #ff453a; background-color: rgba(255, 69, 58, 0.08);',
            });
            stage.add_child(overlay);
            overlay.set_position(Math.round(x), Math.round(y));
            overlay.set_size(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
            overlay.raise_top();
            this._highlightOverlay = overlay;
        } catch (error) {
            this._clearHighlight();
            throw error;
        }
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        this.connected = false;
        this._clearHighlight();
        this._actorsById.clear();
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
