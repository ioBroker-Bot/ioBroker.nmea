// NMEA historical line-chart widget — plots any numeric nmea.* state over a rolling time window.
// Shows:
//   • Header label (top-left) and current value + unit (top-right)
//   • White raw-sample polyline
//   • Grey shaded area below the line (area-chart style)
//   • Dashed horizontal line at the window average, with its numeric value
//
// Data accumulates from the moment the widget mounts (no backfill from ioBroker's history adapter).
// A 1 s re-render tick keeps the time axis scrolling even when no new samples arrive.

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
import type { BoxProps, TypographyProps, DialogProps, IconButtonProps, DialogContentProps } from '@mui/material';
import type { ConfigItemPanel, ConfigItemTabs } from '@iobroker/json-config';

const Box: React.ComponentType<BoxProps> = MuiMaterial?.Box;
const Typography: React.ComponentType<TypographyProps> = MuiMaterial?.Typography;
const Dialog: React.ComponentType<DialogProps> = MuiMaterial?.Dialog;
const DialogContent: React.ComponentType<DialogContentProps> = MuiMaterial?.DialogContent;
const IconButton: React.ComponentType<IconButtonProps> = MuiMaterial?.IconButton;
const CloseIcon: React.ComponentType<any> = MuiIcons?.Close;

interface HistoryChartSettings extends CustomWidgetPlugin {
    /** ioBroker instance, e.g. 'nmea.0' */
    instance?: string;
    /** State path relative to instance, e.g. 'windData.windSpeedApparent' */
    stateId?: string;
    /** Header label shown top-left (e.g. 'AWS') */
    label?: string;
    /** Unit shown next to the current value (e.g. 'knots'). Purely display-level — no conversion. */
    unit?: string;
    /** Rolling time window in seconds (default 300 = 5 min). */
    historySeconds?: number;
    /** Y-axis minimum. Acts as a suggestion if `autoScale` is true, as a hard lower bound otherwise. */
    yMin?: number;
    /** Y-axis maximum. Acts as a suggestion if `autoScale` is true, as a hard upper bound otherwise. */
    yMax?: number;
    /** If true, `yMin`/`yMax` are only suggested bounds — the axis expands whenever the data exceeds them.
     *  If false, the axis is clamped to `[yMin, yMax]` exactly and out-of-range values are clipped. */
    autoScale?: boolean;
    /** Decimal places for the readout and min/avg/max labels. */
    decimals?: number;
    /** Reference lines overlaid on the chart at the visible window's min/avg/max values. */
    showMin?: boolean;
    showAvg?: boolean;
    showMax?: boolean;
}

interface HistoryChartState extends WidgetGenericState {
    samples: { val: number; ts: number }[];
    current: number | null;
    dialogOpen: boolean;
}

const DEFAULT_HISTORY_SECONDS = 60;
const DEFAULT_DECIMALS = 1;

const COLORS = {
    bg: '#191c1d',
    cardBg: '#000000',
    grey: '#8a9095',
    greyArea: '#4a5256',
    contrast: '#FFFFFF',
    avgLine: '#d0d4d8',
    // Min = cool cyan (looks like a "low" water-line); max = warm orange (a "peak" marker).
    minLine: '#5fb3ff',
    maxLine: '#ff9100',
} as const;

function formatNum(val: number | null, decimals: number, isFloatComma?: boolean): string {
    if (val == null || !isFinite(val)) {
        return '—';
    }
    const s = val.toFixed(decimals);
    return isFloatComma ? s.replace('.', ',') : s;
}

export class NmeaHistoryChartComponent extends WidgetGeneric<HistoryChartState, HistoryChartSettings> {
    private stateHandler: ((id: string, state: ioBroker.State | null | undefined) => void) | null = null;
    private subscribedId: string | null = null;
    /** Periodic re-render so the chart scrolls left smoothly without waiting for new samples. */
    private tickInterval: ReturnType<typeof setInterval> | null = null;

    constructor(props: WidgetGenericProps<HistoryChartSettings>) {
        super(props);
        this.state = {
            ...this.state,
            samples: [],
            current: null,
            dialogOpen: false,
        };
    }

