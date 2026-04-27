// Dev-only shim for the dm-widgets runtime resolver.
//
// `@iobroker/dm-widgets` re-exports `React`, `MuiMaterial`, `MuiIcons`, `moment` from
// `window.__iobrokerShared__` at MODULE-INIT time. In production the host (ioBroker.devices)
// populates that global before any plugin loads. In our Vite dev harness nobody sets it, so
// `MuiMaterial?.Button` etc. evaluate to `undefined` and any widget that references MUI
// components crashes with "Element type is invalid".
//
// This file populates the global from the dev environment's real React + MUI instances. It
// must run BEFORE the widget files import `@iobroker/dm-widgets` — which is why `index.tsx`
// imports this module FIRST (ahead of `./App`) and this file has no dependency on App or any
// widget. ES-module evaluation is depth-first along the dependency graph, so this body
// executes before App's transitive imports trigger dm-widgets to initialise.

import * as ReactRuntime from 'react';
import * as MuiMaterialRuntime from '@mui/material';
import * as MuiIconsRuntime from '@mui/icons-material';
import momentRuntime from 'moment';

(window as any).__iobrokerShared__ = {
    react: ReactRuntime,
    '@mui/material': MuiMaterialRuntime,
    '@mui/icons-material': MuiIconsRuntime,
    moment: momentRuntime,
};
