import EventEmitter from 'node:events';

import type { NmeaConfig, WritePgnData } from '../types';
import type { PGN } from '@canboat/ts-pgns';

interface ExtendedEmitter extends EventEmitter {
    setProviderStatus: (id: string, msg: string) => void;
    setProviderError: (id: string, msg: string) => void;
}

export abstract class GenericDriver {
    protected readonly adapter: ioBroker.Adapter;

    protected readonly onData: (event: PGN) => void;

    protected readonly app: ExtendedEmitter;

    protected constructor(adapter: ioBroker.Adapter, settings: NmeaConfig, onData: (event: PGN) => void) {
        this.adapter = adapter;
        this.onData = onData;
        this.app = new EventEmitter() as ExtendedEmitter;
    }

    abstract start(): void;

    abstract write(data: string | WritePgnData): void;

    abstract stop(): void;
}
