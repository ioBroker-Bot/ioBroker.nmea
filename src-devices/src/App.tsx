// Live dev harness — opens a real socket.io connection to the ioBroker admin at
// localhost:8081, wires a minimal StateContext, and renders the NMEA widgets so the
// SVG + rAF animation can be tested against actual PGN data in the browser.
//
// NOT part of the production bundle. Only loaded by src/index.tsx (Vite dev server).

import React, { useEffect, useState } from 'react';
import { Connection } from '@iobroker/adapter-react-v5';
import type { IStateContext, StateChangeListener, ObjectChangeListener } from '@iobroker/dm-widgets';
import NmeaWindCompass from './NmeaWindComponent';
import NmeaHistoryChartComponent from './NmeaHistoryChartComponent';

const IOB_HOST = 'localhost';
const IOB_PORT = 8081;
const DEFAULT_INSTANCE = 'nmea.0';

type WidgetTab = 'wind' | 'chart-aws' | 'chart-tws' | 'chart-sog' | 'chart-stw';

const ACTIVE_TAB_KEY = 'nmeaDevHarness.activeTab';
const VALID_TABS: readonly WidgetTab[] = ['wind', 'chart-aws', 'chart-tws', 'chart-sog', 'chart-stw'];

/** Read the last-selected tab from localStorage; fall back to the Wind compass on first visit or
 *  whenever the stored value isn't one of the currently-defined tabs (e.g. after a rename). */
function loadStoredTab(): WidgetTab {
    try {
        const raw = window.localStorage.getItem(ACTIVE_TAB_KEY);
        if (raw && (VALID_TABS as readonly string[]).includes(raw)) {
            return raw as WidgetTab;
        }
    } catch {
        // Storage may be disabled (private mode, SSR, etc.) — silently fall back.
    }
    return 'wind';
}

interface ChartPreset {
    id: WidgetTab;
    tabLabel: string;
    stateId: string; // relative to instance
    label: string;
    unit: string;
    historySeconds?: number;
}

const CHART_PRESETS: ChartPreset[] = [
    { id: 'chart-aws', tabLabel: 'AWS Chart', stateId: 'windData.windSpeedApparent', label: 'AWS', unit: 'knots' },
    { id: 'chart-tws', tabLabel: 'TWS Chart', stateId: 'windData.windSpeedTrue', label: 'TWS', unit: 'knots' },
    { id: 'chart-sog', tabLabel: 'SOG Chart', stateId: 'cogSogRapidUpdate.sog', label: 'SOG', unit: 'knots' },
    { id: 'chart-stw', tabLabel: 'STW Chart', stateId: 'speed.speedWaterReferenced', label: 'STW', unit: 'knots' },
];

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
    flexWrap: 'wrap',
};

const tabButtonStyle = (active: boolean): React.CSSProperties => ({
    padding: '8px 18px',
    borderRadius: 6,
    border: `1px solid ${active ? '#4a9eff' : '#3a3f43'}`,
    background: active ? '#1b3a5c' : '#0b0f14',
    color: active ? '#ffffff' : '#d8dde0',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
    transition: 'background 120ms, border-color 120ms',
});

/**
 * Minimal IStateContext implementation that routes getState/removeState to a real
 * `@iobroker/socket-client` Connection. Fan-out per ID is handled locally so the
 * same state can have multiple subscribers (widget instance + dev UI for example).
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
            void this.socket.subscribeState(id, (sid, state) => {
                const listeners = this.handlers.get(sid);
                if (!listeners || !state) {
                    return;
                }
                for (const cb of listeners) {
                    cb(sid, state);
                }
            });
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

    getObjectProperty(_id: string, _property: string, _cb: ObjectChangeListener): void {}
    async removeObject(_id: string, _cb: ObjectChangeListener): Promise<void> {}

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
        return (this as any).renderCompassSvg(Math.min(window.innerWidth, window.innerHeight) - 40, false);
    }
}

/**
 * Same trick for the history chart — WidgetGeneric is stubbed in dev, so call the private
 * renderChartSvg directly and wrap it in a size-constrained container.
 */
