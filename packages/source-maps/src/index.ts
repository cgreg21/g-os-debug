import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { originalPositionFor, TraceMap, GREATEST_LOWER_BOUND, LEAST_UPPER_BOUND, generatedPositionFor } from '@jridgewell/trace-mapping';

export interface SourcePosition {
    source: string;
    line: number;
    column: number;
    name?: string | null;
}

export interface GeneratedPosition {
    line: number;
    column: number;
}

export interface SourceMapResolverOptions {
    /** Resolve relative map sources against this directory (normally the map file directory). */
    sourceRoot?: string;
    /** Optional path normalizer for mapping into the editor workspace. */
    normalizeSource?: (source: string) => string;
}

/** Bidirectional resolver for standard v3 JavaScript source maps. */
export class SourceMapResolver {
    readonly #map: TraceMap;
    readonly #mapDirectory: string;
    readonly #options: SourceMapResolverOptions;

    constructor(map: object | string, mapDirectory: string, options: SourceMapResolverOptions = {}) {
        const parsed = typeof map === 'string' ? JSON.parse(map) as object : map;
        this.#map = new TraceMap(parsed as never);
        this.#mapDirectory = resolve(mapDirectory);
        this.#options = options;
    }

    static async fromFile(mapPath: string, options: SourceMapResolverOptions = {}): Promise<SourceMapResolver> {
        const absolutePath = resolve(mapPath);
        return new SourceMapResolver(await readFile(absolutePath, 'utf8'), dirname(absolutePath), options);
    }

    toOriginal(generated: GeneratedPosition): SourcePosition | null {
        if (!Number.isInteger(generated.line) || generated.line < 1 ||
            !Number.isInteger(generated.column) || generated.column < 0)
            throw new RangeError('Generated positions use 1-based lines and 0-based columns');

        const result = originalPositionFor(this.#map, {
            line: generated.line,
            column: generated.column,
            bias: GREATEST_LOWER_BOUND,
        });
        if (!result.source || result.line === null || result.column === null)
            return null;

        return {
            source: this.#resolveSource(result.source),
            line: result.line,
            column: result.column,
            ...(result.name ? { name: result.name } : {}),
        };
    }

    toGenerated(original: SourcePosition): GeneratedPosition | null {
        if (!Number.isInteger(original.line) || original.line < 1 ||
            !Number.isInteger(original.column) || original.column < 0)
            throw new RangeError('Original positions use 1-based lines and 0-based columns');

        const source = this.#findMapSource(original.source);
        if (!source)
            return null;

        const result = generatedPositionFor(this.#map, {
            source,
            line: original.line,
            column: original.column,
            bias: LEAST_UPPER_BOUND,
        });
        return result.line === null || result.column === null
            ? null
            : { line: result.line, column: result.column };
    }

    #resolveSource(source: string): string {
        const rooted = this.#options.sourceRoot
            ? resolve(this.#mapDirectory, this.#options.sourceRoot, source)
            : isAbsolute(source) ? source : resolve(this.#mapDirectory, source);
        return this.#options.normalizeSource?.(rooted) ?? rooted;
    }

    #findMapSource(requested: string): string | null {
        const normalizedRequested = resolve(requested);
        const sources = this.#map.sources;
        for (const source of sources) {
            const resolved = this.#resolveSource(source);
            if (resolved === normalizedRequested)
                return source;
            const normalized = this.#options.normalizeSource?.(resolved);
            if (normalized === requested)
                return source;
        }
        return null;
    }
}
