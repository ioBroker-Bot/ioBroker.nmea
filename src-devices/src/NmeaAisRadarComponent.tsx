// NMEA AIS Radar — KIP-inspired plan-position display of AIS targets relative to the
// own vessel.
//
// Renders a square radar dial with concentric range rings, cardinal labels, a centre
// own-ship icon, and per-target arrows that rotate to each target's course-over-ground.
// Range is user-selectable (3 / 6 / 12 / 24 NM); orientation switchable between North-Up
// and Course-Up. Optional COG vectors extrapolate target motion N minutes ahead.
//
// Data flow: enumerate ioBroker states under `nmea.X.aisClass*PositionReport.*` and
// `nmea.X.aisAidsToNavigationAtonReport.*` via the underlying socket, subscribe to each,
// and parse the JSON value (the adapter stores the full canboat-decoded fields as JSON
// inside the state value — see src/main.ts: `setState(aisId, JSON.stringify(fields))`).
// Targets that haven't reported within the staleness window are pruned automatically.

import WidgetGeneric, {
    React,
    MuiMaterial,
    MuiIcons,
    getTileStyles,
    isNeumorphicTheme,
    type WidgetGenericProps,
    type WidgetGenericState,
    type CustomWidgetPlugin,
} from '@iobroker/dm-widgets';
import type {
    BoxProps,
    TypographyProps,
    DialogProps,
    IconButtonProps,
    DialogContentProps,
    ToggleButtonProps,
    ToggleButtonGroupProps,
} from '@mui/material';
import type { ConfigItemPanel, ConfigItemTabs } from '@iobroker/json-config';
// Leaflet renders the chart base layer behind the SVG overlay. Imported as a side-effect
// for the CSS so the map container gets the default sizing/cursor behaviour.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Same MUI bridge resolution as the other widgets (NmeaAutopilot / NmeaWind / NmeaHistoryChart):
// pull components from the host-shared `window.__iobrokerShared__` via `@iobroker/dm-widgets`,
// not via direct `@mui/material` imports. Keeps all plugins on the same React/MUI instance as
// the host so there's no dual-instance hazard. The dev harness shims the global in dev-shim.ts.
const Box: React.ComponentType<BoxProps> = MuiMaterial?.Box;
const Typography: React.ComponentType<TypographyProps> = MuiMaterial?.Typography;
const Dialog: React.ComponentType<DialogProps> = MuiMaterial?.Dialog;
const DialogContent: React.ComponentType<DialogContentProps> = MuiMaterial?.DialogContent;
const IconButton: React.ComponentType<IconButtonProps> = MuiMaterial?.IconButton;
const ToggleButton: React.ComponentType<ToggleButtonProps> = MuiMaterial?.ToggleButton;
const ToggleButtonGroup: React.ComponentType<ToggleButtonGroupProps> = MuiMaterial?.ToggleButtonGroup;
const CloseIcon: React.ComponentType<any> = MuiIcons?.Close;
const AddIcon: React.ComponentType<any> = MuiIcons?.Add;
const RemoveIcon: React.ComponentType<any> = MuiIcons?.Remove;

interface AisRadarSettings extends CustomWidgetPlugin {
    /** e.g. 'nmea.0' */
    instance?: string;
    /** Initial range in nautical miles. */
    rangeNm?: number;
    /** Show dashed COG vectors extrapolated `vectorMinutes` ahead. */
    showVectors?: boolean;
    /** Length of the COG vector in minutes of motion (1..10). */
    vectorMinutes?: number;
    /** Course-Up (rotates the chart so own bow is up); otherwise North-Up. */
    courseUp?: boolean;
    /** Drop targets that haven't reported within this many minutes (1..60). */
    staleMinutes?: number;
}

interface AisTarget {
    mmsi: string;
    lat: number;
    lon: number;
    /** Course over ground in degrees (0..360, true). May be NaN/undefined for stationary. */
    cog: number;
    /** Speed over ground in knots. */
    sog: number;
    /** True heading in degrees (or undefined). */
    heading: number | null;
    /** Vessel/AtoN classification: 'A' / 'B' / 'AtoN' / 'SAR' / 'Other'. */
    cls: 'A' | 'B' | 'AtoN' | 'SAR' | 'Other';
    /** Vessel name if known (kept across rapid-position updates). */
    name: string | null;
    /** Last update wall clock (ms). */
    lastSeen: number;
    /** Recent positions kept for the trail rendering — last point is `(lat, lon)` itself. */
    trail: { lat: number; lon: number; ts: number }[];
}

/** Maximum number of trail points kept per target — older ones are evicted in FIFO order. */
const TRAIL_MAX_POINTS = 60;
/** Maximum age of a trail point (ms) — points older than this fall out of the buffer. */
const TRAIL_MAX_AGE_MS = 30 * 60_000;

/**
 * Deterministic per-MMSI hue. Uses a simple 32-bit polynomial hash so two adjacent MMSIs
 * (e.g. 211215360 / 211215361) land far apart on the colour wheel — important so neighbours'
 * tracks don't blur into each other on a busy radar. Saturation/lightness chosen so the
 * chevron and trail stay readable against both the dark map and the radial vignette.
 */
function shipColor(mmsi: string): string {
    let h = 0;
    for (let i = 0; i < mmsi.length; i++) {
        h = Math.imul(h ^ mmsi.charCodeAt(i), 2_654_435_761) | 0;
    }
    const hue = ((h % 360) + 360) % 360;
    return `hsl(${hue} 75% 62%)`;
}

interface AisRadarComponentState extends WidgetGenericState {
    targets: Map<string, AisTarget>;
    /** Own vessel state. */
    ownLat: number | null;
    ownLon: number | null;
    ownCog: number | null;
    ownSog: number | null;
    ownHeading: number | null;
    rangeNm: number;
    courseUp: boolean;
    dialogOpen: boolean;
}

