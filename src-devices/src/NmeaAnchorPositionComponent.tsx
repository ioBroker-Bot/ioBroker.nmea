// NMEA Anchor Position — at-anchor monitor showing the relationship between the dropped
// anchor position and the current boat position on a Leaflet base map.
//
// Setup:
//   - Anchor lat/lon are entered manually in settings (or via a "Set current as anchor"
//     button in the dialog when the boat is sitting on the anchor).
//   - Boat lat/lon are read live from the NMEA adapter's GNSS state.
//   - Optional chain length lets the widget draw a "swing circle" around the anchor — a
//     rough estimate of the area the boat could swing through given the rode length and the
//     depth at the time of a drop. Useful as a sanity check for whether the boat is dragging.
//   - Optional initial depth (depth at a drop) and current depth are shown numerically alongside
//     the live distance from anchor.
//
// Map base layer is user-selectable: a clean OSM/Voyager style for general use, or Esri
// WorldImagery satellite imagery for a more visual reference.

import WidgetGeneric, {
    React,
    MuiMaterial,
    MuiIcons,
    moment,
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
    ButtonProps,
    ToggleButtonProps,
    ToggleButtonGroupProps,
} from '@mui/material';
import type { ConfigItemPanel, ConfigItemTabs } from '@iobroker/json-config';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const Box: React.ComponentType<BoxProps> = MuiMaterial?.Box;
const Typography: React.ComponentType<TypographyProps> = MuiMaterial?.Typography;
const Dialog: React.ComponentType<DialogProps> = MuiMaterial?.Dialog;
const DialogContent: React.ComponentType<DialogContentProps> = MuiMaterial?.DialogContent;
const IconButton: React.ComponentType<IconButtonProps> = MuiMaterial?.IconButton;
const Button: React.ComponentType<ButtonProps> = MuiMaterial?.Button;
const ToggleButton: React.ComponentType<ToggleButtonProps> = MuiMaterial?.ToggleButton;
const ToggleButtonGroup: React.ComponentType<ToggleButtonGroupProps> = MuiMaterial?.ToggleButtonGroup;
const CloseIcon: React.ComponentType<any> = MuiIcons?.Close;
const AnchorIcon: React.ComponentType<any> = MuiIcons?.Anchor;
const SailingIcon: React.ComponentType<any> = MuiIcons?.Sailing;

interface AnchorPositionSettings extends CustomWidgetPlugin {
    /** e.g. 'nmea.0' */
    instance?: string;
    /** Anchor latitude in decimal degrees. */
    anchorLat?: number;
    /** Anchor longitude in decimal degrees. */
    anchorLon?: number;
    /** Length of deployed chain/rope in metres. Drives the swing-circle radius. */
    chainLength?: number;
    /**
     * Depth at the moment the anchor touched bottom, in metres. Used for an
     *  effective-scope hint (rode = sqrt(chain² - depth²) gives the horizontal swing).
     */
    depthAtDrop?: number;
    /** Map base layer — 'osm' for normal vector-style tiles, 'satellite' for imagery. */
    mapStyle?: 'osm' | 'satellite';
}

interface AnchorPositionState extends WidgetGenericState {
    boatLat: number | null;
    boatLon: number | null;
    /** Live water depth from `waterDepth.depth` (PGN 128267). */
    currentDepth: number | null;
    dialogOpen: boolean;
}

// Earth radius (m) for the haversine distance calculation. Average — good to ~0.5 % at any
// realistic latitude for distances under a few hundred metres (an anchor swing).
const EARTH_RADIUS_M = 6_371_000;
const RAD = Math.PI / 180;

const COLORS = {
    bg: '#0E1620',
    cardBg: '#0E1F2A',
    contrast: '#FFFFFF',
    grey: '#7E8A99',
    anchor: '#ff5252', // red — eye-catching for the drop point
    boat: '#3a8dff', // blue — matches own-ship colour in the AIS radar
    chain: '#ffeb3b', // yellow — visually links anchor to boat (swing line)
    swingRing: '#ffeb3b', // yellow ring at chain-length radius
} as const;

/** Great-circle distance via haversine, returning metres. */
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_M * c;
}

/**
 * Effective horizontal swing radius from rode length and depth at drop. Rode forms the
 * hypotenuse of a right triangle with the depth as the vertical leg, so the horizontal leg
 * (= max swing radius from the anchor's foot) is sqrt(chain² - depth²). When depth ≥ chain
 * the math breaks (chain too short for the depth) and we fall back to the chain length itself.
 */
