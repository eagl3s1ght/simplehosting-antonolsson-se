<script lang="ts">
  import { onMount } from 'svelte';
  import { joinGame, listenPlayers as origListenPlayers, listenFlows as origListenFlows, updateAngle, updateLayer, updateColor, incrementScore, decrementScore, spawnFlow, recordCatch, recordEvilHit, pruneOldFlows, fetchHighscores, updateFlowLayer, cleanupPlayerMeta, setPlayerActive, setLastSeen, setSessionEvilHits, incrementSessionEvilHits, cleanupInactivePlayers, auth, db, ROOM } from '$lib/firebase.js';
  import { ref, set, goOffline } from 'firebase/database';
  import { browser, dev } from '$app/environment';

  // Debug-only imports (conditional, tree-shaken in production)
  let removeAllFlows: any, removeLayer5Flows: any, analyzeDbSize: any;
  if (dev) {
    import('$lib/firebase.js').then(m => {
      removeAllFlows = m.removeAllFlows;
      removeLayer5Flows = m.removeLayer5Flows;
      analyzeDbSize = m.analyzeDbSize;
    });
  }

  async function debugRemoveAllFlows() {
    if (!dev || !removeAllFlows) return;
    const removed = await removeAllFlows();
    console.log(`Removed ${removed} flows from DB.`);
  }
  async function debugRemoveLayer5() {
    if (!dev || !removeLayer5Flows) return;
    const removed = await removeLayer5Flows();
    console.log(`Removed ${removed} layer-5 flows from DB.`);
  }

  // Types (lightweight to silence TS diagnostics)
  type Player = { id: string; name: string; angle: number; score: number; layer?: number; colorIndex?: number; createdAt?: number; active?: boolean; lastSeen?: number; meta?: any; evilHits?: number; isBot?: boolean; createdBy?: string };
  type Flow = { key?: string; angle: number; spawnTime: number; scored?: boolean; isEvil?: boolean; layer?: number };

  // Download stats
  let dbBytesDownloaded = 0;
  let dbBytesLastSecond = 0;
  let dbBytesPerSecond = 0;
  let dbBytesHistory: number[] = [];
  let dbBytesLastMinute = 0;
  setInterval(() => {
    dbBytesPerSecond = dbBytesDownloaded - dbBytesLastSecond;
    dbBytesLastSecond = dbBytesDownloaded;
    dbBytesHistory.push(dbBytesPerSecond);
    if (dbBytesHistory.length > 60) dbBytesHistory.shift();
    dbBytesLastMinute = dbBytesHistory.reduce((a, b) => a + b, 0);
  }, 1000);

  function countBytes(obj: any) {
    return obj ? new TextEncoder().encode(JSON.stringify(obj)).length : 0;
  }
  function listenPlayers(cb: (players: Player[]) => void) {
    return origListenPlayers((data: any) => {
      dbBytesDownloaded += countBytes(data);
      const playersObj = data || {};
      cb(Object.values(playersObj));
    });
  }
  function listenFlows(cb: (flows: Flow[]) => void) {
    // Request only the newest 100 flows to reduce bandwidth
    return origListenFlows((data: any) => {
      dbBytesDownloaded += countBytes(data);
      const flowsObj = data || {};
      const arr: Flow[] = Object.entries(flowsObj).map(([k, v]) => ({ key: k, ...(v as any) }));
      cb(arr);
    }, 100);
  }

  // Game state
  let canvas!: HTMLCanvasElement;
  let ctx!: CanvasRenderingContext2D;
  let players: Player[] = [];
  let flows: Flow[] = [];
  // Local cache to retain flows even if they fall out of the DB query window
  const flowCache: Map<string, Flow> = new Map();
  let myPlayer: { playerId: string; playerData: Player } | null = null;
  let showInactiveDialog = false; // true when player marked inactive
  let keys: Record<string, boolean> = {};
  const PIPE_WIDTH = 0.4;
  
  // Layer system - dynamic layers (1 per active player, max 12)
  const MAX_LAYERS = 12;
  const INNER_R = 60;
  const OUTER_R = 380;
  const TOTAL_LAYER_AREA = OUTER_R - INNER_R;
  // Fixed spacing as if all MAX_LAYERS exist - this keeps players at consistent positions
  const FIXED_LAYER_SPACING = TOTAL_LAYER_AREA / MAX_LAYERS;
  
  // Manual layer override for debug purposes (null = auto based on active players)
  let manualLayerCount: number | null = null;
  
  // Reactive: number of layers = number of active players (capped at 12), or manual override
  // Layers are numbered from outside-in: layer 11 = outermost (where nests are), layer 0 = innermost (closest to sun)
  $: numLayers = manualLayerCount !== null 
    ? Math.min(MAX_LAYERS, Math.max(1, manualLayerCount))
    : Math.min(MAX_LAYERS, Math.max(1, activeUsedColorsAll.size));
  $: layerSpacing = TOTAL_LAYER_AREA / numLayers;
  $: layerRadii = Array.from({ length: numLayers }, (_, i) => INNER_R + layerSpacing * (i + 1));
  
  // Generate layer colors - fixed colors for each absolute layer index (0-11)
  // Layer 0 (innermost, closest to sun): brightest gray
  // Layer 11 (outermost, in space): darkest gray
  function getLayerColor(layerIndex: number): string {
    const innerRGB = 58;   // #3A3A3A - brighter (near sun, layer 0)
    const outerRGB = 26;   // #1A1A1A - darker (outer space, layer 11)
    
    // t goes from 0 (layer 0, innermost) to 1 (layer 11, outermost)
    const t = layerIndex / (MAX_LAYERS - 1);
    // Interpolate: start bright (inner) and go darker (outer)
    const gray = Math.round(innerRGB - t * (innerRGB - outerRGB));
    const hex = gray.toString(16).padStart(2, '0');
    return `#${hex}${hex}${hex}`;
  }
  
  // Generate colors for currently visible layers
  $: layerColors = Array.from({ length: numLayers }, (_, i) => {
    const layerIndex = (MAX_LAYERS - numLayers) + i;
    return getLayerColor(layerIndex);
  });
  
  const CANVAS_SIZE = (OUTER_R + 30) * 2; // Add 30px padding
  const CENTER_X = CANVAS_SIZE / 2;
  const CENTER_Y = CANVAS_SIZE / 2;
  let baseFlowDuration = 8000; // Base ms for a flow to reach canvas edge
  let flowSpeedSliderValue = 1; // raw UI value
  let difficultySpeedMultiplier = 1; // cumulative difficulty scaling
  function effectiveFlowSpeedMultiplier() { return flowSpeedSliderValue * difficultySpeedMultiplier; }
  function currentFlowDuration() { return baseFlowDuration / effectiveFlowSpeedMultiplier(); }
  const TRAVEL_PIXELS = (CANVAS_SIZE / 2) - INNER_R; // same as MAX_FLOW_RADIUS - INNER_R
  function currentAvgSpeedPxPerSec() { return (TRAVEL_PIXELS / currentFlowDuration()) * 1000; }
  const MAX_FLOW_RADIUS = CANVAS_SIZE / 2; // Allow flows to reach canvas edge
  // Collision tolerance for radius matching the layer ring (in pixels)
  const COLLISION_RADIUS_TOLERANCE = 4;
  let debugSpeed = 0.005;
  let myAngle = 0;
  let myLayer = 0; // Current layer (0-11) - target layer
  let myLayerVisual = 0; // Visual layer position (smoothly interpolated)
  let myColorIndex: number | null = null;
  let mySpeedBoost = 0; // +1% per caught flow (additive)
  
  // Starfield background
  type Star = { x: number; y: number; size: number; opacity: number; twinkleSpeed: number; twinklePhase: number };
  let stars: Star[] = [];
  const STAR_COUNT = 150;
  
  // Bot player state
  // Bot players
  let botPlayers: Map<string, { playerId: string; angle: number; layer: number; colorIndex: number | null; speedBoost: number; lastUpdateTime?: number; lastPresenceTime?: number }> = new Map();
  let botActive = false;
  
  // Debug panel state (only used in dev builds)
  let debugOpen = dev ? false : undefined as any;
  // Lifetime highscores panel toggle (similar to debug panel toggle); default hidden
  let hsOpen = false;
  // Highscores state
  type Highscore = { id:string; totalCatches?:number; evilHits?:number; name?:string; colorIndex?:number; country?: string; lastUpdated?:number };
  let highscores: Highscore[] = [];
  let hsLastLoaded = 0; // timestamp
  const HS_RELOAD_COOLDOWN = 5 * 60 * 1000; // 5 minutes
  let flagIcons: any = null; // Will hold all flag components
  let uniqGen: any = null; let dictAdj: any = null; let dictAnimals: any = null;

  // Scoreboard data for HTML overlay (with flags)
  type ScoreboardEntry = { id: string; name: string; score: number; hits: number; country: string | null; color: string; active: boolean; };
  let scoreboardList: ScoreboardEntry[] = [];
  
  // Nest render logging flag (log only once)
  let nestRenderLogged = false;

  // Idle timer state
  const IDLE_TIMEOUT_MS = 60_000; // 1 minute
  let idleEnabled = true; // debug toggle; when false, idle never triggers (will be loaded from storage)
  // When true, we mark player inactive and stop the game when the window/tab becomes inactive (blur/hidden)
  // This should be user-toggleable via the debug menu and persist across browser sessions.
  let markInactiveOnWindowInactive = true;
  // Auto-spawn bot on join (persisted)
  let autoSpawnBotOnJoin = false;
  let isIdle = false; // set to true once we go idle and stop DB activity
  let lastMovementTime = Date.now();
  let idleRemainingMs = IDLE_TIMEOUT_MS;

  // FPS tracking
  let lastFrameTime = Date.now();
  let frameCount = 0;
  let lastFpsUpdateTime = Date.now();
  let currentFps = 60;
  let fpsHistory: number[] = [];
  let averageFps = 60;
  let uiNow = Date.now();
  let uiTickInterval: any;
  // Browser activity (focus/visibility) tracking
  let windowActive = true; // focused & visible
  let hidden = false;
  let storageLoaded = false; // prevent reactive save from running before initial load

  // Fixed palette with animal-themed names
  const PLAYER_COLORS = [
  { name: 'Night Violet', hex: '#5E35B1', startAngle: (210 * Math.PI) / 180 },       // Deep Purple - 210°
  { name: 'Mystic Purple', hex: '#7E57C2', startAngle: (240 * Math.PI) / 180 },      // Medium Purple - 240°
  { name: 'Indigo', hex: '#3949AB', startAngle: (270 * Math.PI) / 180 },             // Indigo Blue - 270°
  { name: 'Sky Blue', hex: '#1E88E5', startAngle: (300 * Math.PI) / 180 },           // Bright Blue - 300°
  { name: 'Teal', hex: '#00897B', startAngle: (330 * Math.PI) / 180 },               // Teal - 330°
  { name: 'Forest Green', hex: '#43A047', startAngle: 0 },                            // Forest Green - 0°
  { name: 'Lime Green', hex: '#7CB342', startAngle: (30 * Math.PI) / 180 },          // Lime Green - 30°
  { name: 'Meadow', hex: '#D4E157', startAngle: (60 * Math.PI) / 180 },              // Yellow-Green - 60°
  { name: 'Golden Yellow', hex: '#FFCA28', startAngle: (90 * Math.PI) / 180 },       // Golden Yellow - 90°
  { name: 'Solar Orange', hex: '#FB8C00', startAngle: (120 * Math.PI) / 180 },       // Orange - 120°
  { name: 'Ember Orange', hex: '#E64A19', startAngle: (150 * Math.PI) / 180 },       // Red-Orange - 150°
  { name: 'Crimson Red', hex: '#D32F2F', startAngle: (180 * Math.PI) / 180 }         // Red - 180°
  ];

  // Reactive: compute used colors by other players
  function isPlayerActiveNow(pl: any, nowTs: number = Date.now()): boolean {
    if (!pl) return false;
    const activeFlag = pl.active !== false;
    const ls = pl.lastSeen;
    const fresh = typeof ls === 'number' ? (nowTs - ls) < 30000 : true;
    return activeFlag && fresh;
  }
  // Only consider ACTIVE players when marking colors as taken (exclude my own to allow switching)
  $: usedColors = new Set<number>(
    players
      .filter(pl => pl && (!myPlayer || pl.id !== myPlayer.playerId) && pl.colorIndex != null && isPlayerActiveNow(pl))
      .map(pl => pl.colorIndex as number)
  );
  // Active-used colors including me (for display of total taken slots)
  $: activeUsedColorsAll = new Set<number>(
    players
      .filter(pl => pl && pl.colorIndex != null && isPlayerActiveNow(pl))
      .map(pl => pl.colorIndex as number)
  );

  // Map color index -> array of ACTIVE players who use it (including me if active)
  $: colorOwners = (() => {
    const m = new Map<number, Player[]>();
    for (const pl of players) {
      const idx = pl?.colorIndex;
      if (idx == null) continue;
      if (!isPlayerActiveNow(pl)) continue;
      const arr = m.get(idx) ?? [];
      arr.push(pl);
      m.set(idx, arr);
    }
    return m;
  })();

  function ownerLabelFor(idx: number): string | null {
    const owners = colorOwners.get(idx);
    if (!owners || owners.length === 0) return null;
    const labels = owners.map(pl => {
      if (myPlayer && pl.id === myPlayer.playerId) return 'you';
      // Prefer player.name; fallback to a pretty name instead of raw UUID snippet
      return (pl.name && pl.name.trim()) ? pl.name.trim() : prettyName(pl.id);
    });
    return labels.join(', ');
  }

  // Country code (AA) -> flag emoji (fallback to white flag)
  function countryCodeToFlagEmoji(cc: string | null | undefined): string {
    if (!cc || cc.length !== 2) return '🏳️';
    const base = 0x1f1e6;
    const a = cc[0].toUpperCase().charCodeAt(0) - 65;
    const b = cc[1].toUpperCase().charCodeAt(0) - 65;
    if (a < 0 || a > 25 || b < 0 || b > 25) return '🏳️';
    return String.fromCodePoint(base + a) + String.fromCodePoint(base + b);
  }

  // Get flag component for country code (e.g., "SE" -> Se component)
  function getFlagComponent(cc: string | null | undefined): any {
    if (!flagIcons || !cc || cc.length !== 2) return null;
    // Convert country code to component name (e.g., "SE" -> "Se", "US" -> "Us")
    const componentName = cc.charAt(0).toUpperCase() + cc.charAt(1).toLowerCase();
    return flagIcons[componentName] || null;
  }

  function colorForPlayer(p: Player): string {
    const idx = (myPlayer && p.id === myPlayer.playerId) ? (myColorIndex ?? p.colorIndex) : p.colorIndex;
    if (idx != null && PLAYER_COLORS[idx]) return PLAYER_COLORS[idx].hex;
    return '#888';
  }

  // Calculate the center angle of a nest (where player should spawn)
  function getNestAngle(colorIndex: number): number {
    const nestAngularWidth = (Math.PI * 2) / PLAYER_COLORS.length;
    const nestStartAngle = (colorIndex * nestAngularWidth) - (Math.PI * 2 / 4);
    const centerAngle = nestStartAngle + nestAngularWidth / 2;
    const normalized = normalizeAngle(centerAngle);
    return normalized;
  }

  // Queue state for players when all colors are taken
  let isQueued = false;      // true if we are waiting for a free color slot
  let canClaimSpot = false;  // true if a color became available while queued
  
  // Game cleanup reference (populated in main onMount)
  let stopGameFn: (() => void) | null = null;
  
  function claimFreeColor() {
    if (!myPlayer) return;
    // Discover used colors
    const used = new Set<number>();
    players.forEach(pl => { if (pl?.colorIndex != null) used.add(pl.colorIndex as number); });
    if (used.size >= PLAYER_COLORS.length) return; // still full
    // Find first free color
    let chosen: number | null = null;
    for (let i = 0; i < PLAYER_COLORS.length; i++) { if (!used.has(i)) { chosen = i; break; } }
    if (chosen == null) return;
    myColorIndex = chosen;
    updateColor(myPlayer.playerId, chosen);
    // Set starting angle at nest center (where player should spawn)
    const nestAngle = getNestAngle(chosen);
    myAngle = nestAngle;
    updateAngle(myPlayer.playerId, nestAngle);
    // Set player to outermost layer (11) where nest is
    myLayer = MAX_LAYERS - 1;
    myLayerVisual = myLayer; // Initialize visual layer to match
    updateLayer(myPlayer.playerId, myLayer);
    try { setPlayerActive(myPlayer.playerId, true); } catch {}
    try { setSessionEvilHits(myPlayer.playerId, 0); } catch {} // Reset session evil hits
    try { set(ref(db, `${ROOM}/players/${myPlayer.playerId}/queued`), null); } catch {}
    isQueued = false;
    canClaimSpot = false;
    console.log('[PLAYER SPAWN - claimFreeColor] colorIndex:', chosen, 
                'playerAngle:', (myAngle * 180 / Math.PI).toFixed(2) + '°',
                'layer:', myLayer);
  }

  // Persist debug panel state in session storage
  onMount(() => {
    if (browser) {
      if (dev) {
        const saved = sessionStorage.getItem('debugOpen');
        if (saved === '1') debugOpen = true; // restore open state
      }
  const hsToggle = sessionStorage.getItem('hsOpen');
  if (hsToggle === '1') hsOpen = true;
      const hsSaved = sessionStorage.getItem('hsLastLoaded');
      if (hsSaved) hsLastLoaded = parseInt(hsSaved) || 0;
      const idleSaved = localStorage.getItem('idleEnabled');
      if (idleSaved !== null) {
        idleEnabled = idleSaved === '1';
        console.log('[Idle] Loaded setting from storage:', idleEnabled);
      }
      const blurSaved = localStorage.getItem('markInactiveOnWindowInactive');
      if (blurSaved !== null) {
        markInactiveOnWindowInactive = blurSaved === '1';
        console.log('[Blur/Hidden] Loaded setting from storage:', markInactiveOnWindowInactive);
      }
      const autoSpawnBotSaved = localStorage.getItem('autoSpawnBotOnJoin');
      if (autoSpawnBotSaved !== null) {
        autoSpawnBotOnJoin = autoSpawnBotSaved === '1';
        console.log('[Bot] Auto-spawn on join loaded from storage:', autoSpawnBotOnJoin);
      }
      storageLoaded = true;
    }
    // Try to load external libs dynamically (non-blocking)
    import('unique-names-generator').then((m) => { uniqGen = m.uniqueNamesGenerator; dictAdj = m.adjectives; dictAnimals = m.animals; }).catch(() => {});
    import('svelte-flag-icons').then((m) => { flagIcons = m; }).catch(() => {});
    // Load highscores once on page load
    loadHighscoresOnce();

    // UI tick for idle countdown
    uiTickInterval = setInterval(() => {
      uiNow = Date.now();
      if (idleEnabled && !isIdle) {
        const rem = IDLE_TIMEOUT_MS - (uiNow - lastMovementTime);
        idleRemainingMs = Math.max(0, rem);
      }
      // Update windowActive state passively (visibility may have changed)
      hidden = document?.hidden ?? false;
      // windowActive = focused & not hidden
      // (focus logic handled by event listeners below, hidden polled here too)
    }, 250);

    // Focus/blur listeners
    const onFocus = () => { 
      windowActive = true; 
    };
    const onBlur = () => { 
      windowActive = false;
      // Clear all pressed keys when window loses focus
      keys = {};
      // Mark player inactive and disconnect when window loses focus
      if (markInactiveOnWindowInactive && myPlayer?.playerId) {
        try { setPlayerActive(myPlayer.playerId, false); } catch {}
        if (stopGameFn) stopGameFn(); // Stop render loop and intervals
        console.log('[Window] Lost focus, marked inactive and stopped game');
      }
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    const onVisibility = () => {
      hidden = document.hidden;
      windowActive = !hidden && document.hasFocus();
      // Clear all pressed keys when tab becomes hidden
      if (hidden) {
        keys = {};
      }
      // Also disconnect when tab becomes hidden
      if (hidden && markInactiveOnWindowInactive && myPlayer?.playerId) {
        try { setPlayerActive(myPlayer.playerId, false); } catch {}
        if (stopGameFn) stopGameFn(); // Stop render loop and intervals
        console.log('[Window] Tab hidden, marked inactive and stopped game');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      // cleanup UI tick
      try { clearInterval(uiTickInterval); } catch {}
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });
  $: if (dev && browser) sessionStorage.setItem('debugOpen', debugOpen ? '1' : '0');
  $: if (browser) sessionStorage.setItem('hsOpen', hsOpen ? '1' : '0');
  $: if (browser) sessionStorage.setItem('hsLastLoaded', String(hsLastLoaded));
  $: if (browser && storageLoaded) {
    localStorage.setItem('idleEnabled', idleEnabled ? '1' : '0');
    localStorage.setItem('markInactiveOnWindowInactive', markInactiveOnWindowInactive ? '1' : '0');
    localStorage.setItem('autoSpawnBotOnJoin', autoSpawnBotOnJoin ? '1' : '0');
    if (dev) {
      console.log('[Idle] Saved setting to storage:', idleEnabled);
      console.log('[Blur/Hidden] Saved setting to storage:', markInactiveOnWindowInactive);
      console.log('[Bot] Auto-spawn on join saved to storage:', autoSpawnBotOnJoin);
    }
  }
  const toggleDebug = dev ? () => { debugOpen = !debugOpen; } : () => {};
  function hashUid(uid: string | undefined | null) {
    const s = typeof uid === 'string' ? uid : '';
    let h = 2166136261 >>> 0; // FNV-1a
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function prettyName(uid: string | undefined | null) {
    const seed = hashUid(uid);
    if (uniqGen && dictAdj && dictAnimals) {
      try {
        return uniqGen({ dictionaries: [dictAdj, dictAnimals], seed, separator: ' ', style: 'capital' });
      } catch {}
    }
    const adjectives = ['Swift','Silent','Lunar','Solar','Crimson','Azure','Emerald','Golden','Frost','Shadow','Velvet','Ivory','Cinder','Radiant','Dusky','Quantum','Arcane','Chrome','Dawn','Nebula'];
    const animals = ['Fox','Wolf','Falcon','Panda','Heron','Otter','Lynx','Turtle','Jay','Drake','Moth','Stag','Lion','Badger','Hawk','Eagle','Python','Cobra','Koala','Raven'];
    const h = seed; return `${adjectives[h % adjectives.length]} ${animals[(h>>>8) % animals.length]}`;
  }
  function getCountryFromMeta(meta: any): string | null {
    const c = meta?.country || null; if (typeof c === 'string' && c.length === 2) return c.toUpperCase();
    const lang = meta?.language; if (typeof lang === 'string' && lang.includes('-')) return lang.split('-')[1].toUpperCase();
    return null;
  }

  function logPlayersInfo() {
    try {
      console.group('Players snapshot');
      console.log('Raw players array:', players);
      console.table(players.map(p => ({ id: p.id, score: p.score, angle: Number(p.angle?.toFixed?.(3) ?? p.angle), layer: p.layer ?? null, colorIndex: p.colorIndex ?? null })));
      console.groupEnd();

      const user = auth?.currentUser;
      if (user) {
        console.group('Current Auth User');
        console.log('uid:', user.uid);
        console.log('creationTime:', user.metadata?.creationTime);
        console.log('lastSignInTime:', user.metadata?.lastSignInTime);
        console.groupEnd();
      } else {
        console.log('No auth currentUser available yet.');
      }

      console.info('Note: Auth metadata (creationTime/lastSignInTime) is only available for the local signed-in user via auth.currentUser. Other players\' metadata is not accessible on clients unless you store it in the database yourself.');
    } catch (e) {
      console.warn('Failed to log players info', e);
    }
  }

  async function loadHighscoresOnce() {
    try {
      const list = await fetchHighscores(100);
      highscores = list;
      hsLastLoaded = Date.now();
    } catch (e) {
      console.warn('Failed to load highscores', e);
    }
  }
  async function reloadHighscoresIfAllowed() {
    const now = Date.now();
    if (now - hsLastLoaded < HS_RELOAD_COOLDOWN) return; // cooldown
    await loadHighscoresOnce();
  }
    let lastLayerChange = 0; // Timestamp of last layer change to prevent rapid switching

  // Difficulty system
  let difficulty = 1;
  const DIFFICULTY_INTERVAL_MS = 60000; // 60s between automatic difficulty increases
  let difficultyLastAutoIncreaseAt = 0; // timestamp of last automatic difficulty increase
  let pauseAccumulatedMs = 0;           // total paused time since page load
  let pauseStartedAt: number | null = null; // when current pause started
  let pauseAccumAtDiffStart = 0;        // pause total at last difficulty change
  // Reactive: difficulty multiplier recalculated from difficulty level
  $: difficultySpeedMultiplier = Math.pow(1.05, Math.max(0, difficulty - 1));
  let gameStartTime = 0;
  let gameSessionStartTime = 0;         // sessions gate scoreboard membership
  let pauseForNoPlayers = false;        // true when no active players
  // Track last known angles to detect inactive players on difficulty changes
  const lastKnownAngles = new Map<string, number>();

  // Hurt animation state
  let hurtUntil = 0; // Timestamp when hurt animation ends
  
  // Track which flows have already been scored to prevent duplicate scoring
  const scoredFlows = new Set<string>();
  
  // Track flows to remove (collided flows)
  const flowsToRemove = new Set<string>();
  // Track flows we've already removed from DB after passing outer ring
  const flowKeysRemovedFromDb = new Set<string>();

  // Simulate key presses for mobile controls
  function simulateKey(key: string, pressed: boolean) {
    keys[key] = pressed;
  }

  // Mobile buttons pressed states for visual feedback
  let mobileUpPressed = false;
  let mobileLeftPressed = false;
  let mobileDownPressed = false;
  let mobileRightPressed = false;

  // Flow ball stats
  let flowBallsSpawned = 0;
  let flowBallsSpawnedHistory: number[] = [];
  let flowBallsSpawnedLastMinute = 0;
  let evilFlowBallsSpawned = 0;
  let evilFlowBallsHistory: number[] = [];
  let evilFlowBallsLastMinute = 0;
  function recordFlowSpawn() {
    flowBallsSpawned++;
    flowBallsSpawnedHistory.push(Date.now());
    const cutoff = Date.now() - 60000;
    flowBallsSpawnedHistory = flowBallsSpawnedHistory.filter(t => t > cutoff);
    flowBallsSpawnedLastMinute = flowBallsSpawnedHistory.length;
  }
  function recordEvilFlowSpawn() {
    evilFlowBallsSpawned++;
    evilFlowBallsHistory.push(Date.now());
    const cutoff = Date.now() - 60000;
    evilFlowBallsHistory = evilFlowBallsHistory.filter(t => t > cutoff);
    evilFlowBallsLastMinute = evilFlowBallsHistory.length;
  }
  // Burst spawner: create N flows over 500ms with random jitter and angle-influenced speed offset
  function spawnBurst(count: number, evilFraction = 0) {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const delay = Math.random() * 500; // within .5s
      const isEvil = Math.random() < evilFraction;
      setTimeout(() => {
        // Small speed variation based on angle hash for determinism across clients
        const angleSeed = Math.random() * Math.PI * 2; // to keep existing randomness; could derive deterministic later
        const speedBias = (Math.sin(angleSeed * 3) + 1) / 2; // 0..1
        const extraSpeed = 1 + (speedBias - 0.5) * 0.2; // +/-10%
        spawnFlow(isEvil, { speedBias: Number(extraSpeed.toFixed(3)) });
        recordFlowSpawn();
        if (isEvil) recordEvilFlowSpawn();
      }, delay);
    }
  }

  function normalizeAngle(a: number) {
    return ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  }
  // Deterministic per-flow speed variation based on angle; same for all clients
  function speedBiasForAngle(angle: number) {
    // Map sin to ~±10-12% variation
    const s = Math.sin(angle * 3.137); // irrational-ish multiplier to avoid symmetry
    return 1 + s * 0.12; // 0.88x .. 1.12x
  }
  
  function checkCollision(flowAngle: number, playerAngle: number): boolean {
    // Player arc spans from (angle - PIPE_WIDTH/2) to (angle + PIPE_WIDTH/2)
    const playerStart = normalizeAngle(playerAngle - PIPE_WIDTH / 2);
    const playerEnd = normalizeAngle(playerAngle + PIPE_WIDTH / 2);
    const normFlow = normalizeAngle(flowAngle);
    
    // Check if flow angle falls within player arc
    // Handle wrap-around case (arc crosses 0/2π boundary)
    if (playerStart <= playerEnd) {
      return normFlow >= playerStart && normFlow <= playerEnd;
    } else {
      return normFlow >= playerStart || normFlow <= playerEnd;
    }
  }
  
  function checkNestCollisions(flow: Flow) {
    // Check if any active player's nest (in outermost layer) catches this flow
    const flowId = `${flow.spawnTime}_${flow.angle.toFixed(4)}`;
    if (scoredFlows.has(flowId) || flowsToRemove.has(flowId)) return;
    
    const now = Date.now();
    const progress = ((now - flow.spawnTime) / currentFlowDuration()) * speedBiasForAngle(flow.angle);
    const flowRadius = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);
    
    // Nest collision detector is at the outer border (outermostRadius + 12.5)
    const outermostRadius = layerRadii[numLayers - 1];
    const nestBorderRadius = outermostRadius + 12.5; // Where the bright border is drawn
    const R_WINDOW = COLLISION_RADIUS_TOLERANCE;
    
    // Check if flow is at the nest border radius (the collision detector)
    if (flowRadius >= (nestBorderRadius - R_WINDOW) && flowRadius <= (nestBorderRadius + R_WINDOW)) {
      const nestAngularWidth = (Math.PI * 2) / PLAYER_COLORS.length;
      
      // Check each color's nest
      PLAYER_COLORS.forEach((colorData, idx) => {
        // Only check nests for active players
        if (!activeUsedColorsAll.has(idx)) return;
        
        // Calculate nest angular range (same as rendering)
        const nestStartAngle = (idx * nestAngularWidth) - (Math.PI * 2 / 4);
        const nestEndAngle = nestStartAngle + nestAngularWidth;
        
        // Normalize angles
        const normFlowAngle = normalizeAngle(flow.angle);
        const normStart = normalizeAngle(nestStartAngle);
        const normEnd = normalizeAngle(nestEndAngle);
        
        // Check if flow angle falls within nest range
        let isInNest = false;
        if (normStart <= normEnd) {
          isInNest = normFlowAngle >= normStart && normFlowAngle <= normEnd;
        } else {
          // Handle wrap-around case
          isInNest = normFlowAngle >= normStart || normFlowAngle <= normEnd;
        }
        
        if (isInNest) {
          // Find the player(s) with this color
          const owners = colorOwners.get(idx);
          if (!owners || owners.length === 0) return;
          
          // Award points to all players of this color
          owners.forEach(owner => {
            scoredFlows.add(flowId);
            flowsToRemove.add(flowId);
            
            if (flow.isEvil) {
              decrementScore(owner.id);
              recordEvilHit(owner.id); // Lifetime stats
              incrementSessionEvilHits(owner.id); // Session stats
              console.debug('Nest caught evil flow!', { colorIndex: idx, playerId: owner.id });
            } else {
              incrementScore(owner.id);
              recordCatch(owner.id, idx);
              console.debug('Nest caught flow!', { colorIndex: idx, playerId: owner.id });
            }
          });
        }
      });
    }
  }
  
  function checkScore(flow: Flow) {
    if (!myPlayer) return;
    
    // Create unique ID for this flow based on spawn time and angle
    const flowId = `${flow.spawnTime}_${flow.angle.toFixed(4)}`;
    
    // Skip if already scored or marked for removal
    if (scoredFlows.has(flowId) || flowsToRemove.has(flowId)) return;
    
  const now = Date.now();
  const progress = ((now - flow.spawnTime) / currentFlowDuration()) * speedBiasForAngle(flow.angle);
    const flowRadius = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);

    // Determine target radius for this player using fixed layer position
    const targetRadius = INNER_R + FIXED_LAYER_SPACING * (myLayer + 1);

  // Ignore any stored flow.layer for collision; flows can be caught on whichever layer the player is on

    // Only collide when the flow is on the circle: tight radius window
    const R_WINDOW = COLLISION_RADIUS_TOLERANCE;
    if (flowRadius >= (targetRadius - R_WINDOW) && flowRadius <= (targetRadius + R_WINDOW)) {
      if (checkCollision(flow.angle, myAngle)) {
        scoredFlows.add(flowId);
        flowsToRemove.add(flowId); // Mark for immediate removal
        
        if (flow.isEvil) {
          // Evil flow reduces score and triggers hurt animation
          decrementScore(myPlayer.playerId);
          recordEvilHit(myPlayer.playerId); // Lifetime stats
          incrementSessionEvilHits(myPlayer.playerId); // Session stats
          hurtUntil = now + 400; // Blink for 400ms (2 blinks at ~200ms each)
          console.debug('HIT BY EVIL FLOW! Score reduced', {
            flowId,
            flowAngle: flow.angle,
            playerAngle: myAngle,
            layer: myLayer
          });
        } else {
          // Normal flow increases score AND speed boost
          incrementScore(myPlayer.playerId);
          mySpeedBoost++; // +1% additive per catch
          // Update lifetime highscore (catches)
          recordCatch(
            myPlayer.playerId,
            myColorIndex ?? undefined,
            getCountryFromMeta((myPlayer.playerData as any)?.meta) ?? undefined
          );
          console.debug('COLLISION! Flow caught at angle', {
            flowId,
            flowAngle: flow.angle,
            playerAngle: myAngle,
            progress: progress.toFixed(3),
            layer: myLayer,
            speedBoost: mySpeedBoost
          });
        }
      }
    }
  }

  // Bot AI logic (handles all active bots)
  function updateBotAI(now: number) {
    if (botPlayers.size === 0) return;
    
    botPlayers.forEach((botPlayer) => {
      // Simple AI: find nearest flow on bot's current layer
      const botLayerRadius = INNER_R + FIXED_LAYER_SPACING * (botPlayer.layer + 1);
      const R_WINDOW = COLLISION_RADIUS_TOLERANCE + 20; // Look ahead window
      
      let targetFlow: Flow | null = null;
      let minAngleDist = Infinity;
      
      flowCache.forEach((flow) => {
        const progress = ((now - flow.spawnTime) / currentFlowDuration()) * speedBiasForAngle(flow.angle);
        const flowRadius = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);
        
        // Check if flow is approaching bot's layer
        if (Math.abs(flowRadius - botLayerRadius) < R_WINDOW) {
          const angleDist = Math.abs(normalizeAngle(flow.angle - botPlayer.angle));
          const shortDist = Math.min(angleDist, Math.PI * 2 - angleDist);
          
          // Prioritize normal flows, avoid evil flows
          if (flow.isEvil) {
            // Avoid evil flows by moving away
            if (shortDist < 0.5) {
              // Move perpendicular to evil flow
              const avoidDir = shortDist < Math.PI ? -1 : 1;
              botPlayer.angle = normalizeAngle(botPlayer.angle + avoidDir * 0.01);
            }
          } else if (shortDist < minAngleDist) {
            minAngleDist = shortDist;
            targetFlow = flow;
          }
        }
      });
      
      // Move toward target normal flow
      if (targetFlow) {
        const targetAngle = targetFlow.angle;
        const diff = normalizeAngle(targetAngle - botPlayer.angle);
        const turnSpeed = 0.008 * (1 + botPlayer.speedBoost * 0.01);
        if (diff > 0.01 && diff < Math.PI) {
          botPlayer.angle = normalizeAngle(botPlayer.angle + turnSpeed);
        } else if (diff < -0.01 || diff > Math.PI) {
          botPlayer.angle = normalizeAngle(botPlayer.angle - turnSpeed);
        }
      }
      
      // Occasionally switch layers (random strategy)
      if (Math.random() < 0.005 && numLayers > 1) {
        const minLayer = MAX_LAYERS - numLayers;
        const maxLayer = MAX_LAYERS - 1;
        const newLayer = minLayer + Math.floor(Math.random() * numLayers);
        botPlayer.layer = newLayer;
        updateLayer(botPlayer.playerId, newLayer);
      }
      
      // Throttled Firebase updates (100ms for angle, 3s for presence)
      if (!botPlayer.lastUpdateTime) botPlayer.lastUpdateTime = 0;
      if (!botPlayer.lastPresenceTime) botPlayer.lastPresenceTime = 0;
      
      if (now - botPlayer.lastUpdateTime > 100) {
        updateAngle(botPlayer.playerId, botPlayer.angle);
        botPlayer.lastUpdateTime = now;
      }
      
      if (now - botPlayer.lastPresenceTime > 3000) {
        setLastSeen(botPlayer.playerId);
        botPlayer.lastPresenceTime = now;
      }
      
      // Check bot collisions
      flowCache.forEach((flow) => {
        const flowId = `${flow.spawnTime}_${flow.angle.toFixed(4)}`;
        if (scoredFlows.has(flowId) || flowsToRemove.has(flowId)) return;
        
        const progress = ((now - flow.spawnTime) / currentFlowDuration()) * speedBiasForAngle(flow.angle);
        const flowRadius = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);
        const targetRadius = INNER_R + FIXED_LAYER_SPACING * (botPlayer.layer + 1);
        
        if (flowRadius >= (targetRadius - COLLISION_RADIUS_TOLERANCE) && flowRadius <= (targetRadius + COLLISION_RADIUS_TOLERANCE)) {
          if (checkCollision(flow.angle, botPlayer.angle)) {
            scoredFlows.add(flowId);
            flowsToRemove.add(flowId);
            
            if (flow.isEvil) {
              decrementScore(botPlayer.playerId);
              recordEvilHit(botPlayer.playerId); // Lifetime stats
              incrementSessionEvilHits(botPlayer.playerId); // Session stats
            } else {
              incrementScore(botPlayer.playerId);
              botPlayer.speedBoost++;
              recordCatch(botPlayer.playerId, botPlayer.colorIndex ?? undefined);
            }
          }
        }
      });
    });
  }

  async function spawnBot() {
    // Check if there are free slots (only count active players)
    const used = new Set<number>();
    players.forEach(pl => { 
      if (pl?.colorIndex != null && isPlayerActiveNow(pl)) {
        used.add(pl.colorIndex as number); 
      }
    });
    // Also include bot players in the used set
    botPlayers.forEach(bot => { if (bot.colorIndex != null) used.add(bot.colorIndex); });
    
    if (used.size >= PLAYER_COLORS.length) {
      console.log('[Bot] All game slots are full');
      return;
    }
    
    try {
      // Find free color for bot before joining
      let botColor: number | null = null;
      for (let i = 0; i < PLAYER_COLORS.length; i++) {
        if (!used.has(i)) { botColor = i; break; }
      }
      
      if (botColor === null) {
        console.log('[Bot] No free color slots found');
        return;
      }
      
      // Use nest center angle
      const startAngle = getNestAngle(botColor);
      // Start at outermost layer (11) where nest is
      const startLayer = MAX_LAYERS - 1;
      
      // Generate bot ID
      const botId = `bot-${Date.now()}-${Math.floor(Math.random()*1000)}`;
      
      // Create bot player data directly in database (don't use joinGame which requires auth)
      const playerData = {
        id: botId,
        angle: startAngle,
        score: 0,
        layer: startLayer,
        colorIndex: botColor,
        createdAt: Date.now(),
        active: true,
        lastSeen: Date.now(),
        evilHits: 0,
        isBot: true,
        createdBy: myPlayer?.playerId || null, // Track who created this bot
        meta: {
          country: null,
          language: null,
          creationTime: null,
          lastSignInTime: null
        }
      };
      
      // Write bot to database
      await set(ref(db, `${ROOM}/players/${botId}`), playerData);
      
      const newBot = {
        playerId: botId,
        angle: startAngle,
        layer: startLayer,
        colorIndex: botColor,
        speedBoost: 0
      };
      
      // Add to bot map (trigger reactivity)
      botPlayers.set(botId, newBot);
      botPlayers = botPlayers; // Trigger Svelte reactivity
      
      console.log('[Bot] Spawned bot player:', botId, 'at angle', startAngle, 'Total bots:', botPlayers.size);
    } catch (e) {
      console.error('[Bot] Failed to spawn bot:', e);
    }
  }

  async function removeBot(botId?: string) {
    if (botPlayers.size === 0) return;
    
    try {
      // If specific botId provided, remove that one, otherwise remove the first bot
      const targetBotId = botId || Array.from(botPlayers.keys())[0];
      const bot = botPlayers.get(targetBotId);
      
      if (!bot) return;
      
      await setPlayerActive(bot.playerId, false);
      await set(ref(db, `${ROOM}/players/${bot.playerId}`), null);
      botPlayers.delete(targetBotId);
      botPlayers = botPlayers; // Trigger Svelte reactivity
      console.log('[Bot] Removed bot player:', targetBotId, 'Remaining bots:', botPlayers.size);
    } catch (e) {
      console.error('[Bot] Failed to remove bot:', e);
    }
  }

  onMount(() => {
    if (!browser) return;
    canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    
    // Initialize starfield
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * CANVAS_SIZE,
        y: Math.random() * CANVAS_SIZE,
        size: Math.random() * 1.5 + 0.5, // 0.5 to 2 pixels
        opacity: Math.random() * 0.5 + 0.3, // 0.3 to 0.8
        twinkleSpeed: Math.random() * 0.02 + 0.005, // Slow twinkle
        twinklePhase: Math.random() * Math.PI * 2 // Random starting phase
      });
    }

  let unsubPlayers: () => void = () => {};
  let unsubFlows: () => void = () => {};
  let presenceInterval: any;
    const init = async () => {
  const joined = await joinGame(() => {});
  myPlayer = joined as any;
  if (myPlayer) {
    myColorIndex = (myPlayer.playerData as any).colorIndex ?? null;
    myLayer = (myPlayer.playerData as any).layer ?? 0;
    myLayerVisual = myLayer; // Initialize visual layer to match
    
    // If player has a color, position them at their nest center (ignore old angle from DB)
    if (myColorIndex != null) {
      myAngle = getNestAngle(myColorIndex);
      myLayer = MAX_LAYERS - 1; // Ensure on outermost layer (11) where nests are
      myLayerVisual = myLayer; // Update visual layer too
      // Update database with correct nest position
      updateAngle(myPlayer.playerId, myAngle);
      updateLayer(myPlayer.playerId, myLayer);
      setSessionEvilHits(myPlayer.playerId, 0); // Reset session evil hits
      console.log('[PLAYER SPAWN - Rejoin] colorIndex:', myColorIndex, 
                  'playerAngle:', (myAngle * 180 / Math.PI).toFixed(2) + '°',
                  'layer:', myLayer);
    } else {
      // No color assigned yet, load angle from DB
      myAngle = myPlayer.playerData.angle;
      setSessionEvilHits(myPlayer.playerId, 0); // Reset session evil hits for new players too
    }
    
    console.log('Player joined:', myPlayer.playerId);
      // Start presence heartbeat (every 5s for better visibility)
      presenceInterval = setInterval(() => {
        if (myPlayer?.playerId) setLastSeen(myPlayer.playerId);
      }, 5000);
      
      // Set initial lastSeen immediately
      setLastSeen(myPlayer.playerId);
      
      // Auto-spawn bot if enabled
      if (autoSpawnBotOnJoin) {
        console.log('[Bot] Auto-spawning bot on join...');
        setTimeout(() => spawnBot(), 1000); // Delay to ensure player is fully initialized
      }
  }

      unsubPlayers = listenPlayers(p => {
        players = p;
        if (myPlayer) {
          // Check if my player was marked inactive
          const me = players.find(pl => pl.id === myPlayer!.playerId);
          if (me && me.active === false && !showInactiveDialog) {
            showInactiveDialog = true;
            console.log('[Inactive] You have been marked inactive.');
          }

          const used = new Set<number>();
          players.forEach(pl => { if (pl?.colorIndex != null) used.add(pl.colorIndex as number); });
          const totalColors = PLAYER_COLORS.length;
          const hasFree = used.size < totalColors;
          // If we do not have a color yet
          if (myColorIndex == null) {
            if (!hasFree) {
              // Enter queue if not already queued
              if (!isQueued) {
                isQueued = true;
                try { set(ref(db, `${ROOM}/players/${myPlayer.playerId}/queued`), true); } catch {}
                try { setPlayerActive(myPlayer.playerId, false); } catch {}
                console.log('[Queue] All colors taken. You are queued.');
              }
              canClaimSpot = false;
            } else {
              // Free color exists
              if (isQueued) {
                // We were queued, now can claim manually
                canClaimSpot = true;
              } else {
                // Auto assign on first join
                let chosen: number | null = null;
                for (let i = 0; i < totalColors; i++) { if (!used.has(i)) { chosen = i; break; } }
                if (chosen != null) {
                  myColorIndex = chosen;
                  updateColor(myPlayer.playerId, chosen);
                  // Set starting angle at nest center
                  const nestAngle = getNestAngle(chosen);
                  myAngle = nestAngle;
                  updateAngle(myPlayer.playerId, nestAngle);
                  // Set player to outermost layer (11) where nest is
                  myLayer = MAX_LAYERS - 1;
                  myLayerVisual = myLayer; // Initialize visual layer to match
                  updateLayer(myPlayer.playerId, myLayer);
                  try { setPlayerActive(myPlayer.playerId, true); } catch {}
                  try { setSessionEvilHits(myPlayer.playerId, 0); } catch {} // Reset session evil hits
                  try { set(ref(db, `${ROOM}/players/${myPlayer.playerId}/queued`), null); } catch {}
                  console.log('[PLAYER SPAWN - Auto-assign] colorIndex:', chosen, 
                              'playerAngle:', (myAngle * 180 / Math.PI).toFixed(2) + '°',
                              'layer:', myLayer);
                }
              }
            }
          } else {
            // Already have color: ensure flags reset
            canClaimSpot = false;
          }
        }
      }) as any;
      unsubFlows = listenFlows(f => {
        flows = f;
        // Merge incoming flows into local cache so they persist until fully off-canvas
        for (const flow of f) {
          const id = `${flow.spawnTime}_${Number(flow.angle).toFixed(4)}`;
          if (!flowCache.has(id)) flowCache.set(id, flow);
        }
        // Periodic hygiene: trim scored/removed IDs older than 30s
        const now = Date.now();
        const oldFlowIds = Array.from(scoredFlows).filter(id => {
          const [timestamp] = id.split('_');
          return now - (parseInt(timestamp) || 0) > 30000;
        });
        for (const id of oldFlowIds) { scoredFlows.delete(id); flowsToRemove.delete(id); }
      }) as any;
    };
    
    // Start async init but don't block
    init();

    // Set game start time
    gameStartTime = Date.now();
    gameSessionStartTime = gameStartTime;
    difficultyLastAutoIncreaseAt = gameStartTime;
    pauseAccumAtDiffStart = pauseAccumulatedMs;
    // Initialize lastKnownAngles for all players at start
    players.forEach((pl) => {
      if (pl && pl.id) lastKnownAngles.set(pl.id, pl.angle);
    });

    // Increase difficulty every minute
    const difficultyInterval = setInterval(() => {
      if (pauseForNoPlayers) return; // freeze difficulty while paused
      if (difficulty < 10) {
        // Before increasing difficulty, check for inactive players (no angle change since last difficulty)
        players.forEach((pl) => {
          if (!pl || !pl.id || !myPlayer || pl.id === myPlayer.playerId) return;
          const lastAngle = lastKnownAngles.get(pl.id);
          const currentAngle = pl.angle;
          if (lastAngle !== undefined && Math.abs(currentAngle - lastAngle) < 0.0001) {
            // Player hasn't moved since last difficulty change; mark inactive
            try { setPlayerActive(pl.id, false); } catch (e) { console.warn('Failed to mark player inactive:', pl.id, e); }
            console.log(`[Difficulty] Marking player ${prettyName(pl.id)} inactive (no movement)`);
          }
        });
        difficulty++;
        difficultyLastAutoIncreaseAt = Date.now();
        pauseAccumAtDiffStart = pauseAccumulatedMs;
        // Snapshot current angles for next check
        players.forEach((pl) => {
          if (pl && pl.id) lastKnownAngles.set(pl.id, pl.angle);
        });
        console.log('Difficulty increased to:', difficulty);
        // difficultySpeedMultiplier updates reactively from difficulty
      }
    }, DIFFICULTY_INTERVAL_MS); // Every minute

    // Auto burst: every 10s spawn a burst sized to players
    function countOnlinePlayers() {
      const nowTs = Date.now();
      return players.filter((pl) => {
        const active = (pl as any)?.active !== false;
        const ls = (pl as any)?.lastSeen;
        const fresh = typeof ls === 'number' ? (nowTs - ls) < 30000 : true; // 30s window
        return active && fresh;
      }).length;
    }

    const spawnInterval = setInterval(() => {
      if (pauseForNoPlayers) return; // don't spawn while paused
      const numPlayers = countOnlinePlayers();
      if (numPlayers === 0) return; // safety
      const burstSize = Math.min(12, Math.max(3, numPlayers * 2));
      spawnBurst(burstSize, 0); // normal flows only
      console.debug(`Burst spawned ${burstSize} normal flows for ${numPlayers} players`);
    }, 10000);

    // Evil burst every minute if difficulty >=2
    const evilSpawnInterval = setInterval(() => {
      if (pauseForNoPlayers) return; // paused
      if (difficulty >= 2) {
        const numPlayers = countOnlinePlayers();
        if (numPlayers === 0) return;
        const burstSize = Math.min(16, Math.max(4, numPlayers * 2));
        const evilFraction = 0.4; // 40% evil inside this burst
        spawnBurst(burstSize, evilFraction);
        console.debug(`Evil burst spawned ${burstSize} flows (${Math.round(burstSize*evilFraction)} evil) difficulty=${difficulty}`);
      }
    }, 60000);

    // Cleanup layer 5 flows every minute (these have left playable area)
    const layer5CleanupInterval = setInterval(async () => {
      const removed = await removeLayer5Flows();
      if (removed > 0) console.debug('[layer5 cleanup] removed flows:', removed);
    }, 60000);

    // Cleanup inactive players every 5 minutes
    const inactivePlayerCleanupInterval = setInterval(async () => {
      const result = await cleanupInactivePlayers(5 * 60 * 1000); // 5 minutes
      if (result.removed > 0) {
        console.log(`[Inactive Players] Removed ${result.removed} inactive players, archived ${result.archived} to highscores`);
      }
    }, 5 * 60 * 1000); // Run every 5 minutes

    // Keyboard
    const onKey = (e: KeyboardEvent) => {
      keys[e.key] = e.type === 'keydown';
      
      // Debug mode: numpad +/- to adjust layers
      if (dev && e.type === 'keydown') {
        if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
          // Increase layers
          if (manualLayerCount === null) {
            manualLayerCount = numLayers;
          }
          if (manualLayerCount < MAX_LAYERS) {
            manualLayerCount++;
            console.log(`[Debug] Layers increased to ${manualLayerCount}`);
          }
          e.preventDefault();
        } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
          // Decrease layers
          if (manualLayerCount === null) {
            manualLayerCount = numLayers;
          }
          if (manualLayerCount > 1) {
            manualLayerCount--;
            console.log(`[Debug] Layers decreased to ${manualLayerCount}`);
          }
          e.preventDefault();
        }
      }
      
      // Prevent arrow keys from scrolling the page or debug panel
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);

    // Throttle state
    let lastAngleUpdateTime = 0;
    let lastAngleSent = myAngle;
    let lastPresenceUpdateTime = 0;
    let raf: number;

    // Helper to stop game (for idle/blur)
    function stopGame() {
      try { unsubPlayers && unsubPlayers(); } catch {}
      try { unsubFlows && unsubFlows(); } catch {}
      try { clearInterval(spawnInterval); } catch {}
      try { clearInterval(difficultyInterval); } catch {}
      try { clearInterval(evilSpawnInterval); } catch {}
      try { clearInterval(layer5CleanupInterval); } catch {}
      try { clearInterval(inactivePlayerCleanupInterval); } catch {}
      try { if (presenceInterval) clearInterval(presenceInterval); } catch {}
      try { goOffline(db); } catch {}
      try { cancelAnimationFrame(raf); } catch {}
    }
    
    // Make available to blur/visibility handlers
    stopGameFn = stopGame;

    function loop() {
      if (isIdle) return; // stop rendering & DB sync when idle
      if (!ctx || !canvas) return;
      
      // Get current time at the start of the loop
      const now = Date.now();
      
      // Track FPS - count frames and update display values every second
      frameCount++;
      const frameDelta = now - lastFrameTime;
      lastFrameTime = now;
      
      // Update FPS display once per second
      if (now - lastFpsUpdateTime >= 1000) {
        const elapsed = (now - lastFpsUpdateTime) / 1000;
        currentFps = Math.round(frameCount / elapsed);
        fpsHistory.push(currentFps);
        if (fpsHistory.length > 60) fpsHistory.shift(); // Keep last 60 seconds
        averageFps = Math.round(fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length);
        frameCount = 0;
        lastFpsUpdateTime = now;
      }
      
      // Calculate allowed layer range
      const minAllowedLayer = MAX_LAYERS - numLayers;
      const maxAllowedLayer = MAX_LAYERS - 1;
      
      // Check if player is on a layer that no longer exists and move them to nearest valid layer
      if (myPlayer && myLayer < minAllowedLayer) {
        myLayer = minAllowedLayer;
        myLayerVisual = myLayer; // Snap visual layer immediately when forced to move
        updateLayer(myPlayer.playerId, myLayer);
      }
      
      // Check if bots are on layers that no longer exist and move them to nearest valid layer
      botPlayers.forEach((bot) => {
        if (bot.layer < minAllowedLayer) {
          bot.layer = minAllowedLayer;
          updateLayer(bot.playerId, minAllowedLayer);
        }
      });
      
      // Cleanup bots whose creator is no longer active
      const activePlayerIds = new Set(
        players
          .filter(pl => pl && isPlayerActiveNow(pl))
          .map(pl => pl.id)
      );
      
      // Remove bots whose creator is not active
      const botsToRemove: string[] = [];
      players.forEach(pl => {
        if (pl?.isBot && pl.createdBy && !activePlayerIds.has(pl.createdBy)) {
          botsToRemove.push(pl.id);
        }
      });
      
      // Delete bots from database
      if (botsToRemove.length > 0) {
        botsToRemove.forEach(botId => {
          try {
            set(ref(db, `${ROOM}/players/${botId}`), null);
          } catch (err) {
            console.warn('Failed to remove bot', botId, err);
          }
        });
      }
      
      // Update pause state from current players
      const nowTs = now;
      const online = players.some((pl) => {
        const active = (pl as any)?.active !== false;
        const ls = (pl as any)?.lastSeen;
        const fresh = typeof ls === 'number' ? (nowTs - ls) < 30000 : true;
        return active && fresh;
      });
      if (!online && !pauseForNoPlayers) {
        pauseForNoPlayers = true;
        pauseStartedAt = now;
      } else if (online && pauseForNoPlayers) {
        pauseForNoPlayers = false;
        if (pauseStartedAt != null) {
          pauseAccumulatedMs += now - pauseStartedAt;
          pauseStartedAt = null;
        }
      }

      // Session rollover at difficulty 10 after its countdown completes (account for pause)
      if (difficulty === 10) {
        const pausedSinceDiffStart = pauseAccumulatedMs - pauseAccumAtDiffStart;
        const effectiveElapsed = Math.max(0, (now - difficultyLastAutoIncreaseAt) - pausedSinceDiffStart);
        if (effectiveElapsed >= DIFFICULTY_INTERVAL_MS) {
          const t = now;
          difficulty = 1;
          difficultyLastAutoIncreaseAt = t;
          pauseAccumAtDiffStart = pauseAccumulatedMs;
          gameSessionStartTime = t;
          try { flowCache.clear(); } catch {}
          try { scoredFlows.clear(); } catch {}
          try { flowsToRemove.clear(); } catch {}
          console.log('[Session] New session started');
        }
      }
      // Reflect keyboard state on mobile control visual pressed states
      mobileUpPressed = !!(keys.ArrowUp || keys.w || keys.W);
      mobileDownPressed = !!(keys.ArrowDown || keys.s || keys.S);
      mobileLeftPressed = !!(keys.ArrowLeft || keys.a || keys.A);
      mobileRightPressed = !!(keys.ArrowRight || keys.d || keys.D);
      
      // Input (with speed boost applied: +1% per boost)
      const effectiveDebugSpeed = debugSpeed * (1 + mySpeedBoost * 0.01);
      if (keys.ArrowLeft || keys.a || keys.A) { 
        myAngle = normalizeAngle(myAngle - effectiveDebugSpeed); 
        lastMovementTime = Date.now();
      }
      if (keys.ArrowRight || keys.d || keys.D) { 
        myAngle = normalizeAngle(myAngle + effectiveDebugSpeed); 
        lastMovementTime = Date.now();
      }
      
        // Layer switching with debounce (200ms between changes)
        // Layers numbered 0-11, where 11 is outermost (nest), 0 is innermost (sun)
        // Up = move away from sun (increase layer), Down = move towards sun (decrease layer)
        // Players can only move to layers that exist: (MAX_LAYERS - numLayers) to (MAX_LAYERS - 1)
        
        if ((keys.ArrowUp || keys.w || keys.W || keys.ArrowDown || keys.s || keys.S) && now - lastLayerChange > 200) {
          if ((keys.ArrowUp || keys.w || keys.W) && myLayer < maxAllowedLayer) {
            myLayer++; // Move away from sun
            lastLayerChange = now;
            lastMovementTime = Date.now();
            if (myPlayer?.playerId) updateLayer(myPlayer.playerId, myLayer);
          } else if ((keys.ArrowDown || keys.s || keys.S) && myLayer > minAllowedLayer) {
            myLayer--; // Move towards sun
            lastLayerChange = now;
            lastMovementTime = Date.now();
            if (myPlayer?.playerId) updateLayer(myPlayer.playerId, myLayer);
          }
        }
        
        // Smooth layer transition - interpolate visual layer towards target layer
        const layerTransitionSpeed = 0.15; // Higher = faster transition (0-1)
        myLayerVisual += (myLayer - myLayerVisual) * layerTransitionSpeed;
        // Snap to target when very close to avoid floating point drift
        if (Math.abs(myLayer - myLayerVisual) < 0.01) {
          myLayerVisual = myLayer;
        }

      // Update bot AI (for all active bots)
      if (botPlayers.size > 0) {
        updateBotAI(now);
      }

      // Clear
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Draw starfield background with twinkling effect
      stars.forEach(star => {
        star.twinklePhase += star.twinkleSpeed;
        const twinkle = Math.sin(star.twinklePhase) * 0.3 + 0.7; // Oscillate between 0.4 and 1.0
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity * twinkle})`;
        ctx.fillRect(star.x, star.y, star.size, star.size);
      });

      // Center circle
      ctx.fillStyle = '#ff0';
      ctx.beginPath();
      ctx.arc(CENTER_X, CENTER_Y, INNER_R, 0, Math.PI * 2);
      ctx.fill();

      // Game title on the center circle
      {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Use Roboto font with fallbacks
        ctx.font = 'bold 14px Roboto, "Helvetica Neue", Arial, sans-serif';
        ctx.fillStyle = '#000';
        ctx.globalAlpha = 0.9;
        
        const titleLine1 = 'Flow ~together~';
        const titleLine2 = 'made with 🩸, 💦 & ❤️';
        const titleLine3 = 'by a gothenburgian';
        
        // Calculate total height for vertical centering
        const line1Height = 14;
        const line2Height = 10;
        const line3Height = 10;
        const spacing = 6;
        const totalHeight = line1Height + spacing + line2Height + spacing + line3Height;
        const startY = CENTER_Y - totalHeight / 2 + line1Height / 2;
        
        // Draw centered text
        ctx.fillText(titleLine1, CENTER_X, startY);
        ctx.font = '10px Roboto, "Helvetica Neue", Arial, sans-serif';
        ctx.fillText(titleLine2, CENTER_X, startY + line1Height / 2 + spacing + line2Height / 2);
        ctx.fillText(titleLine3, CENTER_X, startY + line1Height / 2 + spacing + line2Height + spacing + line3Height / 2);
        
        ctx.globalAlpha = 1;
        ctx.restore();
      }
      
        // Draw layer rings using fixed spacing
        // Layers are numbered 0-11, we only draw layers (MAX_LAYERS - numLayers) through (MAX_LAYERS - 1)
        const minLayerIndex = MAX_LAYERS - numLayers;
        for (let layerIdx = minLayerIndex; layerIdx < MAX_LAYERS; layerIdx++) {
          const innerRadius = INNER_R + FIXED_LAYER_SPACING * layerIdx;
          const outerRadius = INNER_R + FIXED_LAYER_SPACING * (layerIdx + 1);
          
          // Map layerIdx to color index (0 to numLayers-1 for the color array)
          const colorIndex = layerIdx - minLayerIndex;
          ctx.fillStyle = layerColors[colorIndex];
          ctx.beginPath();
          ctx.arc(CENTER_X, CENTER_Y, outerRadius, 0, Math.PI * 2);
          ctx.arc(CENTER_X, CENTER_Y, innerRadius, 0, Math.PI * 2, true); // Draw hole
          ctx.fill();
        }

      // Draw player nests (wheel segments in outermost layer)
      {
        // Nests are always at the fixed outermost position (MAX_LAYERS - 1)
        const outermostRadius = INNER_R + FIXED_LAYER_SPACING * MAX_LAYERS;
        const nestAngularWidth = (Math.PI * 2) / PLAYER_COLORS.length; // Divide circle evenly, no gaps
        
        PLAYER_COLORS.forEach((colorData, idx) => {
          // Calculate nest position to fill entire circle with no gaps
          const nestStartAngle = (idx * nestAngularWidth) - (Math.PI * 2 / 4); // Start from top, rotate -90°
          const nestEndAngle = nestStartAngle + nestAngularWidth;
          
          // Check if this color is active
          const isActive = activeUsedColorsAll.has(idx);
          
          // Draw main nest arc with low opacity (0.2) - nest background
          ctx.globalAlpha = 0.2;
          ctx.strokeStyle = colorData.hex;
          ctx.lineWidth = 25;
          ctx.lineCap = 'butt'; // Square caps so nests connect seamlessly
          ctx.beginPath();
          ctx.arc(CENTER_X, CENTER_Y, outermostRadius, nestStartAngle, nestEndAngle);
          ctx.stroke();
          
          // Draw collision border at 0.8 opacity if active (outer edge)
          if (isActive) {
            ctx.globalAlpha = 0.8;
            ctx.strokeStyle = colorData.hex;
            ctx.lineWidth = 4;
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.arc(CENTER_X, CENTER_Y, outermostRadius + 12.5, nestStartAngle, nestEndAngle);
            ctx.stroke();
          }
          
          ctx.globalAlpha = 1.0; // Reset opacity
        });
      }

      // Players - render only currently active players (active flag true and fresh lastSeen)
      players.forEach((p, i) => {
        if (!p || !p.id) return;
        // Only show active players' fragments
        const ls = (p as any)?.lastSeen;
        const activeFlag = (p as any)?.active !== false;
        const fresh = typeof ls === 'number' ? (now - ls) < 30000 : true;
        const isCurrentlyActive = activeFlag && fresh;
        if (!isCurrentlyActive) return;
        
        // Check if this is the current player and if hurt animation is active
        const isMyPlayer = !!(myPlayer && p.id === myPlayer.playerId);
        const isHurt = isMyPlayer && now < hurtUntil;
        
        // Blink effect: show/hide every 100ms during hurt animation
        if (isHurt && Math.floor((hurtUntil - now) / 100) % 2 === 0) {
          return; // Skip rendering during blink-off phase
        }
        
    // Use palette color if assigned (use myColorIndex for my player)
  const cIndex = (isMyPlayer ? myColorIndex : p.colorIndex);
  const color = (cIndex != null && PLAYER_COLORS[cIndex]) ? PLAYER_COLORS[cIndex].hex : '#888';
        
  // Get player's layer and corresponding radius
  // For the current player, use smooth visual layer; for others use their actual layer
  const playerLayer = isMyPlayer ? myLayerVisual : (p.layer ?? 0);
    // Use fixed layer spacing - layers are numbered 0-11, where 11 is outermost
    const layerRadius = INNER_R + FIXED_LAYER_SPACING * (playerLayer + 1);
        
        ctx.strokeStyle = color;
        ctx.lineWidth = 25;
        ctx.lineCap = 'round';
        ctx.beginPath();
    const angle = isMyPlayer ? myAngle : p.angle;
        const startA = normalizeAngle(angle - PIPE_WIDTH / 2);
        const endA = normalizeAngle(angle + PIPE_WIDTH / 2);
    ctx.arc(CENTER_X, CENTER_Y, layerRadius, startA, endA);
        ctx.stroke();

        // Accent ring
        ctx.lineWidth = 8;
        ctx.strokeStyle = color + '44';
        ctx.beginPath();
    ctx.arc(CENTER_X, CENTER_Y, layerRadius, startA, endA);
        ctx.stroke();

        // Speed boost indicator (draw small triangles/chevrons if myPlayer has boosts)
        if (isMyPlayer && mySpeedBoost > 0) {
          const midAngle = angle;
          const numChevrons = Math.min(3, mySpeedBoost); // 1 chevron per boost, max 3 visible
          const chevronGap = 12;
          const baseOffset = layerRadius + 18;
          for (let c = 0; c < numChevrons; c++) {
            const offset = baseOffset + c * chevronGap;
            const cx = CENTER_X + Math.cos(midAngle) * offset;
            const cy = CENTER_Y + Math.sin(midAngle) * offset;
            const size = 6;
            // Draw a small forward-facing triangle (speed indicator)
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(midAngle);
            ctx.fillStyle = '#ffcc00';
            ctx.beginPath();
            ctx.moveTo(size, 0);
            ctx.lineTo(-size/2, -size/2);
            ctx.lineTo(-size/2, size/2);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        }
      });

      // Flows - render from cache and remove by radius threshold (with generous overshoot)
      const activeFlows: Flow[] = [];
  const overshootPx = 240; // keep flows until further past canvas edge (doubled)
      flowCache.forEach((flow, id) => {
        if (flowsToRemove.has(id)) return; // collided -> skip
        const progress = ((now - flow.spawnTime) / currentFlowDuration()) * speedBiasForAngle(flow.angle);
  const flowRadius = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);
  // If flow exits beyond the canvas (outside render radius), tag it as layer 5 once
  if (flow.layer !== 5 && flowRadius > MAX_FLOW_RADIUS) {
          flow.layer = 5;
          // If we have the Firebase key, persist layer change for server-side cleanup
          const key = (flow as any).key as string | undefined;
          if (key) {
            updateFlowLayer(key, 5);
            // Also delete from DB immediately (keep rendering via local cache)
            if (!flowKeysRemovedFromDb.has(key)) {
              set(ref(db, `${ROOM}/flows/${key}`), null).catch((err) => {
                console.warn('Failed to remove layer-5 flow immediately', key, err);
              });
              flowKeysRemovedFromDb.add(key);
            }
          }
        }
        if (flowRadius < MAX_FLOW_RADIUS + overshootPx) {
          activeFlows.push(flow);
        } else {
          flowCache.delete(id);
        }
      });
      
      activeFlows.forEach(flow => {
        const rawProgress = ((now - flow.spawnTime) / currentFlowDuration()) * speedBiasForAngle(flow.angle);
        const r = INNER_R + rawProgress * (MAX_FLOW_RADIUS - INNER_R);
        const headX = CENTER_X + Math.cos(flow.angle) * r;
        const headY = CENTER_Y + Math.sin(flow.angle) * r;

        // Fading trail length factor (shortens near end of life)
        const trailFactor = Math.min(1, Math.max(0.15, 1 - rawProgress * 0.7));
        const tailR = INNER_R + (rawProgress - trailFactor * 0.25) * (MAX_FLOW_RADIUS - INNER_R);
        const tailRClamped = Math.max(INNER_R, tailR);
        const tailX = CENTER_X + Math.cos(flow.angle) * tailRClamped;
        const tailY = CENTER_Y + Math.sin(flow.angle) * tailRClamped;

        // Create gradient for trail fade
        const grad = ctx.createLinearGradient(tailX, tailY, headX, headY);
        if (flow.isEvil) {
          grad.addColorStop(0, 'rgba(255,64,64,0)');
          grad.addColorStop(1, 'rgba(255,64,64,0.4)');
        } else {
          grad.addColorStop(0, 'rgba(255,255,0,0)');
          grad.addColorStop(1, 'rgba(255,255,0,0.4)');
        }

        ctx.lineWidth = flow.isEvil ? 5 : 4;
        ctx.lineCap = 'round';
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(headX, headY);
        ctx.stroke();

        // Draw head with slight glow effect via double circle
        if (flow.isEvil) {
          ctx.fillStyle = '#ff3333';
          ctx.beginPath();
          ctx.arc(headX, headY, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ff6666';
          ctx.beginPath();
          ctx.arc(headX, headY, 5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = '#ffff33';
          ctx.beginPath();
          ctx.arc(headX, headY, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fffacd';
          ctx.beginPath();
          ctx.arc(headX, headY, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      // Check collisions only on active flows
      if (myPlayer) {
        activeFlows.forEach(checkScore);
        // Check nest collisions for all active players
        activeFlows.forEach(checkNestCollisions);
        // Remove collided flows from cache immediately
        flowsToRemove.forEach((fid) => { if (flowCache.has(fid)) flowCache.delete(fid); });
      }

      // Scores overlay (sorted by score desc): [flag] [name] [score] [-hits] (session + active filtering, grayed inactive)
      // Now rendered in HTML overlay with flag icons
      {
        const hsMap = new Map<string, Highscore>(highscores.map(h => [h.id, h]));
        const now = Date.now();
        const FIVE_MINUTES_MS = 5 * 60 * 1000; // 5 minutes in milliseconds
        
        const list = [...players]
          .filter(p => p && p.id)
          .filter(p => {
            const ls = (p as any)?.lastSeen;
            const inSession = typeof ls === 'number' ? (ls >= gameSessionStartTime) : true;
            return inSession;
          })
          .filter(p => {
            // Only show players who have been active in the last 5 minutes
            const ls = (p as any)?.lastSeen;
            if (typeof ls !== 'number') return false; // Hide if no lastSeen data (old/legacy players)
            const timeSinceLastSeen = now - ls;
            return timeSinceLastSeen < FIVE_MINUTES_MS;
          })
          .sort((a, b) => (b.score || 0) - (a.score || 0));
        
        // Update scoreboardList for HTML overlay
        scoreboardList = list.map(p => {
          const name = prettyName(p.id);
          const score = typeof p.score === 'number' ? p.score : 0;
          const hs = hsMap.get(p.id);
          const hits = (p as any)?.evilHits ?? 0; // Use session hits from player object
          const cc = hs?.country || getCountryFromMeta((p as any)?.meta) || null;
          const activeFlag = (p as any)?.active !== false;
          const ls = (p as any)?.lastSeen;
          const fresh = typeof ls === 'number' ? (now - ls) < 30000 : true;
          const currentlyActive = activeFlag && fresh;
          return {
            id: p.id,
            name,
            score,
            hits,
            country: cc,
            color: colorForPlayer(p),
            active: currentlyActive
          };
        });
      }

      // Top-right canvas overlay: game slots (active usage) visual (12 dots)
      {
        const slotCount = PLAYER_COLORS.length;
        const dotSize = 12;
        const gap = 6;
        const margin = 12;
        const panelPadding = 8;
        const panelW = slotCount * dotSize + (slotCount - 1) * gap + panelPadding * 2;
        const panelH = dotSize + panelPadding * 2 + 14; // extra for label
        const panelX = canvas.width - panelW - margin;
        const panelY = margin;
        // Panel background
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(panelX, panelY, panelW, panelH);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.strokeRect(panelX + 0.5, panelY + 0.5, panelW - 1, panelH - 1);
        // Label
        ctx.font = '12px Arial';
        ctx.fillStyle = '#ccc';
        const activeSlots = activeUsedColorsAll.size;
        ctx.fillText(`Slots ${activeSlots}/${slotCount}`, panelX + panelPadding, panelY + 14);
        // Dots row
        const dotsY = panelY + panelPadding + 14;
        for (let i = 0; i < slotCount; i++) {
          const x = panelX + panelPadding + i * (dotSize + gap);
          const isTaken = activeUsedColorsAll.has(i);
          const isMine = myColorIndex === i;
          const color = isTaken ? PLAYER_COLORS[i].hex : '#444';
          ctx.beginPath();
          ctx.fillStyle = color;
          ctx.arc(x + dotSize / 2, dotsY + dotSize / 2, dotSize / 2, 0, Math.PI * 2);
          ctx.fill();
          // Outline
          ctx.strokeStyle = isMine ? '#fff' : (isTaken ? color + 'aa' : '#666');
          ctx.lineWidth = isMine ? 2 : 1;
          ctx.beginPath();
          ctx.arc(x + dotSize / 2, dotsY + dotSize / 2, dotSize / 2 + (isMine?1:0), 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Difficulty countdown bar (bottom of canvas) - paused-aware
      {
        const nowMs = now;
        const pausedSinceDiffStart = pauseAccumulatedMs - pauseAccumAtDiffStart;
        const effectiveElapsedSinceLast = Math.max(0, (nowMs - difficultyLastAutoIncreaseAt) - pausedSinceDiffStart);
        const remainingMs = Math.max(0, DIFFICULTY_INTERVAL_MS - effectiveElapsedSinceLast);
        const remainingFrac = remainingMs / DIFFICULTY_INTERVAL_MS; // 1 -> just reset, 0 -> about to increase
        const barHeight = 14;
        const padding = 8;
        const y = canvas.height - barHeight - padding;
        // Above the bar: left = my name with color, right = playtime
        {
          const nameX = 8;
          const labelY = y - 6;
          ctx.font = '14px Arial';
          ctx.textAlign = 'left';
          ctx.globalAlpha = 1;
          let myName = '—';
          let colorHex = '#888';
          if (myPlayer) {
            myName = prettyName(myPlayer.playerId);
            if (myColorIndex != null && PLAYER_COLORS[myColorIndex]) colorHex = PLAYER_COLORS[myColorIndex].hex;
          }
          // Color dot
          ctx.fillStyle = colorHex;
          ctx.beginPath();
          ctx.arc(nameX + 6, labelY - 6, 5, 0, Math.PI * 2);
          ctx.fill();
          // Name with underline in color
          const textX = nameX + 18;
          ctx.fillStyle = '#fff';
          ctx.fillText(myName, textX, labelY);
          const w = ctx.measureText(myName).width;
          ctx.strokeStyle = colorHex + 'cc';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(textX, labelY + 3);
          ctx.lineTo(textX + w, labelY + 3);
          ctx.stroke();

          // Right side: FPS above playtime
          ctx.textAlign = 'right';
          ctx.fillStyle = '#fff';
          const fpsLabel = `FPS: ${currentFps} (avg: ${averageFps})`;
          ctx.fillText(fpsLabel, canvas.width - 8, labelY - 20);
          
          // Right side: playtime since session start
          const playMs = Math.max(0, nowMs - gameSessionStartTime);
          const totalSec = Math.floor(playMs / 1000);
          const h = Math.floor(totalSec / 3600);
          const m = Math.floor((totalSec % 3600) / 60);
          const s = totalSec % 60;
          const timeStr = h > 0
            ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
            : `${m}:${String(s).padStart(2,'0')}`;
          const rightLabel = `Playtime ${timeStr}`;
          ctx.textAlign = 'right';
          ctx.fillStyle = '#fff';
          ctx.fillText(rightLabel, canvas.width - 8, labelY);
          ctx.textAlign = 'left';
        }
        // Background bar (full width)
        ctx.fillStyle = '#222';
        ctx.globalAlpha = 0.85;
        ctx.fillRect(0, y, canvas.width, barHeight);
        // Foreground remaining width (shrinks as we approach next level)
        ctx.globalAlpha = 0.95;
        const remainingWidth = canvas.width * remainingFrac;
        ctx.fillStyle = '#ffcc00';
        ctx.fillRect(0, y, remainingWidth, barHeight);
        // Border
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, y + 0.5, canvas.width - 1, barHeight - 1);
        // Text above bar
        ctx.fillStyle = '#fff';
        ctx.font = '14px Arial';
        ctx.textAlign = 'center';
        const secondsRemaining = Math.ceil(remainingMs / 1000);
        const label = difficulty < 10
          ? `Difficulty ${difficulty}/10  •  Next in ${secondsRemaining}s`
          : `Difficulty ${difficulty}/10 (MAX)`;
        ctx.fillText(label, canvas.width / 2, y - 6);
      }

      // Throttled angle sync
      if (myPlayer && myPlayer.playerId) {
        const now2 = Date.now();
        if (now2 - lastAngleUpdateTime > 100 && myAngle !== lastAngleSent) {
          updateAngle(myPlayer.playerId, myAngle);
          lastAngleUpdateTime = now2;
          lastAngleSent = myAngle;
        }
        
        // Periodic presence updates every 3 seconds to ensure visibility
        if (now2 - lastPresenceUpdateTime > 3000) {
          setLastSeen(myPlayer.playerId);
          lastPresenceUpdateTime = now2;
        }
      }

      // Idle detection (movement = angle or layer changes)
      if (idleEnabled && !isIdle) {
        const idleFor = Date.now() - lastMovementTime;
        if (idleFor >= IDLE_TIMEOUT_MS) {
          // Transition to idle: mark inactive in DB and stop syncing
          isIdle = true;
          if (myPlayer?.playerId) {
            try { set(ref(db, `${ROOM}/players/${myPlayer.playerId}/active`), false); } catch {}
          }
          if (presenceInterval) { try { clearInterval(presenceInterval); } catch {} }
          try { unsubPlayers && unsubPlayers(); } catch {}
          try { unsubFlows && unsubFlows(); } catch {}
          try { clearInterval(spawnInterval); } catch {}
          try { clearInterval(difficultyInterval); } catch {}
          try { clearInterval(evilSpawnInterval); } catch {}
          try { clearInterval(layer5CleanupInterval); } catch {}
          try { goOffline(db); } catch {}
          return; // do not schedule next frame
        }
      }

      raf = requestAnimationFrame(loop);
    }
    loop();

    return () => {
      unsubPlayers && unsubPlayers();
      unsubFlows && unsubFlows();
      clearInterval(spawnInterval);
      clearInterval(difficultyInterval);
      clearInterval(evilSpawnInterval);
  clearInterval(layer5CleanupInterval);
      if (presenceInterval) clearInterval(presenceInterval);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      cancelAnimationFrame(raf);
      if (myPlayer) set(ref(db, `${ROOM}/players/${myPlayer.playerId}`), null);
    };
  });
</script>

<svelte:head>
  <title>Flow ~together~ made with 🩸, 💦 & ❤️ by a gothenburgian</title>
</svelte:head>

{#if dev}
<div style="position: absolute; top: 10px; right: 10px; z-index: 10;">
  <button on:click={toggleDebug} style="background:#333; color:#fff; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; margin-bottom:6px; width:100%;">
    {debugOpen ? 'Hide Debug' : 'Show Debug'}
  </button>
  <div id="debugPanel" style="background: #222; color: #fff; padding: 12px 18px; border-radius: 8px; width: 300px; max-height: 600px; overflow-y: auto; transition: opacity 0.25s ease;"
       style:display={debugOpen ? 'block' : 'none'}
       style:opacity={debugOpen ? 1 : 0}
  >
  <label for="difficultySlider">Difficulty: {difficulty}/10 {difficulty >= 2 ? '⚠️ Evil flows active' : ''}</label>
  <input id="difficultySlider" type="range" min="1" max="10" step="1" bind:value={difficulty} style="width: 100%; margin-top: 8px;" />
  
  <div style="margin-top: 12px;">
    <label for="speedSlider">Player Speed: {debugSpeed.toFixed(3)}</label>
    <input id="speedSlider" type="range" min="0.001" max="0.2" step="0.001" bind:value={debugSpeed} style="width: 100%; margin-top: 8px;" />
  </div>

  <div style="margin-top: 12px;">
  <label for="flowSpeedSlider">Flow Ball Speed: {effectiveFlowSpeedMultiplier().toFixed(2)}× (User {flowSpeedSliderValue.toFixed(2)}× · Diff {difficultySpeedMultiplier.toFixed(2)}×)</label>
  <input id="flowSpeedSlider" type="range" min="0.5" max="3" step="0.05" bind:value={flowSpeedSliderValue} style="width:100%; margin-top:8px;" />
    <div style="font-size:12px; opacity:.7; margin-top:4px;">
  Base {baseFlowDuration}ms → Effective {Math.round(currentFlowDuration())}ms · Avg {currentAvgSpeedPxPerSec().toFixed(1)} px/s
      <br />Cache: {Array.from(flowCache.keys()).length} flows retained
    </div>
  </div>

  <div style="margin-top: 12px;">
    <label for="colorSelect">Player Color</label>
    <div style="margin-top:4px; font-size:12px; opacity:.85;">
      Game slots (active): {activeUsedColorsAll.size}/{PLAYER_COLORS.length}
    </div>
    <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
      {#each PLAYER_COLORS as c, idx}
        {#key activeUsedColorsAll}
          <div
            title={ownerLabelFor(idx) ? `Taken by ${ownerLabelFor(idx)}` : 'Available'}
            style={`width:16px;height:16px;border-radius:50%;
                    background:${activeUsedColorsAll.has(idx)?PLAYER_COLORS[idx].hex:'#444'};
                    border:${myColorIndex===idx?'2px solid #fff':'1px solid #666'};
                    box-shadow:${activeUsedColorsAll.has(idx)?'0 0 6px rgba(255,255,255,.2)':'none'};
                    `}
          ></div>
        {/key}
      {/each}
    </div>
    {#if myPlayer}
      <select id="colorSelect" style="width: 100%; margin-top: 6px;"
        on:change={(e) => {
          const idx = parseInt(e.currentTarget.value);
          if (!isNaN(idx)) { myColorIndex = idx; updateColor(myPlayer!.playerId, idx); }
        }}>
        {#each PLAYER_COLORS as c, idx}
          {#key usedColors}
            <option value={idx} selected={idx === myColorIndex} disabled={usedColors.has(idx) && idx !== myColorIndex}
              title={ownerLabelFor(idx) ? `Taken by ${ownerLabelFor(idx)}` : 'Available'}>
              {c.name}{ownerLabelFor(idx) ? ` — ${idx === myColorIndex ? 'yours' : 'taken by ' + ownerLabelFor(idx)}` : ''}
            </option>
          {/key}
        {/each}
      </select>
      <div style="margin-top:6px; display:flex; gap:6px; align-items:center;">
        <div style={`width:16px;height:16px;border-radius:50%;background:${myColorIndex!=null?PLAYER_COLORS[myColorIndex].hex:'#888'};`}></div>
        <span style="font-size:13px;opacity:.8;">{myColorIndex!=null?PLAYER_COLORS[myColorIndex].name:'Unassigned'}</span>
      </div>
      {#if isQueued}
        <div style="margin-top:10px; background:#331a1a; padding:8px 10px; border:1px solid #552a2a; border-radius:6px; font-size:13px; line-height:1.4;">
          <b style="color:#f99;">Queue</b><br />
          {#if canClaimSpot}
            <div style="margin-top:4px;">A color is free! <button style="background:#662222; color:#fff; border:1px solid #aa4444; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:12px;" on:click={claimFreeColor}>Claim Spot</button></div>
          {:else}
            Waiting for a free color slot... ({usedColors.size}/{PLAYER_COLORS.length} in use)
          {/if}
        </div>
      {/if}
    {/if}
  </div>
  
  <div style="margin-top: 12px; font-size: 14px;">
    <b>DB Download:</b><br />
    { (dbBytesPerSecond/1024).toFixed(2) } KB/s<br />
    { (dbBytesPerSecond/1024/1024).toFixed(3) } MB/s<br />
    <span style="font-size:13px;">Last minute: { (dbBytesLastMinute/1024).toFixed(1) } KB / { (dbBytesLastMinute/1024/1024).toFixed(3) } MB</span>
  </div>
  <button style="margin-top: 14px; width: 100%; padding: 8px; background: #444; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={() => { spawnBurst(8, 0); }}>
    Create Flow Burst
  </button>
  <button style="margin-top: 8px; width: 100%; padding: 8px; background: #661111; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={() => { spawnBurst(8, 1); }}>
    Create Evil Flow Burst
  </button>
  <div style="margin-top: 10px; font-size: 13px;">
    <b>Flow Balls:</b> {flowBallsSpawned} total<br />
    Last minute: {flowBallsSpawnedLastMinute}
    <br /><b>Evil Flows:</b> {evilFlowBallsSpawned} total · Last minute: {evilFlowBallsLastMinute}
    <br />Ratio (evil/total last min): {flowBallsSpawnedLastMinute? ((evilFlowBallsLastMinute/flowBallsSpawnedLastMinute)*100).toFixed(1):'0.0'}%
  </div>
  <button style="margin-top: 8px; width: 100%; padding: 8px; background: #2e2e2e; color: #fff; border: 1px solid #555; border-radius: 4px; cursor: pointer;" on:click={logPlayersInfo}>
    Log Player Data to Console
  </button>
  <div style="margin-top: 12px;">
    <b>Bot Players ({botPlayers.size}/{PLAYER_COLORS.length})</b>
    <label style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:12px;">
      <input type="checkbox" bind:checked={autoSpawnBotOnJoin} />
      Auto-add 1 bot on join
    </label>
    <div style="margin-top:4px; font-size:11px; opacity:.65;">
      Automatically spawns one bot player when you join the game. Persists across sessions.
    </div>
    <button style="margin-top: 6px; width: 100%; padding: 8px; background: #336633; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={spawnBot}>
      Add Bot Player
    </button>
    {#if botPlayers.size > 0}
      <button style="margin-top: 6px; width: 100%; padding: 8px; background: #663333; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={() => removeBot()}>
        Remove Bot
      </button>
      <div style="margin-top:4px; font-size:12px; opacity:.8;">
        {#each Array.from(botPlayers.values()) as bot, i}
          <div>Bot {i + 1}: Layer {bot.layer}, Boost {bot.speedBoost}</div>
        {/each}
      </div>
    {/if}
  </div>
  <div style="margin-top: 12px;">
    <b>Game Layers ({numLayers}/{MAX_LAYERS})</b>
    {#if manualLayerCount !== null}
      <div style="margin-top:4px; font-size:12px; color:#fa3;">Manual override active</div>
    {/if}
    <div style="display: flex; gap: 4px; margin-top: 6px;">
      <button 
        style="flex: 1; padding: 8px; background: #663333; color: #fff; border: none; border-radius: 4px; cursor: pointer;"
        disabled={numLayers <= 1}
        on:click={() => {
          if (manualLayerCount === null) {
            manualLayerCount = numLayers;
          }
          manualLayerCount = Math.max(1, manualLayerCount - 1);
        }}>
        − Remove Layer
      </button>
      <button 
        style="flex: 1; padding: 8px; background: #336633; color: #fff; border: none; border-radius: 4px; cursor: pointer;"
        disabled={numLayers >= MAX_LAYERS}
        on:click={() => {
          if (manualLayerCount === null) {
            manualLayerCount = numLayers;
          }
          manualLayerCount = Math.min(MAX_LAYERS, manualLayerCount + 1);
        }}>
        + Add Layer
      </button>
    </div>
    {#if manualLayerCount !== null}
      <button 
        style="margin-top: 6px; width: 100%; padding: 6px; background: #444; color: #fff; border: 1px solid #666; border-radius: 4px; cursor: pointer; font-size: 12px;"
        on:click={() => { manualLayerCount = null; }}>
        Reset to Auto (by active players)
      </button>
    {/if}
  </div>
  <button style="margin-top: 8px; width: 100%; padding: 8px; background: #444; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={async () => {
    const removed = await pruneOldFlows(5 * 60 * 1000);
    console.debug('Pruned old flows (5m):', removed);
  }}>
    Prune Old Flows (older than 5 min)
  </button>
  <button style="margin-top: 8px; width: 100%; padding: 8px; background: #884400; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={debugRemoveLayer5}>
    Remove Layer 5 Flows (debug)
  </button>
  <button style="margin-top: 8px; width: 100%; padding: 8px; background: #b00; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;" on:click={debugRemoveAllFlows}>
    Remove ALL Flows (debug)
  </button>
  <button style="margin-top: 8px; width: 100%; padding: 8px; background: #444; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={async () => {
    const updated = await cleanupPlayerMeta();
    console.debug('Player meta cleanup complete. Records updated:', updated);
  }}>
    Cleanup Player Meta
  </button>
  <button style="margin-top: 8px; width: 100%; padding: 8px; background: #664400; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={async () => {
    console.log('🧹 Cleaning up inactive players...');
    const result = await cleanupInactivePlayers(5 * 60 * 1000);
    console.log(`Removed ${result.removed} inactive players, archived ${result.archived} to highscores`);
  }}>
    Cleanup Inactive Players (5min)
  </button>
  <button style="margin-top: 8px; width: 100%; padding: 8px; background: #336633; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={async () => {
    console.log('📊 Analyzing database size...');
    const analysis = await analyzeDbSize();
    const formatBytes = (b: number) => {
      if (b < 1024) return `${b} B`;
      if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KB`;
      return `${(b / 1024 / 1024).toFixed(2)} MB`;
    };
    const sorted = Object.entries(analysis.tree).sort((a: any, b: any) => b[1].bytes - a[1].bytes);
    console.log(`\n🗄️  Total Database Size: ${formatBytes(analysis.total)}\n`);
    console.log('📁 Breakdown by collection:\n');
    sorted.forEach(([name, info]: [string, any]) => {
      const pct = ((info.bytes / analysis.total) * 100).toFixed(1);
      console.log(`  ${name.padEnd(15)} ${formatBytes(info.bytes).padStart(12)}  (${pct}%)  [${info.count} items]`);
      if (info.sample && info.sample.length > 0) {
        console.log(`    Sample keys: ${info.sample.join(', ')}`);
      }
    });
    console.log('\n💡 Tip: Use "Remove ALL Flows" or "Prune Old Flows" to reduce database size.\n');
  }}>
    Analyze Database Size
  </button>
  <div style="margin-top:12px; font-size:13px; line-height:1.4; background:#1a1a1a; padding:8px 10px; border-radius:6px;">
    <b>Idle Timer</b>
    <span style="margin-left:8px; font-size:10px; padding:2px 6px; border-radius:4px;"
      style:background={windowActive ? '#114422' : '#444'}
      style:color={windowActive ? '#8f8' : '#ccc'}
      style:border={windowActive ? '1px solid #2a6a2a' : '1px solid #555'}>
      Window: {windowActive && !hidden ? 'ACTIVE' : 'INACTIVE'}
    </span>
    <span style="margin-left:8px; font-size:11px; padding:2px 6px; border-radius:4px; background:{isIdle ? '#661111' : '#116611'}; color:#fff;">
      {isIdle ? 'IDLE' : 'ACTIVE'}
    </span>
    <br />
    <label style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:12px;">
      <input type="checkbox" bind:checked={idleEnabled} on:change={() => {
        if (!idleEnabled && isIdle) {
          // Re-enable immediately when unchecking while idle
          location.reload();
        }
      }} /> Enable idle auto-off (1 min)
    </label>
    <label style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:12px;">
      <input type="checkbox" bind:checked={markInactiveOnWindowInactive} />
      Mark me inactive when window/tab is inactive
    </label>
    <div style="margin-top:4px; font-size:11px; opacity:.65;">
      If enabled, losing focus or hiding the tab will set you inactive and stop the game. This persists across sessions.
    </div>
    {#if !isIdle}
      {#if idleEnabled}
        <div style="margin-top:4px;">Time until idle: {(idleRemainingMs/1000).toFixed(1)}s</div>
      {:else}
        <div style="margin-top:4px; opacity:0.6;">Timer paused (auto-off disabled)</div>
      {/if}
      <button style="margin-top:6px; width:100%; padding:4px 8px; background:#552222; color:#fff; border:1px solid #883333; border-radius:4px; cursor:pointer; font-size:11px;" on:click={() => {
        isIdle = true;
        if (myPlayer?.playerId) {
          try { set(ref(db, `${ROOM}/players/${myPlayer.playerId}/active`), false); } catch {}
        }
      }}>
        Set as Idle (debug)
      </button>
    {:else}
      <div style="margin-top:4px; color:#f66;">
        You are idle. <button style="background:#333; color:#fff; border:1px solid #555; border-radius:4px; padding:2px 6px; cursor:pointer;" on:click={() => { location.reload(); }}>Rejoin Game</button>
      </div>
    {/if}
  </div>
  </div>
</div>
{/if}

<!-- Canvas Container with Scoreboard Overlay -->
<div style="position: relative; display: inline-block; margin: 0 auto;">
  <canvas id="gameCanvas" class="mx-auto block" width={CANVAS_SIZE} height={CANVAS_SIZE}></canvas>
  
  <!-- Scoreboard Overlay (top-left of canvas) -->
  <div style="position: absolute; top: 0; left: 0; pointer-events: none; width: 100%; height: 100%;">
    <div style="position: absolute; top: 2.5%; left: 2.5%; pointer-events: auto;">
      <div style="font-family: Arial, sans-serif; color: #fff; font-size: 2.2vmin; font-weight: bold; margin-bottom: 1vmin; opacity: 0.9;">
        Scores
      </div>
      {#each scoreboardList as entry, i (entry.id)}
        {@const FlagComp = getFlagComponent(entry.country)}
        <div style="display: flex; align-items: center; gap: 1vmin; margin-bottom: 0.25vmin; opacity: {entry.active ? 1 : 0.45}; font-family: Arial, sans-serif; font-size: 1.95vmin;">
          {#if FlagComp}
            <svelte:component this={FlagComp} style="width: 2.4vmin; height: 1.8vmin; border-radius: 0.25vmin; overflow: hidden; flex-shrink: 0;" />
          {:else}
            <span style="width: 2.4vmin; display: inline-block; flex-shrink: 0;">🏳️</span>
          {/if}
          <span style="color: #fff; text-decoration: underline; text-decoration-color: {entry.color}; text-decoration-thickness: 0.25vmin; text-underline-offset: 0.4vmin;">
            {entry.name}
          </span>
          <span style="color: #fff; margin-left: 0.25vmin;">
            {entry.score}
          </span>
          <span style="color: #f88; margin-left: 0.25vmin;">
            -{entry.hits}
          </span>
        </div>
      {/each}
    </div>
  </div>
</div>

<!-- Inactive Player Dialog -->
{#if showInactiveDialog}
<div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.75); z-index: 100; display: flex; align-items: center; justify-content: center;">
  <div style="background: #222; color: #fff; padding: 30px 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); text-align: center; max-width: 400px;">
    <h2 style="margin: 0 0 16px 0; font-size: 24px; color: #f99;">You've Been Marked Inactive</h2>
    <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.5;">Your session was paused due to inactivity. Click the button below to refresh and rejoin the game.</p>
    <button on:click={() => location.reload()} style="background: #4CAF50; color: #fff; border: none; border-radius: 6px; padding: 12px 24px; font-size: 16px; font-weight: bold; cursor: pointer; transition: background 0.2s;">
      Refresh & Rejoin
    </button>
  </div>
</div>
{/if}

<!-- Mobile Controls (bottom-center) -->
<div style="position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); z-index: 10; display: flex; flex-direction: column; align-items: center; gap: 8px;">
  <!-- Up button -->
  <button
    aria-label="Up"
    aria-pressed={mobileUpPressed}
    on:pointerdown={() => { mobileUpPressed = true; simulateKey('ArrowUp', true); }}
    on:pointerup={() => { mobileUpPressed = false; simulateKey('ArrowUp', false); }}
    on:pointerleave={() => { mobileUpPressed = false; simulateKey('ArrowUp', false); }}
    on:pointercancel={() => { mobileUpPressed = false; simulateKey('ArrowUp', false); }}
    style={`background:${mobileUpPressed?'#555':'#333'}; color:#fff; border:2px solid ${mobileUpPressed?'#aaa':'#555'}; border-radius:8px; width:60px; height:60px; font-size:24px; cursor:pointer; user-select:none; touch-action:none; box-shadow:${mobileUpPressed?'inset 0 2px 6px rgba(0,0,0,.6)':'0 2px 6px rgba(0,0,0,.3)'}; transform:${mobileUpPressed?'translateY(1px)':'none'}; transition: background .08s, border-color .08s, box-shadow .08s, transform .08s;`}>
  ⬆️
  </button>
  <!-- Left, Down, Right buttons -->
  <div style="display: flex; gap: 8px;">
    <button
      aria-label="Left"
      aria-pressed={mobileLeftPressed}
      on:pointerdown={() => { mobileLeftPressed = true; simulateKey('ArrowLeft', true); }}
      on:pointerup={() => { mobileLeftPressed = false; simulateKey('ArrowLeft', false); }}
      on:pointerleave={() => { mobileLeftPressed = false; simulateKey('ArrowLeft', false); }}
      on:pointercancel={() => { mobileLeftPressed = false; simulateKey('ArrowLeft', false); }}
      style={`background:${mobileLeftPressed?'#555':'#333'}; color:#fff; border:2px solid ${mobileLeftPressed?'#aaa':'#555'}; border-radius:8px; width:60px; height:60px; font-size:24px; cursor:pointer; user-select:none; touch-action:none; box-shadow:${mobileLeftPressed?'inset 0 2px 6px rgba(0,0,0,.6)':'0 2px 6px rgba(0,0,0,.3)'}; transform:${mobileLeftPressed?'translateY(1px)':'none'}; transition: background .08s, border-color .08s, box-shadow .08s, transform .08s;`}>
  ⬅️
    </button>
    <button
      aria-label="Down"
      aria-pressed={mobileDownPressed}
      on:pointerdown={() => { mobileDownPressed = true; simulateKey('ArrowDown', true); }}
      on:pointerup={() => { mobileDownPressed = false; simulateKey('ArrowDown', false); }}
      on:pointerleave={() => { mobileDownPressed = false; simulateKey('ArrowDown', false); }}
      on:pointercancel={() => { mobileDownPressed = false; simulateKey('ArrowDown', false); }}
      style={`background:${mobileDownPressed?'#555':'#333'}; color:#fff; border:2px solid ${mobileDownPressed?'#aaa':'#555'}; border-radius:8px; width:60px; height:60px; font-size:24px; cursor:pointer; user-select:none; touch-action:none; box-shadow:${mobileDownPressed?'inset 0 2px 6px rgba(0,0,0,.6)':'0 2px 6px rgba(0,0,0,.3)'}; transform:${mobileDownPressed?'translateY(1px)':'none'}; transition: background .08s, border-color .08s, box-shadow .08s, transform .08s;`}>
  ⬇️
    </button>
    <button
      aria-label="Right"
      aria-pressed={mobileRightPressed}
      on:pointerdown={() => { mobileRightPressed = true; simulateKey('ArrowRight', true); }}
      on:pointerup={() => { mobileRightPressed = false; simulateKey('ArrowRight', false); }}
      on:pointerleave={() => { mobileRightPressed = false; simulateKey('ArrowRight', false); }}
      on:pointercancel={() => { mobileRightPressed = false; simulateKey('ArrowRight', false); }}
      style={`background:${mobileRightPressed?'#555':'#333'}; color:#fff; border:2px solid ${mobileRightPressed?'#aaa':'#555'}; border-radius:8px; width:60px; height:60px; font-size:24px; cursor:pointer; user-select:none; touch-action:none; box-shadow:${mobileRightPressed?'inset 0 2px 6px rgba(0,0,0,.6)':'0 2px 6px rgba(0,0,0,.3)'}; transform:${mobileRightPressed?'translateY(1px)':'none'}; transition: background .08s, border-color .08s, box-shadow .08s, transform .08s;`}>
  ➡️
    </button>
  </div>
</div>

<style>
  :global(html, body) { margin: 0; background: #111; }
  canvas { max-width: 100vw; max-height: 100vh; object-fit: contain; }
  /* Improve readability of the color dropdown in the dark debug panel */
  #debugPanel select {
    background: #333;
    color: #fff;
    border: 1px solid #555;
    padding: 6px 8px;
    border-radius: 6px;
  }
  #debugPanel select:focus {
    outline: 2px solid #888;
    outline-offset: 2px;
  }
  #debugPanel option {
    background: #2a2a2a;
    color: #fff;
  }
</style>

<!-- Lifetime Highscores Panel (bottom-left) -->
<div style="position: absolute; bottom: 10px; left: 10px; z-index: 9;">
  <button on:click={() => { hsOpen = !hsOpen; }}
    style="background:#333; color:#fff; border:1px solid #555; border-radius:6px; padding:6px 10px; cursor:pointer; width: 320px; text-align:left; margin-bottom:6px;">
    {hsOpen ? 'Hide Highscores' : 'Show Highscores'}
  </button>
  <div style="background:#1d1d1d; color:#fff; padding:10px 12px; border-radius:8px; width: 320px; box-shadow: 0 2px 10px rgba(0,0,0,.35);"
       style:display={hsOpen ? 'block' : 'none'}
       style:opacity={hsOpen ? 1 : 0}
  >
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <div style="font-weight:600;">Lifetime Highscores</div>
      {#if Date.now() - hsLastLoaded >= HS_RELOAD_COOLDOWN}
        <button title="Reload (5 min cooldown)" on:click={reloadHighscoresIfAllowed}
          style="background:#333; color:#fff; border:1px solid #555; border-radius:6px; padding:4px 8px; cursor:pointer;">
          ⟳ Reload
        </button>
      {:else}
        <button title="Reload available soon" disabled
          style="background:#222; color:#777; border:1px solid #444; border-radius:6px; padding:4px 8px; cursor:not-allowed;">
          ⟳ Reload
        </button>
      {/if}
    </div>
    {#if highscores.length === 0}
      <div style="font-size:13px; opacity:.8;">No data yet.</div>
    {:else}
      <div style="max-height: 400px; overflow:auto;">
        {#each highscores as h, i (h.id)}
          {@const FlagComp = getFlagComponent(h.country)}
          <div style="display:flex; align-items:center; gap:10px; padding:6px 0; border-top: 1px solid #2a2a2a;"
               style:opacity={players.some(pl => pl.id === h.id) ? 1 : 0.55}
               title={`Last updated: ${h.lastUpdated?new Date(h.lastUpdated).toLocaleString():''}${h.country?`\nCountry: ${h.country}`:''}`}>
            <div style="width: 24px; text-align:right; opacity:.8;">{i+1}.</div>
            <div style="flex:1;">
              <div style="font-size:14px; display:flex; align-items:center; gap:6px;">
                {#if FlagComp}
                  <svelte:component this={FlagComp} style="width:16px;height:12px;border-radius:2px; overflow:hidden;" />
                {/if}
                <span>
                  {prettyName(h.id)}
                </span>
              </div>
              <div style="font-size:12px; opacity:.8;">Catches: {h.totalCatches || 0} · Evil hits: {h.evilHits || 0}</div>
            </div>
          </div>
        {/each}
      </div>
      <div style="margin-top:6px; font-size:11px; opacity:.7;">Last updated: {new Date(hsLastLoaded).toLocaleTimeString()}</div>
    {/if}
  </div>
</div>