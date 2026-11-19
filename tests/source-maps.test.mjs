import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceMapResolver } from '../packages/source-maps/dist/index.js';

const map = {
    version: 3,
    file: 'extension.js',
    sourceRoot: '',
    sources: ['../src/extension.ts'],
    sourcesContent: ['const answer = 42;\nconsole.log(answer);\n'],
    names: ['answer'],
    mappings: 'AAAA,MAAMA,MAAM,CAAC;AACb,OAAO,CAACC,GAAG,CAACD,MAAM,CAAC',
};

test('maps generated JavaScript positions to TypeScript', () => {
    const resolver = new SourceMapResolver(map, '/workspace/dist');
    const result = resolver.toOriginal({ line: 2, column: 4 });
    assert.ok(result);
    assert.equal(result.source, '/workspace/src/extension.ts');
    assert.equal(result.line, 2);
});

test('maps TypeScript positions back to generated JavaScript', () => {
    const resolver = new SourceMapResolver(map, '/workspace/dist');
    const result = resolver.toGenerated({
        source: '/workspace/src/extension.ts',
        line: 2,
        column: 0,
    });
    assert.deepEqual(result, { line: 2, column: 0 });
});

test('returns null for unmapped locations', () => {
    const resolver = new SourceMapResolver(map, '/workspace/dist');
    assert.equal(resolver.toOriginal({ line: 20, column: 0 }), null);
    assert.equal(resolver.toGenerated({
        source: '/workspace/src/missing.ts', line: 1, column: 0,
    }), null);
});

test('rejects invalid generated coordinates', () => {
    const resolver = new SourceMapResolver(map, '/workspace/dist');
    assert.throws(() => resolver.toOriginal({ line: 0, column: 0 }), RangeError);
});