    static override getConfigSchema(): { name: string; schema: ConfigItemPanel | ConfigItemTabs } {
        return {
            name: 'NmeaHistoryChartComponent',
            schema: {
                type: 'panel',
                items: {
                    instance: {
                        type: 'instance',
                        adapter: 'nmea',
                        label: 'nmeahc_instance',
                        default: 'nmea.0',
                        sm: 12,
                    },
                    stateId: {
                        type: 'objectId',
                        label: 'nmeahc_stateId',
                        help: 'nmeahc_stateId_help',
                        default: 'nmea.0.windData.windSpeedApparent',
                        fillOnSelect: 'common.name=>label(X),common.unit=>unit',
                        sm: 12,
                    },
                    label: {
                        type: 'text',
                        label: 'nmeahc_label',
                        default: 'AWS',
                        sm: 6,
                    },
                    unit: {
                        type: 'text',
                        label: 'nmeahc_unit',
                        default: 'knots',
                        sm: 6,
                    },
                    historySeconds: {
                        type: 'number',
                        label: 'nmeahc_historySeconds',
                        help: 'nmeahc_historySeconds_help',
                        default: DEFAULT_HISTORY_SECONDS,
                        min: 10,
                        max: 3600,
                        sm: 12,
                        md: 4,
                    },
                    yMin: {
                        type: 'number',
                        label: 'nmeahc_yMin',
                        help: 'nmeahc_yMin_help',
                        default: 0,
                        sm: 12,
                        md: 4,
                    },
                    yMax: {
                        type: 'number',
                        label: 'nmeahc_yMax',
                        help: 'nmeahc_yMax_help',
                        default: 0,
                        sm: 12,
                        md: 4,
                    },
                    autoScale: {
                        type: 'checkbox',
                        label: 'nmeahc_autoScale',
                        help: 'nmeahc_autoScale_help',
                        default: true,
                        sm: 12,
                        md: 4,
                    },
                    showMin: {
                        newLine: true,
                        type: 'checkbox',
                        label: 'nmeahc_showMin',
                        default: false,
                        sm: 4,
                    },
                    showAvg: {
                        type: 'checkbox',
                        label: 'nmeahc_showAvg',
                        default: true,
                        sm: 4,
                    },
                    showMax: {
                        type: 'checkbox',
                        label: 'nmeahc_showMax',
                        default: false,
                        sm: 4,
                    },
                    decimals: {
                        type: 'number',
                        label: 'nmeahc_decimals',
                        default: DEFAULT_DECIMALS,
                        min: 0,
                        max: 3,
                        sm: 6,
                    },
                },
            },
        };
    }

    componentDidMount(): void {
        super.componentDidMount?.();
        this.subscribe();
        // Tick at ~10 Hz so the chart scrolls smoothly — at 300 s / ~560 px the axis moves
        // roughly 0.2 px per tick, well below perceptible jumps. Data still arrives whenever
        // ioBroker publishes a new sample; this interval is purely for the time-axis animation.
        this.tickInterval = setInterval(() => {
            if (this.state.samples.length > 0) {
                this.forceUpdate();
            }
        }, 100);
    }

    componentDidUpdate(prevProps: Readonly<WidgetGenericProps<HistoryChartSettings>>): void {
        super.componentDidUpdate?.(prevProps, this.state);
        if (
            prevProps.settings.instance !== this.props.settings.instance ||
            prevProps.settings.stateId !== this.props.settings.stateId
        ) {
            this.unsubscribe();
            this.setState({ samples: [], current: null });
            this.subscribe();
        }
    }

    componentWillUnmount(): void {
        super.componentWillUnmount?.();
        this.unsubscribe();
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
    }

    private subscribe(): void {
        const instance = this.props.settings.instance || 'nmea.0';
        const stateId = this.props.settings.stateId;
        if (!stateId) {
            return;
        }
        const fullId = `${instance}.${stateId}`;
        this.subscribedId = fullId;
        this.stateHandler = (_id, state) => {
            if (!state || state.val == null) {
                return;
            }
            const val = Number(state.val);
            if (!isFinite(val)) {
                return;
            }
            const ts = state.ts || Date.now();
            this.setState(s => {
                const windowMs = (this.props.settings.historySeconds ?? DEFAULT_HISTORY_SECONDS) * 1000;
                const cutoff = Date.now() - windowMs;
                const trimmed = s.samples.filter(x => x.ts >= cutoff);
                return {
                    samples: [...trimmed, { val, ts }],
                    current: val,
                } as HistoryChartState;
            });
        };
        this.props.stateContext.getState(fullId, this.stateHandler);
        // Background-load historical samples so the chart isn't empty on first paint — but only
        // when the object opts into a default history adapter via `common.custom[defaultHistory]`.
        void this.prefillFromHistory(fullId);
    }

