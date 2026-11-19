import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
    RUNTIME_PROTOCOL_VERSION,
    type RuntimeRequest,
    type RuntimeResponse,
} from '@g-os-debug/protocol';

export type RuntimeCommand = Exclude<RuntimeRequest, { type: 'hello' }>;
export type RuntimeEvent = Exclude<RuntimeResponse, { type: 'hello' }>;

export interface RuntimeEndpointOptions {
    socketPath: string;
    runtimeVersion: string;
    capabilities?: string[];
    handshakeTimeoutMs?: number;
}

export interface RuntimeEndpoint {
    readonly token: string;
    readonly socketPath: string;
    readonly server: Server;
    send(command: RuntimeCommand): void;
    onMessage(listener: (message: RuntimeEvent) => void): () => void;
    close(): Promise<void>;
}

/** Create a private Unix socket endpoint and authenticate the in-process GJS runtime. */
export async function createRuntimeEndpoint(options: RuntimeEndpointOptions): Promise<RuntimeEndpoint> {
    const token = randomBytes(32).toString('hex');
    await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
    await rm(options.socketPath, { force: true });

    let activeSocket: Socket | undefined;
    let runtimeReady = false;
    const listeners = new Set<(message: RuntimeEvent) => void>();

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
        runtimeReady = false;
        socket.setEncoding('utf8');
        socket.setTimeout(options.handshakeTimeoutMs ?? 5000);
        let input = '';

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
                    const response: RuntimeResponse = {
                        type: 'hello',
                        protocolVersion: RUNTIME_PROTOCOL_VERSION,
                        runtimeVersion: options.runtimeVersion,
                        capabilities: options.capabilities ?? [],
                    };
                    socket.write(JSON.stringify(response) + '\n');
                } else {
                    const event = message as RuntimeEvent;
                    if (!event || (event.type !== 'pong' && event.type !== 'error')) {
                        reject('INVALID_MESSAGE', 'Unexpected runtime response');
                        return;
                    }
                    for (const listener of listeners)
                        listener(event);
                }
                newline = input.indexOf('\n');
            }
        });

        socket.on('close', () => {
            if (activeSocket === socket) {
                activeSocket = undefined;
                runtimeReady = false;
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

    return {
        token,
        socketPath: options.socketPath,
        server,
        send(command) {
            if (!activeSocket || !runtimeReady)
                throw new Error('No authenticated GJS runtime is connected');
            if (command.type !== 'ping' && command.type !== 'shutdown')
                throw new TypeError('Unsupported runtime command');
            activeSocket.write(JSON.stringify(command) + '\n');
        },
        onMessage(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: async () => {
            activeSocket?.destroy();
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
            await rm(options.socketPath, { force: true });
        },
    };
}