const DEFAULT_RANGE_NM = 6;
const DEFAULT_VECTOR_MINUTES = 6;
const DEFAULT_STALE_MINUTES = 10;
const DEFAULT_SHOW_VECTORS = true;
const DEFAULT_COURSE_UP = false;
// Minimum zoom is 1 NM — narrower than that and individual AIS positions would jitter visibly
// inside the dial just from GPS noise. Maximum 48 NM keeps tile-load latency reasonable.
const RANGE_PRESETS_NM = [1, 1.5, 2, 3, 6, 12, 24, 48];

// Earth radius (meters) for the equirectangular projection. Accurate enough for ranges
// well below 100 NM where curvature error stays in the cm range — perfect for a radar plot.
const EARTH_RADIUS_M = 6_371_000;
const M_PER_NM = 1852;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MS_TO_KN = 1.9438444924574;

const COLORS = {
    bg: '#000000',
    cardBg: '#0E1F2A',
    grey: '#5C6E80',
    contrast: '#FFFFFF',
    dim: '#7E8A99',
    own: '#3a8dff', // own-ship blue (matches compass-N convention)
    classA: '#ffeb3b', // standard AIS yellow for cargo/passenger
    classB: '#4caf50', // green for class B (recreational)
    aton: '#9c27b0', // purple for aids-to-navigation
    sar: '#ff5252', // red for SAR / emergency
    vector: '#90a4ae',
} as const;

// Square viewBox.
const VIEWBOX = 1000;
const CENTER = VIEWBOX / 2;
const R_OUTER = 470; // outermost ring radius
const RING_FRACTIONS = [0.25, 0.5, 0.75, 1.0];

/** AIS class lookup. The state-channel name encodes the source PGN, which maps to the type. */
function classifyAisChannel(channelId: string): AisTarget['cls'] {
    if (channelId.includes('aisAidsToNavigation')) {
        return 'AtoN';
    }
    if (channelId.includes('SafetyRelatedBroadcast') || channelId.includes('SARAircraft')) {
        return 'SAR';
    }
    if (channelId.includes('aisClassA')) {
        return 'A';
    }
    if (channelId.includes('aisClassB')) {
        return 'B';
    }
    return 'Other';
}

/**
 * Equirectangular projection: project (lat, lon) relative to (refLat, refLon) into local
 * meters east / north. The cosine factor keeps the eastward distance correct as you move away
 * from the equator. Linear in (Δlat, Δlon), so direct, fast, and within centimetres of
 * great-circle for ranges under ~100 NM at mid-latitudes.
 */
function projectToMeters(lat: number, lon: number, refLat: number, refLon: number): { east: number; north: number } {
    const dLat = (lat - refLat) * RAD;
    const dLon = (lon - refLon) * RAD;
    const meanLat = (lat + refLat) * 0.5 * RAD;
    return {
        east: dLon * Math.cos(meanLat) * EARTH_RADIUS_M,
        north: dLat * EARTH_RADIUS_M,
    };
}

export class NmeaAisRadarComponent extends WidgetGeneric<AisRadarComponentState, AisRadarSettings> {
    private stateHandlers = new Map<string, (id: string, state: ioBroker.State | null | undefined) => void>();
    private aisChannels = new Set<string>();
    /** Leaflet map instances — one per render variant (compact tile, wide-tall tile, dialog).
     *  Each rendered radar gets its own map because Leaflet binds tightly to its container DOM,
     *  and we render the SVG into different containers per variant. The instance is keyed by a
     *  deterministic suffix supplied by the caller (renderRadar(...)). */
    private maps = new Map<string, L.Map>();
    /** Container divs are written into via React refs (see renderRadar). */
    private mapContainers = new Map<string, HTMLDivElement | null>();
    /**
     * Stable ref callbacks per key — recreated only on first render for a key, then reused.
     *  Without this, an inline `ref={el => this.attachMap(key, el)}` would have a fresh
     *  identity every render → React would call it with null (unmount old) then with the new
     *  element (mount), tearing the Leaflet map down + back up on every render and causing a
     *  visible flicker. Stable refs mean React only invokes the callback when the DOM node
     *  actually changes.
     */
    private mapRefCallbacks = new Map<string, (el: HTMLDivElement | null) => void>();
    /**
     * Same idea for the outer radar wrapper — used to attach a non-passive `wheel` listener
     *  so we can preventDefault page-scrolling and zoom the radar instead.
     */
    private wrapperRefCallbacks = new Map<string, (el: HTMLDivElement | null) => void>();
    private wrapperContainers = new Map<string, HTMLDivElement | null>();
    /** Timer that restores the default range after a period without wheel activity. */
    private wheelResetTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly WHEEL_RESET_MS = 15_000;

    constructor(props: WidgetGenericProps<AisRadarSettings>) {
        super(props);
        this.state = {
            ...this.state,
            targets: new Map(),
            ownLat: null,
            ownLon: null,
            ownCog: null,
            ownSog: null,
            ownHeading: null,
            rangeNm: props.settings.rangeNm ?? DEFAULT_RANGE_NM,
            courseUp: props.settings.courseUp ?? DEFAULT_COURSE_UP,
            dialogOpen: false,
        };
    }

