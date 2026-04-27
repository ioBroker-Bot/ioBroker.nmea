// NMEA Autopilot — KIP-inspired control widget for the device manager.
// Shows current heading vs locked target heading on a rotating compass dial with
// port/starboard "no-go" arcs, AWA pointer in Wind mode, rudder bar, and offers
// Standby/Auto/Wind/Track mode buttons plus −10/−1/+1/+10 adjust buttons.

import WidgetGeneric, {
    React,
    getTileStyles,
    isNeumorphicTheme,
    type WidgetGenericProps,
    type WidgetGenericState,
    type CustomWidgetPlugin,
} from '@iobroker/dm-widgets';
// Import MUI components directly (not through the dm-widgets `MuiMaterial` bridge). The bridge
// reads `window.__iobrokerShared__` at module-init time and returns `undefined` whenever the
// host hasn't populated that global yet (e.g. our Vite dev harness, or any race in HMR).
// Direct imports always resolve to a real module, and Module Federation's `shared` config
// routes them to the host's instance in production so there's no dual-instance hazard.
import { Box, Typography, Dialog, DialogContent, IconButton, Button, ButtonGroup } from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import type { ConfigItemPanel, ConfigItemTabs } from '@iobroker/json-config';

interface AutopilotSettings extends CustomWidgetPlugin {
    /** e.g. 'nmea.0' */
    instance?: string;
    /** Show AWA digital readout + dial pointer in Wind mode. */
    showAwa?: boolean;
    /** Show rudder bar at the bottom of the dial. */
    showRudder?: boolean;
}

interface AutopilotComponentState extends WidgetGenericState {
    mode: number | null; // 0=Standby, 1=Auto, 2=Wind, 3=Track, 4=NoDrift
    heading: number | null; // current compass heading (deg)
    lockedHeading: number | null; // autoPilot.heading (deg)
    awa: number | null; // apparent wind angle (deg, ±)
    rudder: number | null; // rudder position (deg, ±, port negative)
    dialogOpen: boolean;
}

const MODE_LABELS: Record<number, string> = {
    0: 'Standby',
    1: 'Auto',
    2: 'Wind',
    3: 'Track',
    4: 'NoDrift',
};

// Per-mode accent colour — shared between the in-dial mode label and the mode button row so a
// glance at either one tells you which mode the autopilot is in.
//   Standby red (off / safety), Auto green (engaged on heading), Wind light blue (wind-follow),
//   Track orange (route follow), NoDrift purple (rare, distinct).
const MODE_COLORS: Record<number, string> = {
    0: '#d32f2f',
    1: '#2e7d32',
    2: '#29b6f6',
    3: '#ed6c02',
    4: '#9c27b0',
};

const COLORS = {
    bg: '#191c1d',
    cardBg: '#0E1F2A',
    cardBgLight: '#FFFFFF',
    grey: '#B5B5B5',
    contrast: '#FFFFFF',
    contrastLight: '#0E1F2A',
    dim: '#9AA8B8',
    dimLight: '#5C6E80',
    port: '#c62828',
    starboard: '#2e7d32',
    yellow: '#FFD700',
    yellowDark: '#B38600',
} as const;

// Half-circle dial geometry — 1000×500 (or 1000×580 when the rudder bar is shown).
// Pivot is parked at the bottom edge of the SVG so only the upper half of the compass
// rose is visible — same layout as the KIP "svg-autopilot" reference.
const VIEWBOX_W = 1000;
const VIEWBOX_H_BASE = 500; // dial only — viewBox bottom is the dial diameter
const VIEWBOX_H_RUDDER = 580; // 80 px gutter under the dial for the rudder bar
const CX = 500;
const CY = 500; // pivot at the bottom edge of the dial-only viewBox
const R_OUTER = 480; // outer ring radius — top of arc at y = CY - R_OUTER = 20
const R_RING = 465; // numbered scale radius
const R_INNER = 370; // inside edge of the ring band
const POINTER_TIP_Y = CY - R_OUTER + 85; // top triangle tip just inside the outer edge
// Rudder bar matches the compass diameter (2 * R_OUTER) and is centred under the dial,
// so its left/right edges align with the leftmost / rightmost points of the outer ring.
const RUDDER_W = R_OUTER * 2;
const RUDDER_X = CX - R_OUTER;
const RUDDER_Y = VIEWBOX_H_BASE + 30; // sits below the dial in the rudder-enabled viewBox
const RUDDER_H = 32;
const RUDDER_MAX_DEG = 35;