function effectiveSwingRadius(chainM: number, depthM: number | undefined | null): number {
    if (depthM == null || !isFinite(depthM) || depthM <= 0) {
        return chainM;
    }
    if (depthM >= chainM) {
        return chainM;
    }
    return Math.sqrt(chainM * chainM - depthM * depthM);
}

// SVG-data-URL anchor & boat markers — sized & coloured to read well at typical zoom levels
// without needing an external icon set. Returned as Leaflet DivIcons via inline HTML.
function buildAnchorIcon(): L.DivIcon {
    const html = `
        <div style="
            display: flex; align-items: center; justify-content: center;
            width: 32px; height: 32px;
            border-radius: 50%;
            background: ${COLORS.anchor};
            border: 2px solid #000;
            box-shadow: 0 0 6px rgba(255,82,82,0.65);
            color: #fff;
            font-weight: 700;
            font-family: Roboto, Arial, sans-serif;
            font-size: 18px;
            line-height: 1;
        ">⚓</div>
    `;
    return L.divIcon({
        className: 'nmea-anchor-marker',
        html,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
    });
}

function buildBoatIcon(): L.DivIcon {
    const html = `
        <div style="
            width: 0; height: 0;
            border-left: 10px solid transparent;
            border-right: 10px solid transparent;
            border-bottom: 22px solid ${COLORS.boat};
            filter: drop-shadow(0 0 4px rgba(58,141,255,0.6));
        "></div>
    `;
    return L.divIcon({
        className: 'nmea-boat-marker',
        html,
        iconSize: [20, 22],
        iconAnchor: [10, 11],
    });
}

export class NmeaAnchorPositionComponent extends WidgetGeneric<AnchorPositionState, AnchorPositionSettings> {
    private stateHandlers = new Map<string, (id: string, state: ioBroker.State | null | undefined) => void>();
    /** One Leaflet map per render variant (compact / widetall / dialog). */
    private maps = new Map<string, L.Map>();
    private mapContainers = new Map<string, HTMLDivElement | null>();
    private mapRefCallbacks = new Map<string, (el: HTMLDivElement | null) => void>();
    /**
     * Per-map overlay handles so we can update the existing anchor/boat marker / swing ring /
     *  rode polyline in place instead of removing & re-adding (which would flicker tiles).
     */
    private overlays = new Map<
        string,
        {
            anchor: L.Marker;
            boat: L.Marker;
            rode: L.Polyline;
            swing: L.Circle | null;
            tile: L.TileLayer;
        }
    >();
    private currentTileStyle = new Map<string, 'osm' | 'satellite'>();

    constructor(props: WidgetGenericProps<AnchorPositionSettings>) {
        super(props);
        this.state = {
            ...this.state,
            boatLat: null,
            boatLon: null,
            currentDepth: null,
            dialogOpen: false,
        };
    }

    static override getConfigSchema(): { name: string; schema: ConfigItemPanel | ConfigItemTabs } {
        return {
            name: 'NmeaAnchorPosition',
            schema: {
                type: 'panel',
                items: {
                    anchorPosition: {
                        type: 'objectId',
                        label: 'nmeaap2_anchorPosition',
                        help: 'nmeaap2_anchorPosition_help',
                        hidden: '!!data.anchorLat || !!data.anchorLon',
                        sm: 6,
                    },
                    anchorLat: {
                        type: 'objectId',
                        label: 'nmeaap2_anchorLat',
                        help: 'nmeaap2_anchorLat_help',
                        hidden: '!!data.anchorPosition',
                        sm: 6,
                    },
                    anchorLon: {
                        type: 'objectId',
                        label: 'nmeaap2_anchorLon',
                        help: 'nmeaap2_anchorLon_help',
                        hidden: '!!data.anchorPosition',
                        sm: 6,
                    },
                    positionLat: {
                        type: 'objectId',
                        label: 'nmeaap2_actualPositionLat',
                        help: 'nmeaap2_chainLength_help',
                        sm: 6,
                    },
                    positionLon: {
                        type: 'objectId',
                        label: 'nmeaap2_actualPositionLon',
                        help: 'nmeaap2_depthAtDrop_help',
                        sm: 6,
                    },
                    mapStyle: {
                        type: 'select',
                        label: 'nmeaap2_mapStyle',
                        options: [
                            { value: 'osm', label: 'nmeaap2_mapStyle_osm' },
                            { value: 'satellite', label: 'nmeaap2_mapStyle_satellite' },
                        ],
                        default: 'osm',
                        sm: 12,
                    },
                },
            },
        };
    }

