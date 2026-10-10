/*
 * Plex Subtitles Jellyfin
 *
 * Replaces the subtitle (CC) button menu in the web video player with a Plex style
 * settings panel: track, secondary track, colour, position, size, style and offset.
 * Text subtitles are drawn in an overlay this script owns, so the chosen look applies
 * the same way whether Jellyfin renders cues natively or with its custom element.
 */
(function () {
    'use strict';

    if (window.SubtitleCustomiser) {
        return;
    }

    var LOG = '[SubtitleCustomiser]';
    var STORAGE_PREFIX = 'subtitleCustomiser.v1';
    var KNOWN_PLAYBACK_MANAGER_ID = '68221';

    var COLOURS = [
        { id: 'white', name: 'White', value: '#ffffff' },
        { id: 'yellow', name: 'Yellow', value: '#ffe14d' },
        { id: 'green', name: 'Green', value: '#62e27f' },
        { id: 'cyan', name: 'Cyan', value: '#5fe3f2' },
        { id: 'blue', name: 'Blue', value: '#78adff' },
        { id: 'magenta', name: 'Magenta', value: '#f27ce4' },
        { id: 'red', name: 'Red', value: '#ff6161' },
        { id: 'grey', name: 'Grey', value: '#c4c4c4' },
        { id: 'black', name: 'Black', value: '#000000', dark: true }
    ];

    // Font size as a percentage of the player height, scaled to sit close to Plex's sizes.
    var SIZES = [
        { id: 'tiny', name: 'Tiny', value: 2.4 },
        { id: 'small', name: 'Small', value: 3.0 },
        { id: 'normal', name: 'Normal', value: 3.6 },
        { id: 'large', name: 'Large', value: 4.4 },
        { id: 'huge', name: 'Huge', value: 5.4 }
    ];

    var POSITIONS = [
        { id: 'bottom', name: 'Bottom' },
        { id: 'raised', name: 'Raised' },
        { id: 'middle', name: 'Middle' },
        { id: 'top', name: 'Top' }
    ];

    var STYLES = [
        { id: 'shadow', name: 'Drop Shadow' },
        { id: 'outline', name: 'Outline' },
        { id: 'box', name: 'Box' },
        { id: 'plain', name: 'Plain' }
    ];

    var OFFSET_STEPS = [-1000, -100, 100, 1000];

    var DEFAULTS = {
        colour: 'white',
        size: 'normal',
        position: 'bottom',
        style: 'shadow',
        liftWithControls: true
    };

    var scriptSrc = (document.currentScript && document.currentScript.src) || '';
    var apiBase = scriptSrc ? new URL('.', scriptSrc).href : '';

    var serverDefaults = {};
    var settings = Object.assign({}, DEFAULTS);
    var settingsKey = null;

    var state = {
        video: null,
        overlay: null,
        primaryEl: null,
        secondaryEl: null,
        lastPrimary: null,
        lastSecondary: null,
        timer: 0,
        observer: null,
        boundTracks: [],
        lift: -1,
        fontPx: 0,
        errors: 0,
        mismatchSince: 0,
        fallback: false,
        reported: {}
    };

    var panel = {
        root: null,
        box: null,
        anchor: null,
        openMenu: null,
        bypassClick: false,
        swallowClickUntil: 0,
        refreshTimer: 0
    };

    /* ------------------------------------------------------------------ */
    /* Settings                                                            */
    /* ------------------------------------------------------------------ */

    function currentUserId() {
        try {
            var api = window.ApiClient;
            return (api && typeof api.getCurrentUserId === 'function' && api.getCurrentUserId()) || '';
        } catch (e) {
            return '';
        }
    }

    function storageKey() {
        var uid = currentUserId();
        return uid ? STORAGE_PREFIX + '.' + uid : STORAGE_PREFIX;
    }

    function pick(list, id, fallbackId) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) {
                return list[i];
            }
        }
        return fallbackId ? pick(list, fallbackId) : list[0];
    }

    function readServerValue(obj, name) {
        if (!obj) {
            return undefined;
        }
        if (obj[name] !== undefined) {
            return obj[name];
        }
        var camel = name.charAt(0).toLowerCase() + name.slice(1);
        return obj[camel];
    }

    function loadSettings() {
        var key = storageKey();
        var saved = {};
        try {
            saved = JSON.parse(window.localStorage.getItem(key) || '{}') || {};
        } catch (e) {
            saved = {};
        }
        settings = Object.assign({}, DEFAULTS, serverDefaults, saved);
        settings.colour = pick(COLOURS, settings.colour, DEFAULTS.colour).id;
        settings.size = pick(SIZES, settings.size, DEFAULTS.size).id;
        settings.position = pick(POSITIONS, settings.position, DEFAULTS.position).id;
        settings.style = pick(STYLES, settings.style, DEFAULTS.style).id;
        settings.liftWithControls = settings.liftWithControls !== false;
        settingsKey = key;
        return settings;
    }

    function ensureSettingsForUser() {
        if (settingsKey !== storageKey()) {
            loadSettings();
            applyAppearance();
        }
    }

    function saveSettings() {
        var toSave = {
            colour: settings.colour,
            size: settings.size,
            position: settings.position,
            style: settings.style
        };
        try {
            window.localStorage.setItem(storageKey(), JSON.stringify(toSave));
        } catch (e) {
            /* storage can be unavailable in private windows */
        }
    }

    function updateSetting(name, value) {
        settings[name] = value;
        saveSettings();
        applyAppearance();
    }

    function fetchServerDefaults() {
        if (!apiBase || !window.fetch) {
            return Promise.resolve();
        }
        return fetch(apiBase + 'Defaults', { credentials: 'same-origin' })
            .then(function (res) {
                return res.ok ? res.json() : null;
            })
            .then(function (cfg) {
                if (!cfg) {
                    return;
                }
                if (readServerValue(cfg, 'Enabled') === false) {
                    serverDefaults.disabled = true;
                }
                var map = {
                    colour: readServerValue(cfg, 'DefaultColour'),
                    size: readServerValue(cfg, 'DefaultSize'),
                    position: readServerValue(cfg, 'DefaultPosition'),
                    style: readServerValue(cfg, 'DefaultStyle')
                };
                Object.keys(map).forEach(function (k) {
                    if (typeof map[k] === 'string' && map[k]) {
                        serverDefaults[k] = map[k].toLowerCase();
                    }
                });
                var lift = readServerValue(cfg, 'LiftAboveControls');
                if (typeof lift === 'boolean') {
                    serverDefaults.liftWithControls = lift;
                }
            })
            .catch(function (e) {
                console.warn(LOG, 'Could not load server defaults', e);
            });
    }

    /* ------------------------------------------------------------------ */
    /* Access to Jellyfin's playback manager                               */
    /* ------------------------------------------------------------------ */

    var webpackRequire = null;
    var playbackManager = null;

    function getWebpackRequire() {
        if (webpackRequire) {
            return webpackRequire;
        }
        var chunkKey = Object.keys(self).filter(function (k) {
            return k.indexOf('webpackChunk') === 0;
        })[0];
        var chunk = chunkKey && self[chunkKey];
        if (!chunk || typeof chunk.push !== 'function') {
            return null;
        }
        try {
            chunk.push([['subtitle-customiser-' + Date.now()], {}, function (req) {
                webpackRequire = req;
            }]);
        } catch (e) {
            console.warn(LOG, 'webpack hook failed', e);
        }
        return webpackRequire;
    }

    function looksLikePlaybackManager(obj) {
        return !!obj && typeof obj === 'object'
            && typeof obj.getCurrentPlayer === 'function'
            && typeof obj.subtitleTracks === 'function'
            && typeof obj.setSubtitleStreamIndex === 'function'
            && typeof obj.getSubtitleStreamIndex === 'function';
    }

    function playbackManagerFromExports(exp) {
        if (!exp) {
            return null;
        }
        if (looksLikePlaybackManager(exp)) {
            return exp;
        }
        var keys = Object.keys(exp);
        for (var i = 0; i < keys.length; i++) {
            var value;
            try {
                value = exp[keys[i]];
            } catch (e) {
                continue;
            }
            if (looksLikePlaybackManager(value)) {
                return value;
            }
        }
        return null;
    }

    function getPlaybackManager() {
        if (playbackManager) {
            return playbackManager;
        }
        var req = getWebpackRequire();
        if (!req || !req.m) {
            return null;
        }
        var ids = Object.keys(req.m);
        var known = ids.indexOf(KNOWN_PLAYBACK_MANAGER_ID);
        if (known > 0) {
            ids.splice(known, 1);
            ids.unshift(KNOWN_PLAYBACK_MANAGER_ID);
        }
        for (var i = 0; i < ids.length; i++) {
            var src;
            try {
                src = Function.prototype.toString.call(req.m[ids[i]]);
            } catch (e) {
                continue;
            }
            // Only the module that defines the API, not the modules that call it.
            if (!/setSubtitleStreamIndex\s*=\s*function|setSubtitleStreamIndex\s*\(\s*\w+\s*,\s*\w+\s*\)\s*\{/.test(src)
                || src.indexOf('getPlayerSubtitleOffset') === -1) {
                continue;
            }
            try {
                playbackManager = playbackManagerFromExports(req(ids[i]));
            } catch (e) {
                playbackManager = null;
            }
            if (playbackManager) {
                break;
            }
        }
        if (!playbackManager) {
            console.warn(LOG, 'Playback manager not found; track selection falls back to the Jellyfin menu');
        }
        return playbackManager;
    }

    function attempt(fn, fallback) {
        try {
            var result = fn();
            return result === undefined ? fallback : result;
        } catch (e) {
            return fallback;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    var GOLD = '#e5a00d';

    var CSS = [
        /* Hide Jellyfin's own text subtitle rendering while the overlay is active. */
        'html.scActive video.htmlvideoplayer::-webkit-media-text-track-container{visibility:hidden!important;opacity:0!important}',
        'html.scActive video.htmlvideoplayer.htmlvideoplayer::cue{color:transparent!important;background:transparent!important;text-shadow:none!important}',
        'html.scActive .videoSubtitles{visibility:hidden!important;opacity:0!important}',

        /* Overlay */
        /* Sizes are pixels worked out from the player height by the script, with vh fallbacks. */
        '.scSubs{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;box-sizing:border-box;',
        'padding:0 5% calc(var(--sc-lift,0px) + var(--sc-pad,5.5vh));transition:padding-bottom .22s ease;',
        'font-family:"Noto Sans","Open Sans","Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}',
        '.scSubs[data-position=raised]{padding-bottom:calc(var(--sc-lift,0px) + var(--sc-raise,16vh))}',
        '.scSubs[data-position=middle]{justify-content:center;padding-bottom:0}',
        '.scSubs[data-position=top]{justify-content:flex-start;padding-bottom:0;padding-top:var(--sc-pad,5.5vh)}',
        '.scSubsStack{display:flex;flex-direction:column;align-items:center;gap:.25em;max-width:100%;font-size:var(--sc-font,5.3vh)}',
        '.scSubs[data-position=top] .scSubsStack{flex-direction:column-reverse}',
        '.scSubsLine{display:block;width:fit-content;max-width:100%;text-align:center;white-space:pre-line;line-height:1.28;font-weight:500;color:var(--sc-colour,#fff);overflow-wrap:break-word}',
        '.scSubsLine:empty{display:none}',
        '.scSubsSecondary{font-size:.86em}',
        '.scSubs[data-style=shadow] .scSubsLine{text-shadow:0 0 .1em var(--sc-edge),.04em .06em .08em var(--sc-edge),0 0 .4em var(--sc-edge-soft)}',
        '.scSubs[data-style=outline] .scSubsLine{text-shadow:-.055em -.055em 0 var(--sc-edge),0 -.065em 0 var(--sc-edge),.055em -.055em 0 var(--sc-edge),.065em 0 0 var(--sc-edge),.055em .055em 0 var(--sc-edge),0 .065em 0 var(--sc-edge),-.055em .055em 0 var(--sc-edge),-.065em 0 0 var(--sc-edge),.05em .08em .12em var(--sc-edge-soft)}',
        '.scSubs[data-style=box] .scSubsLine{background:var(--sc-box);padding:.06em .42em .1em;border-radius:.14em;-webkit-box-decoration-break:clone;box-decoration-break:clone}',
        '.scSubs[data-style=plain] .scSubsLine{text-shadow:none}',

        /* Panel */
        '.scPanel{position:fixed;z-index:99999;box-sizing:border-box;min-width:min(400px,calc(100vw - 24px));max-width:calc(100vw - 24px);padding:14px 22px 14px 16px;background:#282828;border-radius:4px;',
        'box-shadow:0 10px 36px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.06);color:#eee;font-family:"Open Sans","Noto Sans","Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.3;',
        'opacity:0;transform:translateY(6px);transition:opacity .14s ease,transform .14s ease;-webkit-user-select:none;user-select:none}',
        '.scPanel.scOpen{opacity:1;transform:none}',
        '.scPanel.scBelow{transform:translateY(-6px)}',
        '.scPanel.scBelow.scOpen{transform:none}',
        '.scArrow{position:absolute;bottom:-7px;width:14px;height:14px;background:#282828;transform:rotate(45deg);margin-left:-7px;box-shadow:3px 3px 4px rgba(0,0,0,.18)}',
        '.scBelow .scArrow{bottom:auto;top:-7px;box-shadow:-2px -2px 3px rgba(0,0,0,.12)}',
        '.scRow{display:grid;grid-template-columns:minmax(150px,auto) 1fr;align-items:center;column-gap:18px;min-height:31px;position:relative}',
        '.scLabel{text-align:right;text-transform:uppercase;font-weight:700;font-size:13px;letter-spacing:.03em;color:#9a9a9a;white-space:nowrap}',
        '.scValue{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:5px 2px;cursor:pointer;color:' + GOLD + ';font-weight:600;font-size:14px;white-space:nowrap;border-radius:3px}',
        '.scValue:hover,.scValue:focus-visible{color:#f3b42b}',
        '.scValue:focus-visible{outline:2px solid rgba(229,160,13,.55);outline-offset:2px}',
        '.scValue.scWhite{color:#fff}',
        '.scValue.scWhite:hover,.scValue.scWhite:focus-visible{color:#fff;opacity:.85}',
        '.scValue[disabled]{cursor:default;color:#6f6f6f}',
        '.scValueText{overflow:hidden;text-overflow:ellipsis;max-width:260px}',
        '.scCaret{width:0;height:0;border-left:4.5px solid transparent;border-right:4.5px solid transparent;border-top:5px solid currentColor;flex:none;margin-top:1px}',
        '.scGear{width:15px;height:15px;flex:none;fill:currentColor}',
        '.scSwatch{width:12px;height:12px;border-radius:50%;flex:none;box-shadow:0 0 0 1px rgba(255,255,255,.35)}',
        '.scMenu{position:absolute;left:0;z-index:2;min-width:180px;max-width:min(360px,calc(100vw - 40px));max-height:min(320px,60vh);overflow-y:auto;padding:6px 0;background:#1d1d1d;border-radius:4px;',
        'box-shadow:0 8px 28px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.07)}',
        '.scOption{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;padding:8px 16px 8px 12px;cursor:pointer;color:#ddd;font-size:14px;white-space:nowrap}',
        '.scOption:hover,.scOption:focus-visible{background:rgba(255,255,255,.08);color:#fff}',
        '.scOption .scCheck{width:14px;flex:none;color:' + GOLD + ';font-size:13px;text-align:center}',
        '.scOption.scSelected{color:' + GOLD + '}',
        '.scOffsetBox{display:flex;flex-direction:column;gap:10px;padding:10px 12px;min-width:250px}',
        '.scOffsetValue{text-align:center;font-size:20px;font-weight:600;color:#fff}',
        '.scOffsetButtons{display:flex;gap:6px;justify-content:center}',
        '.scStep{all:unset;box-sizing:border-box;min-width:52px;padding:6px 8px;text-align:center;cursor:pointer;border-radius:3px;background:rgba(255,255,255,.08);color:#eee;font-size:13px;font-weight:600}',
        '.scStep:hover,.scStep:focus-visible{background:rgba(255,255,255,.16);color:#fff}',
        '.scReset{all:unset;align-self:center;cursor:pointer;color:' + GOLD + ';font-size:13px;font-weight:600;padding:2px 6px}',
        '.scReset:hover,.scReset:focus-visible{text-decoration:underline}',
        '.scNote{color:#8a8a8a;font-size:12px;text-align:center;white-space:normal;max-width:240px;align-self:center}',
        '.scPanelNote{margin:8px 0 0 6px;max-width:380px;color:#8a8a8a;font-size:12px;line-height:1.4}',
        '.videoOsdBottom .btnSubtitles.scPanelOpen{color:' + GOLD + '}',
        '@media (max-width:520px){.scPanel{padding:12px 14px 12px 10px}.scRow{grid-template-columns:minmax(118px,auto) 1fr;column-gap:12px}.scLabel{font-size:11.5px}.scValueText{max-width:150px}}'
    ].join('');

    function injectStyles() {
        if (document.getElementById('subtitleCustomiserStyles')) {
            return;
        }
        var style = document.createElement('style');
        style.id = 'subtitleCustomiserStyles';
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    /* ------------------------------------------------------------------ */
    /* Subtitle overlay                                                    */
    /* ------------------------------------------------------------------ */

    function applyAppearance() {
        var overlay = state.overlay;
        if (!overlay) {
            return;
        }
        var colour = pick(COLOURS, settings.colour);
        overlay.dataset.position = settings.position;
        overlay.dataset.style = settings.style;
        overlay.style.setProperty('--sc-colour', colour.value);
        overlay.style.setProperty('--sc-edge', colour.dark ? 'rgba(255,255,255,.95)' : 'rgba(0,0,0,.95)');
        overlay.style.setProperty('--sc-edge-soft', colour.dark ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.55)');
        overlay.style.setProperty('--sc-box', colour.dark ? 'rgba(255,255,255,.82)' : 'rgba(0,0,0,.72)');
        state.fontPx = 0;
        state.lift = -1;
        updateMetrics();
        updateLift();
    }

    // Font size and margins in pixels from the player height, so nothing depends on
    // container query support.
    function updateMetrics() {
        var overlay = state.overlay;
        var height = overlay ? overlay.clientHeight : 0;
        if (!height) {
            return;
        }
        var fontPx = Math.max(10, Math.round(height * pick(SIZES, settings.size).value / 100));
        if (fontPx === state.fontPx) {
            return;
        }
        state.fontPx = fontPx;
        overlay.style.setProperty('--sc-font', fontPx + 'px');
        overlay.style.setProperty('--sc-pad', Math.round(height * 0.055) + 'px');
        overlay.style.setProperty('--sc-raise', Math.round(height * 0.16) + 'px');
    }

    function findVideo() {
        return document.querySelector('video.htmlvideoplayer');
    }

    function setNativeHidden(hidden) {
        document.documentElement.classList.toggle('scActive', !!hidden);
    }

    function render() {
        // The video can leave the page between a cue event and this call when playback stops.
        if (state.overlay && state.video && state.video.parentNode && !state.fallback) {
            try {
                renderSubtitles(state.video);
                state.errors = 0;
            } catch (e) {
                state.errors++;
                if (state.errors === 1) {
                    console.error(LOG, e);
                }
                if (state.errors > 3) {
                    fallBackToJellyfin('render-error', { message: String(e && e.message) });
                }
            }
        }
    }

    function bindTracks(video) {
        unbindTracks();
        var tracks = video.textTracks || [];
        for (var i = 0; i < tracks.length; i++) {
            tracks[i].addEventListener('cuechange', render);
            state.boundTracks.push(tracks[i]);
        }
    }

    function unbindTracks() {
        state.boundTracks.forEach(function (track) {
            track.removeEventListener('cuechange', render);
        });
        state.boundTracks = [];
    }

    function onTrackListChange() {
        if (state.video) {
            bindTracks(state.video);
        }
        render();
    }

    function detachVideo() {
        var video = state.video;
        if (video && video.textTracks) {
            video.textTracks.removeEventListener('addtrack', onTrackListChange);
            video.textTracks.removeEventListener('removetrack', onTrackListChange);
            video.textTracks.removeEventListener('change', onTrackListChange);
        }
        unbindTracks();
        if (state.observer) {
            state.observer.disconnect();
            state.observer = null;
        }
    }

    function removeOverlay() {
        detachVideo();
        if (state.overlay && state.overlay.parentNode) {
            state.overlay.parentNode.removeChild(state.overlay);
        }
        state.overlay = null;
        state.primaryEl = null;
        state.secondaryEl = null;
        state.lastPrimary = null;
        state.lastSecondary = null;
        state.video = null;
        state.lift = -1;
        state.fontPx = 0;
        state.errors = 0;
        state.mismatchSince = 0;
        state.fallback = false;
        state.reported = {};
    }

    function attachVideo(video) {
        removeOverlay();
        var parent = video.parentNode;
        var overlay = document.createElement('div');
        overlay.className = 'scSubs';
        overlay.innerHTML = '<div class="scSubsStack"><div class="scSubsLine scSubsSecondary"></div><div class="scSubsLine scSubsPrimary"></div></div>';
        parent.appendChild(overlay);
        state.overlay = overlay;
        state.video = video;
        state.secondaryEl = overlay.querySelector('.scSubsSecondary');
        state.primaryEl = overlay.querySelector('.scSubsPrimary');

        if (video.textTracks) {
            video.textTracks.addEventListener('addtrack', onTrackListChange);
            video.textTracks.addEventListener('removetrack', onTrackListChange);
            video.textTracks.addEventListener('change', onTrackListChange);
        }
        bindTracks(video);
        // Jellyfin's custom subtitle element is rewritten on every time update; follow it as it changes.
        if (window.MutationObserver) {
            state.observer = new MutationObserver(function (mutations) {
                for (var i = 0; i < mutations.length; i++) {
                    if (!state.overlay || !state.overlay.contains(mutations[i].target)) {
                        render();
                        return;
                    }
                }
            });
            state.observer.observe(parent, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
        }

        ensureSettingsForUser();
        applyAppearance();
    }

    function sameList(a, b) {
        if (!a || !b || a.length !== b.length) {
            return false;
        }
        for (var i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    function renderCues(el, cues, slot) {
        var list = cues ? Array.prototype.slice.call(cues) : [];
        if (sameList(state[slot], list)) {
            return;
        }
        state[slot] = list;
        el.textContent = '';
        list.forEach(function (cue, i) {
            if (i > 0) {
                el.appendChild(document.createElement('br'));
            }
            if (typeof cue.getCueAsHTML === 'function') {
                el.appendChild(cue.getCueAsHTML());
            } else {
                el.appendChild(document.createTextNode(cue.text || ''));
            }
        });
    }

    function mirrorElement(el, source, slot) {
        var visible = isShowingText(source);
        var html = visible ? source.innerHTML : '';
        if (state[slot] === html) {
            return;
        }
        state[slot] = html;
        el.textContent = '';
        if (visible) {
            // Jellyfin has already sanitised this markup; copy its nodes rather than re-parse it.
            Array.prototype.forEach.call(source.childNodes, function (node) {
                el.appendChild(node.cloneNode(true));
            });
        }
    }

    function isShowingText(el) {
        return !!el && !el.classList.contains('hide') && !!el.textContent.trim();
    }

    // Text tracks the browser would draw itself. Jellyfin's own tracks (label "manualTrack")
    // come first so a stray caption track from the stream cannot push them aside.
    function showingTracks(video) {
        var list = [];
        var tracks = video.textTracks || [];
        for (var i = 0; i < tracks.length; i++) {
            var t = tracks[i];
            if (t.mode === 'showing' && (t.kind === 'subtitles' || t.kind === 'captions')) {
                list.push(t);
            }
        }
        var own = list.filter(function (t) { return t.label === 'manualTrack'; });
        var other = list.filter(function (t) { return t.label !== 'manualTrack'; });
        return own.concat(other);
    }

    function customElements(video) {
        var container = (video.parentNode && video.parentNode.querySelector('.videoSubtitles')) || document.querySelector('.videoSubtitles');
        return {
            primary: container ? container.querySelector('.videoSubtitlesInner') : null,
            secondary: container ? container.querySelector('.videoSecondarySubtitlesInner') : null
        };
    }

    function renderSubtitles(video) {
        var custom = customElements(video);
        var tracks = showingTracks(video);
        if (isShowingText(custom.primary) || (!tracks.length && custom.primary)) {
            mirrorElement(state.primaryEl, custom.primary, 'lastPrimary');
        } else {
            renderCues(state.primaryEl, tracks[0] && tracks[0].activeCues, 'lastPrimary');
        }
        if (isShowingText(custom.secondary) || (!tracks.length && custom.secondary)) {
            mirrorElement(state.secondaryEl, custom.secondary, 'lastSecondary');
        } else {
            renderCues(state.secondaryEl, tracks[1] && tracks[1].activeCues, 'lastSecondary');
        }
    }

    function jellyfinHasText(video) {
        var custom = customElements(video);
        if (isShowingText(custom.primary) || isShowingText(custom.secondary)) {
            return true;
        }
        return showingTracks(video).some(function (t) {
            var cues = t.activeCues;
            if (!cues) {
                return false;
            }
            for (var i = 0; i < cues.length; i++) {
                if ((cues[i].text || '').replace(/<[^>]*>/g, '').trim()) {
                    return true;
                }
            }
            return false;
        });
    }

    function overlayVisible() {
        var overlay = state.overlay;
        if (!overlay || !overlay.isConnected) {
            return false;
        }
        var fs = document.fullscreenElement || document.webkitFullscreenElement;
        if (fs && !fs.contains(overlay)) {
            return false;
        }
        var rect = overlay.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) {
            return false;
        }
        var style = window.getComputedStyle(overlay);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
            return false;
        }
        var stack = overlay.firstChild;
        return !stack || parseFloat(window.getComputedStyle(stack).fontSize) >= 6;
    }

    function describe(video) {
        var rect = state.overlay ? state.overlay.getBoundingClientRect() : null;
        return {
            v: window.SubtitleCustomiser && window.SubtitleCustomiser.version,
            ua: (navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/g) || []).join(' '),
            tracks: Array.prototype.map.call(video.textTracks || [], function (t) {
                return t.kind + ':' + t.label + ':' + t.mode + ':' + (t.cues ? t.cues.length : '-') + ':' + (t.activeCues ? t.activeCues.length : '-');
            }),
            custom: !!document.querySelector('.videoSubtitles'),
            overlay: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
            font: state.fontPx,
            lift: state.lift,
            text: (state.primaryEl ? state.primaryEl.textContent : '').slice(0, 40),
            fullscreen: !!(document.fullscreenElement || document.webkitFullscreenElement),
            visible: document.visibilityState,
            settings: settings
        };
    }

    function report(kind, data) {
        if (state.reported[kind]) {
            return;
        }
        state.reported[kind] = true;
        try {
            var api = window.ApiClient;
            var token = api && typeof api.accessToken === 'function' ? api.accessToken() : '';
            if (!apiBase || !token || !window.fetch) {
                return;
            }
            fetch(apiBase + 'ClientLog', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'MediaBrowser Token="' + token + '"'
                },
                body: JSON.stringify({ Kind: kind, Message: JSON.stringify(data).slice(0, 1800) })
            }).catch(function () { /* diagnostics are best effort */ });
        } catch (e) {
            /* ignore */
        }
    }

    function fallBackToJellyfin(reason, extra) {
        if (state.fallback) {
            return;
        }
        state.fallback = true;
        setNativeHidden(false);
        if (state.primaryEl) {
            state.primaryEl.textContent = '';
            state.secondaryEl.textContent = '';
        }
        console.warn(LOG, 'Showing Jellyfin subtitles instead of the overlay:', reason);
        report('fallback-' + reason, Object.assign(describe(state.video), extra || {}));
    }

    // Never leave the viewer without subtitles: if Jellyfin has a line to show and the overlay
    // cannot show it, hand rendering back to Jellyfin for this video.
    function checkOverlay() {
        var video = state.video;
        var expected = jellyfinHasText(video);
        if (expected && !state.reported.status) {
            report('status', describe(video));
        }
        var showing = !!(state.primaryEl.textContent.trim() || state.secondaryEl.textContent.trim());
        var visible = overlayVisible();
        if (expected && (!showing || !visible)) {
            var now = Date.now();
            if (!state.mismatchSince) {
                state.mismatchSince = now;
            } else if (now - state.mismatchSince > 1200) {
                fallBackToJellyfin(visible ? 'blank-overlay' : 'overlay-not-visible');
            }
        } else {
            state.mismatchSince = 0;
        }
        setNativeHidden(!state.fallback && visible);
    }

    function updateLift() {
        var overlay = state.overlay;
        if (!overlay) {
            return;
        }
        var lift = 0;
        var osd = document.querySelector('.videoOsdBottom');
        var hidden = !osd || osd.classList.contains('hide') || osd.classList.contains('videoOsdBottom-hidden');
        if (!hidden && settings.liftWithControls && (settings.position === 'bottom' || settings.position === 'raised')) {
            var controls = osd.querySelector('.osdControls') || osd;
            var top = controls.getBoundingClientRect().top;
            var slider = osd.querySelector('.osdPositionSliderContainer');
            if (slider) {
                top = Math.min(top, slider.getBoundingClientRect().top);
            }
            var rect = overlay.getBoundingClientRect();
            // The overlay already keeps a margin from the bottom; only add what is still covered.
            var base = rect.height * (settings.position === 'raised' ? 0.16 : 0.055);
            lift = Math.max(0, Math.min(Math.round(rect.bottom - top - base + 12), Math.round(rect.height * 0.4)));
        }
        if (lift !== state.lift) {
            state.lift = lift;
            overlay.style.setProperty('--sc-lift', lift + 'px');
        }
    }

    function tick() {
        var video = findVideo();
        if (!video || !video.parentNode || serverDefaults.disabled) {
            stopOverlay();
            return;
        }
        try {
            if (video !== state.video || !state.overlay || state.overlay.parentNode !== video.parentNode) {
                attachVideo(video);
            }
            updateMetrics();
            render();
            updateLift();
            if (!state.fallback) {
                checkOverlay();
            }
        } catch (e) {
            console.error(LOG, e);
            setNativeHidden(false);
        }
    }

    function startOverlay() {
        if (serverDefaults.disabled) {
            return;
        }
        if (!state.timer) {
            state.timer = window.setInterval(tick, 200);
            tick();
        }
    }

    function stopOverlay() {
        if (state.timer) {
            window.clearInterval(state.timer);
            state.timer = 0;
        }
        removeOverlay();
        setNativeHidden(false);
        closePanel();
    }

    /* ------------------------------------------------------------------ */
    /* Panel                                                               */
    /* ------------------------------------------------------------------ */

    var GEAR_SVG = '<svg class="scGear" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.73 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.31-.08.64-.08.94s.02.63.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>';

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined && text !== null) {
            node.textContent = text;
        }
        return node;
    }

    var CODEC_NAMES = {
        subrip: 'SRT',
        srt: 'SRT',
        ass: 'ASS',
        ssa: 'SSA',
        webvtt: 'VTT',
        vtt: 'VTT',
        pgssub: 'PGS',
        pgs: 'PGS',
        dvdsub: 'VobSub',
        vobsub: 'VobSub',
        dvbsub: 'DVB',
        mov_text: 'TX3G',
        ttml: 'TTML'
    };

    var FLAG_WORDS = ['forced', 'sdh', 'cc', 'default', 'external'];

    // Plex style name, for example "English (SRT External)" or "Russian (SRT Forced)".
    function trackLabel(track) {
        if (!track) {
            return 'None';
        }
        var name = track.LocalizedLanguage || track.Language || '';
        var title = (track.Title || '').trim();
        var codec = (track.Codec || '').toLowerCase();
        var flags = [];
        if (codec) {
            flags.push(CODEC_NAMES[codec] || codec.toUpperCase());
        }
        if (track.IsExternal) {
            flags.push('External');
        }
        if (track.IsForced || /^forced$/i.test(title)) {
            flags.push('Forced');
        }
        if (track.IsHearingImpaired || /^(sdh|cc)$/i.test(title)) {
            flags.push('SDH');
        }
        var base = name;
        if (title && FLAG_WORDS.indexOf(title.toLowerCase()) === -1 && title.toLowerCase() !== name.toLowerCase()) {
            base = !name || title.toLowerCase().indexOf(name.toLowerCase()) !== -1 ? title : name + ' ' + title;
        }
        if (!base) {
            return track.DisplayTitle || ('Track ' + track.Index);
        }
        return flags.length ? base + ' (' + flags.join(' ') + ')' : base;
    }

    function formatOffset(ms) {
        var rounded = Math.round(ms);
        return (rounded > 0 ? '+' : '') + rounded + ' ms';
    }

    // Jellyfin applies an offset change after a short debounce and treats a positive value as
    // "earlier". The panel shows Plex's convention (positive = later) and remembers what it set
    // so quick repeated clicks add up correctly.
    var offsetMemo = { player: null, track: null, ms: 0, at: 0 };

    function readOffsetMs(pm, player) {
        var track = attempt(function () { return pm.getSubtitleStreamIndex(player); }, -1);
        if (offsetMemo.player === player && offsetMemo.track === track && Date.now() - offsetMemo.at < 2000) {
            return offsetMemo.ms;
        }
        var seconds = attempt(function () { return pm.getPlayerSubtitleOffset(player); }, 0);
        return Math.round(-(parseFloat(seconds) || 0) * 1000);
    }

    function writeOffsetMs(pm, player, ms) {
        offsetMemo = {
            player: player,
            track: attempt(function () { return pm.getSubtitleStreamIndex(player); }, -1),
            ms: ms,
            at: Date.now()
        };
        pm.setSubtitleOffset(-ms / 1000, player);
    }

    function playerContext() {
        var pm = getPlaybackManager();
        var player = pm ? attempt(function () { return pm.getCurrentPlayer(); }, null) : null;
        return { pm: pm, player: player };
    }

    function buildRows() {
        var ctx = playerContext();
        var pm = ctx.pm;
        var player = ctx.player;
        var rows = [];

        if (pm && player) {
            var tracks = attempt(function () { return pm.subtitleTracks(player); }, []) || [];
            var current = attempt(function () { return pm.getSubtitleStreamIndex(player); }, -1);
            if (current === null || current === undefined) {
                current = -1;
            }
            var trackOptions = [{ id: -1, name: 'None' }].concat(tracks.map(function (t) {
                return { id: t.Index, name: trackLabel(t) };
            }));
            rows.push({
                key: 'track',
                label: 'Subtitles',
                white: true,
                options: trackOptions,
                value: current,
                onSelect: function (index) {
                    if (index !== current) {
                        pm.setSubtitleStreamIndex(index, player);
                    }
                    scheduleRefresh();
                }
            });

            var secondaryTracks = attempt(function () { return pm.secondarySubtitleTracks(player); }, []) || [];
            var secondarySupported = current !== -1 && secondaryTracks.length > 0
                && attempt(function () { return pm.playerHasSecondarySubtitleSupport(player); }, false)
                && attempt(function () { return pm.trackHasSecondarySubtitleSupport(pm.getSubtitleStream(player, current), player); }, false);
            if (secondarySupported) {
                var secondary = attempt(function () { return pm.getSecondarySubtitleStreamIndex(player); }, -1);
                if (secondary === null || secondary === undefined) {
                    secondary = -1;
                }
                rows.push({
                    key: 'secondary',
                    label: 'Secondary Subtitles',
                    white: true,
                    options: [{ id: -1, name: 'None' }].concat(secondaryTracks.map(function (t) {
                        return { id: t.Index, name: trackLabel(t) };
                    })),
                    value: secondary,
                    onSelect: function (index) {
                        if (index !== secondary) {
                            pm.setSecondarySubtitleStreamIndex(index, player);
                        }
                        scheduleRefresh();
                    }
                });
            }
        } else {
            rows.push({
                key: 'track',
                label: 'Subtitles',
                white: true,
                action: 'Choose track',
                onAction: openJellyfinMenu
            });
        }

        rows.push({
            key: 'colour',
            label: 'Subtitle Colour',
            swatches: true,
            options: COLOURS,
            value: settings.colour,
            onSelect: function (id) {
                updateSetting('colour', id);
            }
        });
        rows.push({
            key: 'position',
            label: 'Subtitle Position',
            options: POSITIONS,
            value: settings.position,
            onSelect: function (id) {
                updateSetting('position', id);
            }
        });
        rows.push({
            key: 'size',
            label: 'Subtitle Size',
            options: SIZES,
            value: settings.size,
            onSelect: function (id) {
                updateSetting('size', id);
            }
        });
        rows.push({
            key: 'style',
            label: 'Subtitle Style',
            options: STYLES,
            value: settings.style,
            onSelect: function (id) {
                updateSetting('style', id);
            }
        });

        var offsetAvailable = !!(pm && player)
            && attempt(function () { return pm.supportSubtitleOffset(player); }, false)
            && attempt(function () { return pm.canHandleOffsetOnCurrentSubtitle(player); }, false);
        rows.push({
            key: 'offset',
            label: 'Subtitles Offset',
            offset: true,
            available: offsetAvailable,
            pm: pm,
            player: player
        });

        var note = styleNote(pm, player);
        if (note) {
            rows.push({ key: 'note', note: note });
        }

        return rows;
    }

    var IMAGE_OR_STYLED_CODECS = ['ass', 'ssa', 'pgssub', 'pgs', 'dvdsub', 'vobsub', 'dvbsub'];

    function styleNote(pm, player) {
        if (!pm || !player) {
            return '';
        }
        var index = attempt(function () { return pm.getSubtitleStreamIndex(player); }, -1);
        if (index === null || index === undefined || index === -1) {
            return '';
        }
        var stream = attempt(function () { return pm.getSubtitleStream(player, index); }, null);
        if (!stream) {
            return '';
        }
        if (stream.DeliveryMethod === 'Encode') {
            return 'This track is burned into the video by the server, so colour, position, size and style do not apply.';
        }
        if (IMAGE_OR_STYLED_CODECS.indexOf((stream.Codec || '').toLowerCase()) !== -1) {
            return 'This track (' + (CODEC_NAMES[(stream.Codec || '').toLowerCase()] || stream.Codec) + ') keeps its own styling. Colour, position, size and style apply to text tracks such as SRT and VTT.';
        }
        return '';
    }

    function optionName(row) {
        for (var i = 0; i < row.options.length; i++) {
            if (row.options[i].id === row.value) {
                return row.options[i].name;
            }
        }
        return row.options.length ? row.options[0].name : '';
    }

    function currentOffsetMs(row) {
        return readOffsetMs(row.pm, row.player);
    }

    function renderPanel() {
        if (!panel.box) {
            return;
        }
        closeMenu();
        var body = panel.box.querySelector('.scRows');
        body.textContent = '';
        buildRows().forEach(function (row) {
            if (row.note) {
                body.appendChild(el('div', 'scPanelNote', row.note));
                return;
            }
            var rowEl = el('div', 'scRow');
            rowEl.dataset.key = row.key;
            rowEl.appendChild(el('div', 'scLabel', row.label));
            var cell = el('div', 'scCell');
            var button = el('button', 'scValue' + (row.white ? ' scWhite' : ''));
            button.type = 'button';

            if (row.action) {
                button.appendChild(el('span', 'scValueText', row.action));
                button.appendChild(el('span', 'scCaret'));
                button.addEventListener('click', row.onAction);
            } else if (row.offset) {
                var text = row.available ? formatOffset(currentOffsetMs(row)) : 'Unavailable';
                button.appendChild(el('span', 'scValueText', text));
                if (row.available) {
                    button.insertAdjacentHTML('beforeend', GEAR_SVG);
                    button.addEventListener('click', function () {
                        toggleMenu(rowEl, button, function (menu) {
                            buildOffsetMenu(menu, row, button);
                        });
                    });
                } else {
                    button.disabled = true;
                    button.title = 'Offset works on subtitles rendered by this browser, not on burned-in subtitles';
                }
            } else {
                if (row.swatches) {
                    var swatch = el('span', 'scSwatch');
                    swatch.style.background = pick(COLOURS, row.value).value;
                    button.appendChild(swatch);
                }
                button.appendChild(el('span', 'scValueText', optionName(row)));
                button.appendChild(el('span', 'scCaret'));
                button.addEventListener('click', function () {
                    toggleMenu(rowEl, button, function (menu) {
                        buildOptionMenu(menu, row);
                    });
                });
            }
            button.setAttribute('aria-label', row.label);
            cell.appendChild(button);
            rowEl.appendChild(cell);
            body.appendChild(rowEl);
        });
        positionPanel();
    }

    function buildOptionMenu(menu, row) {
        menu.setAttribute('role', 'listbox');
        row.options.forEach(function (option) {
            var selected = option.id === row.value;
            var item = el('button', 'scOption' + (selected ? ' scSelected' : ''));
            item.type = 'button';
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', selected ? 'true' : 'false');
            item.appendChild(el('span', 'scCheck', selected ? '✓' : ''));
            if (row.swatches) {
                var swatch = el('span', 'scSwatch');
                swatch.style.background = option.value;
                item.appendChild(swatch);
            }
            item.appendChild(el('span', null, option.name));
            item.addEventListener('click', function () {
                row.onSelect(option.id);
                renderPanel();
                var again = panel.box && panel.box.querySelector('.scRow[data-key="' + row.key + '"] .scValue');
                if (again) {
                    again.focus({ preventScroll: true });
                }
            });
            menu.appendChild(item);
        });
    }

    function buildOffsetMenu(menu, row, button) {
        var box = el('div', 'scOffsetBox');
        var value = el('div', 'scOffsetValue', formatOffset(currentOffsetMs(row)));
        var buttons = el('div', 'scOffsetButtons');

        function setOffset(ms) {
            var clamped = Math.max(-30000, Math.min(30000, Math.round(ms)));
            writeOffsetMs(row.pm, row.player, clamped);
            value.textContent = formatOffset(clamped);
            var label = button.querySelector('.scValueText');
            if (label) {
                label.textContent = formatOffset(clamped);
            }
        }

        OFFSET_STEPS.forEach(function (step) {
            var b = el('button', 'scStep', (step > 0 ? '+' : '−') + (Math.abs(step) >= 1000 ? (Math.abs(step) / 1000) + ' s' : Math.abs(step)));
            b.type = 'button';
            b.title = (step > 0 ? 'Delay' : 'Advance') + ' subtitles by ' + Math.abs(step) + ' ms';
            b.addEventListener('click', function () {
                setOffset(currentOffsetMs(row) + step);
            });
            buttons.appendChild(b);
        });

        value.addEventListener('wheel', function (e) {
            e.preventDefault();
            setOffset(currentOffsetMs(row) + (e.deltaY < 0 ? 50 : -50));
        }, { passive: false });

        var reset = el('button', 'scReset', 'Reset');
        reset.type = 'button';
        reset.addEventListener('click', function () {
            setOffset(0);
        });

        box.appendChild(value);
        box.appendChild(buttons);
        box.appendChild(reset);
        box.appendChild(el('div', 'scNote', 'Positive values show subtitles later. Negative values show them earlier.'));
        menu.appendChild(box);
    }

    function closeMenu() {
        if (panel.openMenu) {
            if (panel.openMenu.parentNode) {
                panel.openMenu.parentNode.removeChild(panel.openMenu);
            }
            panel.openMenu = null;
        }
    }

    function toggleMenu(rowEl, button, build) {
        var wasOpenHere = panel.openMenu && panel.openMenu.parentNode === rowEl;
        closeMenu();
        if (wasOpenHere) {
            return;
        }
        var menu = el('div', 'scMenu');
        build(menu);
        rowEl.appendChild(menu);
        panel.openMenu = menu;

        // Place the menu under the value, or above it when there is no room below.
        var rowRect = rowEl.getBoundingClientRect();
        var btnRect = button.getBoundingClientRect();
        menu.style.left = Math.max(0, btnRect.left - rowRect.left - 10) + 'px';
        var menuRect = menu.getBoundingClientRect();
        var spaceBelow = window.innerHeight - btnRect.bottom - 8;
        if (menuRect.height > spaceBelow && btnRect.top > spaceBelow) {
            menu.style.bottom = (rowRect.bottom - btnRect.top + 2) + 'px';
        } else {
            menu.style.top = (btnRect.bottom - rowRect.top + 2) + 'px';
        }
        var overflowRight = menu.getBoundingClientRect().right - (window.innerWidth - 8);
        if (overflowRight > 0) {
            menu.style.left = Math.max(-rowRect.left + 8, parseFloat(menu.style.left) - overflowRight) + 'px';
        }

        var focusTarget = menu.querySelector('.scSelected') || menu.querySelector('button');
        if (focusTarget) {
            focusTarget.focus({ preventScroll: true });
            if (focusTarget.scrollIntoView) {
                focusTarget.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    function positionPanel() {
        if (!panel.box || !panel.anchor) {
            return;
        }
        var box = panel.box;
        var arrow = box.querySelector('.scArrow');
        var a = panel.anchor.getBoundingClientRect();
        var b = box.getBoundingClientRect();
        if (!a.width && !a.height) {
            // The controls are hidden, so the button has no box. Keep the panel where it is, or on
            // first open sit it above the bottom right, where the button normally is.
            if (box.style.top) {
                return;
            }
            a = {
                left: window.innerWidth - 220,
                width: 40,
                top: window.innerHeight - 90,
                bottom: window.innerHeight - 50
            };
        }
        var centre = a.left + a.width / 2;
        var left = Math.round(Math.min(Math.max(centre - b.width / 2, 12), window.innerWidth - b.width - 12));
        var top = Math.round(a.top - b.height - 14);
        var below = false;
        if (top < 8) {
            top = Math.round(a.bottom + 14);
            below = true;
        }
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        box.classList.toggle('scBelow', below);
        arrow.style.left = Math.round(Math.min(Math.max(centre - left, 16), b.width - 16)) + 'px';
    }

    function scheduleRefresh() {
        clearTimeout(panel.refreshTimer);
        // Track changes resolve asynchronously; refresh once the player has switched.
        panel.refreshTimer = setTimeout(function () {
            if (panel.box && !panel.openMenu) {
                renderPanel();
            }
        }, 700);
    }

    function refreshOsdIdleTimer() {
        // The player re-checks for open dialogs on pointerup: with the panel's marker present it
        // cancels the pending fade-out, and once the panel is gone it starts the normal 3 s timer.
        try {
            var type = window.PointerEvent ? 'pointerup' : 'mouseup';
            var Ctor = window.PointerEvent || window.MouseEvent;
            window.dispatchEvent(new Ctor(type, { bubbles: false, pointerType: 'mouse' }));
        } catch (e) {
            /* ignore */
        }
    }

    function openJellyfinMenu() {
        var button = panel.anchor;
        closePanel();
        if (button) {
            panel.bypassClick = true;
            try {
                button.click();
            } finally {
                panel.bypassClick = false;
            }
        }
    }

    function openPanel(anchor) {
        closePanel();
        ensureSettingsForUser();
        panel.anchor = anchor;
        anchor.classList.add('scPanelOpen');

        var root = el('div', 'scPanelRoot');
        // Jellyfin keeps the player controls on screen while a dialog is open; this hidden
        // marker uses that rule so the controls do not fade out under the panel.
        var marker = el('div', 'dialogContainer');
        marker.style.setProperty('display', 'none', 'important');
        marker.appendChild(el('div', 'dialog opened'));
        root.appendChild(marker);

        var box = el('div', 'scPanel');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', 'Subtitle settings');
        box.appendChild(el('div', 'scRows'));
        box.appendChild(el('div', 'scArrow'));
        root.appendChild(box);
        document.body.appendChild(root);

        panel.root = root;
        panel.box = box;
        renderPanel();
        refreshOsdIdleTimer();
        window.requestAnimationFrame(function () {
            if (panel.box === box) {
                box.classList.add('scOpen');
                var first = box.querySelector('.scValue:not([disabled])');
                if (first) {
                    first.focus({ preventScroll: true });
                }
            }
        });
    }

    function closePanel() {
        clearTimeout(panel.refreshTimer);
        closeMenu();
        if (panel.anchor) {
            panel.anchor.classList.remove('scPanelOpen');
        }
        var wasOpen = !!panel.root;
        if (panel.root && panel.root.parentNode) {
            panel.root.parentNode.removeChild(panel.root);
        }
        panel.root = null;
        panel.box = null;
        panel.anchor = null;
        if (wasOpen) {
            refreshOsdIdleTimer();
        }
    }

    function isPanelOpen() {
        return !!panel.box;
    }

    /* ------------------------------------------------------------------ */
    /* Event wiring                                                        */
    /* ------------------------------------------------------------------ */

    function onClickCapture(e) {
        if (panel.swallowClickUntil) {
            var swallow = Date.now() < panel.swallowClickUntil;
            panel.swallowClickUntil = 0;
            if (swallow) {
                // This click only dismissed the panel; do not let it also pause the video.
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
        }
        if (panel.bypassClick || serverDefaults.disabled) {
            return;
        }
        var target = e.target;
        var button = target && target.closest ? target.closest('.btnSubtitles') : null;
        if (!button || !button.closest('.videoOsdBottom')) {
            return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (isPanelOpen() && panel.anchor === button) {
            closePanel();
        } else {
            openPanel(button);
        }
    }

    function onPointerDownCapture(e) {
        if (!isPanelOpen()) {
            return;
        }
        var target = e.target;
        if (panel.root.contains(target)) {
            if (panel.openMenu && !panel.openMenu.contains(target) && !(target.closest && target.closest('.scValue'))) {
                closeMenu();
            }
            return;
        }
        if (panel.anchor && panel.anchor.contains(target)) {
            return;
        }
        var onControls = target && target.closest && target.closest('.videoOsdBottom, .osdHeader, .skinHeader, header');
        closePanel();
        // A press on the video itself just closes the panel. The player toggles pause on
        // pointerdown, so stop it here. Presses on other player controls still do their job.
        if (!onControls) {
            e.stopImmediatePropagation();
            panel.swallowClickUntil = Date.now() + 800;
        }
    }

    function moveFocus(direction) {
        var scope = panel.openMenu || panel.box;
        var items = Array.prototype.slice.call(scope.querySelectorAll('button:not([disabled])'));
        if (!items.length) {
            return;
        }
        var index = items.indexOf(document.activeElement);
        index = index === -1 ? 0 : (index + direction + items.length) % items.length;
        items[index].focus({ preventScroll: true });
        if (items[index].scrollIntoView) {
            items[index].scrollIntoView({ block: 'nearest' });
        }
    }

    function onKeyDownCapture(e) {
        if (!isPanelOpen()) {
            return;
        }
        var key = e.key;
        if (key === 'Escape' || key === 'Backspace' || key === 'GoBack' || key === 'BrowserBack') {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (panel.openMenu) {
                var row = panel.openMenu.parentNode;
                closeMenu();
                var value = row && row.querySelector('.scValue');
                if (value) {
                    value.focus({ preventScroll: true });
                }
            } else {
                var anchor = panel.anchor;
                closePanel();
                if (anchor) {
                    anchor.focus({ preventScroll: true });
                }
            }
            return;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            e.preventDefault();
            e.stopImmediatePropagation();
            moveFocus(key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (key === 'Enter' || key === ' ' || key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Tab') {
            // Keep the player's own shortcuts (play/pause, seek) from firing behind the panel.
            e.stopImmediatePropagation();
        }
    }

    function onMediaEvent(e) {
        var target = e.target;
        if (target && target.tagName === 'VIDEO' && target.classList.contains('htmlvideoplayer')) {
            startOverlay();
        }
    }

    function onResize() {
        if (isPanelOpen()) {
            closeMenu();
            positionPanel();
        }
        state.lift = -1;
        state.fontPx = 0;
    }

    function init() {
        injectStyles();
        loadSettings();
        document.addEventListener('click', onClickCapture, true);
        document.addEventListener('pointerdown', onPointerDownCapture, true);
        window.addEventListener('keydown', onKeyDownCapture, true);
        window.addEventListener('resize', onResize);
        ['loadedmetadata', 'play', 'playing', 'timeupdate'].forEach(function (name) {
            document.addEventListener(name, onMediaEvent, true);
        });
        // Catch a player that was already running before this script loaded.
        if (findVideo()) {
            startOverlay();
        }
        fetchServerDefaults().then(function () {
            loadSettings();
            applyAppearance();
            if (serverDefaults.disabled) {
                stopOverlay();
            }
        });
    }

    window.SubtitleCustomiser = {
        version: '1.0.0',
        get settings() {
            return Object.assign({}, settings);
        },
        open: function () {
            var button = document.querySelector('.videoOsdBottom .btnSubtitles');
            if (button) {
                openPanel(button);
            }
        },
        close: closePanel,
        reset: function () {
            try {
                window.localStorage.removeItem(storageKey());
            } catch (e) {
                /* ignore */
            }
            loadSettings();
            applyAppearance();
            if (isPanelOpen()) {
                renderPanel();
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
