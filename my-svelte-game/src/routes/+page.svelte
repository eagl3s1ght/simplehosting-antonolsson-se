<script lang="ts">
  import { onMount } from 'svelte';
  import { joinGame, listenPlayers as origListenPlayers, listenFlows as origListenFlows, updateAngle, updateLayer, updateColor, incrementScore, decrementScore, spawnFlow, recordCatch, recordEvilHit, pruneOldFlows, fetchHighscores, removeAllFlows, updateFlowLayer, removeLayer5Flows, cleanupPlayerMeta, setPlayerActive, setLastSeen, analyzeDbSize, auth, db, ROOM } from '$lib/firebase.js';
  async function debugRemoveAllFlows() {
    const removed = await removeAllFlows();
    console.log(`Removed ${removed} flows from DB.`);
  }
  async function debugRemoveLayer5() {
    const removed = await removeLayer5Flows();
    console.log(`Removed ${removed} layer-5 flows from DB.`);
  }
  import { ref, set, goOffline } from 'firebase/database';
  import { browser } from '$app/environment';

  // Types (lightweight to silence TS diagnostics)
  type Player = { id: string; name: string; angle: number; score: number; layer?: number; colorIndex?: number; createdAt?: number; active?: boolean; lastSeen?: number; meta?: any };
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
  let keys: Record<string, boolean> = {};
  const PIPE_WIDTH = 0.4;
  
  // Layer system - 5 concentric circles
  const NUM_LAYERS = 5;
  const INNER_R = 60;
  const OUTER_R = 380;
  const LAYER_SPACING = (OUTER_R - INNER_R) / NUM_LAYERS;
  const LAYER_RADII = Array.from({ length: NUM_LAYERS }, (_, i) => INNER_R + LAYER_SPACING * (i + 1));
  // Layer colors: lighter gray near sun, darker gray far from sun
  const LAYER_COLORS = [
    '#6b6b6b', // Layer 0 (innermost) - lightest gray
    '#5a5a5a', // Layer 1
    '#494949', // Layer 2
    '#383838', // Layer 3
    '#272727'  // Layer 4 (outermost) - darkest gray
  ];
  
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
  let myLayer = 0; // Current layer (0-4)
  let myColorIndex: number | null = null;
  let debugOpen = true; // debug panel visibility
  // Highscores state
  type Highscore = { id:string; totalCatches?:number; evilHits?:number; name?:string; colorIndex?:number; country?: string; lastUpdated?:number };
  let highscores: Highscore[] = [];
  let hsLastLoaded = 0; // timestamp
  const HS_RELOAD_COOLDOWN = 5 * 60 * 1000; // 5 minutes
  let FlagComp: any = null;
  let uniqGen: any = null; let dictAdj: any = null; let dictAnimals: any = null;

  // Idle timer state
  const IDLE_TIMEOUT_MS = 60_000; // 1 minute
  let idleEnabled = true; // debug toggle; when false, idle never triggers (will be loaded from storage)
  let isIdle = false; // set to true once we go idle and stop DB activity
  let lastMovementTime = Date.now();
  let idleRemainingMs = IDLE_TIMEOUT_MS;
  let uiNow = Date.now();
  let uiTickInterval: any;
  // Browser activity (focus/visibility) tracking
  let windowActive = true; // focused & visible
  let hidden = false;
  let storageLoaded = false; // prevent reactive save from running before initial load

  // Fixed palette with animal-themed names
  const PLAYER_COLORS = [
  { name: 'Night Violet', hex: '#5E35B1' },       // Deep Purple
  { name: 'Mystic Purple', hex: '#7E57C2' },      // Medium Purple
  { name: 'Indigo', hex: '#3949AB' },             // Indigo Blue
  { name: 'Sky Blue', hex: '#1E88E5' },           // Bright Blue
  { name: 'Teal', hex: '#00897B' },               // Teal
  { name: 'Forest Green', hex: '#43A047' },       // Forest Green
  { name: 'Lime Green', hex: '#7CB342' },         // Lime Green
  { name: 'Meadow', hex: '#D4E157' },             // Yellow-Green
  { name: 'Golden Yellow', hex: '#FFCA28' },      // Golden Yellow
  { name: 'Solar Orange', hex: '#FB8C00' },       // Orange
  { name: 'Ember Orange', hex: '#E64A19' },       // Red-Orange
  { name: 'Crimson Red', hex: '#D32F2F' }         // Red
  ];

  // Reactive: compute used colors by other players
  $: usedColors = new Set<number>(
    players.filter(pl => pl && (!myPlayer || pl.id !== myPlayer.playerId) && pl.colorIndex != null).map(pl => pl.colorIndex as number)
  );

  // Map color index -> array of players who use it (including me)
  $: colorOwners = (() => {
    const m = new Map<number, Player[]>();
    for (const pl of players) {
      const idx = pl?.colorIndex;
      if (idx == null) continue;
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

  function colorForPlayer(p: Player): string {
    const idx = (myPlayer && p.id === myPlayer.playerId) ? (myColorIndex ?? p.colorIndex) : p.colorIndex;
    if (idx != null && PLAYER_COLORS[idx]) return PLAYER_COLORS[idx].hex;
    return '#888';
  }

  // Queue state for players when all colors are taken
  let isQueued = false;      // true if we are waiting for a free color slot
  let canClaimSpot = false;  // true if a color became available while queued
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
    try { setPlayerActive(myPlayer.playerId, true); } catch {}
    try { set(ref(db, `${ROOM}/players/${myPlayer.playerId}/queued`), null); } catch {}
    isQueued = false;
    canClaimSpot = false;
    console.log('[Queue] Claimed color spot', chosen);
  }

  // Persist debug panel state in session storage
  onMount(() => {
    if (browser) {
      const saved = sessionStorage.getItem('debugOpen');
      if (saved === '0') debugOpen = false;
      const hsSaved = sessionStorage.getItem('hsLastLoaded');
      if (hsSaved) hsLastLoaded = parseInt(hsSaved) || 0;
      const idleSaved = localStorage.getItem('idleEnabled');
      if (idleSaved !== null) {
        idleEnabled = idleSaved === '1';
        console.log('[Idle] Loaded setting from storage:', idleEnabled);
      }
      storageLoaded = true;
    }
    // Try to load external libs dynamically (non-blocking)
    import('unique-names-generator').then((m) => { uniqGen = m.uniqueNamesGenerator; dictAdj = m.adjectives; dictAnimals = m.animals; }).catch(() => {});
    import('svelte-flag-icons').then((m) => { FlagComp = (m as any).Flag || (m as any).default || null; }).catch(() => {});
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
    const onFocus = () => { windowActive = true; };
    const onBlur = () => { windowActive = false; };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    const onVisibility = () => {
      hidden = document.hidden;
      windowActive = !hidden && document.hasFocus();
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
  $: if (browser) sessionStorage.setItem('debugOpen', debugOpen ? '1' : '0');
  $: if (browser) sessionStorage.setItem('hsLastLoaded', String(hsLastLoaded));
  $: if (browser && storageLoaded) {
    localStorage.setItem('idleEnabled', idleEnabled ? '1' : '0');
    console.log('[Idle] Saved setting to storage:', idleEnabled);
  }
  function toggleDebug() { debugOpen = !debugOpen; }
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
      const list = await fetchHighscores(20);
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
  
  function checkScore(flow: Flow) {
    if (!myPlayer) return;
    
    // Create unique ID for this flow based on spawn time and angle
    const flowId = `${flow.spawnTime}_${flow.angle.toFixed(4)}`;
    
    // Skip if already scored or marked for removal
    if (scoredFlows.has(flowId) || flowsToRemove.has(flowId)) return;
    
  const now = Date.now();
  const progress = ((now - flow.spawnTime) / currentFlowDuration()) * speedBiasForAngle(flow.angle);
    const flowRadius = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);

    // Determine target layer and radius for this player
    const targetLayer = Math.max(0, Math.min(NUM_LAYERS - 1, myLayer));
    const targetRadius = LAYER_RADII[targetLayer];

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
          recordEvilHit(myPlayer.playerId);
          hurtUntil = now + 400; // Blink for 400ms (2 blinks at ~200ms each)
          console.debug('HIT BY EVIL FLOW! Score reduced', {
            flowId,
            flowAngle: flow.angle,
            playerAngle: myAngle,
            layer: targetLayer
          });
        } else {
          // Normal flow increases score
          incrementScore(myPlayer.playerId);
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
            layer: targetLayer
          });
        }
      }
    }
  }

  onMount(() => {
    if (!browser) return;
    canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;

  let unsubPlayers: () => void = () => {};
  let unsubFlows: () => void = () => {};
  let presenceInterval: any;
    const init = async () => {
  const joined = await joinGame(() => {});
  myPlayer = joined as any;
  if (myPlayer) {
    myAngle = myPlayer.playerData.angle;
    myLayer = (myPlayer.playerData as any).layer ?? 0;
        myColorIndex = (myPlayer.playerData as any).colorIndex ?? null;
    console.log('Player joined:', myPlayer.playerId);
      // Start presence heartbeat (every 10s)
      presenceInterval = setInterval(() => {
        if (myPlayer?.playerId) setLastSeen(myPlayer.playerId);
      }, 10000);
  }

      unsubPlayers = listenPlayers(p => {
        players = p;
        if (myPlayer) {
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
                  try { setPlayerActive(myPlayer.playerId, true); } catch {}
                  try { set(ref(db, `${ROOM}/players/${myPlayer.playerId}/queued`), null); } catch {}
                  console.log('[Queue] Auto-assigned color', chosen);
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

    // Increase difficulty every minute
    const difficultyInterval = setInterval(() => {
      if (pauseForNoPlayers) return; // freeze difficulty while paused
      if (difficulty < 10) {
        difficulty++;
        difficultyLastAutoIncreaseAt = Date.now();
        pauseAccumAtDiffStart = pauseAccumulatedMs;
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

    // Keyboard
    const onKey = (e: KeyboardEvent) => {
      keys[e.key] = e.type === 'keydown';
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);

    // Throttle state
    let lastAngleUpdateTime = 0;
    let lastAngleSent = myAngle;
    let raf: number;

    function loop() {
      if (isIdle) return; // stop rendering & DB sync when idle
      if (!ctx || !canvas) return;
      
      // Get current time at the start of the loop
      const now = Date.now();
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
      
      // Input
      if (keys.ArrowLeft || keys.a || keys.A) { myAngle = normalizeAngle(myAngle - debugSpeed); lastMovementTime = Date.now(); }
      if (keys.ArrowRight || keys.d || keys.D) { myAngle = normalizeAngle(myAngle + debugSpeed); lastMovementTime = Date.now(); }
      
        // Layer switching with debounce (200ms between changes)
        if ((keys.ArrowUp || keys.w || keys.W || keys.ArrowDown || keys.s || keys.S) && now - lastLayerChange > 200) {
          if ((keys.ArrowUp || keys.w || keys.W) && myLayer > 0) {
            myLayer--;
            lastLayerChange = now;
            lastMovementTime = Date.now();
            if (myPlayer?.playerId) updateLayer(myPlayer.playerId, myLayer);
          } else if ((keys.ArrowDown || keys.s || keys.S) && myLayer < NUM_LAYERS - 1) {
            myLayer++;
            lastLayerChange = now;
            lastMovementTime = Date.now();
            if (myPlayer?.playerId) updateLayer(myPlayer.playerId, myLayer);
          }
        }

      // Clear
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Center circle
      ctx.fillStyle = '#ff0';
      ctx.beginPath();
      ctx.arc(CENTER_X, CENTER_Y, INNER_R, 0, Math.PI * 2);
      ctx.fill();
      
        // Draw layer rings (from innermost to outermost)
        for (let i = 0; i < NUM_LAYERS; i++) {
          const innerRadius = i === 0 ? INNER_R : LAYER_RADII[i - 1];
          const outerRadius = LAYER_RADII[i];
        
          ctx.fillStyle = LAYER_COLORS[i];
          ctx.beginPath();
          ctx.arc(CENTER_X, CENTER_Y, outerRadius, 0, Math.PI * 2);
          ctx.arc(CENTER_X, CENTER_Y, innerRadius, 0, Math.PI * 2, true); // Draw hole
          ctx.fill();
        }

      // Players - each gets a unique color based on their ID
      players.forEach((p, i) => {
        if (!p || !p.id) return;
        
        // Check if this is the current player and if hurt animation is active
        const isMyPlayer = i === 0;
        const isHurt = isMyPlayer && now < hurtUntil;
        
        // Blink effect: show/hide every 100ms during hurt animation
        if (isHurt && Math.floor((hurtUntil - now) / 100) % 2 === 0) {
          return; // Skip rendering during blink-off phase
        }
        
    // Generate unique color from player ID (stable across sessions)
  // Use palette color if assigned
  const cIndex = (i === 0 ? myColorIndex : p.colorIndex);
  const color = (cIndex != null && PLAYER_COLORS[cIndex]) ? PLAYER_COLORS[cIndex].hex : '#888';
        
    // Get player's layer and corresponding radius
    const playerLayer = i === 0 ? myLayer : (p.layer ?? 0);
    const layerRadius = LAYER_RADII[playerLayer];
        
        ctx.strokeStyle = color;
        ctx.lineWidth = 25;
        ctx.lineCap = 'round';
        ctx.beginPath();
        const angle = i === 0 ? myAngle : p.angle;
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
      });

      // Flows - render from cache and remove by radius threshold (with generous overshoot)
      const activeFlows: Flow[] = [];
  const overshootPx = 240; // keep flows until further past canvas edge (doubled)
      flowCache.forEach((flow, id) => {
        if (flowsToRemove.has(id)) return; // collided -> skip
        const age = Math.max(0, (now - flow.spawnTime) - pauseAccumulatedMs);
        const progress = (age / currentFlowDuration()) * speedBiasForAngle(flow.angle);
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
        const rawProgress = (Math.max(0, (now - flow.spawnTime) - pauseAccumulatedMs) / currentFlowDuration()) * speedBiasForAngle(flow.angle);
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
        // Remove collided flows from cache immediately
        flowsToRemove.forEach((fid) => { if (flowCache.has(fid)) flowCache.delete(fid); });
      }

      // Scores overlay (sorted by score desc): [flag] [name] [score] [-hits] (session + active filtering, grayed inactive)
      {
        const hsMap = new Map<string, Highscore>(highscores.map(h => [h.id, h]));
        const list = [...players]
          .filter(p => p && p.id)
          .filter(p => {
            const ls = (p as any)?.lastSeen;
            const inSession = typeof ls === 'number' ? (ls >= gameSessionStartTime) : true;
            return inSession;
          })
          .sort((a, b) => (b.score || 0) - (a.score || 0));
        const leftPad = 20;
        const topPad = 40;
        const lineH = 24;
        ctx.textAlign = 'left';
        ctx.font = '16px Arial';
        list.forEach((p, i) => {
          const y = topPad + i * lineH;
          const name = prettyName(p.id);
          const score = typeof p.score === 'number' ? p.score : 0;
          const hs = hsMap.get(p.id);
          const hits = hs?.evilHits ?? 0;
          const cc = hs?.country || getCountryFromMeta((p as any)?.meta) || null;
          const flag = countryCodeToFlagEmoji(cc);
          const activeFlag = (p as any)?.active !== false;
          const ls = (p as any)?.lastSeen;
          const fresh = typeof ls === 'number' ? (Date.now() - ls) < 30000 : true;
          const currentlyActive = activeFlag && fresh;
          ctx.globalAlpha = currentlyActive ? 1 : 0.45;

          let x = leftPad;
          // Flag
          ctx.fillStyle = '#fff';
          ctx.fillText(flag, x, y);
          x += ctx.measureText(flag).width + 8;
          // Name
          ctx.fillStyle = '#fff';
          ctx.fillText(name, x, y);
          const nameW = ctx.measureText(name).width;
          // Underline in player's color
          const underlineY = y + 3;
          ctx.strokeStyle = colorForPlayer(p);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, underlineY);
          ctx.lineTo(x + nameW, underlineY);
          ctx.stroke();
          x += nameW + 10;
          // Score
          const scoreStr = String(score);
          ctx.fillStyle = '#fff';
          ctx.fillText(scoreStr, x, y);
          x += ctx.measureText(scoreStr).width + 8;
          // -hits
          const hitsStr = `-${hits}`;
          ctx.fillStyle = '#f88';
          ctx.fillText(hitsStr, x, y);
          ctx.globalAlpha = 1;
        });
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
<canvas id="gameCanvas" class="mx-auto block" width={CANVAS_SIZE} height={CANVAS_SIZE}></canvas>

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
  :global(body) { margin: 0; background: #000; }
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
  <div style="background:#1d1d1d; color:#fff; padding:10px 12px; border-radius:8px; width: 320px; box-shadow: 0 2px 10px rgba(0,0,0,.35);">
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
      <div style="max-height: 220px; overflow:auto;">
        {#each highscores as h, i (h.id)}
          <div style="display:flex; align-items:center; gap:10px; padding:6px 0; border-top: 1px solid #2a2a2a;"
               style:opacity={players.some(pl => pl.id === h.id) ? 1 : 0.55}
               title={`Last updated: ${h.lastUpdated?new Date(h.lastUpdated).toLocaleString():''}${h.country?`\nCountry: ${h.country}`:''}`}>
            <div style="width: 18px; text-align:right; opacity:.8;">{i+1}.</div>
            {#if h.colorIndex != null && PLAYER_COLORS[h.colorIndex]}
              <div style={`width:14px;height:14px;border-radius:50%;background:${PLAYER_COLORS[h.colorIndex].hex};`}></div>
            {:else}
              <div style="width:14px;height:14px;border-radius:50%;background:#666;"></div>
            {/if}
            <div style="flex:1;">
              <div style="font-size:14px; display:flex; align-items:center; gap:6px;">
                {#if FlagComp && h.country}
                  <svelte:component this={FlagComp} code={h.country} style="width:16px;height:12px;border-radius:2px; overflow:hidden;" />
                {/if}
                {#if h.colorIndex != null && PLAYER_COLORS[h.colorIndex]}
                  <span style={`text-decoration: underline; text-decoration-color: ${PLAYER_COLORS[h.colorIndex].hex}; text-decoration-thickness: 2px; text-underline-offset: 3px;`}>
                    {prettyName(h.id)}
                  </span>
                {:else}
                  {prettyName(h.id)}
                {/if}
                {#if h.colorIndex != null && PLAYER_COLORS[h.colorIndex]}
                  <span style="opacity:.7; font-size:12px;"> · {PLAYER_COLORS[h.colorIndex].name}</span>
                {/if}
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