function pad3(n: number | null): string {
    if (n == null || !isFinite(n)) {
        return '---';
    }
    const v = ((Math.round(n) % 360) + 360) % 360;
    return v.toString().padStart(3, '0');
}

function fmtSigned(n: number | null): string {
    if (n == null || !isFinite(n)) {
        return '--';
    }
    return Math.abs(Math.round(n)).toString();
}

export class NmeaAutopilotComponent extends WidgetGeneric<AutopilotComponentState, AutopilotSettings> {
    private stateHandlers: Map<string, (id: string, state: ioBroker.State | null | undefined) => void> = new Map();

    constructor(props: WidgetGenericProps<AutopilotSettings>) {
        super(props);
        this.state = {
            ...this.state,
            mode: null,
            heading: null,
            lockedHeading: null,
            awa: null,
            rudder: null,
            dialogOpen: false,
        };
    }

    static override getConfigSchema(): { name: string; schema: ConfigItemPanel | ConfigItemTabs } {
        return {
            name: 'NmeaAutopilot',
            schema: {
                type: 'panel',
                items: {
                    instance: {
                        type: 'instance',
                        adapter: 'nmea',
                        label: 'nmeaap_instance',
                        default: 'nmea.0',
                    },
                    showAwa: {
                        type: 'checkbox',
                        label: 'nmeaap_showAwa',
                        default: true,
                        sm: 6,
                    },
                    showRudder: {
                        type: 'checkbox',
                        label: 'nmeaap_showRudder',
                        default: true,
                        sm: 6,
                    },
                },
            },
        };
    }

    componentDidMount(): void {
        super.componentDidMount?.();
        this.subscribeAll();
    }

    componentDidUpdate(prevProps: Readonly<WidgetGenericProps<AutopilotSettings>>): void {
        super.componentDidUpdate?.(prevProps, this.state);
        if (prevProps.settings.instance !== this.props.settings.instance) {
            this.unsubscribeAll();
            this.subscribeAll();
        }
    }

    componentWillUnmount(): void {
        super.componentWillUnmount?.();
        this.unsubscribeAll();
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

        bind(`${instance}.autoPilot.state`, v => this.setState({ mode: v } as AutopilotComponentState));
        bind(`${instance}.autoPilot.heading`, v => this.setState({ lockedHeading: v } as AutopilotComponentState));
        // Prefer true heading; fall back to seatalk pilot heading sources.
        bind(`${instance}.vesselHeading.headingTrue`, v => this.setState({ heading: v } as AutopilotComponentState));
        bind(`${instance}.windData.windAngleApparent`, v => this.setState({ awa: v } as AutopilotComponentState));
        bind(`${instance}.rudder.position`, v => this.setState({ rudder: v } as AutopilotComponentState));
    }

    private unsubscribeAll(): void {
        const ctx = this.props.stateContext;
        for (const [id, handler] of this.stateHandlers) {
            ctx.removeState(id, handler);
        }
        this.stateHandlers.clear();
    }

    private writeState(suffix: string, value: ioBroker.StateValue): void {
        const instance = this.props.settings.instance || 'nmea.0';
        try {
            void this.props.stateContext.getSocket().setState(`${instance}.${suffix}`, value);
        } catch (e) {
            // ignore — host catches it as well
            console.warn('[NmeaAutopilot] setState failed', e);
        }
    }

    private setMode(mode: number): void {
        this.writeState('autoPilot.state', mode);
    }