    componentDidMount(): void {
        super.componentDidMount?.();
        this.subscribeAll();
    }

    componentDidUpdate(
        prevProps: Readonly<WidgetGenericProps<AnchorPositionSettings>>,
        prevState: Readonly<AnchorPositionState>,
    ): void {
        super.componentDidUpdate?.(prevProps, this.state);
        if (prevProps.settings.instance !== this.props.settings.instance) {
            this.unsubscribeAll();
            this.subscribeAll();
        }
        // Anything that affects the overlays gets re-applied to all attached maps. We only
        // touch overlays that have actually changed so Leaflet doesn't reload tiles.
        if (
            prevProps.settings.anchorLat !== this.props.settings.anchorLat ||
            prevProps.settings.anchorLon !== this.props.settings.anchorLon ||
            prevProps.settings.chainLength !== this.props.settings.chainLength ||
            prevProps.settings.depthAtDrop !== this.props.settings.depthAtDrop ||
            prevProps.settings.mapStyle !== this.props.settings.mapStyle ||
            prevState.boatLat !== this.state.boatLat ||
            prevState.boatLon !== this.state.boatLon
        ) {
            this.updateAllOverlays();
        }
    }

    componentWillUnmount(): void {
        super.componentWillUnmount?.();
        this.unsubscribeAll();
        for (const map of this.maps.values()) {
            map.remove();
        }
        this.maps.clear();
        this.mapContainers.clear();
        this.mapRefCallbacks.clear();
        this.overlays.clear();
        this.currentTileStyle.clear();
    }

    private subscribeAll(): void {
        const instance = this.props.settings.instance || 'nmea.0';
        const ctx = this.props.stateContext;
        const bind = (id: string, update: (v: number | null) => void): void => {
            const handler = (_id: string, state: ioBroker.State | null | undefined): void => {
                update(state?.val != null ? Number(state.val) : null);
            };
            ctx.getState(id, handler);
            this.stateHandlers.set(id, handler);
        };
        bind(`${instance}.gnssPositionData.latitude`, v => this.setState({ boatLat: v } as AnchorPositionState));
        bind(`${instance}.gnssPositionData.longitude`, v => this.setState({ boatLon: v } as AnchorPositionState));
        bind(`${instance}.waterDepth.depth`, v => this.setState({ currentDepth: v } as AnchorPositionState));
    }

    private unsubscribeAll(): void {
        const ctx = this.props.stateContext;
        for (const [id, handler] of this.stateHandlers) {
            ctx.removeState(id, handler);
        }
        this.stateHandlers.clear();
    }

    private getMapRef(key: string): (el: HTMLDivElement | null) => void {
        let cb = this.mapRefCallbacks.get(key);
        if (!cb) {
            cb = (el: HTMLDivElement | null): void => this.attachMap(key, el);
            this.mapRefCallbacks.set(key, cb);
        }
        return cb;
    }

