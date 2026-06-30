// CoListen - Spicetify Extension
// Sync architecture:
//   - Clock sync: guests run a Cristian/NTP-style handshake against the host
//     to get a shared time reference (typically <5ms error).
//   - State broadcast: host emits state (uri, position, isPlaying, sentAt)
//     on track change, play/pause, manual triggers, and as a slow heartbeat.
//   - Local prediction: guests extrapolate position locally from the last
//     known host state and only seek() if drift exceeds a threshold,
//     eliminating audio glitches from constant seeking.

(function coListen() {
    if (!Spicetify.Player || !Spicetify.Platform || !Spicetify.React || !Spicetify.ReactDOM) {
        setTimeout(coListen, 300);
        return;
    }
    main();
})();

function main() {
    const { React, ReactDOM } = Spicetify;
    const { useState, useEffect, useRef } = React;

    const STORAGE_KEY = "coListen:username";
    const POS_KEY = "coListen:panelPos";

    function loadPanelPos() {
        try {
            const p = JSON.parse(Spicetify.LocalStorage.get(POS_KEY) || "null");
            return p && typeof p.x === "number" && typeof p.y === "number" ? p : null;
        } catch { return null; }
    }

    function savePanelPos(x, y) {
        try { Spicetify.LocalStorage.set(POS_KEY, JSON.stringify({ x, y })); } catch {}
    }

    // ─── Drag hook ────────────────────────────────────────────────────────────
    // Why a callback ref instead of useRef + useEffect([]):
    //   The Panel renders one of three different <div>s depending on screen
    //   (home / host-wait / session). When screen changes, React mounts a NEW
    //   DOM node — but useEffect with [] does NOT re-run, so the closure keeps
    //   pointing at the OLD node which is no longer in the document. That's
    //   why drag "only worked the first time": after the first screen change
    //   or major re-render that swapped the panel root, the listeners were
    //   wired to a ghost node.
    //
    // A callback ref is invoked by React every time the underlying DOM node
    // changes (mount, unmount, swap). We use it to (re)attach listeners to
    // whatever node is currently live, and to clean up on the previous one.
    function useDrag() {
        // Persist mutable state across renders without triggering re-renders.
        const stateRef = useRef({
            panelEl: null,
            header: null,
            dragging: false,
            startX: 0, startY: 0, origLeft: 0, origTop: 0,
            // Stable handler references so add/remove pair correctly.
            onMouseDown: null,
            onMouseMove: null,
            onMouseUp: null,
        });

        // Initialize handlers once. They reference stateRef, which is stable,
        // so the closures stay valid forever.
        if (!stateRef.current.onMouseDown) {
            const st = stateRef.current;

            st.onMouseDown = (e) => {
                if (!st.panelEl) return;
                if (e.target.closest(".lt-x")) return; // don't drag from the X
                st.dragging = true;
                const rect = st.panelEl.getBoundingClientRect();
                st.startX = e.clientX; st.startY = e.clientY;
                st.origLeft = rect.left; st.origTop = rect.top;
                st.panelEl.style.right = "auto";
                st.panelEl.style.left  = st.origLeft + "px";
                st.panelEl.style.top   = st.origTop  + "px";
                e.preventDefault();
            };

            st.onMouseMove = (e) => {
                if (!st.dragging || !st.panelEl) return;
                const dx = e.clientX - st.startX;
                const dy = e.clientY - st.startY;
                const newX = Math.max(0, Math.min(window.innerWidth  - st.panelEl.offsetWidth,  st.origLeft + dx));
                const newY = Math.max(0, Math.min(window.innerHeight - st.panelEl.offsetHeight, st.origTop  + dy));
                st.panelEl.style.left = newX + "px";
                st.panelEl.style.top  = newY + "px";
            };

            st.onMouseUp = () => {
                if (!st.dragging || !st.panelEl) return;
                st.dragging = false;
                savePanelPos(parseInt(st.panelEl.style.left), parseInt(st.panelEl.style.top));
            };
        }

        // Document-level listeners: attach once, never remove during the
        // component's lifetime. Cleaning them up is handled when the Panel
        // unmounts via a separate effect below.
        useEffect(() => {
            const st = stateRef.current;
            document.addEventListener("mousemove", st.onMouseMove);
            document.addEventListener("mouseup",   st.onMouseUp);
            return () => {
                document.removeEventListener("mousemove", st.onMouseMove);
                document.removeEventListener("mouseup",   st.onMouseUp);
                // Detach from any header still referenced
                if (st.header) {
                    st.header.removeEventListener("mousedown", st.onMouseDown);
                    st.header = null;
                }
                st.panelEl = null;
            };
        }, []);

        // Callback ref: React calls this with the new DOM node on every
        // mount AND every time the rendered root changes (e.g., switching
        // between "home" / "host-wait" / "session" screens).
        return (node) => {
            const st = stateRef.current;

            // Same node as before → nothing to do.
            if (node === st.panelEl) return;

            // Detach mousedown from the old header, if any.
            if (st.header) {
                st.header.removeEventListener("mousedown", st.onMouseDown);
                st.header = null;
            }

            st.panelEl = node;
            if (!node) return; // unmounting

            // Apply the saved position to the new panel node.
            const saved = loadPanelPos();
            if (saved) {
                node.style.right = "auto";
                node.style.left  = saved.x + "px";
                node.style.top   = saved.y + "px";
            }

            // Attach mousedown to this panel's header.
            const header = node.querySelector(".lt-hd");
            if (header) {
                header.addEventListener("mousedown", st.onMouseDown);
                st.header = header;
            }
        };
    }

    const SERVER_URL_KEY = "coListen:serverUrl";

    function getServerUrl() {
        const saved = Spicetify.LocalStorage.get(SERVER_URL_KEY);
        return saved && saved.trim() ? saved.trim() : null;
    }
    function setServerUrl(url) {
        Spicetify.LocalStorage.set(SERVER_URL_KEY, url.trim());
        Spicetify.showNotification("✅ Server URL saved!");
    }
    const HEARTBEAT_MS        = 4000;   // slow state heartbeat from host
    const PREDICT_CHECK_MS    = 2000;   // how often guests check drift
    const SEEK_THRESHOLD_MS   = 500;    // only seek if drift exceeds this
    const TIMESYNC_SAMPLES    = 8;      // samples per clock-sync pass
    const TIMESYNC_GAP_MS     = 200;    // delay between samples
    const TIMESYNC_REFRESH_MS = 60000;  // re-sync clock every 60s

    const session = {
        ws: null,
        amHost: false,
        active: false,
        inSession: false,
        code: "",
        myName: "",
        sid: "",
        members: [],
        myLatency: null,
        pingMap: {},
        heartbeatTimer: null,
        lastSharedState: null,
        reconnectTimer: null,
        reconnectCount: 0,
        intentionalClose: false,

        // clock synchronization (guest side)
        clockOffset: 0,              // hostNow ≈ Date.now() + clockOffset
        clockOffsetConfidence: 0,    // RTT of the chosen best sample
        timesyncSamples: [],
        timesyncTimer: null,
        timesyncInProgress: false,

        // prediction (guest side)
        lastHostState: null,
        predictTimer: null,

        // pause handling (guest side): ignore drift correction briefly after
        // a play/pause transition so stale "position" from the host doesn't
        // undo the pause by seeking backwards.
        lastPlayStateChange: 0,

        // queue dedup (all sides): URIs we've already processed for the
        // shared queue, so a host echo doesn't cause the guest to re-add
        // tracks it already has. Cleared on leave.
        processedQueueUris: new Set(),
    };

    let uiCallback = null;
    function notifyUI() { uiCallback?.(); }

    const log = (...a) => console.log("[CL]", ...a);
    const err = (...a) => console.error("[CL]", ...a);

    function getSpotifyUsername() {
        try {
            return Spicetify.Platform?.UserAPI?._product_state?.pairs?.name
                || Spicetify.Platform?.UserAPI?.getUser?.()?.displayName
                || Spicetify.LocalStorage.get("spicetify_local_storage_user_display_name")
                || "Me";
        } catch { return "Me"; }
    }
    const getUsername = () => Spicetify.LocalStorage.get(STORAGE_KEY) || getSpotifyUsername();
    const saveUsername = (n) => Spicetify.LocalStorage.set(STORAGE_KEY, n);

    function makeCode() {
        const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join("");
    }

    function send(msg) {
        if (session.ws?.readyState === WebSocket.OPEN) {
            const tagged = { ...msg, _sid: session.sid };
            try { session.ws.send(JSON.stringify(tagged)); } catch(e) { err("send:", e); }
        }
    }

    // hostNow(): current time in the host's clock frame.
    // Host itself has offset 0; guests compute offset via the handshake.
    function hostNow() { return Date.now() + session.clockOffset; }

    // CANONICAL source of "is the player currently playing?".
    // Spicetify's API actually exposes `data.isPaused` (boolean, inverted),
    // NOT a `Spicetify.Player.isPlaying` property. Previous code treated
    // it as a boolean property, which is always `undefined` → coerced to
    // `false`, which silently broke every play/pause comparison across
    // the network. That's why pause "didn't propagate" — every peer always
    // thought every other peer was paused, so no edge transition ever fired.
    function isPlayingNow() {
        try {
            const p = Spicetify.Player;
            // 1) Modern path: data.isPaused
            if (p?.data && typeof p.data.isPaused === "boolean") return !p.data.isPaused;
            // 2) Legacy method form: isPlaying()
            if (typeof p?.isPlaying === "function") return !!p.isPlaying();
            // 3) Legacy property form (older Spicetify builds)
            if (typeof p?.isPlaying === "boolean") return p.isPlaying;
        } catch {}
        return false;
    }

    function getState() {
        try {
            const d = Spicetify.Player.data;
            if (!d?.item) return null;
            return {
                uri: d.item.uri,
                name: d.item.name || "",
                position: Spicetify.Player.getProgress(),
                isPlaying: !!isPlayingNow(),
                sentAt: Date.now(), // host clock (host always runs with offset=0)
            };
        } catch { return null; }
    }

    // Build a full queue snapshot to send to a newly-joined guest. Only the
    // host calls this (guests never broadcast queue state).
    function getQueueSnapshot() {
        try {
            const nextTracks = Spicetify.Queue?.nextTracks || [];
            const out = [];
            for (let i = 0; i < Math.min(nextTracks.length, 20); i++) {
                const uri = nextTracks[i]?.uri || nextTracks[i]?.track?.uri;
                if (uri) out.push(uri);
            }
            return out;
        } catch { return []; }
    }

    async function playUri(uri, pos) {
        const fns = [
            () => Spicetify.Platform.PlayerAPI.play({ uri }, {}, { positionMs: pos }),
            () => Spicetify.CosmosAsync.put("sp://player/v2/main", { playing_uri: uri, position: pos }),
        ];
        for (const fn of fns) {
            try { await fn(); return true; } catch {}
        }
        return false;
    }

    // Full apply: used on track change, first join, and manual sync.
    async function applyHostState(s) {
        if (!s?.uri) return;
        try {
            const elapsed = Math.max(0, Math.min(hostNow() - s.sentAt, 5000));
            const target = Math.floor((s.position || 0) + (s.isPlaying ? elapsed : 0));

            const cur = Spicetify.Player.data?.item;
            if (!cur || cur.uri !== s.uri) {
                await playUri(s.uri, target);
                await new Promise(r => setTimeout(r, 600));
                if (s.isPlaying && !isPlayingNow()) Spicetify.Player.play();
                if (!s.isPlaying && isPlayingNow()) Spicetify.Player.pause();
                return;
            }
            Spicetify.Player.seek(target);
            setTimeout(() => {
                if (s.isPlaying && !isPlayingNow()) Spicetify.Player.play();
                if (!s.isPlaying && isPlayingNow()) Spicetify.Player.pause();
            }, 200);
        } catch(e) {}
    }

    // Add a single URI to the local queue, skipping anything we've already
    // processed in this session. Used by both guests (receiving queue_add
    // events from host) and by the host itself (for local tracking).
    async function addToLocalQueueIfNew(uri) {
        if (!uri) return;
        if (session.processedQueueUris.has(uri)) {
            log(`queue dedup: skipping ${uri} (already added)`);
            return;
        }
        session.processedQueueUris.add(uri);
        try {
            await Spicetify.addToQueue([{ uri }]);
            log(`queue: added ${uri}`);
        } catch(e) {
            err("addToQueue failed:", e);
            // If it failed, remove from set so it can be retried later
            session.processedQueueUris.delete(uri);
        }
    }

    // Apply a full queue snapshot. Used when:
    //   - A guest first joins (initial catch-up)
    //   - The host changes track via prev/next (reset & resync)
    // Clears the guest's current queue first so stale items from before the
    // context change don't fight with newly-added ones.
    async function applyQueueSnapshot(queueUris) {
        // Try to clear existing queue first (different Spicetify builds expose
        // this in different places).
        try {
            if (typeof Spicetify.Platform?.PlayerAPI?.clearQueue === "function") {
                await Spicetify.Platform.PlayerAPI.clearQueue();
            }
        } catch(e) { err("clearQueue failed (ignoring):", e); }

        if (!queueUris?.length) return;
        await new Promise(r => setTimeout(r, 800)); // let the track start first
        for (const uri of queueUris) {
            await addToLocalQueueIfNew(uri);
            await new Promise(r => setTimeout(r, 250));
        }
    }

    // Extrapolate host position in "now" time, using the shared clock.
    function predictedHostPosition(s) {
        if (!s) return 0;
        const elapsed = Math.max(0, hostNow() - s.sentAt);
        return (s.position || 0) + (s.isPlaying ? elapsed : 0);
    }

    // Conditional correction: only seek if drift is perceptually significant.
    function checkDriftAndCorrect() {
        if (!session.active || session.amHost) return;
        const s = session.lastHostState;
        if (!s?.uri) return;

        // Grace period after any play/pause transition: don't let stale
        // position data yank the guest back to where the host WAS just before
        // they paused. This is the "pause goes back in time" bug.
        const GRACE_AFTER_PAUSE_MS = 1500;
        if (Date.now() - session.lastPlayStateChange < GRACE_AFTER_PAUSE_MS) {
            return;
        }

        try {
            const cur = Spicetify.Player.data?.item;
            if (!cur || cur.uri !== s.uri) return; // track mismatch handled by full apply

            if (s.isPlaying && !isPlayingNow()) {
                Spicetify.Player.play();
                return;
            }
            if (!s.isPlaying && isPlayingNow()) {
                Spicetify.Player.pause();
                return;
            }
            if (!s.isPlaying) return;

            const expected = predictedHostPosition(s);
            const actual   = Spicetify.Player.getProgress();
            const drift    = actual - expected;

            if (Math.abs(drift) > SEEK_THRESHOLD_MS) {
                log(`drift ${drift}ms > threshold → correcting`);
                Spicetify.Player.seek(Math.floor(expected));
            }
        } catch(e) {}
    }

    function startPredictLoop() {
        stopPredictLoop();
        session.predictTimer = setInterval(checkDriftAndCorrect, PREDICT_CHECK_MS);
    }
    function stopPredictLoop() {
        if (session.predictTimer) clearInterval(session.predictTimer);
        session.predictTimer = null;
    }

    // Clock sync (Cristian's algorithm).
    // guest: send t0 → host stamps t1 on receive → guest records t3 on receive.
    // RTT = t3 - t0, offset = t1 - (t0 + RTT/2).
    // Multiple samples; keep the one with smallest RTT (least jitter).
    function runTimesync() {
        if (session.amHost || !session.active || session.timesyncInProgress) return;
        session.timesyncInProgress = true;
        session.timesyncSamples = [];

        let sampleIdx = 0;
        function sendSample() {
            if (sampleIdx >= TIMESYNC_SAMPLES) { finishTimesync(); return; }
            sampleIdx++;
            const t0 = Date.now();
            const id = "ts_" + t0 + "_" + Math.random().toString(36).slice(2, 6);
            session.pingMap[id] = (t1) => {
                const t3 = Date.now();
                const rtt = t3 - t0;
                const offset = t1 - (t0 + rtt / 2);
                session.timesyncSamples.push({ rtt, offset });
            };
            send({ type: "ts_req", id, t0 });
            setTimeout(sendSample, TIMESYNC_GAP_MS);
        }

        function finishTimesync() {
            session.timesyncInProgress = false;
            if (session.timesyncSamples.length === 0) return;
            session.timesyncSamples.sort((a, b) => a.rtt - b.rtt);
            const best = session.timesyncSamples[0];
            session.clockOffset = Math.round(best.offset);
            session.clockOffsetConfidence = best.rtt;
            session.myLatency = Math.round(best.rtt);
            log(`clock sync: offset=${session.clockOffset}ms, rtt=${best.rtt}ms (${session.timesyncSamples.length} samples)`);
            notifyUI();
        }

        sendSample();
    }

    function startPeriodicTimesync() {
        stopPeriodicTimesync();
        runTimesync();
        session.timesyncTimer = setInterval(runTimesync, TIMESYNC_REFRESH_MS);
    }
    function stopPeriodicTimesync() {
        if (session.timesyncTimer) clearInterval(session.timesyncTimer);
        session.timesyncTimer = null;
    }

    function onMessage(msg) {
        if (!msg?.type || (msg._sid && msg._sid === session.sid)) return;

        // Time-sync handshake
        if (msg.type === "ts_req" && session.amHost) {
            send({ type: "ts_resp", id: msg.id, t0: msg.t0, t1: Date.now() });
            return;
        }
        if (msg.type === "ts_resp") {
            const cb = session.pingMap[msg.id];
            if (cb) { cb(msg.t1); delete session.pingMap[msg.id]; }
            return;
        }

        // Legacy ping/pong kept for compatibility (unused now that timesync gives us latency)
        if (msg.type === "ping") { send({ type: "pong", id: msg.id }); return; }
        if (msg.type === "pong") {
            const resolve = session.pingMap[msg.id];
            if (resolve) { resolve(Date.now() - msg.id); delete session.pingMap[msg.id]; }
            return;
        }

        if (msg.type === "state") {
            const s = msg.state;
            if (!s) return;
            const prev = session.lastHostState;
            session.lastHostState = s;
            session.lastSharedState = s;

            // Track change → full apply
            if (!prev || prev.uri !== s.uri) {
                log(`track change from host: ${s.name}`);
                applyHostState(s);
                return;
            }

            // Same track → mirror play/pause edge, otherwise let predict loop handle drift
            if (prev.isPlaying !== s.isPlaying) {
                // Record when we saw the transition so the drift loop doesn't
                // immediately undo it with stale position data.
                session.lastPlayStateChange = Date.now();
                if (s.isPlaying && !isPlayingNow()) Spicetify.Player.play();
                if (!s.isPlaying && isPlayingNow()) Spicetify.Player.pause();
            }
            return;
        }

        // Shared queue: a single new track added (relayed by host)
        if (msg.type === "queue_add") {
            if (!session.amHost && msg.uri) {
                addToLocalQueueIfNew(msg.uri);
            }
            return;
        }

        // Shared queue: full snapshot. Sent in two cases:
        //   1) A fresh guest joins → catches them up on the cumulative queue.
        //   2) The host changes track (including via prev/next) → resets the
        //      shared queue state because Spotify's playback context just
        //      changed, invalidating whatever queue items were pending.
        // On receive, we RESET the dedup set before re-applying so the new
        // snapshot is treated as the ground truth, not diffed against the old.
        if (msg.type === "queue_snapshot") {
            if (!session.amHost && Array.isArray(msg.uris)) {
                session.processedQueueUris = new Set();
                applyQueueSnapshot(msg.uris);
            }
            return;
        }

        if (msg.type === "cmd" && session.amHost) {
            const cmd = msg.cmd;
            if (cmd.action === "request_state") {
                const s = getState();
                if (s) send({ type: "state", state: s });
                return;
            }
            try {
                if (cmd.action === "play")  Spicetify.Player.play();
                if (cmd.action === "pause") Spicetify.Player.pause();
                if (cmd.action === "next")  Spicetify.Player.next();
                if (cmd.action === "prev")  Spicetify.Player.back();
                if (cmd.action === "addToQueue" && cmd.uri) {
                    // Host adds to its own queue (deduped) and broadcasts to peers
                    addToLocalQueueIfNew(cmd.uri).then(() => {
                        send({ type: "queue_add", uri: cmd.uri });
                    });
                }
            } catch(e) {}
            setTimeout(() => { const s = getState(); if (s) send({ type: "state", state: s }); }, 300);
            return;
        }

        if (msg.type === "joined") {
            if (!session.members.find(m => m.name === msg.user)) session.members.push({ name: msg.user });
            Spicetify.showNotification(`🎵 ${msg.user} joined`);
            if (session.amHost) {
                // New guest: send them current player state AND a queue snapshot
                // so they're caught up with everything already shared.
                setTimeout(() => {
                    const s = getState();
                    if (s) send({ type: "state", state: s });
                    const snap = getQueueSnapshot();
                    if (snap.length) send({ type: "queue_snapshot", uris: snap });
                }, 200);
            }
            notifyUI();
            return;
        }
        if (msg.type === "left") {
            session.members = session.members.filter(m => m.name !== msg.user);
            Spicetify.showNotification(`👋 ${msg.user} left`);
            notifyUI();
            return;
        }
        if (msg.type === "members") {
            session.members = msg.members.map(name => ({ name }));
            notifyUI();
            return;
        }
    }

    Spicetify.Player.addEventListener("songchange", () => {
        if (!session.active) return;
        setTimeout(() => {
            const s = getState();
            if (s) {
                log("local songchange → broadcast");
                send({ type: "state", state: s });
            }
            // Only the host authorities the shared queue. On any track change
            // (including prev/next), Spotify's playback context has shifted,
            // so we re-broadcast a fresh queue snapshot that becomes the new
            // ground truth for every guest. This is what fixes the "prev
            // breaks the queue" bug — guests reset and re-add rather than
            // accumulating stale items against a moved context.
            if (session.amHost) {
                // Reset the host's own dedup set too, so future adds during
                // this new context work correctly.
                session.processedQueueUris = new Set();
                const snap = getQueueSnapshot();
                send({ type: "queue_snapshot", uris: snap });
                log(`broadcast fresh queue snapshot (${snap.length} tracks)`);
            }
        }, 300);
    });

    Spicetify.Player.addEventListener("onplaypause", () => {
        if (!session.active || !session.amHost) return;
        // Mark locally too — prevents the host's own drift checker (unused
        // today but harmless for consistency) from fighting with the pause.
        session.lastPlayStateChange = Date.now();
        // Slightly longer delay so data.isPaused and getProgress()
        // have both settled before we snapshot and broadcast. Otherwise the
        // guest may receive a state where isPlaying=false but position is
        // the position-we-WERE-at, causing a visible rewind.
        setTimeout(() => {
            const s = getState();
            if (s) {
                log(`local play/pause → broadcast (playing=${s.isPlaying})`);
                send({ type: "state", state: s });
            }
        }, 250);
    });

    function startHeartbeat() {
        stopHeartbeat();
        session.heartbeatTimer = setInterval(() => {
            if (!session.active || !session.amHost) return;
            const s = getState();
            if (s) send({ type: "state", state: s });
        }, HEARTBEAT_MS);
    }

    function stopHeartbeat() {
        if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
        session.heartbeatTimer = null;
    }

    function connectToRoom(code, username, asHost, onProgress) {
        const serverUrl = getServerUrl();
        if (!serverUrl) { onProgress({ type: "error", reason: "no-url" }); return; }
        const url = `${serverUrl}/room/${code}?name=${encodeURIComponent(username)}`;
        const ws = new WebSocket(url);
        session.ws = ws;

        const timeout = setTimeout(() => {
            if (!session.active) { onProgress({ type: "timeout" }); cleanup(); }
        }, 15000);

        ws.onopen = () => {
            clearTimeout(timeout);
            session.active = true;
            session.amHost = asHost;
            session.code = code;
            session.myName = username;
            session.sid = Math.random().toString(36).slice(2);
            session.reconnectCount = 0;
            session.intentionalClose = false;

            // Host is the reference clock → offset 0.
            // Guest resets and re-syncs on every fresh connection.
            session.clockOffset = 0;
            session.clockOffsetConfidence = 0;
            session.lastHostState = null;
            session.lastPlayStateChange = 0;
            session.processedQueueUris = new Set();

            if (!session.members.find(m => m.name === username)) session.members.push({ name: username });

            if (asHost) {
                startHeartbeat();
            } else {
                session.inSession = true;
                startPeriodicTimesync();
                startPredictLoop();
            }
            onProgress({ type: "connected" });
            notifyUI();
        };

        ws.onmessage = (ev) => {
            try { onMessage(JSON.parse(ev.data)); } catch(e) { err("parse error", e); }
        };

        ws.onclose = () => {
            if (session.intentionalClose) return;
            if (session.active) {
                const savedCode    = session.code;
                const savedName    = session.myName;
                const savedAsHost  = session.amHost;
                const savedMembers = [...session.members];
                const reconnectNum = session.reconnectCount + 1;
                if (reconnectNum > 5) {
                    cleanup();
                    renderUI();
                    Spicetify.showNotification("Session lost — too many reconnect attempts");
                    return;
                }
                session.reconnectCount = reconnectNum;
                Spicetify.showNotification(`⚠️ Reconnecting (${reconnectNum}/5)…`);
                session.reconnectTimer = setTimeout(() => {
                    session.members = savedMembers;
                    connectToRoom(savedCode, savedName, savedAsHost, (ev) => {
                        if (ev.type === "connected") {
                            Spicetify.showNotification("✅ Reconnected!");
                            notifyUI();
                        }
                    });
                }, 2000);
            }
        };

        ws.onerror = () => {};
    }

    function cleanup() {
        stopHeartbeat();
        stopPredictLoop();
        stopPeriodicTimesync();
        if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }
        session.active        = false;
        session.amHost        = false;
        session.inSession     = false;
        session.myLatency     = null;
        session.pingMap       = {};
        session.members       = [];
        session.code          = "";
        session.myName        = "";
        session.sid           = "";
        session.lastSharedState     = null;
        session.lastHostState       = null;
        session.reconnectCount      = 0;
        session.clockOffset         = 0;
        session.clockOffsetConfidence = 0;
        session.timesyncSamples     = [];
        session.timesyncInProgress  = false;
        session.lastPlayStateChange = 0;
        session.processedQueueUris  = new Set();
        if (session.ws) {
            try { session.ws.close(); } catch {}
            session.ws = null;
        }
        notifyUI();
    }

    function addUriToCoListenQueue(uri) {
        if (!session.active) {
            Spicetify.showNotification("⚠️ Join a CoListen session first!");
            return;
        }
        if (session.amHost) {
            // Dedup locally, then broadcast the single-track event.
            // NO LONGER sends full state — the old code did that, which
            // combined with the broken queue diff caused duplicate adds
            // when other guests received it.
            addToLocalQueueIfNew(uri).then(() => {
                send({ type: "queue_add", uri });
                Spicetify.showNotification("✅ Added to shared queue");
            }).catch(() => {
                Spicetify.showNotification("❌ Couldn't add to queue");
            });
        } else {
            send({ type: "cmd", cmd: { action: "addToQueue", uri } });
            Spicetify.showNotification("📤 Sent to host queue");
        }
    }

    const contextMenuItem = new Spicetify.ContextMenu.Item(
        "Add to CoListen Queue",
        (uris) => {
            for (const uri of uris) {
                if (uri.startsWith("spotify:track:")) addUriToCoListenQueue(uri);
            }
        },
        (uris) => uris.some(uri => uri.startsWith("spotify:track:")),
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M3 6h15v2H3V6zm0 5h15v2H3v-2zm0 5h9v2H3v-2zm16.5-1l-4.5 4.5V15h-1v-4h1v1.5l4.5-4.5 1.5 1.5-1.5 1.5z"/></svg>`
    );
    contextMenuItem.register();

    if (!document.getElementById("lt-css")) {
        const el = document.createElement("style");
        el.id = "lt-css";
        el.textContent = `
            @keyframes lt-in   { from{opacity:0;transform:translateY(-5px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)} }
            @keyframes lt-spin { to{transform:rotate(360deg)} }
            #lt-root * { box-sizing:border-box; }
            #lt-root .lt-panel { position:fixed;top:56px;right:16px;z-index:9999;width:300px;background:#111;border:1px solid #1e1e1e;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.8);color:#fff;font-family:'Circular','Helvetica Neue',Arial,sans-serif;animation:lt-in .15s cubic-bezier(.16,1,.3,1);overflow:hidden;user-select:none; }
            #lt-root .lt-hd { cursor:grab;display:flex;align-items:center;justify-content:space-between;padding:13px 15px 11px;border-bottom:1px solid #1a1a1a; }
            #lt-root .lt-hd:active { cursor:grabbing; }
            #lt-root .lt-hl { display:flex;align-items:center;gap:7px; }
            #lt-root .lt-dot { width:6px;height:6px;border-radius:50%;background:#1ed760;box-shadow:0 0 5px #1ed76077; }
            #lt-root .lt-dot.off { background:#252525;box-shadow:none; }
            #lt-root .lt-ttl { font-size:12px;font-weight:600;color:#ccc; }
            #lt-root .lt-x { background:none;border:none;color:#3a3a3a;cursor:pointer;font-size:16px;line-height:1;padding:0 2px;transition:color .1s; }
            #lt-root .lt-x:hover { color:#888; }
            #lt-root .lt-bd { padding:13px 15px 15px; }
            #lt-root .lt-nr { display:flex;align-items:center;gap:8px;margin-bottom:13px; }
            #lt-root .lt-av { width:28px;height:28px;border-radius:50%;background:#1ed760;color:#000;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0;text-transform:uppercase; }
            #lt-root .lt-ni { flex:1;background:transparent;border:none;border-bottom:1px solid #1e1e1e;color:#aaa;font-size:13px;padding:2px 0;outline:none;font-family:inherit;transition:border-color .15s; }
            #lt-root .lt-ni:focus { border-bottom-color:#1ed760;color:#fff; }
            #lt-root .lt-ni::placeholder { color:#303030; }
            #lt-root .lt-btn { display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:10px 14px;border-radius:9px;border:none;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;transition:opacity .12s,transform .1s,background .12s; }
            #lt-root .lt-btn:active { transform:scale(.97); }
            #lt-root .lt-g  { background:#1ed760;color:#000; }
            #lt-root .lt-g:hover { background:#21e865; }
            #lt-root .lt-gh { background:transparent;color:#484848;border:1px solid #1e1e1e; }
            #lt-root .lt-gh:hover { color:#777;border-color:#2a2a2a; }
            #lt-root .lt-sy { background:transparent;color:#1ed760;border:1px solid #1ed76033; }
            #lt-root .lt-sy:hover { background:#1ed76010; }
            #lt-root .lt-lv { background:transparent;color:#c0392b;border:1px solid #1e1e1e; }
            #lt-root .lt-lv:hover { background:#c0392b0d;border-color:#c0392b33; }
            #lt-root .lt-dim { opacity:.25;pointer-events:none; }
            #lt-root .lt-st { display:flex;flex-direction:column;gap:7px; }
            #lt-root .lt-dv { border:none;border-top:1px solid #1a1a1a;margin:12px 0; }
            #lt-root .lt-lb { font-size:10px;font-weight:600;color:#333;text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px; }
            #lt-root .lt-cb { background:#0c0c0c;border:1px solid #1c1c1c;border-radius:10px;padding:16px;text-align:center;margin-bottom:10px; }
            #lt-root .lt-cv { font-size:32px;font-weight:800;letter-spacing:8px;color:#1ed760;font-family:'Courier New',monospace;display:block;margin-bottom:8px; }
            #lt-root .lt-cp { background:#1ed76015;border:1px solid #1ed76022;color:#1ed760;border-radius:6px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .12s; }
            #lt-root .lt-cp:hover { background:#1ed76025; }
            #lt-root .lt-ci { width:100%;background:#0c0c0c;border:1px solid #1c1c1c;border-radius:9px;padding:10px 13px;color:#aaa;font-size:22px;font-weight:700;font-family:'Courier New',monospace;letter-spacing:5px;outline:none;text-align:center;transition:border-color .15s;margin-bottom:8px;text-transform:uppercase; }
            #lt-root .lt-ci:focus { border-color:#2a2a2a;color:#fff; }
            #lt-root .lt-ci::placeholder { font-size:13px;letter-spacing:1px;color:#252525;font-weight:400; }
            #lt-root .lt-er { font-size:11px;color:#e74c3c;margin-bottom:8px; }
            #lt-root .lt-sp { display:inline-block;width:11px;height:11px;flex-shrink:0;border:1.5px solid #1e1e1e;border-top-color:#1ed760;border-radius:50%;animation:lt-spin .6s linear infinite; }
            #lt-root .lt-ml { background:#0c0c0c;border:1px solid #1a1a1a;border-radius:8px;padding:8px 11px;margin-bottom:10px; }
            #lt-root .lt-mr { display:flex;align-items:center;gap:7px;font-size:12px;color:#555;padding:3px 0; }
            #lt-root .lt-md { width:5px;height:5px;border-radius:50%;background:#1ed760;flex-shrink:0; }
            #lt-root .lt-ms { font-size:10px;margin-left:auto;font-weight:600; }
            #lt-root .lt-np { background:#0c0c0c;border:1px solid #1a1a1a;border-radius:8px;padding:9px 11px;margin-bottom:10px;display:flex;align-items:center;gap:8px; }
            #lt-root .lt-npd { width:6px;height:6px;border-radius:50%;background:#1ed760;box-shadow:0 0 5px #1ed76077;flex-shrink:0; }
            #lt-root .lt-npt { font-size:11px;color:#555;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis; }
            #lt-root .lt-bar { position:fixed;bottom:90px;right:16px;z-index:9999;background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:8px 14px;display:flex;align-items:center;gap:8px;font-family:'Circular','Helvetica Neue',Arial,sans-serif;font-size:12px;color:#555;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.6);animation:lt-in .2s ease; }
            #lt-root .lt-bar:hover { background:#161616; }
            #lt-root .lt-bd2 { width:6px;height:6px;border-radius:50%;background:#1ed760;box-shadow:0 0 5px #1ed76077;flex-shrink:0; }
            #lt-root .lt-ht { font-size:13px;color:#555;margin-bottom:10px; }
            #lt-root .lt-ht strong { color:#888; }
            #lt-root .lt-ld { display:flex;align-items:center;gap:8px;font-size:12px;color:#444;margin-bottom:8px; }
            #lt-root .lt-ic { display:flex;align-items:center;justify-content:space-between;background:#0c0c0c;border:1px solid #1c1c1c;border-radius:8px;padding:8px 12px;margin-bottom:10px; }
            #lt-root .lt-iv { font-size:18px;font-weight:800;letter-spacing:5px;color:#1ed760;font-family:'Courier New',monospace; }
        `;
        document.head.appendChild(el);
    }

    function Panel({ onClose }) {
        const panelRef = useDrag(); // callback ref — handles mount, unmount, screen swaps

        const getScreen = () => {
            if (!session.active && !session.ws) return "home";
            if (session.amHost && !session.inSession) return "host-wait";
            return "session";
        };

        const [, setTick]           = useState(0);
        const [username, setUsername] = useState(getUsername());
        const [paste, setPaste]     = useState("");
        const [error, setError]     = useState("");
        const [loading, setLoading] = useState(false);
        const [track, setTrack]     = useState("");
        const [syncing, setSyncing] = useState(false);
        const [serverUrl, setServerUrlState] = useState(getServerUrl() || "");
        const [configuringUrl, setConfiguringUrl] = useState(false);

        const screen = getScreen();
        const e = React.createElement;

        useEffect(() => {
            uiCallback = () => setTick(t => t + 1);
            return () => { uiCallback = null; };
        }, []);

        useEffect(() => {
            const t = setInterval(() => {
                const d = Spicetify.Player.data;
                if (d?.item?.name) setTrack(d.item.name);
            }, 1000);
            return () => clearInterval(t);
        }, []);

        function onName(ev) { setUsername(ev.target.value); saveUsername(ev.target.value); }
        function av() { return (username || "?")[0].toUpperCase(); }
        function copy(t) { navigator.clipboard.writeText(t); Spicetify.showNotification("📋 Copied!"); }

        function pingColor(ms) {
            if (ms == null) return "#555";
            if (ms < 100) return "#1ed760";
            if (ms < 300) return "#f0a500";
            return "#e74c3c";
        }

        function saveUrl() {
            const trimmed = serverUrl.trim().replace(/\/$/, "");
            if (!trimmed.startsWith("wss://") && !trimmed.startsWith("ws://")) {
                setError("URL must start with wss:// or ws://"); return;
            }
            setServerUrl(trimmed);
            setServerUrlState(trimmed);
            setConfiguringUrl(false);
            setError("");
        }

        async function create() {
            if (!getServerUrl()) { setConfiguringUrl(true); return; }
            setError(""); setLoading(true);
            const code = makeCode();
            connectToRoom(code, username, true, ev => {
                if (ev.type === "connected") { setLoading(false); setTick(t => t+1); }
                if (ev.type === "error" || ev.type === "no-url" || ev.type === "timeout") { setError("Connection failed — check your server URL"); setLoading(false); }
            });
        }

        async function join() {
            if (!getServerUrl()) { setConfiguringUrl(true); return; }
            const code = paste.trim().toUpperCase();
            if (code.length !== 6) { setError("Enter a 6-character code."); return; }
            setError(""); setLoading(true);
            connectToRoom(code, username, false, ev => {
                if (ev.type === "connected") { setLoading(false); setTick(t => t+1); }
                if (ev.type === "error" || ev.type === "no-url" || ev.type === "timeout") { setError("Connection failed — check your server URL"); setLoading(false); }
            });
        }

        function leave() {
            session.intentionalClose = true;
            send({ type: "left", user: username });
            cleanup();
            setPaste(""); setError(""); setLoading(false);
        }

        async function manualSync() {
            if (!session.lastHostState) return;
            setSyncing(true);
            send({ type: "cmd", cmd: { action: "request_state" } });
            // give host ~400ms to answer with fresh state, then apply
            setTimeout(async () => {
                await applyHostState(session.lastHostState);
                setSyncing(false);
            }, 400);
        }

        function cmd(action) {
            if (session.amHost) {
                try {
                    if (action === "play")  Spicetify.Player.play();
                    if (action === "pause") Spicetify.Player.pause();
                    if (action === "next")  Spicetify.Player.next();
                    if (action === "prev")  Spicetify.Player.back();
                } catch(e) {}
            } else {
                send({ type: "cmd", cmd: { action } });
            }
        }

        function Hdr({ dot = false }) {
            return e("div", { className: "lt-hd" },
                e("div", { className: "lt-hl" },
                    e("div", { className: `lt-dot ${dot ? "" : "off"}` }),
                    e("span", { className: "lt-ttl" }, "CoListen")
                ),
                e("button", { className: "lt-x", onClick: onClose }, "×")
            );
        }

        if (configuringUrl) return e("div", { className: "lt-panel", ref: panelRef },
            e(Hdr, {}),
            e("div", { className: "lt-bd" },
                e("div", { className: "lt-lb" }, "Worker URL"),
                e("div", { className: "lt-ht" }, "Paste your Cloudflare Worker WebSocket URL."),
                e("input", {
                    className: "lt-ni",
                    placeholder: "wss://your-worker.workers.dev",
                    value: serverUrl,
                    onChange: ev => { setServerUrlState(ev.target.value); setError(""); },
                    style: { fontSize: "13px", marginBottom: "10px", width: "100%" }
                }),
                error && e("div", { className: "lt-er" }, error),
                e("div", { className: "lt-st" },
                    e("button", { className: "lt-btn lt-g", onClick: saveUrl }, "Save"),
                    e("button", { className: "lt-btn lt-gh", onClick: () => { setConfiguringUrl(false); setError(""); } }, "Cancel")
                )
            )
        );

        if (screen === "home") return e("div", { className: "lt-panel", ref: panelRef },
            e(Hdr, {}),
            e("div", { className: "lt-bd" },
                e("div", { className: "lt-nr" },
                    e("div", { className: "lt-av" }, av()),
                    e("input", { className: "lt-ni", value: username, placeholder: "Your name", onChange: onName })
                ),
                e("div", { className: "lt-st" },
                    e("button", {
                        className: `lt-btn lt-g ${loading ? "lt-dim" : ""}`,
                        onClick: create
                    }, loading ? e(React.Fragment, null, e("span", { className: "lt-sp" }), "Setting up…") : "Create session")
                ),
                e("hr", { className: "lt-dv" }),
                e("div", { className: "lt-lb" }, "Join a session"),
                e("input", {
                    className: "lt-ci",
                    placeholder: "Enter code",
                    value: paste,
                    maxLength: 6,
                    onChange: ev => { setPaste(ev.target.value.toUpperCase()); setError(""); }
                }),
                error && e("div", { className: "lt-er" }, error),
                e("button", {
                    className: `lt-btn lt-gh ${(!paste.trim() || loading) ? "lt-dim" : ""}`,
                    onClick: join
                }, loading ? e(React.Fragment, null, e("span", { className: "lt-sp" }), "Connecting…") : "Join session"),
                e("hr", { className: "lt-dv" }),
                e("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
                    e("span", { style: { fontSize: 10, color: "#2a2a2a" } }, getServerUrl() ? "✓ Server configured" : "⚠ No server set"),
                    e("button", {
                        style: { background: "none", border: "none", color: "#333", fontSize: 10, cursor: "pointer", padding: 0 },
                        onClick: () => { setConfiguringUrl(true); setError(""); }
                    }, getServerUrl() ? "Change" : "Set up server →")
                )
            )
        );

        if (screen === "host-wait") return e("div", { className: "lt-panel", ref: panelRef },
            e(Hdr, {}),
            e("div", { className: "lt-bd" },
                e("div", { className: "lt-ht" },
                    e("strong", null, "Share this code "),
                    "with your friends."
                ),
                e("div", { className: "lt-lb" }, "Room code"),
                e("div", { className: "lt-cb" },
                    e("span", { className: "lt-cv" }, session.code),
                    e("button", { className: "lt-cp", onClick: () => copy(session.code) }, "Copy")
                ),
                session.members.length > 1
                ? e("div", { className: "lt-st", style: { marginTop: 4 } },
                    e("button", { className: "lt-btn lt-g", onClick: () => { session.inSession = true; setTick(t => t + 1); } }, "Go to session →"),
                    e("button", { className: "lt-btn lt-gh", onClick: leave }, "Cancel")
                  )
                : e(React.Fragment, null,
                    e("div", { className: "lt-ld" }, e("span", { className: "lt-sp" }), "Waiting for friends…"),
                    e("button", { className: "lt-btn lt-gh", style: { marginTop: 4 }, onClick: leave }, "Cancel")
                  )
            )
        );

        if (screen === "session") return e("div", { className: "lt-panel", ref: panelRef },
            e(Hdr, { dot: true }),
            e("div", { className: "lt-bd" },
                track && e("div", { className: "lt-np" },
                    e("div", { className: "lt-npd" }),
                    e("div", { className: "lt-npt" }, track)
                ),
                e("div", { className: "lt-ic" },
                    e("span", { className: "lt-iv" }, session.code),
                    e("button", { className: "lt-cp", onClick: () => copy(session.code) }, "Copy")
                ),
                session.members.length > 0 && e("div", { className: "lt-ml" },
                    session.members.map(m => {
                        const isMe = m.name === username;
                        const ms = isMe ? session.myLatency : null;
                        return e("div", { key: m.name, className: "lt-mr" },
                            e("div", { className: "lt-md" }), m.name,
                            ms != null && e("span", { className: "lt-ms", style: { color: pingColor(ms) } }, ms + " ms"),
                            isMe && e("span", { style: { marginLeft: "auto", fontSize: 10, color: "#1ed760" } }, session.amHost ? "host" : "you")
                        );
                    })
                ),
                e("div", { className: "lt-st" },
                    e("div", { style: { display: "flex", gap: 6 } },
                        [["⏮","prev"],["⏸","pause"],["▶","play"],["⏭","next"]].map(([icon, action]) =>
                            e("button", {
                                key: action,
                                style: { flex: 1, padding: "9px 0", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 8, color: "#888", cursor: "pointer", fontSize: 15 },
                                onClick: () => cmd(action)
                            }, icon)
                        )
                    ),
                    !session.amHost && e("button", {
                        className: `lt-btn lt-sy ${syncing ? "lt-dim" : ""}`,
                        onClick: manualSync
                    }, syncing ? e(React.Fragment, null, e("span", { className: "lt-sp" }), "Syncing…") : "⟳ Sync now"),
                    e("button", { className: "lt-btn lt-lv", onClick: leave }, "Leave session")
                )
            )
        );

        return null;
    }

    function Bar({ onClick }) {
        const e = React.createElement;
        const trackName = Spicetify.Player.data?.item?.name || "";
        return e("div", { className: "lt-bar", onClick },
            e("div", { className: "lt-bd2" }),
            trackName ? `🎵 ${trackName.slice(0, 28)}${trackName.length > 28 ? "…" : ""}` : "Session active"
        );
    }

    let container = null;
    let isOpen = false;

    function renderUI() {
        if (!container) {
            container = document.createElement("div");
            container.id = "lt-root";
            document.body.appendChild(container);
        }
        if (isOpen) {
            ReactDOM.render(React.createElement(Panel, { onClose: () => { isOpen = false; renderUI(); } }), container);
        } else if (session.active || session.ws) {
            ReactDOM.render(React.createElement(Bar, { onClick: () => { isOpen = true; renderUI(); } }), container);
        } else {
            ReactDOM.unmountComponentAtNode(container);
        }
    }

    function openPanel() {
        isOpen = !isOpen;
        renderUI();
    }

    new Spicetify.Topbar.Button("CoListen",
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 3C7.03 3 3 7.03 3 12v5a3 3 0 003 3h1a1 1 0 001-1v-5a1 1 0 00-1-1H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-2a1 1 0 00-1 1v5a1 1 0 001 1h1a3 3 0 003-3v-5c0-4.97-4.03-9-9-9z"/></svg>`,
        openPanel,
        false
    );

    log("✅ CoListen loaded (NTP time-sync + drift prediction)");
}