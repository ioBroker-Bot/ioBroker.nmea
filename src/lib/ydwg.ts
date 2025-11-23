import net from 'node:net';
import dgram from 'node:dgram';
import { Ydwg02, FromPgn } from '@canboat/canboatjs';
import type { PGN } from '@canboat/ts-pgns';

import { type NmeaConfig, type PGNMessage } from '../types';
import { GenericDriver } from './genericDriver';

export default class YDWG extends GenericDriver {
    private socketTcp: net.Socket | null = null;
    private socketUdp: dgram.Socket | null = null;
    private readonly ipAddress: string;
    private readonly port: number;
    private readonly protocol: 'tcp' | 'udp';
    private parser: FromPgn | null = null;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private aliveInterval: NodeJS.Timeout | null = null;
    private lastMessageTime = 0;

    private ydgw02: any;

    private readonly pgnErrors: Record<string, boolean>;

    constructor(adapter: ioBroker.Adapter, settings: NmeaConfig, onData: (event: PGN) => void) {
        super(adapter, settings, onData);
        this.ipAddress = settings.ydwgIp;
        this.port = parseInt(settings.ydwgPort as string, 10) || 1457;
        this.protocol = settings.ydwgProtocol || 'tcp';
        this.ydgw02 = null;
        this.pgnErrors = {};

        this.app.setProviderError = (id: string, msg: string) => {
            this.adapter.log.error(`YDGW: ${msg}`);
        };
    }

    reconnect(): void {
        if (this.aliveInterval) {
            clearInterval(this.aliveInterval);
            this.aliveInterval = null;
        }
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.adapter.log.debug('Reconnecting to YDEN-0x...');
            this.startClient();
        }, 5000);
    }

    startClient(): void {
        if (this.protocol === 'udp') {
            this.socketUdp = dgram.createSocket('udp4');
            this.socketUdp.on('message', (msg: Buffer) => {
                if (!this.parser) {
                    // cannot happen
                    this.adapter.log.error(`YDGW: no parser available`);
                    return;
                }
                try {
                    // YDEN-03 delivers N2K Frames, that could understood by canboatjs
                    const parsedMsg = this.parser.parseString(msg.toString());
                    if (parsedMsg) {
                        this.lastMessageTime = Date.now();
                        this.onData(parsedMsg);
                    }
                } catch (e: any) {
                    this.adapter.log.error(`Error by parsing: ${e?.message ?? e}`);
                }
            });
            this.socketUdp.on('error', err => {
                this.adapter.log.error(`Socket-Error: ${err.message}`);
                this.reconnect();
            });
            this.socketUdp.bind(this.port, '0.0.0.0', () => {
                this.adapter.log.debug(`Listening for YDEN-0x UDP packets on ${this.ipAddress}:${this.port}`);
            });
            this.socketUdp.on('listening', () => {
                this.lastMessageTime = Date.now();
                this.socketUdp?.setBroadcast(true);
                const addr = this.socketUdp?.address();
                this.adapter.log.debug(`Listening for YDEN-0x UDP packets on ${addr?.address}:${addr?.port}`);
                this.aliveInterval = setInterval(() => {
                    if (this.lastMessageTime && Date.now() - this.lastMessageTime > 10000) {
                        this.adapter.log.warn('No UDP packets received from YDEN-0x for 30 seconds, reconnecting...');
                        this.reconnect();
                    }
                }, 10_000);
            });
        } else {
            this.socketTcp = net.createConnection({ host: this.ipAddress, port: this.port }, () => {
                this.adapter.log.debug(`Connected with YDEN-0x (${this.ipAddress}:${this.port})`);
                this.lastMessageTime = Date.now();
                this.aliveInterval = setInterval(() => {
                    if (this.lastMessageTime && Date.now() - this.lastMessageTime > 10000) {
                        this.adapter.log.warn('No TCP packets received from YDEN-0x for 30 seconds, reconnecting...');
                        this.reconnect();
                    }
                }, 10_000);
            });

            this.socketTcp.on('data', (chunk: Buffer) => {
                if (this.reconnectTimeout) {
                    clearTimeout(this.reconnectTimeout);
                    this.reconnectTimeout = null;
                }

                if (!this.parser) {
                    this.adapter.log.error(`YDGW: no parser available`);
                    return;
                }
                try {
                    // YDEN-03 delivers N2K Frames, that could understood by canboatjs
                    const msg = this.parser.parseString(chunk.toString());
                    if (msg) {
                        this.lastMessageTime = Date.now();
                        this.onData(msg);
                    }
                } catch (e: any) {
                    this.adapter.log.error(`Error by parsing: ${e?.message ?? e}`);
                }
            });

            this.socketTcp.on('error', err => {
                this.adapter.log.error(`TCP Socket-Error: ${err.message}`);
                this.reconnect();
            });
        }
    }

    start(): void {
        this.parser = new FromPgn();

        this.parser.on('warning', (pgn: PGNMessage, warning: string) => {
            if (this.pgnErrors[pgn.pgn]) {
                return;
            }
            this.pgnErrors[pgn.pgn] = true;
            this.adapter.log.warn(`${pgn.pgn} ${warning}`);
        });

        this.app.setProviderStatus = (id: string, msg: string) => {
            if (msg.startsWith('Connected to')) {
                this.adapter.log.debug('Connected to Yacht Devices Gateway');
            } else {
                this.adapter.log.debug(`YDGW: ${msg}`);
            }
        };

        this.ydgw02 = Ydwg02(
            {
                app: this.app,
                plainText: true,
                disableSetTransmitPGNs: true,
                outputOnly: false,
            },
            'not-usb',
        );

        this.startClient();
    }

    write(data: string): void {
        this.adapter.log.debug(`Sending ${JSON.stringify(data)} to YDGW`);
        this.app?.emit('nmea2000out', data);
    }

    stop(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.aliveInterval) {
            clearInterval(this.aliveInterval);
            this.aliveInterval = null;
        }
        if (this.socketTcp) {
            this.socketTcp.end();
            this.socketTcp = null;
        }
        if (this.socketUdp) {
            this.socketUdp.close();
            this.socketUdp = null;
        }
        this.ydgw02?.end();
        this.app?.removeAllListeners();
    }
}