    /**
     * Lazily create the Leaflet map for the given container and bind anchor/boat overlays.
     * Re-runs when the ref callback fires with a different DOM node (e.g. dialog mount).
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
            this.overlays.delete(key);
            this.currentTileStyle.delete(key);
        }
        if (!el) {
            return;
        }
        const map = L.map(el, {
            zoomControl: false,
            attributionControl: false,
            // Allow user gestures: the anchor view benefits from panning / zooming to inspect
            // shoreline distances etc. (unlike the AIS radar which is locked to range NM).
            dragging: true,
            scrollWheelZoom: true,
            doubleClickZoom: true,
            boxZoom: false,
            keyboard: false,
            zoomSnap: 0,
            zoomDelta: 0.5,
        });
        const tile = this.buildTileLayer(this.props.settings.mapStyle ?? 'osm');
        tile.addTo(map);

        const anchorIcon = buildAnchorIcon();
        const boatIcon = buildBoatIcon();
        const anchorMarker = L.marker([0, 0], { icon: anchorIcon, opacity: 0 }).addTo(map);
        const boatMarker = L.marker([0, 0], { icon: boatIcon, opacity: 0 }).addTo(map);
        const rode = L.polyline([], {
            color: COLORS.chain,
            weight: 2,
            opacity: 0.85,
            dashArray: '6 6',
        }).addTo(map);
        // Swing circle is created lazily once we know we have a chain length — it's rendered
        // on top of the rode line so the boundary is visible even when the boat sits near it.

        this.maps.set(key, map);
        this.overlays.set(key, {
            anchor: anchorMarker,
            boat: boatMarker,
            rode,
            swing: null,
            tile,
        });
        this.currentTileStyle.set(key, this.props.settings.mapStyle ?? 'osm');

        // Centre on a reasonable initial view: fit anchor + boat if we have both, else jump to
        // anchor, else to boat, else to (0, 0) and wait for data.
        map.setView([0, 0], 2, { animate: false });
        requestAnimationFrame(() => {
            map.invalidateSize();
            this.updateOverlays(key, true);
        });
    }

    private buildTileLayer(style: 'osm' | 'satellite'): L.TileLayer {
        if (style === 'satellite') {
            // Esri WorldImagery is freely usable with attribution. Good resolution, no key.
            return L.tileLayer(
                'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                {
                    maxZoom: 19,
                    attribution:
                        'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
                    detectRetina: true,
                },
            );
        }
        // CartoDB Voyager — clean, low-saturation OSM-style basemap that works as a "normal"
        // chart background. Looks good in light or dark UI without overpowering the markers.
        return L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            subdomains: ['a', 'b', 'c', 'd'],
            maxZoom: 19,
            attribution: '© OpenStreetMap, © CARTO',
            detectRetina: true,
        });
    }

    private updateAllOverlays(force = false): void {
        for (const key of this.maps.keys()) {
            this.updateOverlays(key, force);
        }
    }

    private updateOverlays(key: string, fitView: boolean): void {
        const map = this.maps.get(key);
        const overlays = this.overlays.get(key);
        if (!map || !overlays) {
            return;
        }
        const { anchorLat, anchorLon, chainLength, depthAtDrop, mapStyle } = this.props.settings;
        const { boatLat, boatLon } = this.state;
        const haveAnchor = anchorLat != null && anchorLon != null && isFinite(anchorLat) && isFinite(anchorLon);
        const haveBoat = boatLat != null && boatLon != null && isFinite(boatLat) && isFinite(boatLon);

        // Swap tile layer when the map style setting changes — replace the layer instance so
        // the new tiles are loaded; the marker/polyline overlays stay attached.
        const currentStyle = this.currentTileStyle.get(key);
        const desiredStyle = mapStyle ?? 'osm';
        if (currentStyle !== desiredStyle) {
            map.removeLayer(overlays.tile);
            const newTile = this.buildTileLayer(desiredStyle);
            newTile.addTo(map);
            overlays.tile = newTile;
            this.currentTileStyle.set(key, desiredStyle);
        }

        // Anchor marker — only visible when the user has set anchor coords. `setLatLng` on a
        // hidden (opacity 0) marker keeps the same DOM element so the icon doesn't blink in.
        if (haveAnchor) {
            overlays.anchor.setLatLng([anchorLat, anchorLon]);
            overlays.anchor.setOpacity(1);
        } else {
            overlays.anchor.setOpacity(0);
        }

        // Boat marker — visible whenever we have a fix.
        if (haveBoat) {
            overlays.boat.setLatLng([boatLat, boatLon]);
            overlays.boat.setOpacity(1);
        } else {
            overlays.boat.setOpacity(0);
        }

        // Rode (anchor → boat dashed line) — only when both points are known.
        if (haveAnchor && haveBoat) {
            overlays.rode.setLatLngs([
                [anchorLat, anchorLon],
                [boatLat, boatLon],
            ]);
            overlays.rode.setStyle({ opacity: 0.85 });
        } else {
            overlays.rode.setLatLngs([]);
        }

        // Swing circle — drawn around the anchor at the effective swing radius (chain length
        // adjusted for depth at a drop, if both are known). Created lazily on the first need.
        if (haveAnchor && chainLength != null && chainLength > 0) {
            const radius = effectiveSwingRadius(chainLength, depthAtDrop);
            if (!overlays.swing) {
                overlays.swing = L.circle([anchorLat, anchorLon], {
                    radius,
                    color: COLORS.swingRing,
                    weight: 2,
                    opacity: 0.7,
                    fillColor: COLORS.swingRing,
                    fillOpacity: 0.05,
                }).addTo(map);
            } else {
                overlays.swing.setLatLng([anchorLat, anchorLon]);
                overlays.swing.setRadius(radius);
                overlays.swing.setStyle({ opacity: 0.7, fillOpacity: 0.05 });
            }
        } else if (overlays.swing) {
            // Hide by setting zero radius — keeps the layer attached so we don't churn it.
            overlays.swing.setStyle({ opacity: 0, fillOpacity: 0 });
        }

        // Auto-fit the view: on first attach OR when the user just changed the anchor/style.
        // For routine boat-position updates we leave the existing zoom/pan so the user can
        // freely pan around without the map snapping back every second.
        if (fitView) {
            const points: L.LatLngExpression[] = [];
            if (haveAnchor) {
                points.push([anchorLat, anchorLon]);
            }
            if (haveBoat) {
                points.push([boatLat, boatLon]);
            }
            if (points.length === 2) {
                map.fitBounds(L.latLngBounds(points), {
                    padding: [40, 40],
                    animate: false,
                    maxZoom: 18,
                });
            } else if (points.length === 1) {
                map.setView(points[0], 17, { animate: false });
            }
        }
    }

    /** Set the anchor position to the boat's current GPS fix. */
    private setAnchorToCurrent(): void {
        const { boatLat, boatLon } = this.state;
        if (boatLat == null || boatLon == null) {
            return;
        }
        // Persist the change through the host's settings system if it exposes a write API; the
        // dm-widgets bridge doesn't expose that uniformly, so we just update the local widget
        // state via the host's standard onOpenSettings flow. As a fallback we mutate the
        // settings object so the current session sees the new anchor.
        const settingsAny = this.props.settings;
        settingsAny.anchorLat = boatLat;
        settingsAny.anchorLon = boatLon;
        this.forceUpdate();
        // Force-refit so the dialog zooms to the freshly set anchor.
        for (const key of this.maps.keys()) {
            this.updateOverlays(key, true);
        }
    }