class DevHistoryChart extends NmeaHistoryChartComponent {
    override render(): React.JSX.Element {
        const w = Math.min(window.innerWidth - 40, 1100);
        const h = Math.min(window.innerHeight - 120, Math.round(w / 1.5));
        return <div style={{ width: w, height: h }}>{(this as any).renderChartSvg(false)}</div>;
    }
}

type ConnState = 'connecting' | 'ready' | { error: string };

export default function App(): React.JSX.Element {
    const [ctx, setCtx] = useState<DevStateContext | null>(null);
    const [conn, setConn] = useState<ConnState>('connecting');
    // Lazy initializer so localStorage is only read once on mount, not on every render.
    const [activeTab, setActiveTab] = useState<WidgetTab>(() => loadStoredTab());

    // Persist the tab whenever it changes so a hard-refresh lands on the same widget.
    useEffect(() => {
        try {
            window.localStorage.setItem(ACTIVE_TAB_KEY, activeTab);
        } catch {
            // localStorage may be unavailable — non-fatal.
        }
    }, [activeTab]);

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

    // Minimal WidgetInfo — the widgets never read most of these, but the prop type requires them.
    const widget = {
        id: `dev-${activeTab}`,
        type: 'widget' as const,
        name: activeTab,
        control: {
            states: [],
            type: 'unknown',
            storeId: '',
            parentId: '',
            deviceId: '',
            channelId: '',
        },
    };

    const windSettings = {
        size: '2x1' as const,
        name: 'Wind',
        favorite: false,
        color: '',
        chartHours: 0,
        icon: '',
        iconActive: '',
        text: '',
        textActive: '',
        instance: DEFAULT_INSTANCE,
        historySeconds: 60,
        speedUnit: 'knots' as const,
        closeHauledAngle: 60,
    };

    const chartPreset = CHART_PRESETS.find(p => p.id === activeTab);
    const chartSettings = chartPreset
        ? {
              size: '2x1' as const,
              name: chartPreset.label,
              favorite: false,
              color: '',
              chartHours: 0,
              icon: '',
              iconActive: '',
              text: '',
              textActive: '',
              instance: DEFAULT_INSTANCE,
              stateId: chartPreset.stateId,
              label: chartPreset.label,
              unit: chartPreset.unit,
              historySeconds: chartPreset.historySeconds ?? 300,
              yMin: 0,
              yMax: 0,
              decimals: 1,
          }
        : null;

    const tabs: { id: WidgetTab; label: string }[] = [
        { id: 'wind', label: 'Wind Compass' },
        ...CHART_PRESETS.map(p => ({ id: p.id, label: p.tabLabel })),
    ];

    return (
        <div
            style={{ minHeight: '100vh', background: '#191c1d', color: '#d8dde0', fontFamily: 'system-ui, sans-serif' }}
        >
            <div style={toolbarStyle}>
                {tabs.map(t => (
                    <button
                        key={t.id}
                        type="button"
                        style={tabButtonStyle(activeTab === t.id)}
                        onClick={() => setActiveTab(t.id)}
                    >
                        {t.label}
                    </button>
                ))}
                <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 13 }}>
                    connected to {IOB_HOST}:{IOB_PORT}
                </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
                {activeTab === 'wind' ? (
                    // Key forces a full remount on tab switch so refs/subscriptions reset cleanly.
                    <DevWindCompass
                        key="wind"
                        widget={widget as any}
                        stateContext={ctx as any}
                        settings={windSettings as any}
                        onHide={() => {}}
                    />
                ) : chartSettings ? (
                    <DevHistoryChart
                        key={activeTab}
                        widget={widget as any}
                        stateContext={ctx as any}
                        settings={chartSettings as any}
                        onHide={() => {}}
                    />
                ) : null}
            </div>
        </div>
    );
}
