import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, stat, rm, writeFile, readFile } from 'node:fs/promises';
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
                try { resolve({ response: JSON.parse(data.slice(0, end)), socket }); }
                catch (error) { reject(error); }
            }
        });
        socket.on('error', reject);
    });
}

async function withEndpoint(run) {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-debug-'));
    const path = join(dir, 'runtime.sock');
    const endpoint = await createRuntimeEndpoint({ socketPath: path, runtimeVersion: 'test' });
    try { await run({ endpoint, path }); }
    finally {
        await endpoint.close();
        await rm(dir, { recursive: true, force: true });
    }
}

test('creates a private socket and authenticates the matching runtime protocol', async () => {
    await withEndpoint(async ({ endpoint, path }) => {
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const result = await handshake(path, { type: 'hello', protocolVersion: 1, adapterVersion: 'test', token: endpoint.token });
        assert.deepEqual(result.response, { type: 'hello', protocolVersion: 1, runtimeVersion: 'test', capabilities: [] });
        result.socket.destroy();
    });
});

test('rejects an invalid session token', async () => {
    await withEndpoint(async ({ endpoint, path }) => {
        const result = await handshake(path, { type: 'hello', protocolVersion: 1, adapterVersion: 'test', token: 'wrong' });
        assert.equal(result.response.code, 'AUTHENTICATION_FAILED');
        result.socket.destroy();
    });
});

test('rejects incompatible runtime protocol versions', async () => {
    await withEndpoint(async ({ endpoint, path }) => {
        const result = await handshake(path, { type: 'hello', protocolVersion: 99, adapterVersion: 'test', token: endpoint.token });
        assert.equal(result.response.code, 'PROTOCOL_MISMATCH');
        result.socket.destroy();
    });
});

test('sends a bounded stage inspection request and receives a snapshot event', async () => {
    await withEndpoint(async ({ endpoint, path }) => {
        const result = await handshake(path, { type: 'hello', protocolVersion: 1, adapterVersion: 'test', token: endpoint.token });
        const eventPromise = new Promise(resolve => endpoint.onMessage(resolve));
        endpoint.send({ type: 'inspectStage', id: 7, maxDepth: 4, maxNodes: 100 });
        let input = '';
        const command = await new Promise((resolve, reject) => {
            result.socket.on('data', chunk => {
                input += chunk;
                const newline = input.indexOf('\n');
                if (newline >= 0) resolve(JSON.parse(input.slice(0, newline)));
            });
            result.socket.on('error', reject);
        });
        assert.deepEqual(command, { type: 'inspectStage', id: 7, maxDepth: 4, maxNodes: 100 });
        result.socket.write(JSON.stringify({
            type: 'stageSnapshot',
            id: 7,
            root: { id: 1, typeName: 'Stage', name: null, visible: true, mapped: true, childCount: 0, allocation: null, children: [] },
            truncated: false,
        }) + '\n');
        const event = await eventPromise;
        assert.equal(event.type, 'stageSnapshot');
        assert.equal(event.id, 7);
        assert.equal(event.root.typeName, 'Stage');
        assert.equal(event.truncated, false);
        result.socket.destroy();
    });
});

test('refuses commands before an authenticated runtime is connected', async () => {
    await withEndpoint(async ({ endpoint }) => {
        assert.throws(() => endpoint.send({ type: 'ping', id: 1 }), /No authenticated GJS runtime/);
    });
});

test('does not remove an existing file at the requested socket path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-os-debug-existing-'));
    const path = join(dir, 'runtime.sock');
    await writeFile(path, 'preserve me');
    try {
        await assert.rejects(
            createRuntimeEndpoint({ socketPath: path, runtimeVersion: 'test' }),
            /already exists/
        );
        assert.equal(await readFile(path, 'utf8'), 'preserve me');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});


test('supports actor highlight and clear-highlight runtime commands', async () => {
    await withEndpoint(async ({ endpoint, path }) => {
        const result = await handshake(path, { type: 'hello', protocolVersion: 1, adapterVersion: 'test', token: endpoint.token });
        const events = [];
        endpoint.onMessage(event => events.push(event));

        endpoint.send({ type: 'highlightActor', id: 21, actorId: 9 });
        let input = '';
        const highlightCommand = await new Promise((resolve, reject) => {
            result.socket.on('data', chunk => {
                input += chunk;
                const newline = input.indexOf('\n');
                if (newline >= 0) resolve(JSON.parse(input.slice(0, newline)));
            });
            result.socket.on('error', reject);
        });
        assert.deepEqual(highlightCommand, { type: 'highlightActor', id: 21, actorId: 9 });
        result.socket.write(JSON.stringify({ type: 'highlightResult', id: 21, actorId: 9, success: true }) + '\n');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(events[0], { type: 'highlightResult', id: 21, actorId: 9, success: true });

        endpoint.send({ type: 'clearHighlight', id: 22 });
        result.socket.write(JSON.stringify({ type: 'highlightResult', id: 22, actorId: null, success: true }) + '\n');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(events[1], { type: 'highlightResult', id: 22, actorId: null, success: true });
        result.socket.destroy();
    });
});