    static override getConfigSchema(): { name: string; schema: ConfigItemPanel | ConfigItemTabs } {
        return {
            name: 'NmeaAisRadar',
            schema: {
                type: 'panel',
                items: {
                    instance: {
                        type: 'instance',
                        adapter: 'nmea',
                        label: 'nmeaair_instance',
                        default: 'nmea.0',
                    },
                    rangeNm: {
                        type: 'number',
                        label: 'nmeaair_rangeNm',
                        default: DEFAULT_RANGE_NM,
                        min: 1,
                        max: 96,
                        sm: 6,
                    },
                    staleMinutes: {
                        type: 'number',
                        label: 'nmeaair_staleMinutes',
                        default: DEFAULT_STALE_MINUTES,
                        min: 1,
                        max: 60,
                        sm: 6,
                    },
                    showVectors: {
                        type: 'checkbox',
                        label: 'nmeaair_showVectors',
                        default: DEFAULT_SHOW_VECTORS,
                        sm: 6,
                    },
                    vectorMinutes: {
                        type: 'number',
                        label: 'nmeaair_vectorMinutes',
                        default: DEFAULT_VECTOR_MINUTES,
                        min: 1,
                        max: 30,
                        sm: 6,
                        hidden: 'data.showVectors === false',
                    },
                    courseUp: {
                        type: 'checkbox',
                        label: 'nmeaair_courseUp',
                        default: DEFAULT_COURSE_UP,
                        sm: 6,
                    },
                },
            },
        };
    }

    componentDidMount(): void {
        super.componentDidMount?.();
        this.subscribeOwnShip();
        void this.discoverAndSubscribeAis();
        // No periodic re-render: targets refresh from their own state-change subscriptions, and
        // stale-target filtering happens at render time (so they disappear on the next normal
        // re-render without needing a forced repaint). Forcing a render every 2 s caused a
        // visible flicker on the Leaflet base layer.
    }

    componentDidUpdate(
        prevProps: Readonly<WidgetGenericProps<AisRadarSettings>>,
        prevState: Readonly<AisRadarComponentState>,
    ): void {
        super.componentDidUpdate?.(prevProps, this.state);
        if (prevProps.settings.instance !== this.props.settings.instance) {
            this.unsubscribeAll();
            this.subscribeOwnShip();
            void this.discoverAndSubscribeAis();
        }
        // Re-sync Leaflet maps whenever the own position or chosen range changes.
        if (
            prevState.ownLat !== this.state.ownLat ||
            prevState.ownLon !== this.state.ownLon ||
            prevState.rangeNm !== this.state.rangeNm
        ) {
            this.syncAllMaps();
        }
    }

    componentWillUnmount(): void {
        super.componentWillUnmount?.();
        this.unsubscribeAll();
        // Tear down Leaflet maps to release the tile-layer caches and DOM listeners.
        for (const map of this.maps.values()) {
            map.remove();
        }
        this.maps.clear();
        this.mapContainers.clear();
        this.mapRefCallbacks.clear();
        // Detach wheel listeners from the radar wrappers.
        for (const [, el] of this.wrapperContainers) {
            if (el) {
                el.removeEventListener('wheel', this.onWheel as any);
            }
        }
        this.wrapperContainers.clear();
        this.wrapperRefCallbacks.clear();
        if (this.wheelResetTimer) {
            clearTimeout(this.wheelResetTimer);
            this.wheelResetTimer = null;
        }
    }

    /** Get (or lazily create) a stable ref callback for the given key. See `mapRefCallbacks`. */
    private getMapRef(key: string): (el: HTMLDivElement | null) => void {
        let cb = this.mapRefCallbacks.get(key);
        if (!cb) {
            cb = (el: HTMLDivElement | null): void => this.attachMap(key, el);
            this.mapRefCallbacks.set(key, cb);
        }
        return cb;
    }

    /**
     * Stable ref callback for the outer radar wrapper. Attaches a non-passive `wheel` listener
     * so we can call `preventDefault()` and treat the wheel as a zoom action instead of a page
     * scroll. React's synthetic onWheel is passive by default in modern browsers, which makes
     * `preventDefault` a no-op; only a raw addEventListener with `passive: false` works.
     */
    private getWrapperRef(key: string): (el: HTMLDivElement | null) => void {
        let cb = this.wrapperRefCallbacks.get(key);
        if (!cb) {
            cb = (el: HTMLDivElement | null): void => {
                const prev = this.wrapperContainers.get(key);
                if (prev === el) {
                    return;
                }
                if (prev) {
                    prev.removeEventListener('wheel', this.onWheel as any);
                }
                this.wrapperContainers.set(key, el);
                if (el) {
                    el.addEventListener('wheel', this.onWheel as any, { passive: false });
                }
            };
            this.wrapperRefCallbacks.set(key, cb);
        }
        return cb;
    }

