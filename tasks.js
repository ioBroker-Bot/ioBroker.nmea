const { deleteFoldersRecursive, buildReact, npmInstall, copyFiles } = require('@iobroker/build-tools');

const SRC = 'src-devices/';
const src = `${__dirname}/${SRC}`;

function cleanDevices() {
    deleteFoldersRecursive(`${src}build`);
    deleteFoldersRecursive(`${__dirname}/admin/dm-widgets`);
}

function copyAllFilesDevices() {
    copyFiles([`${SRC}build/customDevices.js`], `admin/dm-widgets`);
    copyFiles([`${SRC}build/assets/*.*`], `admin/dm-widgets/assets`);
    copyFiles([`${SRC}build/img/*`], `admin/dm-widgets/img`);
    copyFiles([`${SRC}img/witmotion.png`], `admin/dm-widgets`);
}

function copyAllFiles() {
    copyFiles(
        [
            'src-widgets/build/**/*',
            '!src-widgets/build/index.html',
            '!src-widgets/build/mf-manifest.json',
            '!src-widgets/build/static/js/*node_modules*.*',
            '!src-widgets/build/static/js/node_modules_*',
        ],
        'widgets/nmea/',
    );
    copyFiles(
        [
            `src-widgets/build/static/js/*echarts-for-react_lib_core*.*`,
            `src-widgets/build/static/js/*spectrum_color_dist_import_mjs*.*`,
            `src-widgets/build/static/js/*uiw_react-color-shade-slider*.*`,
            `src-widgets/build/static/js/*runtime_js-src_sketch_css*.*`,
            `src-widgets/build/static/js/*node_modules_babel_runtime_helpers_createForOfItera*.*`,
        ],
        'widgets/nmea/static/js',
    );
}

if (process.argv.includes('--copy-files')) {
    copyAllFiles();
} else if (process.argv.includes('--build')) {
    buildReact(`${__dirname}/src-widgets`, { rootDir: __dirname, vite: true }).catch(() =>
        console.error('Error by build'),
    );
} else if (process.argv.includes('--copy-i18n')) {
    copyFiles(['src/i18n/**/*'], 'build/i18n/');
} else {
    deleteFoldersRecursive('src-widgets/build');
    deleteFoldersRecursive('widgets');
    npmInstall('src-widgets')
        .then(() => buildReact(`${__dirname}/src-widgets`, { rootDir: __dirname, vite: true }))
        .then(() => copyAllFiles())
        .then(() => cleanDevices())
        .then(() => npmInstall(src))
        .then(() => buildReact(src, { rootDir: src, vite: true }))
        .then(() => copyAllFilesDevices())
        .catch(e => console.error(`Cannot build: ${e}`));
}