    /**
     * Query the system's default-history adapter for the last `historySeconds` of this state and
     * merge the result into the sample buffer. Silently no-ops if the state isn't being historised
     * or the history call fails — the live subscription still populates the chart over time.
     */
    private async prefillFromHistory(fullId: string): Promise<void> {
        const ctx = this.props.stateContext;
        const historyAdapter = ctx.defaultHistory;
        if (!historyAdapter) {
            return;
        }
        let obj: ioBroker.StateObject | undefined;
        try {
            obj = await ctx.getObject<ioBroker.StateObject>(fullId);
        } catch {
            return;
        }
        if (!obj?.common?.custom?.[historyAdapter]) {
            return;
        }
        // Subscription may have been torn down while we were awaiting the object lookup
        // (e.g. instance-setting change). Bail out — the fresh subscribe() will re-invoke us.
        if (this.subscribedId !== fullId) {
            return;
        }
        const windowMs = (this.props.settings.historySeconds ?? DEFAULT_HISTORY_SECONDS) * 1000;
        const end = Date.now();
        const start = end - windowMs;
        try {
            const socket = ctx.getSocket();
            const result = await socket.getHistory(fullId, {
                instance: historyAdapter,
                start,
                end,
                aggregate: 'none',
            });
            if (!result || !Array.isArray(result) || this.subscribedId !== fullId) {
                return;
            }
            const historical: { val: number; ts: number }[] = [];
            for (const row of result as Array<{ val: unknown; ts?: number }>) {
                const v = Number(row.val);
                if (!isFinite(v) || !row.ts) {
                    continue;
                }
                historical.push({ val: v, ts: row.ts });
            }
            if (historical.length === 0) {
                return;
            }
            // Merge with live samples that may have arrived meanwhile, de-duplicating by timestamp
            // and keeping the array sorted ascending so the renderer can walk it left-to-right.
            this.setState(s => {
                const seen = new Set(s.samples.map(x => x.ts));
                const merged = [...historical.filter(x => !seen.has(x.ts)), ...s.samples].sort((a, b) => a.ts - b.ts);
                const latest = merged.length ? merged[merged.length - 1].val : s.current;
                return {
                    samples: merged,
                    current: s.current ?? latest,
                } as HistoryChartState;
            });
        } catch {
            // History adapter unreachable or returned an error — just keep going with live data.
        }
    }

    private unsubscribe(): void {
        if (this.subscribedId && this.stateHandler) {
            this.props.stateContext.removeState(this.subscribedId, this.stateHandler);
        }
        this.subscribedId = null;
        this.stateHandler = null;
    }

    protected isTileActive(): boolean {
        return this.state.current != null;
    }