    private adjust(delta: 1 | -1 | 10 | -10): void {
        if (this.state.mode === 2) {
            // Wind mode → use signed magnitude on windAngleChange
            this.writeState('autoPilot.windAngleChange', delta);
            return;
        }
        // Otherwise use the dedicated heading +/− buttons
        if (delta === 1) {
            this.writeState('autoPilot.headingPlus1', true);
        } else if (delta === -1) {
            this.writeState('autoPilot.headingMinus1', true);
        } else if (delta === 10) {
            this.writeState('autoPilot.headingPlus10', true);
        } else if (delta === -10) {
            this.writeState('autoPilot.headingMinus10', true);
        }
    }

    protected isTileActive(): boolean {
        return this.state.mode != null && this.state.mode !== 0;
    }

    /**
     * Half-circle autopilot dial — only the upper 180° of the compass rose is visible.
     * The pivot CY sits at the bottom edge of the dial viewBox; everything below CY is
     * cropped via a clipPath so the rotating rose, AWA pointer, and inner plate become
     * a clean half-disc. HDG / AWA / mode / locked-heading text sit fixed inside the
     * lower interior of the disc.
     *
     * `compact=true` drops the corner HDG/AWA blocks (used by the small tile).
     */
    protected renderDialSvg(size: number | string, compact = false, dark = true): React.JSX.Element {
        const { heading, lockedHeading, awa, mode, rudder } = this.state;
        const headingDeg = heading ?? 0;
        const fg = dark ? COLORS.contrast : COLORS.contrastLight;
        const bgRing = dark ? '#1B2733' : '#E8EEF3';
        const dimmed = dark ? COLORS.dim : COLORS.dimLight;
        const cardBg = dark ? COLORS.cardBg : COLORS.cardBgLight;

        const showRudder = !compact && this.props.settings.showRudder !== false;
        const showAwa = !compact && this.props.settings.showAwa !== false;
        const viewH = showRudder ? VIEWBOX_H_RUDDER : VIEWBOX_H_BASE;

        const triangleD = `M ${CX} ${POINTER_TIP_Y - 14}
            L ${CX - 26} ${POINTER_TIP_Y + 26}
            L ${CX + 26} ${POINTER_TIP_Y + 26} Z`;

        // Polar helper — 0° is "up", clockwise positive.
        const polar = (r: number, deg: number): { x: number; y: number } => {
            const rad = (deg * Math.PI) / 180;
            return { x: CX + Math.sin(rad) * r, y: CY - Math.cos(rad) * r };
        };

        // tick marks every 10°, major every 30° (the rotating group is clipped to the
        // upper half so we render the full 360° here without conditionals).
        const ticks: React.JSX.Element[] = [];
        for (let a = 0; a < 360; a += 10) {
            const major = a % 30 === 0;
            const len = major ? 22 : 12;
            const stroke = major ? 6 : 3;
            const inner = polar(R_RING - len / 2, a);
            const outer = polar(R_RING + len / 2, a);
            ticks.push(
                <line
                    key={`tk${a}`}
                    x1={inner.x}
                    y1={inner.y}
                    x2={outer.x}
                    y2={outer.y}
                    stroke={fg}
                    strokeWidth={stroke}
                    strokeLinecap="square"
                />,
            );
        }
        const labelPoints: { angle: number; text: string; bold?: boolean }[] = [
            { angle: 0, text: 'N', bold: true },
            { angle: 30, text: '30' },
            { angle: 60, text: '60' },
            { angle: 90, text: 'E', bold: true },
            { angle: 120, text: '120' },
            { angle: 150, text: '150' },
            { angle: 180, text: 'S', bold: true },
            { angle: 210, text: '210' },
            { angle: 240, text: '240' },
            { angle: 270, text: 'W', bold: true },
            { angle: 300, text: '300' },
            { angle: 330, text: '330' },
        ];
        const labels = labelPoints.map(l => {
            const pos = polar(R_RING - 50, l.angle);
            // Classic magnetic-compass colouring: N in blue (north-seeking end), S in red
            // (south pole) — matches the convention in the Wind compass widget. E and W stay
            // in foreground colour, numeric labels likewise.
            const labelFill = l.text === 'N' ? '#3a8dff' : l.text === 'S' ? '#ff3b3b' : fg;
            // Counter-rotate each label so it stays upright relative to the bow regardless of heading.
            return (
                <text
                    key={`lbl${l.angle}`}
                    x={pos.x}
                    y={pos.y}
                    fill={labelFill}
                    fontSize={l.bold ? 38 : 32}
                    fontWeight={l.bold ? 700 : 400}
                    textAnchor="middle"
                    dominantBaseline="central"
                    transform={`rotate(${l.angle} ${pos.x} ${pos.y})`}
                >
                    {l.text}
                </text>
            );
        });

        // Port (red) + starboard (green) bow-fixed "no-go" arcs — drawn in the upper half only.
        // Arc on the port side spans from -90° (left horizon) to -30° (left of bow); starboard
        // mirrors from +30° to +90°. Stroke radius slightly inside the outer edge so it sits on
        // top of the ring band without hiding it.
        const ARC_R = R_OUTER - 15;
        const portStart = polar(ARC_R, -66);
        const portEnd = polar(ARC_R, -30);
        const stbdStart = polar(ARC_R, 30);
        const stbdEnd = polar(ARC_R, 66);
        const portArc = `M ${portStart.x} ${portStart.y} A ${ARC_R} ${ARC_R} 0 0 1 ${portEnd.x} ${portEnd.y}`;
        const stbdArc = `M ${stbdStart.x} ${stbdStart.y} A ${ARC_R} ${ARC_R} 0 0 1 ${stbdEnd.x} ${stbdEnd.y}`;

        const start = polar(ARC_R, -90);
        const end = polar(ARC_R, 90);
        const lightGreyArc = `M ${start.x} ${start.y} A ${ARC_R} ${ARC_R} 0 0 1 ${end.x} ${end.y}`;

        // Half-disc paths: outer ring band (annulus, top half) and inner plate (semi-disc, top half).
        const ringPath = `M ${CX - R_OUTER} ${CY}
            A ${R_OUTER} ${R_OUTER} 0 0 1 ${CX + R_OUTER} ${CY}
            L ${CX + R_INNER} ${CY}
            A ${R_INNER} ${R_INNER} 0 0 0 ${CX - R_INNER} ${CY} Z`;
        const innerHalfDisc = `M ${CX - R_INNER} ${CY}
            A ${R_INNER} ${R_INNER} 0 0 1 ${CX + R_INNER} ${CY} Z`;

        // Rudder bar geometry (only computed when shown).
        const rudderCenter = RUDDER_X + RUDDER_W / 2;
        const halfRudderW = RUDDER_W / 2;
        let barX = rudderCenter;
        let barW = 0;
        let barColor: string = COLORS.grey;
        if (rudder != null && isFinite(rudder)) {
            const clamped = Math.max(-RUDDER_MAX_DEG, Math.min(RUDDER_MAX_DEG, rudder));
            const px = (clamped / RUDDER_MAX_DEG) * halfRudderW;
            if (px >= 0) {
                barX = rudderCenter;
                barW = px;
                barColor = COLORS.starboard;
            } else {
                barX = rudderCenter + px;
                barW = -px;
                barColor = COLORS.port;
            }
        }

        const clipId = `apdial-clip-${String(this.props.widget?.id ?? 'dev')}`;
        return (
            <svg
                viewBox={`0 0 ${VIEWBOX_W} ${viewH}`}
                preserveAspectRatio="xMidYMid meet"
                style={{ width: '100%', height: size, display: 'block' }}
            >
                <defs>
                    {/* Clip everything that belongs inside the half-disc to y ∈ [0, CY]. */}
                    <clipPath id={clipId}>
                        <rect
                            x={0}
                            y={0}
                            width={VIEWBOX_W}
                            height={CY}
                        />
                    </clipPath>
                </defs>

                {/* Outer ring (top-half annulus). */}
                <path
                    d={ringPath}
                    fill={bgRing}
                    stroke={fg}
                    strokeWidth={3}
                />

                <path
                    d={lightGreyArc}
                    fill="none"
                    stroke={'#888'}
                    strokeWidth={30}
                    strokeLinecap="butt"
                />
                {/* Port + starboard "no-go" arcs over the ring band. */}
                <path
                    d={portArc}
                    fill="none"
                    stroke={COLORS.port}
                    strokeWidth={30}
                    strokeLinecap="butt"
                />
                <path
                    d={stbdArc}
                    fill="none"
                    stroke={COLORS.starboard}
                    strokeWidth={30}
                    strokeLinecap="butt"
                />

                {/* Rotating compass rose — only the upper half is visible thanks to the clipPath.
                    IMPORTANT: clipPath and transform must NOT live on the same element. SVG's
                    clip-path is interpreted in the element's local coordinate system, which means
                    if we put both on one <g>, the clip rect rotates along with the contents — so
                    at HDG=180° the clip rect ends up over the lower half and everything visible
                    gets culled. Splitting into an outer (clipping, no transform) and inner
                    (rotating, no clip) group keeps the clip rect locked to the upper half of the
                    SVG while the dial spins inside it.
                    Rotation uses the SVG `transform` ATTRIBUTE (not CSS) so the pivot is always
                    (CX, CY) in user coordinates regardless of how the SVG is scaled. */}
                <g clipPath={`url(#${clipId})`}>
                    <g
                        transform={`rotate(${-headingDeg} ${CX} ${CY})`}
                        style={{ transition: 'transform 0.4s linear' }}
                    >
                        {ticks}
                        {labels}
                    </g>
                </g>

                {/* AWA pointer (Wind mode) — same outer-clip / inner-rotate split. */}
                {mode === 2 && awa != null && isFinite(awa) ? (
                    <g clipPath={`url(#${clipId})`}>
                        <g
                            transform={`rotate(${awa} ${CX} ${CY})`}
                            style={{ transition: 'transform 0.4s linear' }}
                        >
                            <path
                                d={`M ${CX} ${CY - R_OUTER + 5}
                                    L ${CX - 18} ${CY - R_OUTER + 50}
                                    L ${CX + 18} ${CY - R_OUTER + 50} Z`}
                                fill={COLORS.yellow}
                                stroke={COLORS.yellowDark}
                                strokeWidth={3}
                            />
                        </g>
                    </g>
                ) : null}

                {/* Inner plate — half-disc that masks anything inside R_INNER. */}
                {/*<path
                    d={innerHalfDisc}
                    //fill={cardBg}
                    stroke={fg}
                    strokeWidth={2}
                />*/}

                {/* Fixed top triangle pointer (current heading lives at the very top of the bow). */}
                <path
                    d={triangleD}
                    fill={fg}
                    opacity={0.5}
                    stroke={fg}
                />

                {/* HDG label/value — top-left corner, above the dial. */}
                {!compact ? (
                    <>
                        <text
                            x={90}
                            y={50}
                            fill={dimmed}
                            fontSize={28}
                            fontWeight={700}
                            textAnchor="middle"
                        >
                            HDG
                        </text>
                        <text
                            x={90}
                            y={108}
                            fill={fg}
                            fontSize={56}
                            fontWeight={700}
                            textAnchor="middle"
                        >
                            {`${pad3(heading)}°`}
                        </text>
                    </>
                ) : null}

                {/* AWA label/value — top-right corner. */}
                {showAwa ? (
                    <>
                        <text
                            x={VIEWBOX_W - 90}
                            y={50}
                            fill={mode === 2 ? COLORS.yellowDark : dimmed}
                            fontSize={28}
                            fontWeight={700}
                            textAnchor="middle"
                        >
                            AWA
                        </text>
                        <text
                            x={VIEWBOX_W - 90}
                            y={108}
                            fill={mode === 2 ? COLORS.yellow : dimmed}
                            fontSize={56}
                            fontWeight={700}
                            textAnchor="middle"
                        >
                            {`${fmtSigned(awa)}°`}
                        </text>
                    </>
                ) : null}

                {/* Mode label — sits inside the lower interior of the half-disc. Uses the same
                    accent colour as the corresponding mode button so the active state is
                    recognisable from the dial alone. Falls back to `dimmed` when mode is unknown. */}
                <text
                    x={CX}
                    y={CY - 200}
                    fill={mode != null && MODE_COLORS[mode] ? MODE_COLORS[mode] : dimmed}
                    fontSize={42}
                    fontWeight={700}
                    textAnchor="middle"
                >
                    {mode == null ? '---' : (MODE_LABELS[mode] || 'Unknown').toUpperCase()}
                </text>

                {/* Big locked-heading number — central inside the half-disc. */}
                <text
                    x={CX}
                    y={CY - 60}
                    fill={fg}
                    fontSize={150}
                    fontWeight={700}
                    textAnchor="middle"
                >
                    {lockedHeading == null ? '---' : pad3(lockedHeading)}
                    <tspan
                        fontSize={100}
                        fontWeight={400}
                        dy={-25}
                    >
                        °
                    </tspan>
                </text>

                {/* Rudder bar — sits in the gutter below the half-disc. */}
                {showRudder ? (
                    <g>
                        <rect
                            x={RUDDER_X}
                            y={RUDDER_Y}
                            width={RUDDER_W}
                            height={RUDDER_H}
                            fill="none"
                            stroke={fg}
                            strokeWidth={2}
                        />
                        {[0.25, 0.5, 0.75].map(p => (
                            <line
                                key={`d${p}`}
                                x1={RUDDER_X + RUDDER_W * p}
                                y1={RUDDER_Y}
                                x2={RUDDER_X + RUDDER_W * p}
                                y2={RUDDER_Y + RUDDER_H}
                                stroke={fg}
                                strokeWidth={2}
                            />
                        ))}
                        {rudder != null ? (
                            <rect
                                x={barX}
                                y={RUDDER_Y + 2}
                                width={barW}
                                height={RUDDER_H - 4}
                                fill={barColor}
                                style={{ transition: 'all 0.3s linear' }}
                            />
                        ) : null}
                    </g>
                ) : null}
            </svg>
        );
    }

