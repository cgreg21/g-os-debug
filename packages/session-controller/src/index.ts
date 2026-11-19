import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { RUNTIME_PROTOCOL_VERSION, type RuntimeRequest, type RuntimeResponse } from '@g-os-debug/protocol';

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
    close(): Promise<void>;
}

/** Create a private Unix socket endpoint and authenticate the in-process GJS runtime. */
export async function createRuntimeEndpoint(options: RuntimeEndpointOptions): Promise<RuntimeEndpoint> {
    const token = randomBytes(32).toString('hex');
    await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
    await rm(options.socketPath, { force: true });

    let activeSocket: Socket | undefined;
    const server = createServer((socket) => {
        if (activeSocket) {
            socket.end(JSON.stringify({ type: 'error', code: 'SESSION_BUSY', message: 'A runtime is already connected' }) + '\n');
            return;
        }
        activeSocket = socket;
        socket.setEncoding('utf8');
        socket.setTimeout(options.handshakeTimeoutMs ?? 5000);
        let input = '';
        const reject = (code: string, message: string): void => {
            const response: RuntimeResponse = { type: 'error', code, message };
            socket.end(JSON.stringify(response) + '\n');
        };
        socket.on('timeout', () => reject('HANDSHAKE_TIMEOUT', 'Runtime handshake timed out'));
        socket.on('data', (chunk: string) => {
            input += chunk;
            if (input.length > 16 * 1024) {
                reject('MESSAGE_TOO_LARGE', 'Runtime handshake exceeds 16 KiB');
                return;
            }
            const newline = input.indexOf('\n');
            if (newline < 0) return;
            let request: RuntimeRequest;
            try {
                request = JSON.parse(input.slice(0, newline)) as RuntimeRequest;
            } catch {
                reject('INVALID_HANDSHAKE', 'Runtime handshake is not valid JSON');
                return;
            }
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
            socket.setTimeout(0);
            const response: RuntimeResponse = {
                type: 'hello',
                protocolVersion: RUNTIME_PROTOCOL_VERSION,
                runtimeVersion: options.runtimeVersion,
                capabilities: options.capabilities ?? [],
            };
            socket.write(JSON.stringify(response) + '\n');
        });
        socket.on('close', () => {
            if (activeSocket === socket) activeSocket = undefined;
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
        close: async () => {
            activeSocket?.destroy();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await rm(options.socketPath, { force: true });
        },
    };
}