    private currentDistanceM(): number | null {
        const { anchorLat, anchorLon } = this.props.settings;
        const { boatLat, boatLon } = this.state;
        if (
            anchorLat == null ||
            anchorLon == null ||
            boatLat == null ||
            boatLon == null ||
            !isFinite(anchorLat) ||
            !isFinite(anchorLon) ||
            !isFinite(boatLat) ||
            !isFinite(boatLon)
        ) {
            return null;
        }
        return haversineDistance(anchorLat, anchorLon, boatLat, boatLon);
    }

    /**
     * Build the wrapper that hosts the Leaflet map. The map fills the entire box; the SVG-style
     *  numerical readouts live in HTML overlays in the corners.
     */
    private renderMap(size: number | string, key: string): React.JSX.Element {
        return (
            <Box
                sx={{
                    position: 'relative',
                    width: size === '100%' ? '100%' : size,
                    height: size === '100%' ? '100%' : size,
                    overflow: 'hidden',
                    isolation: 'isolate',
                    boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.08)',
                    backgroundColor: COLORS.bg,
                }}
            >
                <div
                    ref={this.getMapRef(key)}
                    style={{ position: 'absolute', inset: 0 }}
                />
                {this.renderReadouts(key === 'compact')}
            </Box>
        );
    }

    /**
     * Numerical overlay — distance from anchor + depths. Compact mode hides the depth lines
     *  to keep the small tile readable.
     */
    private renderReadouts(compact: boolean): React.JSX.Element {
        const distance = this.currentDistanceM();
        const { chainLength, depthAtDrop } = this.props.settings;
        const { currentDepth } = this.state;
        const distanceText = distance != null ? `${Math.round(distance)} m` : '—';
        const distanceHi =
            chainLength != null && distance != null && distance > effectiveSwingRadius(chainLength, depthAtDrop);
        return (
            <Box
                sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    p: 1,
                    pointerEvents: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.5,
                }}
            >
                <Box
                    sx={{
                        alignSelf: 'flex-start',
                        bgcolor: 'rgba(0,0,0,0.55)',
                        color: distanceHi ? '#ff5252' : COLORS.contrast,
                        px: 1.5,
                        py: 0.5,
                        borderRadius: '6px',
                        border: '1px solid rgba(255,255,255,0.15)',
                        backdropFilter: 'blur(2px)',
                    }}
                >
                    <Typography sx={{ fontSize: 11, fontWeight: 600, opacity: 0.7 }}>distance</Typography>
                    <Typography sx={{ fontSize: compact ? 18 : 24, fontWeight: 800, lineHeight: 1.05 }}>
                        {distanceText}
                    </Typography>
                </Box>
                {!compact ? (
                    <Box
                        sx={{
                            alignSelf: 'flex-start',
                            bgcolor: 'rgba(0,0,0,0.5)',
                            color: COLORS.contrast,
                            px: 1.25,
                            py: 0.5,
                            borderRadius: '6px',
                            border: '1px solid rgba(255,255,255,0.1)',
                            backdropFilter: 'blur(2px)',
                            display: 'flex',
                            flexDirection: 'row',
                            gap: 2,
                            fontSize: 12,
                        }}
                    >
                        {chainLength != null ? (
                            <span>
                                chain&nbsp;
                                <strong>{Math.round(chainLength)} m</strong>
                            </span>
                        ) : null}
                        {depthAtDrop != null ? (
                            <span>
                                @drop&nbsp;
                                <strong>{depthAtDrop.toFixed(1)} m</strong>
                            </span>
                        ) : null}
                        {currentDepth != null ? (
                            <span>
                                depth&nbsp;
                                <strong>{currentDepth.toFixed(1)} m</strong>
                            </span>
                        ) : null}
                    </Box>
                ) : null}
            </Box>
        );
    }

    protected isTileActive(): boolean {
        return this.state.boatLat != null && this.state.boatLon != null;
    }

    /** Square tile — small map with distance readout. */
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
                    onClick={() => this.setState({ dialogOpen: true } as AnchorPositionState)}
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
                    <div
                        onClick={e => e.stopPropagation()}
                        style={{ display: 'contents' }}
                    >
                        {indicators}
                    </div>
                    <Box sx={{ width: '100%', aspectRatio: '1' }}>{this.renderMap('100%', 'compact')}</Box>
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

    /** 2x1 tile. */
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
                    onClick={() => this.setState({ dialogOpen: true })}
                    sx={theme => ({
                        display: 'flex',
                        alignItems: 'stretch',
                        justifyContent: 'stretch',
                        width: '100%',
                        aspectRatio: '2',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        ...(getTileStyles(theme, isActive, accent) as any),
                        padding: isNeumorphicTheme(theme) ? '4px' : '6px',
                    })}
                >
                    <div
                        onClick={e => e.stopPropagation()}
                        style={{ display: 'contents' }}
                    >
                        {indicators}
                    </div>
                    <Box sx={{ width: '100%', height: '100%' }}>{this.renderMap('100%', 'widetall')}</Box>
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
                        zIndex: 1000,
                        display: 'flex',
                        gap: 1,
                        alignItems: 'center',
                    }}
                >
                    <ToggleButtonGroup
                        size="small"
                        exclusive
                        value={this.props.settings.mapStyle ?? 'osm'}
                        onChange={(_e, v) => {
                            if (v === 'osm' || v === 'satellite') {
                                this.props.settings.mapStyle = v;
                                this.updateAllOverlays();
                                this.forceUpdate();
                            }
                        }}
                        sx={{ bgcolor: COLORS.cardBg }}
                    >
                        <ToggleButton
                            value="osm"
                            sx={{ color: COLORS.contrast }}
                        >
                            Map
                        </ToggleButton>
                        <ToggleButton
                            value="satellite"
                            sx={{ color: COLORS.contrast }}
                        >
                            Sat
                        </ToggleButton>
                    </ToggleButtonGroup>
                    <Button
                        variant="contained"
                        size="small"
                        startIcon={AnchorIcon ? <AnchorIcon /> : null}
                        onClick={() => this.setAnchorToCurrent()}
                        disabled={this.state.boatLat == null || this.state.boatLon == null}
                        sx={{ bgcolor: COLORS.anchor, '&:hover': { bgcolor: COLORS.anchor } }}
                    >
                        drop here
                    </Button>
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
                        alignItems: 'stretch',
                        justifyContent: 'stretch',
                        p: 2,
                        overflow: 'hidden',
                    }}
                >
                    <Box sx={{ width: '100%', height: '100%' }}>{this.renderMap('100%', 'dialog')}</Box>
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

// Suppress "unused" warnings on the moment / SailingIcon imports while keeping them available
// for future use (status banners, drop-time display, etc.).
void moment;
void SailingIcon;

export default NmeaAnchorPositionComponent;