    /**
     * Core chart renderer — 600×400 viewBox, scales to the container via width/height attrs.
     * `compact=true` drops the header + current readout (used by the small-tile variant).
     */
    private renderChartSvg(compact = false): React.JSX.Element {
        const { samples, current } = this.state;
        const label = this.props.settings.label || 'Value';
        const unit = this.props.settings.unit || '';
        const decimals = this.props.settings.decimals ?? DEFAULT_DECIMALS;
        const isFloatComma = this.props.stateContext.isFloatComma;
        const windowMs = (this.props.settings.historySeconds ?? DEFAULT_HISTORY_SECONDS) * 1000;

        // ---- Geometry ----
        const VIEW_W = 600;
        const VIEW_H = 400;
        const chartLeft = 20;
        const chartRight = VIEW_W - 20;
        const chartTop = compact ? 30 : 110;
        const chartBottom = VIEW_H - 20;
        const chartWidth = chartRight - chartLeft;
        const chartHeight = chartBottom - chartTop;

        const now = Date.now();
        const startMs = now - windowMs;
        const active = samples.filter(s => s.ts >= startMs);

        // ---- Data min / avg / max over the visible window ----
        let dataMin: number | null = null;
        let dataMax: number | null = null;
        let avg: number | null = null;
        if (active.length > 0) {
            dataMin = Infinity;
            dataMax = -Infinity;
            let sum = 0;
            for (const s of active) {
                if (s.val < dataMin) {
                    dataMin = s.val;
                }
                if (s.val > dataMax) {
                    dataMax = s.val;
                }
                sum += s.val;
            }
            avg = sum / active.length;
        }

        // ---- Y-axis scaling ----
        // `yMin`/`yMax` settings act as suggestions when `autoScale` is true (axis grows beyond
        // them if data exceeds), or as hard bounds when false (values outside are clipped).
        const cfgMin = this.props.settings.yMin ?? 0;
        const cfgMax = this.props.settings.yMax ?? 0;
        const hasCfgMax = cfgMax > cfgMin;
        const autoScale = this.props.settings.autoScale ?? true;
        let yMin: number;
        let yMax: number;
        if (autoScale) {
            const lowerSeed = dataMin ?? cfgMin;
            const upperSeed = dataMax != null ? dataMax * 1.1 : cfgMin + 1;
            yMin = Math.min(cfgMin, lowerSeed);
            yMax = Math.max(hasCfgMax ? cfgMax : cfgMin + 1, upperSeed);
        } else {
            yMin = cfgMin;
            yMax = hasCfgMax ? cfgMax : cfgMin + 1;
        }
        if (yMax <= yMin) {
            yMax = yMin + 1; // guarantee a non-zero range
        }
        const yRange = yMax - yMin;

        const xFor = (ts: number): number => chartLeft + ((ts - startMs) / windowMs) * chartWidth;
        const yFor = (val: number): number =>
            chartBottom - ((Math.max(yMin, Math.min(yMax, val)) - yMin) / yRange) * chartHeight;

        // ---- Poly points / area path ----
        const lineParts: string[] = [];
        for (let i = 0; i < active.length; i++) {
            const s = active[i];
            lineParts.push(`${xFor(s.ts).toFixed(1)},${yFor(s.val).toFixed(1)}`);
        }
        // Extend the line horizontally from the newest sample to "now" so the chart doesn't end
        // in a blank strip when updates stop — the signal is assumed to hold its last known value.
        if (active.length > 0) {
            const lastVal = active[active.length - 1].val;
            const nowX = xFor(now);
            const lastX = xFor(active[active.length - 1].ts);
            if (nowX > lastX + 0.5) {
                lineParts.push(`${nowX.toFixed(1)},${yFor(lastVal).toFixed(1)}`);
            }
        }
        const polyline = lineParts.join(' ');

        // Close the area polygon from the baseline (chartBottom) up through the samples.
        let areaPath = '';
        if (active.length > 0) {
            const firstX = xFor(active[0].ts).toFixed(1);
            // Use the last x in `lineParts` (which already includes the hold-last-value extension
            // to "now") so the filled area reaches the chart's right edge instead of stopping at
            // the last sample's timestamp.
            const lastPoint = lineParts[lineParts.length - 1];
            const lastX = lastPoint.split(',')[0];
            areaPath = `M ${firstX},${chartBottom} L ${lineParts.join(' L ')} L ${lastX},${chartBottom} Z`;
        }

        // ---- Reference-line y positions (computed from dataMin/avg/dataMax) ----
        const showMin = this.props.settings.showMin ?? false;
        const showAvg = this.props.settings.showAvg ?? true;
        const showMax = this.props.settings.showMax ?? false;
        const avgY = avg != null ? yFor(avg) : null;
        const minY = dataMin != null ? yFor(dataMin) : null;
        const maxY = dataMax != null ? yFor(dataMax) : null;

        return (
            <svg
                viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                preserveAspectRatio="none"
                style={{ width: '100%', height: '100%', display: 'block' }}
            >
                {/* Card background */}
                <rect
                    x={0}
                    y={0}
                    width={VIEW_W}
                    height={VIEW_H}
                    fill={COLORS.cardBg}
                />

                {/* Header + current value (hidden in compact) */}
                {!compact && (
                    <>
                        <text
                            x={30}
                            y={78}
                            fontSize={64}
                            fontWeight={700}
                            fontFamily="Roboto, Arial, sans-serif"
                            fill={COLORS.grey}
                        >
                            {label}
                        </text>
                        <text
                            x={VIEW_W - 30}
                            y={78}
                            textAnchor="end"
                            fontSize={56}
                            fontWeight={800}
                            fontFamily="Roboto, Arial, sans-serif"
                            fill={COLORS.contrast}
                        >
                            {current != null
                                ? `${formatNum(current, decimals, isFloatComma)}${unit ? ` ${unit}` : ''}`
                                : '—'}
                        </text>
                    </>
                )}

                {/* Area fill under the raw-sample polyline */}
                {areaPath ? (
                    <path
                        d={areaPath}
                        fill={COLORS.greyArea}
                        fillOpacity={0.75}
                    />
                ) : null}

                {/* Raw-sample polyline */}
                {polyline ? (
                    <polyline
                        points={polyline}
                        fill="none"
                        stroke={COLORS.contrast}
                        strokeWidth={2}
                        strokeLinejoin="round"
                    />
                ) : null}

                {/* Reference lines (min, avg, max) — each optional, each colour-coded. Labels sit in a
                    dark pill so they stay readable over the grey fill and the raw polyline. */}
                {((): React.JSX.Element[] => {
                    const refs: React.JSX.Element[] = [];
                    const addRef = (
                        key: string,
                        y: number | null,
                        value: number | null,
                        stroke: string,
                        slot: number, // horizontal slot for the label (0=left, 1=second-from-left, …)
                    ): void => {
                        if (y == null || value == null) {
                            return;
                        }
                        const labelX = chartLeft + 4 + slot * 82;
                        refs.push(
                            // Inner elements are drawn at y=0 and the parent <g> translates them
                            // down to the target y via CSS `transform`. A CSS transition on
                            // `transform` turns every y-change into a 100 ms glide instead of a
                            // hard snap when min/avg/max drifts sample-by-sample.
                            <g
                                key={`ref-${key}`}
                                style={{
                                    transform: `translate(0px, ${y}px)`,
                                    transition: 'transform 100ms ease-out',
                                }}
                            >
                                <line
                                    x1={chartLeft}
                                    y1={0}
                                    x2={chartRight}
                                    y2={0}
                                    stroke={stroke}
                                    strokeWidth={2.5}
                                    strokeDasharray="12 6"
                                    strokeOpacity={0.85}
                                />
                                <rect
                                    x={labelX}
                                    y={-18}
                                    width={78}
                                    height={30}
                                    rx={6}
                                    fill={COLORS.cardBg}
                                    fillOpacity={0.85}
                                    stroke={stroke}
                                    strokeOpacity={0.4}
                                />
                                {/* Single centred label "<key> <value>" — keeps the word and the
                                    number as one glued unit in the pill centre. `dominantBaseline`
                                    is unreliable across renderers, so we compute the baseline y
                                    manually: rect spans [-18, +12] → centre -3 → baseline at
                                    centre + cap-height/2 ≈ centre + fontSize × 0.35 = 4. */}
                                <text
                                    x={labelX + 39}
                                    y={4}
                                    textAnchor="middle"
                                    fontSize={20}
                                    fontWeight={600}
                                    fontFamily="Roboto, Arial, sans-serif"
                                >
                                    <tspan fill={stroke}>{key}</tspan>
                                    <tspan fill={COLORS.contrast}>
                                        {` ${formatNum(value, decimals, isFloatComma)}`}
                                    </tspan>
                                </text>
                            </g>,
                        );
                    };
                    // Slot index runs left-to-right in config order so labels never overlap.
                    let slot = 0;
                    if (showMin) {
                        addRef('min', minY, dataMin, COLORS.minLine, slot++);
                    }
                    if (showAvg) {
                        addRef('avg', avgY, avg, COLORS.avgLine, slot++);
                    }
                    if (showMax) {
                        addRef('max', maxY, dataMax, COLORS.maxLine, slot++);
                    }
                    return refs;
                })()}

                {/* Empty-state hint */}
                {!active.length ? (
                    <text
                        x={VIEW_W / 2}
                        y={(chartTop + chartBottom) / 2}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={28}
                        fontWeight={500}
                        fontFamily="Roboto, Arial, sans-serif"
                        fill={COLORS.grey}
                        opacity={0.6}
                    >
                        waiting for samples…
                    </text>
                ) : null}
            </svg>
        );
    }

