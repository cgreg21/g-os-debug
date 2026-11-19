/** Versioned private protocol shared by the adapter and the in-process GJS runtime. */
export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export interface ActorSnapshot {
    id: number;
    typeName: string;
    name: string | null;
    visible: boolean;
    mapped: boolean;
    childCount: number;
    allocation: { x: number; y: number; width: number; height: number } | null;
    children: ActorSnapshot[];
}

export type RuntimeRequest =
    | { type: 'hello'; protocolVersion: number; adapterVersion: string; token: string }
    | { type: 'ping'; id: number }
    | { type: 'shutdown'; id: number }
    | { type: 'inspectStage'; id: number; maxDepth?: number; maxNodes?: number };

export type RuntimeResponse =
    | { type: 'hello'; protocolVersion: number; runtimeVersion: string; capabilities: string[] }
    | { type: 'pong'; id: number }
    | { type: 'stageSnapshot'; id: number; root: ActorSnapshot | null; truncated: boolean }
    | { type: 'error'; id?: number; code: string; message: string };

export interface DapMessage {
    seq: number;
    type: 'request' | 'response' | 'event';
    [key: string]: unknown;
}

export function encodeDapMessage(message: DapMessage): Buffer {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii');
    return Buffer.concat([header, body]);
}

/** Incremental decoder for partial and coalesced DAP stdio frames. */
export class DapFrameDecoder {
    #buffer = Buffer.alloc(0);

    push(chunk: Buffer | string): DapMessage[] {
        this.#buffer = Buffer.concat([this.#buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        const messages: DapMessage[] = [];
        while (true) {
            const boundary = this.#buffer.indexOf('\r\n\r\n');
            if (boundary < 0) break;
            const headers = this.#buffer.subarray(0, boundary).toString('ascii');
            const match = /^Content-Length:\s*(\d+)\s*$/im.exec(headers);
            if (!match) throw new Error('Invalid DAP frame: missing Content-Length header');
            const length = Number(match[1]);
            if (!Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 * 1024)
                throw new Error('Invalid DAP frame: Content-Length is out of range');
            const bodyStart = boundary + 4;
            if (this.#buffer.length < bodyStart + length) break;
            const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
            this.#buffer = this.#buffer.subarray(bodyStart + length);
            const parsed: unknown = JSON.parse(body);
            if (!parsed || typeof parsed !== 'object' || !('seq' in parsed) || !('type' in parsed))
                throw new Error('Invalid DAP message body');
            messages.push(parsed as DapMessage);
        }
        return messages;
    }
}
