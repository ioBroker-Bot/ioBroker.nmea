// Live dev harness — opens a real socket.io connection to the ioBroker admin at
// localhost:8081, wires a minimal StateContext, and renders NmeaWindCompass so the
// SVG + rAF animation can be tested against actual PGN data in the browser.
//
// NOT part of the production bundle. Only loaded by src/index.tsx (Vite dev server).

import React, { useEffect, useState } from 'react';
import { Connection } from '@iobroker/adapter-react-v5';
import type { IStateContext, StateChangeListener, ObjectChangeListener } from '@iobroker/dm-widgets';
import NmeaWindCompass from './NmeaWindComponent';

const IOB_HOST = 'localhost';
const IOB_PORT = 8081;
const DEFAULT_INSTANCE = 'nmea.0';

const overlayStyle: React.CSSProperties = {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#191c1d',
    color: '#d8dde0',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 18,
};

const toolbarStyle: React.CSSProperties = {
    padding: '10px 16px',
    borderBottom: '1px solid #2a2f33',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
};

/**
 * Minimal IStateContext implementation that routes getState/removeState to a real
 * `@iobroker/socket-client` Connection. Fan-out per ID is handled locally so the
 * same state can have multiple subscribers (widget DEFAULT_INSTANCE + dev UI for example).
 */
class DevStateContext implements IStateContext {
    private handlers = new Map<string, Set<StateChangeListener>>();
    private readonly socket: Connection;

    // Fields required by IStateContext — sensible dev defaults.
    defaultHistory: string | null = null;
    instanceId = '';
    admin = false;
    language: ioBroker.Languages = 'en';
    longitude: number | null = null;
    latitude: number | null = null;
    isFloatComma = true;
    dateFormat = 'DD.MM.YYYY';
    imagePrefix = '../../files/';

    constructor(socket: Connection) {
        this.socket = socket;
    }

    getState(id: string, handler: StateChangeListener): void {
        let set = this.handlers.get(id);
        if (!set) {
            set = new Set();
            this.handlers.set(id, set);
            // Subscribe once per ID. The single socket handler fans out to every registered listener.
            void this.socket.subscribeState(id, (sid, state) => {
                const listeners = this.handlers.get(sid);
                if (!listeners || !state) {
                    return;
                }
                for (const cb of listeners) {
                    cb(sid, state);
                }
            });
            // Deliver the last-known value immediately so the widget doesn't sit at null until the
            // next PGN update.
            void this.socket
                .getState(id)
                .then(state => {
                    if (state) {
                        handler(id, state);
                    }
                })
                .catch(() => {});
        }
        set.add(handler);
    }

    removeState(id: string, handler: StateChangeListener): void {
        const set = this.handlers.get(id);
        if (!set) {
            return;
        }
        set.delete(handler);
        if (set.size === 0) {
            this.socket.unsubscribeState(id);
            this.handlers.delete(id);
        }
    }

    async getObject<T>(id: string): Promise<T | undefined> {
        try {
            return (await this.socket.getObject(id)) as unknown as T;
        } catch {
            return undefined;
        }
    }

    getObjectProperty(_id: string, _property: string, _cb: ObjectChangeListener): void {
        // Widget doesn't use this path; stubbed.
    }

    async removeObject(_id: string, _cb: ObjectChangeListener): Promise<void> {
        // Paired stub.
    }

    getSocket(): Connection {
        return this.socket;
    }

    destroy(): void {
        for (const id of this.handlers.keys()) {
            this.socket.unsubscribeState(id);
        }
        this.handlers.clear();
    }
}

/**
 * Dev subclass — the real WidgetGeneric is provided by the host via Module Federation and is
 * stubbed in the installed dm-widgets package, so `render()` returns null when the widget is
 * loaded standalone. Override it to render the compass SVG directly; all the other lifecycle
 * (subscribe/unsubscribe, rAF animations) runs unchanged.
 */
class DevWindCompass extends NmeaWindCompass {
    override render(): React.JSX.Element {
        // renderCompassSvg is private; cast to any to access it from the subclass.
        return (this as any).renderCompassSvg(Math.min(window.innerWidth, window.innerHeight) - 40, false);
    }
}

type ConnState = 'connecting' | 'ready' | { error: string };

export default function App(): React.JSX.Element {
    const [ctx, setCtx] = useState<DevStateContext | null>(null);
    const [conn, setConn] = useState<ConnState>('connecting');

    useEffect(() => {
        let socket: Connection | null = null;
        try {
            socket = new Connection({
                host: IOB_HOST,
                port: IOB_PORT,
                protocol: 'http:',
                name: 'nmea-dev-harness',
                admin5only: true,
                onReady: () => {
                    setCtx(new DevStateContext(socket!));
                    setConn('ready');
                },
                onError: (err: Error) => setConn({ error: String(err?.message || err) }),
            } as any);
        } catch (err) {
            setConn({ error: String(err) });
        }
        return () => {
            try {
                socket?.destroy?.();
            } catch {
                // ignore
            }
        };
    }, []);

    if (conn === 'connecting') {
        return <div style={overlayStyle}>Connecting to {`http://${IOB_HOST}:${IOB_PORT}`} …</div>;
    }
    if (typeof conn === 'object' && 'error' in conn) {
        return <div style={{ ...overlayStyle, color: '#ff6b6b' }}>Connection error: {conn.error}</div>;
    }
    if (!ctx) {
        return <div style={overlayStyle}>Initializing state context …</div>;
    }

    // Minimal WidgetInfo — the compass never reads most of these, but the prop type requires them.
    const widget = {
        id: 'dev-wind',
        type: 'widget' as const,
        name: 'Wind',
        control: {
            states: [],
            type: 'unknown',
            storeId: '',
            parentId: '',
            deviceId: '',
            channelId: '',
        },
    };

    const settings = {
        size: '2x1' as const,
        name: 'Wind',
        favorite: false,
        color: '',
        chartHours: 0,
        icon: '',
        iconActive: '',
        text: '',
        textActive: '',
        DEFAULT_INSTANCE,
        historySeconds: 60,
        speedUnit: 'knots' as const,
        closeHauledAngle: 60,
    };

    return (
        <div
            style={{ minHeight: '100vh', background: '#191c1d', color: '#d8dde0', fontFamily: 'system-ui, sans-serif' }}
        >
            <div style={toolbarStyle}>
                <span style={{ marginLeft: 16, opacity: 0.7 }}>
                    connected to {IOB_HOST}:{IOB_PORT}
                </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
                {/* Key on `DEFAULT_INSTANCE` so changing it remounts the widget and re-subscribes. */}
                <DevWindCompass
                    key={DEFAULT_INSTANCE}
                    widget={widget as any}
                    stateContext={ctx as any}
                    settings={settings as any}
                    onHide={() => {}}
                />
            </div>
        </div>
    );
}