    override renderCompact(): React.JSX.Element {
        const isActive = this.isTileActive();
        const accent = this.getAccentColor();
        const settingsButton = this.renderSettingsButton();
        const indicators = this.renderIndicators(settingsButton);
        const label = this.props.settings.label || 'Value';
        const unit = this.props.settings.unit || '';
        const decimals = this.props.settings.decimals ?? DEFAULT_DECIMALS;
        const isFloatComma = this.props.stateContext.isFloatComma;
        return (
            <Box
                id={String(this.props.widget.id)}
                className={this.getWidgetClass()}
                sx={theme => WidgetGeneric.getStyleCompact(theme)}
            >
                <Box
                    onClick={() => this.setState({ dialogOpen: true } as HistoryChartState)}
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
                    <Typography
                        variant="caption"
                        sx={{ fontWeight: 700, color: 'text.secondary' }}
                    >
                        {label}
                    </Typography>
                    <Typography sx={{ fontSize: 32, fontWeight: 800, lineHeight: 1 }}>
                        {formatNum(this.state.current, decimals, isFloatComma)}
                    </Typography>
                    {unit ? (
                        <Typography
                            variant="caption"
                            sx={{ opacity: 0.7 }}
                        >
                            {unit}
                        </Typography>
                    ) : null}
                </Box>
            </Box>
        );
    }

