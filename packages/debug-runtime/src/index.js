import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const RUNTIME_PROTOCOL_VERSION = 1;
export const RUNTIME_VERSION = '0.1.0';
const MAX_MESSAGE_BYTES = 16 * 1024;

/**
 * Connect from the extension's own GNOME Shell GJS context.
 * Socket operations are asynchronous and do not block the Shell main loop.
 * This transport is not an engine debugger: extension JavaScript cannot
 * access SpiderMonkey's Debugger API through the public GJS API.
 */
export class DebugRuntime {
    constructor({ socketPath, token, adapterVersion = '0.1.0', onCommand = () => {} }) {
        if (!socketPath || !token)
            throw new TypeError('socketPath and token are required');
        this._socketPath = socketPath;
        this._token = token;
        this._adapterVersion = adapterVersion;
        this._onCommand = onCommand;
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
        this._input = new Gio.DataInputStream({
            base_stream: this._connection.get_input_stream(),
        });
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

    async _readLoop() {
        try {
            while (!this._closed) {
                const message = await this._readLine();
                if (message === null)
                    break;
                if (message.type === 'ping' && Number.isSafeInteger(message.id)) {
                    await this._writeLine({ type: 'pong', id: message.id });
                } else if (message.type === 'shutdown') {
                    this.close();
                    return;
                } else {
                    this._onCommand(message);
                }
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
