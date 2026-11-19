import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeEndpoint } from '../packages/session-controller/dist/index.js';

function handshake(path, payload) {
    return new Promise((resolve, reject) => {
        const socket = connect(path);
        let data = '';
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
        socket.on('data', chunk => {
            data += chunk;
            const end = data.indexOf('\n');
            if (end >= 0) {
                try { resolve({ response: JSON.parse(data.slice(0, end)), socket, remainder: data.slice(end + 1) }); }
                catch (error) { reject(error); }
            }
        });
        socket.on('error', reject);
    });
}

test('creates a private socket and authenticates the matching runtime protocol', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-debug-'));
    const path = join(dir, 'runtime.sock');
    const endpoint = await createRuntimeEndpoint({ socketPath: path, runtimeVersion: 'test', capabilities: ['heartbeat'] });
    try {
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const result = await handshake(path, { type: 'hello', protocolVersion: 1, adapterVersion: 'test', token: endpoint.token });
        assert.deepEqual(result.response, { type: 'hello', protocolVersion: 1, runtimeVersion: 'test', capabilities: ['heartbeat'] });
        result.socket.destroy();
    } finally {
        await endpoint.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('rejects an invalid session token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-debug-'));
    const path = join(dir, 'runtime.sock');
    const endpoint = await createRuntimeEndpoint({ socketPath: path, runtimeVersion: 'test' });
    try {
        const result = await handshake(path, { type: 'hello', protocolVersion: 1, adapterVersion: 'test', token: 'wrong' });
        assert.equal(result.response.code, 'AUTHENTICATION_FAILED');
        result.socket.destroy();
    } finally {
        await endpoint.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('rejects incompatible runtime protocol versions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-debug-'));
    const path = join(dir, 'runtime.sock');
    const endpoint = await createRuntimeEndpoint({ socketPath: path, runtimeVersion: 'test' });
    try {
        const result = await handshake(path, { type: 'hello', protocolVersion: 99, adapterVersion: 'test', token: endpoint.token });
        assert.equal(result.response.code, 'PROTOCOL_MISMATCH');
        result.socket.destroy();
    } finally {
        await endpoint.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('sends runtime commands and receives runtime events after authentication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-debug-'));
    const path = join(dir, 'runtime.sock');
    const endpoint = await createRuntimeEndpoint({ socketPath: path, runtimeVersion: 'test' });
    try {
        const result = await handshake(path, { type: 'hello', protocolVersion: 1, adapterVersion: 'test', token: endpoint.token });
        const event = new Promise(resolve => endpoint.onMessage(resolve));
        endpoint.send({ type: 'ping', id: 42 });

        const command = await new Promise((resolve, reject) => {
            let input = '';
            result.socket.on('data', chunk => {
                input += chunk;
                const end = input.indexOf('\n');
                if (end >= 0) resolve(JSON.parse(input.slice(0, end)));
            });
            result.socket.on('error', reject);
        });
        assert.deepEqual(command, { type: 'ping', id: 42 });
        result.socket.write(JSON.stringify({ type: 'pong', id: 42 }) + '\n');
        assert.deepEqual(await event, { type: 'pong', id: 42 });
        result.socket.destroy();
    } finally {
        await endpoint.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('refuses commands before an authenticated runtime is connected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-debug-'));
    const path = join(dir, 'runtime.sock');
    const endpoint = await createRuntimeEndpoint({ socketPath: path, runtimeVersion: 'test' });
    try {
        assert.throws(() => endpoint.send({ type: 'ping', id: 1 }), /No authenticated GJS runtime/);
    } finally {
        await endpoint.close();
        await rm(dir, { recursive: true, force: true });
    }
});
