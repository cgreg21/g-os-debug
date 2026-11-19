import { createServer, type Server, type Socket } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
    RUNTIME_PROTOCOL_VERSION,
    type RuntimeRequest,
    type RuntimeResponse,
} from '@g-os-debug/protocol';

export type RuntimeCommand = Exclude<RuntimeRequest, { type: 'hello' }>;
export type RuntimeEvent = Exclude<RuntimeResponse, { type: 'hello' }>;
export type RuntimeConnectionState = 'waiting' | 'connected' | 'closed';

export interface RuntimeEndpointOptions {
    socketPath: string;
    runtimeVersion: string;
    capabilities?: string[];
    handshakeTimeoutMs?: number;
    token?: string;
}

export interface RuntimeEndpoint {
    readonly token: string;
    readonly socketPath: string;
    readonly server: Server;
    readonly state: RuntimeConnectionState;
    send(command: RuntimeCommand): void;
    onMessage(listener: (message: RuntimeEvent) => void): () => void;
    onStateChanged(listener: (state: RuntimeConnectionState) => void): () => void;
    close(): Promise<void>;
}

/** Create a private Unix socket endpoint and authenticate the in-process GJS runtime. */
export async function createRuntimeEndpoint(options: RuntimeEndpointOptions): Promise<RuntimeEndpoint> {
    const token = options.token ?? randomBytes(32).toString('hex');
    if (!/^[a-f0-9]{64}$/i.test(token))
        throw new TypeError('Runtime token must be a 256-bit hexadecimal value');
    await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
    try {
        await lstat(options.socketPath);
        throw new Error('Runtime socket path already exists; refusing to replace an existing file or socket');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
    }

    let activeSocket: Socket | undefined;
    let state: RuntimeConnectionState = 'waiting';
    const messageListeners = new Set<(message: RuntimeEvent) => void>();
    const stateListeners = new Set<(state: RuntimeConnectionState) => void>();
    const setState = (next: RuntimeConnectionState): void => {
        if (state === next) return;
        state = next;
        for (const listener of stateListeners) listener(state);
    };

    const server = createServer((socket) => {
        if (activeSocket) {
            socket.end(JSON.stringify({
                type: 'error',
                code: 'SESSION_BUSY',
                message: 'A runtime is already connected',
            }) + '\n');
            return;
        }

        activeSocket = socket;
        socket.setEncoding('utf8');
        socket.setTimeout(options.handshakeTimeoutMs ?? 5000);
        let input = '';
        let runtimeReady = false;

        const reject = (code: string, message: string): void => {
            const response: RuntimeResponse = { type: 'error', code, message };
            socket.end(JSON.stringify(response) + '\n');
        };

        socket.on('timeout', () => {
            if (!runtimeReady)
                reject('HANDSHAKE_TIMEOUT', 'Runtime handshake timed out');
            else
                socket.destroy();
        });

        socket.on('data', (chunk: string) => {
            input += chunk;
            if (Buffer.byteLength(input, 'utf8') > 16 * 1024 && !input.includes('\n')) {
                reject('MESSAGE_TOO_LARGE', 'Runtime message exceeds 16 KiB');
                return;
            }

            let newline = input.indexOf('\n');
            while (newline >= 0) {
                const line = input.slice(0, newline);
                input = input.slice(newline + 1);
                if (Buffer.byteLength(line, 'utf8') > 16 * 1024) {
                    reject('MESSAGE_TOO_LARGE', 'Runtime message exceeds 16 KiB');
                    return;
                }

                let message: unknown;
                try {
                    message = JSON.parse(line);
                } catch {
                    reject('INVALID_MESSAGE', 'Runtime message is not valid JSON');
                    return;
                }

                if (!runtimeReady) {
                    const request = message as RuntimeRequest;
                    if (!request || request.type !== 'hello' || typeof request.token !== 'string') {
                        reject('INVALID_HANDSHAKE', 'Expected a runtime hello message');
                        return;
                    }

                    const expected = Buffer.from(token);
                    const supplied = Buffer.from(request.token);
                    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
                        reject('AUTHENTICATION_FAILED', 'Runtime session token is invalid');
                        return;
                    }
                    if (request.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
                        reject('PROTOCOL_MISMATCH', 'Runtime protocol version is not supported');
                        return;
                    }

                    runtimeReady = true;
                    socket.setTimeout(0);
                    setState('connected');
                    const response: RuntimeResponse = {
                        type: 'hello',
                        protocolVersion: RUNTIME_PROTOCOL_VERSION,
                        runtimeVersion: options.runtimeVersion,
                        capabilities: options.capabilities ?? [],
                    };
                    socket.write(JSON.stringify(response) + '\n');
                } else {
                    const event = message as RuntimeEvent;
                    if (!event || (event.type !== 'pong' && event.type !== 'stageSnapshot' && event.type !== 'error')) {
                        reject('INVALID_MESSAGE', 'Unexpected runtime response');
                        return;
                    }
                    for (const listener of messageListeners) listener(event);
                }
                newline = input.indexOf('\n');
            }
        });

        socket.on('close', () => {
            if (activeSocket === socket) {
                activeSocket = undefined;
                if (state !== 'closed') setState('waiting');
            }
        });
        socket.on('error', () => undefined);
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.socketPath, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    await chmod(options.socketPath, 0o600);
    const socketIdentity = await lstat(options.socketPath);
    if (!socketIdentity.isSocket()) {
        await new Promise<void>(resolve => server.close(() => resolve()));
        throw new Error('Runtime socket path was replaced during endpoint creation');
    }

    return {
        token,
        socketPath: options.socketPath,
        server,
        get state() { return state; },
        send(command) {
            if (!activeSocket || state !== 'connected')
                throw new Error('No authenticated GJS runtime is connected');
            if (command.type !== 'ping' && command.type !== 'shutdown' && command.type !== 'inspectStage')
                throw new TypeError('Unsupported runtime command');
            activeSocket.write(JSON.stringify(command) + '\n');
        },
        onMessage(listener) {
            messageListeners.add(listener);
            return () => messageListeners.delete(listener);
        },
        onStateChanged(listener) {
            stateListeners.add(listener);
            return () => stateListeners.delete(listener);
        },
        close: async () => {
            setState('closed');
            activeSocket?.destroy();
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
            try {
                const current = await lstat(options.socketPath);
                if (current.isSocket() && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino)
                    await unlink(options.socketPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
            }
            messageListeners.clear();
            stateListeners.clear();
        },
    };
}

export interface DebugSessionOptions extends RuntimeEndpointOptions {
    requestTimeoutMs?: number;
}

export interface DebugSession {
    readonly token: string;
    readonly socketPath: string;
    readonly state: RuntimeConnectionState;
    waitForRuntime(timeoutMs?: number): Promise<void>;
    inspectStage(options?: { maxDepth?: number; maxNodes?: number; timeoutMs?: number }): Promise<Extract<RuntimeEvent, { type: 'stageSnapshot' }>>;
    onStateChanged(listener: (state: RuntimeConnectionState) => void): () => void;
    close(): Promise<void>;
}

/** Owns one runtime endpoint and correlates asynchronous inspection requests. */
export async function createDebugSession(options: DebugSessionOptions): Promise<DebugSession> {
    const endpoint = await createRuntimeEndpoint(options);
    let nextRequestId = 1;
    let closed = false;
    const pending = new Map<number, {
        resolve: (value: Extract<RuntimeEvent, { type: 'stageSnapshot' }>) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    const stateListeners = new Set<(state: RuntimeConnectionState) => void>();

    const unsubscribeState = endpoint.onStateChanged(state => {
        for (const listener of stateListeners) listener(state);
        if (state !== 'connected') {
            for (const [id, request] of pending) {
                clearTimeout(request.timer);
                request.reject(new Error(state === 'closed' ? 'Debug session closed' : 'GJS runtime disconnected'));
                pending.delete(id);
            }
        }
    });

    endpoint.onMessage(message => {
        if (message.type === 'stageSnapshot' || message.type === 'error') {
            if (message.id === undefined) return;
            const request = pending.get(message.id);
            if (!request) return;
            clearTimeout(request.timer);
            pending.delete(message.id);
            if (message.type === 'stageSnapshot') request.resolve(message);
            else request.reject(new Error(message.message));
        }
    });

    const waitForRuntime = (timeoutMs = options.handshakeTimeoutMs ?? 5000): Promise<void> => {
        if (endpoint.state === 'connected') return Promise.resolve();
        if (closed) return Promise.reject(new Error('Debug session is closed'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                unsubscribe();
                reject(new Error('Timed out waiting for the GJS runtime'));
            }, timeoutMs);
            const unsubscribe = endpoint.onStateChanged(state => {
                if (state === 'connected') {
                    clearTimeout(timer);
                    unsubscribe();
                    resolve();
                } else if (state === 'closed') {
                    clearTimeout(timer);
                    unsubscribe();
                    reject(new Error('Debug session closed'));
                }
            });
        });
    };

    return {
        token: endpoint.token,
        socketPath: endpoint.socketPath,
        get state() { return endpoint.state; },
        waitForRuntime,
        inspectStage: ({ maxDepth, maxNodes, timeoutMs = options.requestTimeoutMs ?? 3000 } = {}) => {
            if (endpoint.state !== 'connected')
                return Promise.reject(new Error('GJS runtime is not connected'));
            const id = nextRequestId++;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error('Timed out waiting for the GNOME Shell stage snapshot'));
                }, timeoutMs);
                pending.set(id, { resolve, reject, timer });
                try {
                    endpoint.send({ type: 'inspectStage', id, maxDepth, maxNodes });
                } catch (error) {
                    clearTimeout(timer);
                    pending.delete(id);
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        },
        onStateChanged(listener) {
            stateListeners.add(listener);
            return () => stateListeners.delete(listener);
        },
        close: async () => {
            if (closed) return;
            closed = true;
            unsubscribeState();
            await endpoint.close();
            for (const [id, request] of pending) {
                clearTimeout(request.timer);
                request.reject(new Error('Debug session closed'));
                pending.delete(id);
            }
            stateListeners.clear();
        },
    };
}
