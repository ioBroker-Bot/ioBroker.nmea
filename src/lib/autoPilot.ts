import type { NmeaConfig } from '../types';
import type { GenericDriver } from './genericDriver';

export default abstract class AutoPilot {
    protected readonly adapter: ioBroker.Adapter;

    protected readonly config: NmeaConfig;

    protected readonly nmeaDriver: GenericDriver;

    protected readonly values: Record<string, { val: ioBroker.StateValue; ts: number }>;

    protected readonly autoPilotAddress: number;

    protected constructor(
        adapter: ioBroker.Adapter,
        config: NmeaConfig,
        nmeaDriver: GenericDriver,
        values: Record<string, { val: ioBroker.StateValue; ts: number }>,
        autoPilotAddress?: number,
    ) {
        this.adapter = adapter;
        this.config = config;
        this.values = values;
        this.nmeaDriver = nmeaDriver;
        this.autoPilotAddress = autoPilotAddress || 0x04; // Address of the control device

        // create states
        void this.adapter.setObjectNotExists('autoPilot', {
            type: 'channel',
            common: {
                name: 'NavicoAutoPilot',
            },
            native: {
                autoPilotAddress,
            },
        });
        void this.adapter.setObjectNotExists('autoPilot.state', {
            type: 'state',
            common: {
                name: 'Auto pilot mode',
                type: 'number',
                role: 'value.mode.autopilot',
                write: true,
                read: true,
                states: {
                    0: 'Standby',
                    1: 'Auto',
                    2: 'AutoWind',
                    3: 'AutoTrack',
                    4: 'AutoNoDrift', // not supported by raymarine
                },
            },
            native: {
                autoPilotAddress,
            },
        });
        void this.adapter.setObjectNotExists('autoPilot.heading', {
            type: 'state',
            common: {
                name: 'NavicoAutoPilot',
                type: 'number',
                role: 'value.direction.autopilot',
                write: true,
                read: true,
                unit: '°',
            },
            native: {
                autoPilotAddress,
            },
        });
        void this.adapter.setObjectNotExists('autoPilot.headingPlus1', {
            type: 'state',
            common: {
                name: 'Increase heading by 1°',
                type: 'boolean',
                role: 'button',
                write: true,
                read: false,
                unit: '°',
            },
            native: {
                autoPilotAddress,
            },
        });
        void this.adapter.setObjectNotExists('autoPilot.headingPlus10', {
            type: 'state',
            common: {
                name: 'Increase heading by 10°',
                type: 'boolean',
                role: 'button',
                write: true,
                read: false,
                unit: '°',
            },
            native: {
                autoPilotAddress,
            },
        });

        void this.adapter.setObjectNotExists('autoPilot.headingMinus1', {
            type: 'state',
            common: {
                name: 'Decrease heading by 1°',
                type: 'boolean',
                role: 'button',
                write: true,
                read: false,
                unit: '°',
            },
            native: {
                autoPilotAddress,
            },
        });

        void this.adapter.setObjectNotExists('autoPilot.headingMinus10', {
            type: 'state',
            common: {
                name: 'Decrease heading by 10°',
                type: 'boolean',
                role: 'button',
                write: true,
                read: false,
                unit: '°',
            },
            native: {
                autoPilotAddress,
            },
        });
        void this.adapter.setObjectNotExists('autoPilot.windAngleChange', {
            type: 'state',
            common: {
                name: 'NavicoAutoPilot',
                type: 'number',
                role: 'value',
                write: true,
                read: false,
                states: {
                    1: 'Increment 1°',
                    10: 'Increment 10°',
                    '-1': 'Decrement 1°',
                    '-10': 'Decrement 10°',
                },
                unit: '°',
            },
            native: {
                autoPilotAddress,
            },
        });

        this.adapter.subscribeStates('autoPilot.*');
    }

    stop(): void {
        this.adapter.unsubscribeStates('autoPilot.*');
    }

    abstract onStateChange(id: string, state?: ioBroker.State | null): void;
}