    /** 2x0.5 — same compact layout, just wider. */
    override renderWide(): React.JSX.Element {
        const isActive = this.isTileActive();
        const accent = this.getAccentColor();
        const settingsButton = this.renderSettingsButton();
        const indicators = this.renderIndicators(settingsButton);
        return (
            <Box
                id={String(this.props.widget.id)}
                className={this.getWidgetClass()}
                sx={theme => ({ ...WidgetGeneric.getStyleWide(theme), height: 80 })}
            >
                <Box
                    onClick={() => this.setState({ dialogOpen: true } as HistoryChartState)}
                    sx={theme => ({
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        height: '100%',
                        cursor: 'pointer',
                        ...(getTileStyles(theme, isActive, accent) as any),
                        px: 2,
                    })}
                >
                    {indicators}
                    <Typography sx={{ fontSize: 14, fontWeight: 700, color: 'text.secondary' }}>
                        {this.props.settings.label || 'Value'}
                    </Typography>
                    <Typography sx={{ fontSize: 28, fontWeight: 800 }}>
                        {formatNum(
                            this.state.current,
                            this.props.settings.decimals ?? DEFAULT_DECIMALS,
                            this.props.stateContext.isFloatComma,
                        )}
                        {this.props.settings.unit ? ` ${this.props.settings.unit}` : ''}
                    </Typography>
                </Box>
            </Box>
        );
    }

    /** 2x1 — the actual chart. This is the primary layout. */
    override renderWideTall(): React.JSX.Element {
        const isActive = this.isTileActive();
        const accent = this.getAccentColor();
        const settingsButton = this.renderSettingsButton();
        const indicators = this.renderIndicators(settingsButton);

        return (
            <Box
                id={String(this.props.widget.id)}
                className={this.getWidgetClass()}
                sx={theme => WidgetGeneric.getStyleWide(theme)}
            >
                <Box
                    onClick={() => this.setState({ dialogOpen: true } as HistoryChartState)}
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
                    {indicators}
                    <Box sx={{ width: '100%', height: '100%' }}>{this.renderChartSvg(false)}</Box>
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
                onClose={() => this.setState({ dialogOpen: false } as HistoryChartState)}
                maxWidth={false}
                fullWidth
                slotProps={{
                    paper: {
                        sx: {
                            width: '95vw',
                            height: '85vh',
                            maxWidth: '95vw',
                            maxHeight: '85vh',
                            m: 1,
                            bgcolor: COLORS.bg,
                        },
                    },
                }}
            >
                <IconButton
                    onClick={() => this.setState({ dialogOpen: false } as HistoryChartState)}
                    sx={{ position: 'absolute', top: 8, right: 8, zIndex: 1, color: 'white' }}
                >
                    <CloseIcon />
                </IconButton>
                <DialogContent
                    sx={{
                        display: 'flex',
                        alignItems: 'stretch',
                        justifyContent: 'stretch',
                        p: 2,
                        overflow: 'hidden',
                    }}
                >
                    <Box sx={{ width: '100%', height: '100%' }}>{this.renderChartSvg(false)}</Box>
                </DialogContent>
            </Dialog>
        );
    }

    override render(): React.JSX.Element {
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

export default NmeaHistoryChartComponent;
