export type PGNFieldEntry = {
    Order: number;
    Id: string;
    Name: string;
    Description: string;
    BitLength: number;
    BitOffset: number;
    BitStart: number;
    Resolution: number;
    Signed: boolean;
    RangeMin: number;
    RangeMax: number;
    FieldType:
        | 'NUMBER'
        | 'LOOKUP'
        | 'RESERVED'
        | 'STRING_FIX'
        | 'STRING_LAU'
        | 'DATE'
        | 'TIME'
        | 'MMSI'
        | 'INDIRECT_LOOKUP'
        | 'BINARY'
        | 'SPARE';
    LookupEnumeration?: string;
};
export type PGNEntry = {
    PGN: number;
    Id: string;
    Description: string;
    Explanation: string;
    Type: 'Single' | 'ISO';
    Complete: boolean;
    FieldCount: number;
    Length: number;
    TransmissionIrregular: boolean;
    Fields: PGNFieldEntry[];
};

export type PGNLookupEnumeration = {
    Name: string;
    MaxValue: number;
    EnumValues: { Name: string; Value: number }[];
};

export type PGNType = {
    PGNs: PGNEntry[];
    LookupEnumerations: PGNLookupEnumeration[];
};

export interface NmeaConfig extends ioBroker.AdapterConfig {
    serialPort: string;
    type: 'ngt1' | 'picanm' | 'ydwg';
    ydwgIp: string;
    ydwgPort: string | number;
    ydwgProtocol: 'udp' | 'tcp';
    canPort: string;
    updateAtLeastEveryMs: number;
    magneticVariation: string;
    simulationEnabled: false;
    combinedEnvironment: false;
    simulate: {
        oid: string;
        type: 'temperature' | 'humidity' | 'pressure' | 'tank';
        subType: string;
        /** Tank PGN 127505 instance (0..13). Ignored for non-tank rows. */
        instance?: number;
        /** Tank total capacity in liters (PGN 127505 Capacity). Ignored for non-tank rows. */
        capacity?: number;
    }[];
    simulateAddress: number;
    approximateMs: number;
    applyGpsTimeZoneToSystem: false;
    deleteAisAfter: number;
    pressureAlertDiff: number;
    pressureAlertMinutes: number;
    signalKEnabled: boolean;
    signalKPort: number;
    signalKBidirectional: boolean;

    // ── NMEA-2000 Address Claim / device announcement ───────────────────────────────────
    // When true, the adapter periodically broadcasts ISO Address Claim (PGN 60928), Product
    // Information (PGN 126996), and a Raymarine-style Device Identification (PGN 126720)
    // so the autopilot / chart-plotter recognises us as a known controller. Useful when
    // some commands (typically Wind-Datum / advanced PGN-126208 group functions) get
    // silently dropped by the autopilot because the source address isn't claimed.
    announceDevice?: boolean;
    announceSrc?: number; // CAN source address used for both announcement and outbound commands. Default 7.
    announceUniqueNumber?: number; // 21-bit unique number for the NAME field. Default 12345.
    announceManufacturerCode?: number; // 11-bit. Default 2046 (reserved/unassigned — fine for a private adapter).
    announceProductCode?: number; // uint16. Default 0xC001.
    announceModelId?: string; // up to 32 chars. Default "ioBroker.nmea".
    announceRaymarineDeviceId?: number; // Raymarine-proprietary device byte for PGN 126720 ("S100" = 0x03). 0 disables.
}

export interface PGNMessage {
    pgn: number;
}

export interface WritePgnData {
    dst: number;
    prio: number;
    pgn: number;
    fields: {
        sid: number;
        [key: string]: number | string;
    };
    src: number;
}

export interface PgnDataEvent {
    pgn: number;
    src: number;
    fields: {
        SID: number;
        'Wind Angle': number;
        'Wind Speed': number;
        Reference: string;
        Latitude: number;
        Longitude: number;
        Source: string;
        Pressure: number;
        Temperature: number;
        'Temperature Source': string;
        'Actual Temperature': number;
        [key: string]: number | string;
    };
}
