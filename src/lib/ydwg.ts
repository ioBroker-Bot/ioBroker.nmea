import net from 'node:net';
import dgram from 'node:dgram';
import { Ydwg02, FromPgn } from '@canboat/canboatjs';
import { actisenseToYdgwRawFormat } from '@canboat/canboatjs/dist/toPgn';
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
    private tcpLineBuffer = '';

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
                        this.adapter.log.warn('No UDP packets received from YDEN-0x for 10 seconds, reconnecting...');
                        this.reconnect();
                    }
                }, 10_000);
            });
        } else {
            this.tcpLineBuffer = '';
            this.socketTcp = net.createConnection({ host: this.ipAddress, port: this.port }, () => {
                this.adapter.log.debug(`Connected with YDEN-0x (${this.ipAddress}:${this.port})`);
                this.lastMessageTime = Date.now();
                this.aliveInterval = setInterval(() => {
                    if (this.lastMessageTime && Date.now() - this.lastMessageTime > 10000) {
                        this.adapter.log.warn('No TCP packets received from YDEN-0x for 10 seconds, reconnecting...');
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
                // YDEN frames are newline-terminated; a TCP read may deliver partial lines.
                this.tcpLineBuffer += chunk.toString('ascii');
                let newlineIdx: number;
                while ((newlineIdx = this.tcpLineBuffer.indexOf('\n')) >= 0) {
                    const line = this.tcpLineBuffer.slice(0, newlineIdx).replace(/\r$/, '');
                    this.tcpLineBuffer = this.tcpLineBuffer.slice(newlineIdx + 1);
                    if (!line) {
                        continue;
                    }
                    try {
                        const msg = this.parser.parseString(line);
                        if (msg) {
                            this.lastMessageTime = Date.now();
                            this.onData(msg);
                        }
                    } catch (e: any) {
                        this.adapter.log.error(`Error by parsing: ${e?.message ?? e}`);
                    }
                }
            });

            this.socketTcp.on('error', err => {
                this.adapter.log.debug(`TCP Socket-Error: ${err.message}`);
                this.reconnect();
            });
        }
    }

    start(): void {
        this.parser = new FromPgn({ includeRawData: true });

        this.parser.on('warning', (pgn: PGNMessage, warning: string) => {
            if (this.pgnErrors[pgn.pgn]) {
                return;
            }
            this.pgnErrors[pgn.pgn] = true;
            this.adapter.log.warn(`${pgn.pgn} ${warning}`);
        });

        this.app.setProviderStatus = (_id: string, msg: string) => {
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
        // Convert the Actisense-format frame produced by encodeActisense() into the
        // YDGW-02 raw plain-text format ("hh:mm:ss.mmm T <canId> <bytes…>") and write
        // it straight to the gateway. We bypass canboatjs' Ydwg02 output path because
        // it gates sending on `sentAvailable`, which is only flipped when inbound data
        // is piped through that stream (we use our own FromPgn parser instead, so it
        // never flips and writes get silently dropped).
        let lines: string[];
        try {
            lines = actisenseToYdgwRawFormat(data);
        } catch (e: any) {
            this.adapter.log.error(`YDGW: cannot convert frame to YDGW raw: ${e?.message ?? e}`);
            return;
        }
        if (!lines?.length) {
            this.adapter.log.warn(`YDGW: encoder returned no lines for ${JSON.stringify(data)}`);
            return;
        }
        this.adapter.log.debug(`Sending to YDGW: ${lines.join(' | ')}`);
        for (const raw of lines) {
            const payload = `${raw}\r\n`;
            if (this.protocol === 'tcp') {
                if (!this.socketTcp || this.socketTcp.destroyed) {
                    this.adapter.log.warn('YDGW: TCP socket not connected, dropping outbound frame');
                    return;
                }
                this.socketTcp.write(payload);
            } else {
                if (!this.socketUdp) {
                    this.adapter.log.warn('YDGW: UDP socket not bound, dropping outbound frame');
                    return;
                }
                this.socketUdp.send(payload, this.port, this.ipAddress);
            }
        }
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