    protected renderControls(): React.JSX.Element {
        const mode = this.state.mode;
        const adjustDisabled = mode == null || mode === 0 || mode === 3;
        // Each mode gets a distinct accent colour (shared with the in-dial mode label via
        // `MODE_COLORS`). Active button: filled with the mode colour; inactive: outline only.
        const modes: { val: number; label: string }[] = [
            { val: 0, label: 'Standby' },
            { val: 1, label: 'Auto' },
            { val: 2, label: 'Wind' },
            { val: 3, label: 'Track' },
        ];
        // Uniform width — width = 100 px each so the labels (Standby is the longest at ~7 chars)
        // never compress and all four buttons line up evenly.
        const MODE_BTN_WIDTH = 110;
        return (
            <Box
                sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1.5,
                    alignItems: 'center',
                    width: '100%',
                    py: 1,
                }}
            >
                <ButtonGroup size="medium">
                    {modes.map(m => {
                        const active = mode === m.val;
                        const accent = MODE_COLORS[m.val];
                        return (
                            <Button
                                key={m.val}
                                variant={active ? 'contained' : 'outlined'}
                                onClick={() => this.setMode(m.val)}
                                sx={{
                                    minWidth: MODE_BTN_WIDTH,
                                    width: MODE_BTN_WIDTH,
                                    color: active ? '#fff' : accent,
                                    backgroundColor: active ? accent : 'transparent',
                                    borderColor: accent,
                                    fontWeight: active ? 700 : 500,
                                    '&:hover': {
                                        backgroundColor: active ? accent : `${accent}22`,
                                        borderColor: accent,
                                    },
                                }}
                            >
                                {m.label}
                            </Button>
                        );
                    })}
                </ButtonGroup>
                <ButtonGroup
                    size="medium"
                    disabled={adjustDisabled}
                >
                    <Button
                        color="inherit"
                        onClick={() => this.adjust(-10)}
                    >
                        −10
                    </Button>
                    <Button
                        color="inherit"
                        onClick={() => this.adjust(-1)}
                    >
                        −1
                    </Button>
                    <Button
                        color="inherit"
                        onClick={() => this.adjust(1)}
                    >
                        +1
                    </Button>
                    <Button
                        color="inherit"
                        onClick={() => this.adjust(10)}
                    >
                        +10
                    </Button>
                </ButtonGroup>
            </Box>
        );
    }

    /** Square tile — small dial with mode badge (no controls). */
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
                    onClick={() => this.setState({ dialogOpen: true } as AutopilotComponentState)}
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
                    {/* Half-circle dial is 2:1 (or 1.72:1 with rudder); compact tile shows the
                        compact-only variant which is rudder-less so 2:1 fits cleanly. */}
                    <Box sx={{ width: '100%', aspectRatio: '2' }}>{this.renderDialSvg('100%', true)}</Box>
                    {this.props.settings.name ? (
                        <Typography
                            variant="caption"
                            sx={{
                                fontWeight: 600,
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                                textOverflow: 'ellipsis',
                                maxWidth: '100%',
                            }}
                        >
                            {this.props.settings.name}
                        </Typography>
                    ) : null}
                </Box>
            </Box>
        );
    }

    /** 2×0.5 bar — mode + locked heading numerical only. */
    renderWide(): React.JSX.Element {
        const isActive = this.isTileActive();
        const accent = this.getAccentColor();
        const { mode, heading, lockedHeading } = this.state;
        const settingsButton = this.renderSettingsButton();
        const indicators = this.renderIndicators(settingsButton);
        return (
            <Box
                id={String(this.props.widget.id)}
                className={this.getWidgetClass()}
                sx={theme => ({ ...WidgetGeneric.getStyleWide(theme), height: 80 })}
            >
                <Box
                    onClick={() => this.setState({ dialogOpen: true })}
                    sx={theme => ({
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-around',
                        width: '100%',
                        height: '100%',
                        cursor: 'pointer',
                        ...(getTileStyles(theme, isActive, accent) as any),
                        px: 2,
                    })}
                >
                    {indicators}
                    <Box sx={{ textAlign: 'center' }}>
                        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 700 }}>HDG</Typography>
                        <Typography sx={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>
                            {heading != null ? `${pad3(heading)}°` : '—'}
                        </Typography>
                    </Box>
                    <Box sx={{ textAlign: 'center' }}>
                        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 700 }}>MODE</Typography>
                        <Typography sx={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>
                            {mode == null ? '—' : (MODE_LABELS[mode] || '?').toUpperCase()}
                        </Typography>
                    </Box>
                    <Box sx={{ textAlign: 'center' }}>
                        <Typography sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 700 }}>LOCK</Typography>
                        <Typography sx={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>
                            {lockedHeading != null ? `${pad3(lockedHeading)}°` : '—'}
                        </Typography>
                    </Box>
                </Box>
            </Box>
        );
    }

    /** 2×1 — full dial. */
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
                    {/* Match the SVG aspect (2:1 without rudder, 1.72:1 with rudder).
                        Pick the rudder aspect when the user has rudder enabled. */}
                    <Box
                        sx={{
                            aspectRatio:
                                this.props.settings.showRudder !== false ? `${VIEWBOX_W} / ${VIEWBOX_H_RUDDER}` : '2',
                            height: '100%',
                            maxHeight: 320,
                        }}
                    >
                        {this.renderDialSvg('100%')}
                    </Box>
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
                <IconButton
                    onClick={() => this.setState({ dialogOpen: false })}
                    sx={{ position: 'absolute', top: 8, right: 8, zIndex: 1, color: 'white' }}
                >
                    <CloseIcon />
                </IconButton>
                <DialogContent
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 2,
                        p: 2,
                        overflow: 'hidden',
                    }}
                >
                    <Box sx={{ flex: 1, width: '100%', minHeight: 0, display: 'flex', justifyContent: 'center' }}>
                        {this.renderDialSvg('100%')}
                    </Box>
                    {this.renderControls()}
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

export default NmeaAutopilotComponent;