    /**
     * Wheel handler — zooms the radar by stepping through `RANGE_PRESETS_NM`.
     * Wheel down (positive deltaY) zooms OUT (larger range); wheel up zooms IN (smaller range).
     * After WHEEL_RESET_MS without further wheel activity, the range snaps back to the
     * configured default so the radar returns to its baseline state automatically.
     */
    private onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const direction: 1 | -1 = e.deltaY > 0 ? 1 : -1;
        this.setRangeStep(direction);
        if (this.wheelResetTimer) {
            clearTimeout(this.wheelResetTimer);
        }
        this.wheelResetTimer = setTimeout(() => {
            const defaultRange = this.props.settings.rangeNm ?? DEFAULT_RANGE_NM;
            this.setState({ rangeNm: defaultRange });
            this.wheelResetTimer = null;
        }, NmeaAisRadarComponent.WHEEL_RESET_MS);
    };

    private subscribeOwnShip(): void {
        const instance = this.props.settings.instance || 'nmea.0';
        const ctx = this.props.stateContext;
        const bind = (id: string, update: (v: number | null) => void): void => {
            const handler = (_id: string, state: ioBroker.State | null | undefined): void => {
                update(state?.val != null ? Number(state.val) : null);
            };
            ctx.getState(id, handler);
            this.stateHandlers.set(id, handler);
        };
        bind(`${instance}.gnssPositionData.latitude`, v => this.setState({ ownLat: v } as AisRadarComponentState));
        bind(`${instance}.gnssPositionData.longitude`, v => this.setState({ ownLon: v } as AisRadarComponentState));
        bind(`${instance}.cogSogRapidUpdate.cogTrue`, v => this.setState({ ownCog: v } as AisRadarComponentState));
        bind(`${instance}.cogSogRapidUpdate.cog`, v => this.setState({ ownCog: v } as AisRadarComponentState));
        bind(`${instance}.cogSogRapidUpdate.sog`, v => this.setState({ ownSog: v } as AisRadarComponentState));
        bind(`${instance}.vesselHeading.headingTrue`, v => this.setState({ ownHeading: v } as AisRadarComponentState));
    }

    /**
     * Enumerate AIS channel objects under the chosen instance and subscribe to every state
     * underneath that publishes a per-vessel JSON. The channel layout produced by the adapter is
     *
     *     nmea.0.aisClassAPositionReport.<MMSI>      (state, val = JSON of the latest fields)
     *     nmea.0.aisClassBPositionReport.<MMSI>      "
     *     nmea.0.aisAidsToNavigationAtonReport.<MMSI>
     *     ...
     *
     * so a getObjectsView({ type: state, startkey: prefix }) sweep picks them all up. We drop
     * the immediate-class-static-data subscriptions (they don't carry position) — the static
     * fields like ship name, however, do appear inside the position-report JSON.
     */
    private async discoverAndSubscribeAis(): Promise<void> {
        const instance = this.props.settings.instance || 'nmea.0';
        const ctx = this.props.stateContext;
        const socket = ctx.getSocket();

        // Channels we care about: any state-id matching one of these prefixes (without the
        // instance) gets subscribed. Matches the 'WELL_KNOWN_AIS_GROUPS' set in the adapter.
        const PREFIXES = [
            `${instance}.aisClassAPositionReport.`,
            `${instance}.aisClassBPositionReport.`,
            `${instance}.aisAidsToNavigationAtonReport.`,
            `${instance}.aisUtcAndDateReport.`,
        ];

        let allObjects: Record<string, ioBroker.Object> | null = null;
        try {
            // getObjects() returns the entire object cache — pricey on the wire, but for the
            // adapter's typical handful of AIS channels it's negligible. Filter client-side.
            allObjects = (await (socket as any).getObjects?.()) ?? null;
        } catch {
            // ignore — leave the radar empty until objects can be reached
        }
        if (!allObjects) {
            return;
        }
        const ids = Object.keys(allObjects).filter(
            id => PREFIXES.some(p => id.startsWith(p)) && allObjects[id]?.type === 'state',
        );
        for (const id of ids) {
            if (this.aisChannels.has(id)) {
                continue;
            }
            this.aisChannels.add(id);
            const handler = (_id: string, state: ioBroker.State | null | undefined): void => {
                this.handleAisUpdate(_id, state);
            };
            ctx.getState(id, handler);
            this.stateHandlers.set(id, handler);
        }
    }

    private handleAisUpdate(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.val == null) {
            return;
        }
        // Adapter stores the full canboat fields object as JSON inside the state value.
        let fields: Record<string, any>;
        try {
            fields = typeof state.val === 'string' ? JSON.parse(state.val) : (state.val as any);
        } catch {
            return;
        }
        const mmsi = String(fields.userId ?? id.split('.').pop() ?? '');
        if (!mmsi) {
            return;
        }
        const lat = Number(fields.latitude);
        const lon = Number(fields.longitude);
        if (!isFinite(lat) || !isFinite(lon)) {
            return;
        }
        // canboat reports angles in radians (they come from the PGN scaler); convert to degrees.
        const cogRaw = fields.cog ?? fields.courseOverGroundReference ?? null;
        const headingRaw = fields.heading ?? null;
        const sogRaw = fields.sog ?? null;
        const cog = cogRaw != null && isFinite(Number(cogRaw)) ? normDeg(Number(cogRaw) * DEG) : NaN;
        const heading = headingRaw != null && isFinite(Number(headingRaw)) ? normDeg(Number(headingRaw) * DEG) : null;
        const sog = sogRaw != null && isFinite(Number(sogRaw)) ? Number(sogRaw) * MS_TO_KN : 0;

        const channel = id.split('.').slice(0, -1).join('.'); // strip trailing MMSI
        const cls = classifyAisChannel(channel);
        const name =
            (typeof fields.name === 'string' && fields.name.trim()) ||
            (typeof fields.callsign === 'string' && fields.callsign.trim()) ||
            null;

        this.setState(prev => {
            const targets = new Map(prev.targets);
            const existing = targets.get(mmsi);
            const ts = state.ts || Date.now();
            // Trail: append latest point, drop anything older than TRAIL_MAX_AGE_MS, cap length.
            // Reuse the previous trail array's tail (sliced) so identity changes only when a
            // sample is added or expired — React still sees a new outer array reference, which
            // is enough to trigger a render but doesn't waste CPU on every position update.
            const cutoff = ts - TRAIL_MAX_AGE_MS;
            const prevTrail = existing?.trail ?? [];
            const fresh = prevTrail.filter(p => p.ts >= cutoff);
            // Avoid pushing duplicate points — within ~5 m and 1 s of the last one is the same fix.
            const last = fresh[fresh.length - 1];
            const skipDuplicate =
                last && Math.abs(last.lat - lat) < 5e-5 && Math.abs(last.lon - lon) < 5e-5 && ts - last.ts < 1000;
            const trail = skipDuplicate ? fresh : [...fresh, { lat, lon, ts }];
            // Hard cap on history size so very long-running tracks don't bloat the buffer.
            if (trail.length > TRAIL_MAX_POINTS) {
                trail.splice(0, trail.length - TRAIL_MAX_POINTS);
            }
            targets.set(mmsi, {
                mmsi,
                lat,
                lon,
                cog,
                sog,
                heading,
                cls,
                // Preserve the previously-known name if a position-only update doesn't include it.
                name: name || existing?.name || null,
                lastSeen: ts,
                trail,
            });
            return { targets } as AisRadarComponentState;
        });
    }

    private unsubscribeAll(): void {
        const ctx = this.props.stateContext;
        for (const [id, handler] of this.stateHandlers) {
            ctx.removeState(id, handler);
        }
        this.stateHandlers.clear();
        this.aisChannels.clear();
    }

    private getRange(): number {
        return this.state.rangeNm;
    }

    private setRangeStep(direction: 1 | -1): void {
        const cur = this.state.rangeNm;
        const sorted = [...RANGE_PRESETS_NM].sort((a, b) => a - b);
        const idx = sorted.findIndex(v => v >= cur - 1e-6);
        const nextIdx = Math.max(0, Math.min(sorted.length - 1, idx + direction));
        this.setState({ rangeNm: sorted[nextIdx] });
    }

    protected isTileActive(): boolean {
        return this.state.ownLat != null && this.state.ownLon != null;
    }

    /**
     * Wrap the SVG dial in a Leaflet-backed container. The map sits behind a fully transparent
     * card and follows the own ship + selected range; the SVG (rings, targets, vectors, own
     * arrow) is layered on top with `pointer-events: none` so map gestures still work where the
     * SVG is empty. The `key` distinguishes multiple radars on screen (compact / dialog) so
     * each Leaflet instance binds to a separate container.
     */
    private renderRadar(size: number | string, key: string): React.JSX.Element {
        return (
            <Box
                ref={this.getWrapperRef(key)}
                sx={{
                    position: 'relative',
                    width: size === '100%' ? '100%' : size,
                    height: size === '100%' ? '100%' : size,
                    aspectRatio: '1',
                    borderRadius: '50%',
                    overflow: 'hidden',
                    isolation: 'isolate',
                    // Subtle outer glow that frames the radar against the surrounding card.
                    boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.08)',
                }}
            >
                {/* Leaflet base layer. The map container fills the radar disc; the circular
                    `overflow: hidden` on the parent crops the rectangular tile grid into the
                    radar shape so the dial silhouette stays clean. */}
                <div
                    ref={this.getMapRef(key)}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        // CartoDB Dark Matter tiles look almost monochrome; bump saturation a hair
                        // so the small landmasses stand out against the water without becoming
                        // distracting under the SVG overlay.
                        filter: 'saturate(1.2) brightness(0.95)',
                    }}
                />
                {/* SVG overlay — pointer-events disabled so the map below stays interactive
                    where the overlay is transparent (i.e. between the rings). */}
                <Box
                    sx={{
                        position: 'absolute',
                        inset: 0,
                        pointerEvents: 'none',
                    }}
                >
                    {this.renderRadarSvg(size)}
                </Box>
            </Box>
        );
    }

    /**
     * Lazy-instantiate (or re-bind) the Leaflet map for the given container. Re-runs whenever
     * the ref callback fires with a new element (mount / unmount during dialog open/close).
     */
    private attachMap(key: string, el: HTMLDivElement | null): void {
        const prev = this.mapContainers.get(key);
        if (prev === el) {
            return;
        }
        this.mapContainers.set(key, el);
        const existing = this.maps.get(key);
        if (existing) {
            existing.remove();
            this.maps.delete(key);
        }
        if (!el) {
            return;
        }
        // Disable user gestures — the radar locks the view to (own ship × range) so the rings
        // stay anchored. If the user wants to pan/zoom, they use the range +/- buttons.
        const map = L.map(el, {
            zoomControl: false,
            attributionControl: false,
            dragging: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            touchZoom: false,
            zoomAnimation: true,
        });
        // CartoDB Dark Matter — desaturated dark base, free, ideal under a marine overlay.
        // Subdomain rotation prevents browser per-host TCP throttling.
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            subdomains: ['a', 'b', 'c', 'd'],
            maxZoom: 19,
            attribution: '© OpenStreetMap, © CARTO',
            detectRetina: true,
        }).addTo(map);
        this.maps.set(key, map);
        // Initial centring — even before the first state arrives, set a placeholder so Leaflet
        // pre-loads tiles. Updated on the next state change.
        map.setView([0, 0], 2, { animate: false });
        // Force a layout invalidation after the container actually has a size — Leaflet caches
        // dimensions and otherwise renders blank inside flexbox children.
        requestAnimationFrame(() => map.invalidateSize());
        this.syncMapView(key);
    }

    /** Re-centre / re-zoom one map (called whenever ownLat/ownLon/range change). */
    private syncMapView(key: string): void {
        const map = this.maps.get(key);
        if (!map) {
            return;
        }
        const { ownLat, ownLon } = this.state;
        if (ownLat == null || ownLon == null) {
            return;
        }
        const rangeNm = this.getRange();
        const rangeM = rangeNm * M_PER_NM;
        // Convert range-in-meters to a lat/lon delta and ask Leaflet to fit the bounds.
        const latDelta = (rangeM / EARTH_RADIUS_M) * DEG;
        const lonDelta = (rangeM / (EARTH_RADIUS_M * Math.cos(ownLat * RAD))) * DEG;
        const bounds = L.latLngBounds(
            L.latLng(ownLat - latDelta, ownLon - lonDelta),
            L.latLng(ownLat + latDelta, ownLon + lonDelta),
        );
        map.fitBounds(bounds, { animate: false, padding: [0, 0] });
    }

    /** Sync ALL active maps after a state/range change. */
    private syncAllMaps(): void {
        for (const key of this.maps.keys()) {
            this.syncMapView(key);
        }
    }

    /** Build the SVG overlay (rings, targets, own ship, badges). `size` controls the rendered CSS size. */
    private renderRadarSvg(size: number | string): React.JSX.Element {
        const { targets, ownLat, ownLon, ownCog, ownHeading, courseUp } = this.state;
        const rangeNm = this.getRange();
        const showVectors = this.props.settings.showVectors ?? DEFAULT_SHOW_VECTORS;
        const vectorMin = this.props.settings.vectorMinutes ?? DEFAULT_VECTOR_MINUTES;
        const staleMs = (this.props.settings.staleMinutes ?? DEFAULT_STALE_MINUTES) * 60_000;
        const now = Date.now();
        const upRotation = courseUp && ownHeading != null ? -ownHeading : 0;

        // Concentric rings + cardinal labels.
        const rings = RING_FRACTIONS.map(f => ({ r: R_OUTER * f, label: (rangeNm * f).toFixed(f === 1 ? 0 : 1) }));

        // Filter targets within range and not stale.
        const plotted: { t: AisTarget; x: number; y: number; vx: number; vy: number }[] = [];
        if (ownLat != null && ownLon != null) {
            for (const t of targets.values()) {
                if (now - t.lastSeen > staleMs) {
                    continue;
                }
                const { east, north } = projectToMeters(t.lat, t.lon, ownLat, ownLon);
                const distM = Math.sqrt(east * east + north * north);
                const distNm = distM / M_PER_NM;
                if (distNm > rangeNm) {
                    continue;
                }
                const px = (east / M_PER_NM / rangeNm) * R_OUTER;
                const py = -(north / M_PER_NM / rangeNm) * R_OUTER; // SVG y inverts north
                // Vector: extrapolate along COG for vectorMin minutes.
                let vx = 0;
                let vy = 0;
                if (showVectors && isFinite(t.cog) && t.sog > 0.3) {
                    const distVec = (t.sog * vectorMin) / 60; // NM
                    const ang = t.cog * RAD;
                    const vEast = distVec * Math.sin(ang);
                    const vNorth = distVec * Math.cos(ang);
                    vx = (vEast / rangeNm) * R_OUTER;
                    vy = -(vNorth / rangeNm) * R_OUTER;
                }
                plotted.push({ t, x: px, y: py, vx, vy });
            }
        }

        return (
            <svg
                viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
                preserveAspectRatio="xMidYMid meet"
                style={{ width: '100%', height: size, display: 'block' }}
            >
                {/* Card outline only — the Leaflet map shows through underneath. A faint dark
                    radial vignette is overlaid so AIS targets near the centre stay legible
                    against bright tile features (city lights / coastlines). */}
                <defs>
                    <radialGradient
                        id="ais-vignette"
                        cx="50%"
                        cy="50%"
                        r="50%"
                    >
                        <stop
                            offset="0"
                            stopColor="rgba(0,0,0,0)"
                        />
                        <stop
                            offset="0.7"
                            stopColor="rgba(0,0,0,0.15)"
                        />
                        <stop
                            offset="1"
                            stopColor="rgba(0,0,0,0.45)"
                        />
                    </radialGradient>
                </defs>
                <circle
                    cx={CENTER}
                    cy={CENTER}
                    r={R_OUTER}
                    fill="url(#ais-vignette)"
                    stroke={COLORS.dim}
                    strokeWidth={2}
                />

                {/* Rings rotate with the dial in course-up mode (so cardinal labels align with the
                    own bow); in north-up mode they stay fixed. */}
                <g transform={`rotate(${upRotation} ${CENTER} ${CENTER})`}>
                    {rings.map(ring => (
                        <g key={`ring-${ring.r}`}>
                            <circle
                                cx={CENTER}
                                cy={CENTER}
                                r={ring.r}
                                fill="none"
                                stroke={COLORS.grey}
                                strokeWidth={1.5}
                                strokeDasharray="4 6"
                                opacity={0.7}
                            />
                            <text
                                x={CENTER}
                                y={CENTER - ring.r + 18}
                                fill={COLORS.dim}
                                fontSize={20}
                                textAnchor="middle"
                                fontFamily="Roboto, Arial, sans-serif"
                            >
                                {ring.label} NM
                            </text>
                        </g>
                    ))}
                    {/* Cross hairs (rotated with the dial). */}
                    <line
                        x1={CENTER - R_OUTER}
                        y1={CENTER}
                        x2={CENTER + R_OUTER}
                        y2={CENTER}
                        stroke={COLORS.grey}
                        strokeWidth={1}
                        opacity={0.5}
                    />
                    <line
                        x1={CENTER}
                        y1={CENTER - R_OUTER}
                        x2={CENTER}
                        y2={CENTER + R_OUTER}
                        stroke={COLORS.grey}
                        strokeWidth={1}
                        opacity={0.5}
                    />
                    {/* Cardinal labels — pulled INSIDE the outer ring so wide letters (notably
                        "W") don't get clipped by the SVG's default `overflow: hidden` or by the
                        wrapper's circular `border-radius: 50%`. Sits in the empty band between
                        the outer ring outline and the first dashed range ring (75% of R_OUTER),
                        so it doesn't intrude on the target plot area. */}
                    {[
                        { angle: 0, text: 'N', fill: '#3a8dff' },
                        { angle: 90, text: 'E', fill: COLORS.contrast },
                        { angle: 180, text: 'S', fill: '#ff3b3b' },
                        { angle: 270, text: 'W', fill: COLORS.contrast },
                    ].map(c => {
                        const rad = c.angle * RAD;
                        const labelR = R_OUTER - 28;
                        const tx = CENTER + Math.sin(rad) * labelR;
                        const ty = CENTER - Math.cos(rad) * labelR;
                        return (
                            <text
                                key={c.text}
                                x={tx}
                                y={ty}
                                fill={c.fill}
                                fontSize={32}
                                fontWeight={700}
                                textAnchor="middle"
                                dominantBaseline="central"
                                fontFamily="Roboto, Arial, sans-serif"
                                transform={`rotate(${-upRotation} ${tx} ${ty})`}
                            >
                                {c.text}
                            </text>
                        );
                    })}

                    {/* Plotted targets — each as a chevron (or square for AtoN) in the target's
                        own per-MMSI hue, plus a same-coloured trail polyline tracing recent
                        positions. The shape distinguishes class (chevron / square); the colour
                        uniquely identifies the individual vessel — adjacent MMSIs map to far-
                        apart hues thanks to the 32-bit hash, so even a busy harbour stays
                        readable. */}
                    {plotted.map(({ t, x, y, vx, vy }) => {
                        const cx = CENTER + x;
                        const cy = CENTER + y;
                        const cogDeg = isFinite(t.cog) ? t.cog : 0;
                        const color = shipColor(t.mmsi);

                        // Build the trail polyline by projecting every stored history point
                        // through the same range/scale transform as the live target. We
                        // intentionally don't filter by range here — the SVG and the wrapper's
                        // circular `overflow:hidden` will clip points outside the radar disc, so
                        // a track that approached from far away naturally fades in at the edge.
                        let trailPoints = '';
                        if (ownLat != null && ownLon != null && t.trail.length >= 2) {
                            const parts: string[] = [];
                            for (const p of t.trail) {
                                const proj = projectToMeters(p.lat, p.lon, ownLat, ownLon);
                                const tx = (proj.east / M_PER_NM / rangeNm) * R_OUTER;
                                const ty = -(proj.north / M_PER_NM / rangeNm) * R_OUTER;
                                parts.push(`${(CENTER + tx).toFixed(1)},${(CENTER + ty).toFixed(1)}`);
                            }
                            trailPoints = parts.join(' ');
                        }

                        return (
                            <g key={t.mmsi}>
                                {/* Trail behind everything else so the chevron + COG vector sit on top. */}
                                {trailPoints ? (
                                    <polyline
                                        points={trailPoints}
                                        fill="none"
                                        stroke={color}
                                        strokeWidth={2}
                                        strokeLinejoin="round"
                                        strokeLinecap="round"
                                        opacity={0.65}
                                    />
                                ) : null}
                                {/* COG vector — same hue, dashed to differentiate from the trail. */}
                                {showVectors && (vx !== 0 || vy !== 0) ? (
                                    <line
                                        x1={cx}
                                        y1={cy}
                                        x2={cx + vx}
                                        y2={cy + vy}
                                        stroke={color}
                                        strokeWidth={2}
                                        strokeDasharray="4 4"
                                        opacity={0.85}
                                    />
                                ) : null}
                                <g transform={`translate(${cx} ${cy}) rotate(${cogDeg})`}>
                                    {t.cls === 'AtoN' ? (
                                        <rect
                                            x={-7}
                                            y={-7}
                                            width={14}
                                            height={14}
                                            fill={color}
                                            stroke="#000"
                                            strokeWidth={1}
                                            opacity={0.95}
                                        />
                                    ) : (
                                        <path
                                            d="M 0 -14 L 8 10 L 0 5 L -8 10 Z"
                                            fill={color}
                                            stroke="#000"
                                            strokeWidth={1}
                                            opacity={0.95}
                                        />
                                    )}
                                </g>
                                {t.name ? (
                                    <text
                                        x={cx + 12}
                                        y={cy + 4}
                                        fill={color}
                                        fontSize={14}
                                        fontFamily="Roboto, Arial, sans-serif"
                                        opacity={0.9}
                                        transform={`rotate(${-upRotation} ${cx + 12} ${cy + 4})`}
                                    >
                                        {t.name.slice(0, 12)}
                                    </text>
                                ) : null}
                            </g>
                        );
                    })}
                </g>

                {/* Own ship — fixed at the centre. Triangle pointing up (Course-Up) or to the
                    actual heading (North-Up). */}
                {(() => {
                    const heading = ownHeading ?? ownCog ?? 0;
                    const angle = courseUp ? 0 : heading;
                    return (
                        <g transform={`translate(${CENTER} ${CENTER}) rotate(${angle})`}>
                            <path
                                d="M 0 -22 L 14 18 L 0 10 L -14 18 Z"
                                fill={COLORS.own}
                                stroke="#000"
                                strokeWidth={1.5}
                            />
                        </g>
                    );
                })()}

                {/* Range badge (top-left). */}
                <rect
                    x={20}
                    y={20}
                    width={130}
                    height={48}
                    rx={6}
                    fill={COLORS.cardBg}
                    fillOpacity={0.85}
                    stroke={COLORS.dim}
                />
                <text
                    x={85}
                    y={50}
                    fill={COLORS.contrast}
                    fontSize={26}
                    fontWeight={700}
                    textAnchor="middle"
                    fontFamily="Roboto, Arial, sans-serif"
                >
                    {rangeNm} NM
                </text>

                {/* Orientation badge (top-right). */}
                <rect
                    x={VIEWBOX - 150}
                    y={20}
                    width={130}
                    height={48}
                    rx={6}
                    fill={COLORS.cardBg}
                    fillOpacity={0.85}
                    stroke={COLORS.dim}
                />
                <text
                    x={VIEWBOX - 85}
                    y={50}
                    fill={COLORS.contrast}
                    fontSize={22}
                    fontWeight={700}
                    textAnchor="middle"
                    fontFamily="Roboto, Arial, sans-serif"
                >
                    {courseUp ? 'C-Up' : 'N-Up'}
                </text>

                {/* Target counter (bottom-right). */}
                <text
                    x={VIEWBOX - 30}
                    y={VIEWBOX - 30}
                    fill={COLORS.dim}
                    fontSize={18}
                    textAnchor="end"
                    fontFamily="Roboto, Arial, sans-serif"
                >
                    {plotted.length} / {targets.size} targets
                </text>
            </svg>
        );
    }

    /** Compact tile — small radar, no controls. */
    renderCompact(): React.JSX.Element {
        const isActive = this.isTileActive();
        const accent = this.getAccentColor();
        const settingsButton = this.renderSettingsButton();
        const indicators = this.renderIndicators(settingsButton);
        return (
            <Box
                id={String(this.props.widget.id)}
                className={this.getWidgetClass()}
                sx={theme => WidgetGeneric.getStyleCompact(theme)}
            >
                <Box
                    onClick={() => this.setState({ dialogOpen: true } as AisRadarComponentState)}
                    sx={theme => ({
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        alignItems: 'center',
                        width: '100%',
                        aspectRatio: '1',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        ...(getTileStyles(theme, isActive, accent) as any),
                        padding: isNeumorphicTheme(theme) ? '4px' : '6px',
                    })}
                >
                    {indicators}
                    <Box sx={{ width: '100%', aspectRatio: '1' }}>{this.renderRadar('100%', 'compact')}</Box>
                    {this.props.settings.name ? (
                        <Typography
                            variant="caption"
                            sx={{ fontWeight: 600 }}
                        >
                            {this.props.settings.name}
                        </Typography>
                    ) : null}
                </Box>
            </Box>
        );
    }

    renderWideTall(): React.JSX.Element {
        const isActive = this.isTileActive();
        const accent = this.getAccentColor();
        const settingsButton = this.renderSettingsButton();
        const indicators = this.renderIndicators(settingsButton);
        return (
            <Box
                id={String(this.props.widget.id)}
                className={this.getWidgetClass()}
                sx={theme => WidgetGeneric.getStyleWideTall(theme)}
            >
                <Box
                    onClick={() => this.setState({ dialogOpen: true } as AisRadarComponentState)}
                    sx={theme => ({
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        aspectRatio: '2',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        ...(getTileStyles(theme, isActive, accent) as any),
                        padding: isNeumorphicTheme(theme) ? '8px' : '12px',
                    })}
                >
                    {indicators}
                    <Box sx={{ height: '100%', aspectRatio: '1' }}>{this.renderRadar('100%', 'widetall')}</Box>
                </Box>
            </Box>
        );
    }

    private renderDialog(): React.JSX.Element | null {
        if (!this.state.dialogOpen) {
            return null;
        }
        return (
            <Dialog
                open
                onClose={() => this.setState({ dialogOpen: false })}
                maxWidth={false}
                fullWidth
                slotProps={{
                    paper: {
                        sx: {
                            width: '95vw',
                            height: '95vh',
                            maxWidth: '95vw',
                            maxHeight: '95vh',
                            m: 1,
                            bgcolor: COLORS.bg,
                        },
                    },
                }}
            >
                <Box
                    sx={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        zIndex: 1,
                        display: 'flex',
                        gap: 1,
                        alignItems: 'center',
                    }}
                >
                    <IconButton
                        sx={{ color: COLORS.contrast }}
                        onClick={() => this.setRangeStep(-1)}
                        title="Decrease range"
                    >
                        <RemoveIcon />
                    </IconButton>
                    <IconButton
                        sx={{ color: COLORS.contrast }}
                        onClick={() => this.setRangeStep(1)}
                        title="Increase range"
                    >
                        <AddIcon />
                    </IconButton>
                    <ToggleButtonGroup
                        size="small"
                        exclusive
                        value={this.state.courseUp ? 'cup' : 'nup'}
                        onChange={(_e, v) => v && this.setState({ courseUp: v === 'cup' })}
                        sx={{ bgcolor: COLORS.cardBg }}
                    >
                        <ToggleButton
                            value="nup"
                            sx={{ color: COLORS.contrast }}
                        >
                            N-Up
                        </ToggleButton>
                        <ToggleButton
                            value="cup"
                            sx={{ color: COLORS.contrast }}
                        >
                            C-Up
                        </ToggleButton>
                    </ToggleButtonGroup>
                    <IconButton
                        sx={{ color: COLORS.contrast }}
                        onClick={() => this.setState({ dialogOpen: false })}
                    >
                        <CloseIcon />
                    </IconButton>
                </Box>
                <DialogContent
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        p: 2,
                        overflow: 'hidden',
                    }}
                >
                    <Box sx={{ aspectRatio: '1', height: '100%', maxWidth: '100%' }}>
                        {this.renderRadar('100%', 'dialog')}
                    </Box>
                </DialogContent>
            </Dialog>
        );
    }

    render(): React.JSX.Element {
        const widget = super.render();
        const dialog = this.renderDialog();
        if (dialog) {
            return (
                <>
                    {widget}
                    {dialog}
                </>
            );
        }
        return widget;
    }
}

function normDeg(d: number): number {
    return ((d % 360) + 360) % 360;
}

export default NmeaAisRadarComponent;
