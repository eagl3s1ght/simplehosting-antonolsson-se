<script lang="ts">
  import { onMount } from 'svelte';
  import { joinGame, listenPlayers as origListenPlayers, listenFlows as origListenFlows, updateAngle, updateLayer, updateColor, updateVipSkins, incrementScore, decrementScore, spawnFlow, pruneOldFlows, updateFlowLayer, cleanupPlayerMeta, setPlayerActive, setLastSeen, setSessionEvilHits, incrementSessionEvilHits, cleanupInactivePlayers, cleanupStaleBots, auth, db, ROOM, getHighScoresFirestore, savePlacementFirestore } from '$lib/firebase.js';
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
  // Collision width accounts for the visual round caps (lineCap: 'round')
  // The round caps extend the visual appearance by ~lineWidth/2 at each end
  // At typical layer radius (~300px), 12.5px cap ≈ 0.042 radians per side
  const COLLISION_WIDTH = PIPE_WIDTH + 0.09; // Add ~0.045 radians to each side
  
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
  
  // Local co-op (Player 2) state
  let localCoopEnabled = false;
  let localCoopSupported = false;
  let player2Active = false;
  let player2Angle = 0;
  let player2Layer = 0;
  let player2LayerVisual = 0;
  let player2ColorIndex: number | null = null;
  let player2SpeedBoost = 0;
  let player2Player: { playerId: string; playerData: any } | null = null;
  let lastPlayer2LayerChange = 0;
  
  // Mobile controls for Player 2
  let mobileP2UpPressed = false;
  let mobileP2DownPressed = false;
  let mobileP2LeftPressed = false;
  let mobileP2RightPressed = false;
  
  // Mobile shoot arc button
  let mobileShootPressed = false;
  let mobileP2ShootPressed = false;
  
  // Arc ability cooldown (5 seconds)
  let arcCooldownP1 = 0;
  let arcCooldownP2 = 0;
  // Arc cooldown is now difficulty-dependent via getArcCooldown()
  const ARC_ANGLE_RANGE = Math.PI / 3; // 60 degrees arc in front of player
  
  // Reactive timestamp for cooldown display (updated in render loop)
  let currentTime = Date.now();
  
  // Arc animations
  type ArcAnimation = { 
    playerAngle: number; 
    playerLayer: number; 
    startTime: number; 
    duration: number;
    isPlayer2: boolean;
    destroyedFlows: Set<string>; // Track which flows this arc has already destroyed
  };
  let activeArcs: ArcAnimation[] = [];
  const ARC_ANIMATION_DURATION = 500; // 500ms animation
  
  // Dynamic control positions (updated in render loop)
  let mobileControlBottomDistance = 60; // Distance from bottom of viewport
  let mobileControlTopDistance = 60; // Distance from top of viewport
  
  // Splash screen
  let showSplash = false; // Will be set to true after localStorage check
  let splashFading = false; // Controls fade animation for returning visitors
  let isFirstVisit = true; // Will be loaded from localStorage
  let showHowToPlay = false; // Controls the how-to-play dialog
  
  // Starfield background
  type Star = { x: number; y: number; size: number; opacity: number; twinkleSpeed: number; twinklePhase: number };
  let stars: Star[] = [];
  const STAR_COUNT = 150;
  
  // Custom context menu state
  let showContextMenu = false;
  let contextMenuX = 0;
  let contextMenuY = 0;
  let backgroundMusic: HTMLAudioElement | null = null;
  let isMusicPlaying = false;
  
  // YouTube player state
  let youtubePlayer: any = null;
  let isYouTubeReady = false;
  let musicVolume = 15; // Default volume 0-100
  let currentMusicIndex = 1; // 0 = lofi, 1 = chillstep (default to chillstep)
  const musicTracks = [
    { id: 'HuFYqnbVbzY', name: 'Lofi Hip Hop Radio' },
    { id: 'cWuzJBboQyE', name: 'Chillstep Radio' }
  ];
  
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
  
  // VIP Features (toggleable in debug menu)
  let vipGlow = false;
  let vipGolden = false;
  let vipBlackStars = false;
  
  // Version check
  const CURRENT_VERSION = '0.0.1'; // Update this when deploying new versions
  let isOutdated = false;
  let showOutdatedDialog = false;
  
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
  // Mobile emulation (debug toggle)
  let emulateMobileTouch = false;
  // Noclip cheat (debug toggle) - allows players to overlap on same layer
  let noclipEnabled = false;
  let lastMovementTime = Date.now();
  let idleRemainingMs = IDLE_TIMEOUT_MS;

  // Victory screen state
  let showVictoryScreen = false;
  let victoryStats: {
    podium: Array<{id: string; name: string; score: number; country: string | null; colorIndex: number | null}>;
    mostBadHits: {id: string; name: string; hits: number; country: string | null} | null;
    mostLayerMoves: {id: string; name: string; moves: number; country: string | null} | null;
    nearestToSun: {id: string; name: string; layer: number; country: string | null} | null;
  } = { podium: [], mostBadHits: null, mostLayerMoves: null, nearestToSun: null };

  // Difficulty notification state
  let difficultyNotification = '';
  let showDifficultyNotification = false;
  
  function showDifficultyChange(level: number) {
    const messages: Record<number, string> = {
      1: '🌟 Welcome to Flow! Catch the yellow flows!',
      2: '⚠️ Evil flows incoming! +10% speed',
      3: '💀 Evil flows darker & deadlier (-2 points)',
      4: '📈 +25% more flows spawning',
      5: '🌊 Flow surge! Double spawn rate',
      6: '🐌 Flows slowed down 15% (breathing room!)',
      7: '☠️ Evil flows turn black with red glow (-3 points)',
      8: '⭐ Bigger flows worth 2 points each!',
      9: '👹 +30% more evil flows, bigger size',
      10: '🔥 ENDGAME! Red sun, glowing flows (3pts), green evils (-5pts), 3s arc cooldown!'
    };
    
    difficultyNotification = messages[level] || `Difficulty ${level}`;
    showDifficultyNotification = true;
    
    // Hide after 4 seconds
    setTimeout(() => {
      showDifficultyNotification = false;
    }, 4000);
  }

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
  
  // Context menu functions
  function handleCanvasContextMenu(e: MouseEvent) {
    e.preventDefault();
    contextMenuX = e.clientX;
    contextMenuY = e.clientY;
    showContextMenu = true;
  }
  
  function closeContextMenu() {
    showContextMenu = false;
  }
  
  function openContextMenu() {
    // Position menu in center of screen or near a button
    contextMenuX = window.innerWidth / 2 - 100;
    contextMenuY = window.innerHeight / 2 - 100;
    showContextMenu = true;
  }
  
  function becomeInactive() {
    if (myPlayer?.playerId) {
      try { 
        setPlayerActive(myPlayer.playerId, false);
        showInactiveDialog = true;
      } catch (err) {
        console.error('Failed to set inactive:', err);
      }
    }
    closeContextMenu();
  }
  
  function mailtoAuthor() {
    window.location.href = 'mailto:eagleenterprises08+flowtogether@gmail.com';
    closeContextMenu();
  }
  
  function startPlaying() {
    showSplash = false;
    isFirstVisit = false;
    if (browser) {
      localStorage.setItem('hasVisitedBefore', '1');
      console.log('[Splash] Marked user as returning visitor');
    }
  }
  
  function openHowToPlay() {
    showHowToPlay = true;
    closeContextMenu();
  }
  
  function closeHowToPlay() {
    showHowToPlay = false;
  }
  
  function toggleBackgroundMusic() {
    if (!youtubePlayer) {
      // Initialize YouTube player if not already created
      if (isYouTubeReady) {
        createYouTubePlayer();
      } else {
        // Load YouTube API if not loaded yet
        loadYouTubeAPI();
      }
    } else {
      // Toggle play/pause
      if (isMusicPlaying) {
        youtubePlayer.pauseVideo();
        isMusicPlaying = false;
        localStorage.setItem('isMusicPlaying', '0');
      } else {
        youtubePlayer.playVideo();
        isMusicPlaying = true;
        localStorage.setItem('isMusicPlaying', '1');
      }
    }
    closeContextMenu();
  }
  
  function switchMusicTrack() {
    currentMusicIndex = (currentMusicIndex + 1) % musicTracks.length;
    if (youtubePlayer) {
      const track = musicTracks[currentMusicIndex];
      youtubePlayer.loadVideoById({
        videoId: track.id,
        startSeconds: 0
      });
      // Update playlist for looping
      youtubePlayer.setLoop(true);
      isMusicPlaying = true;
      localStorage.setItem('isMusicPlaying', '1');
      console.log('[Music] Switched to:', track.name);
    }
    closeContextMenu();
  }
  
  function loadYouTubeAPI() {
    if (typeof window === 'undefined') return;
    
    // Check if API is already loaded
    if ((window as any).YT && (window as any).YT.Player) {
      isYouTubeReady = true;
      createYouTubePlayer();
      return;
    }
    
    // Load YouTube IFrame API
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
    
    // Set up callback for when API is ready
    (window as any).onYouTubeIframeAPIReady = () => {
      isYouTubeReady = true;
      createYouTubePlayer();
      console.log('[Music] YouTube API ready, auto-starting music');
    };
  }
  
  // Version check function
  async function checkVersion() {
    try {
      // Fetch version.json from the server (with cache busting)
      const response = await fetch(`/version.json?t=${Date.now()}`);
      if (!response.ok) {
        console.log('[Version] Could not fetch version info');
        return;
      }
      
      const data = await response.json();
      const serverVersion = data.version || '0.0.1';
      
      // Check if stored version is different
      const storedVersion = localStorage.getItem('appVersion');
      
      if (storedVersion && storedVersion !== serverVersion) {
        // Version changed - show outdated dialog
        isOutdated = true;
        showOutdatedDialog = true;
        console.log('[Version] Outdated version detected. Current:', storedVersion, 'Server:', serverVersion);
      } else {
        console.log('[Version] Up to date:', serverVersion);
      }
      
      // Store current version
      localStorage.setItem('appVersion', serverVersion);
    } catch (error) {
      console.log('[Version] Version check failed:', error);
    }
  }
  
  function reloadPage() {
    // Clear cache and reload
    if ('caches' in window) {
      caches.keys().then(names => {
        names.forEach(name => caches.delete(name));
      });
    }
    window.location.reload();
  }
  
  function createYouTubePlayer() {
    if (!isYouTubeReady || youtubePlayer) return;
    
    // Check if music was playing before (e.g., from page refresh)
    const musicPlayingSaved = localStorage.getItem('isMusicPlaying');
    const shouldAutoplay = musicPlayingSaved === '1';
    
    const track = musicTracks[currentMusicIndex];
    youtubePlayer = new (window as any).YT.Player('youtube-player', {
      height: '0',
      width: '0',
      videoId: track.id,
      playerVars: {
        autoplay: shouldAutoplay ? 1 : 0,
        controls: 0,
        loop: 1,
        playlist: track.id // Required for looping
      },
      events: {
        onReady: (event: any) => {
          event.target.setVolume(musicVolume);
          if (shouldAutoplay) {
            event.target.playVideo();
            isMusicPlaying = true;
            localStorage.setItem('isMusicPlaying', '1');
            console.log('[Music] YouTube player ready and auto-playing:', track.name);
          } else {
            console.log('[Music] YouTube player ready (paused):', track.name);
          }
        },
        onStateChange: (event: any) => {
          // YT.PlayerState.PLAYING = 1, PAUSED = 2
          isMusicPlaying = event.data === 1;
          localStorage.setItem('isMusicPlaying', isMusicPlaying ? '1' : '0');
        }
      }
    });
  }
  
  // Local co-op functions
  function checkLocalCoopSupport() {
    if (typeof navigator === 'undefined') return false;
    // PC utan touch = numpad stöd
    // Mobil med touch = on-screen controls
    const hasTouch = emulateMobileTouch || navigator.maxTouchPoints > 0;
    const isMobile = hasTouch && window.innerWidth < 768;
    localCoopSupported = true; // Stöd både PC och mobil
    return true;
  }
  
  async function startLocalCoop() {
    if (!localCoopSupported) {
      alert('Lokal flerspelarläge finns bara på kompatibla enheter. Prova på en PC med tangentbord eller mobil enhet!');
      return;
    }
    
    if (!myPlayer) {
      alert('Du måste vara inloggad som spelare #1 först!');
      return;
    }
    
    // Hitta en ledig färg för spelare #2
    const used = new Set<number>();
    players.forEach(pl => { if (pl?.colorIndex != null) used.add(pl.colorIndex as number); });
    botPlayers.forEach(bot => { if (bot.colorIndex != null) used.add(bot.colorIndex); });
    
    let chosenColor: number | null = null;
    for (let i = 0; i < PLAYER_COLORS.length; i++) {
      if (!used.has(i)) { chosenColor = i; break; }
    }
    
    if (chosenColor === null) {
      alert('Alla färger är upptagna! Ingen plats för spelare #2.');
      return;
    }
    
    try {
      // Skapa spelare #2
      const player2Id = `local-p2-${myPlayer.playerId}`;
      const startAngle = getNestAngle(chosenColor);
      const startLayer = MAX_LAYERS - 1;
      
      const playerData = {
        id: player2Id,
        angle: startAngle,
        score: 0,
        layer: startLayer,
        colorIndex: chosenColor,
        createdAt: Date.now(),
        active: true,
        lastSeen: Date.now(),
        evilHits: 0,
        isBot: false,
        isLocalCoop: true,
        createdBy: myPlayer.playerId,
        meta: {
          country: null,
          language: null,
          creationTime: null,
          lastSignInTime: null
        }
      };
      
      await set(ref(db, `${ROOM}/players/${player2Id}`), playerData);
      
      player2Player = { playerId: player2Id, playerData };
      player2Angle = startAngle;
      player2Layer = startLayer;
      player2LayerVisual = startLayer;
      player2ColorIndex = chosenColor;
      player2SpeedBoost = 0;
      player2Active = true;
      localCoopEnabled = true;
      
      console.log('[LOCAL COOP] Player 2 started:', chosenColor);
    } catch (err) {
      console.error('Failed to start local coop:', err);
      alert('Kunde inte starta lokal flerspelarläge. Försök igen.');
    }
  }
  
  async function stopLocalCoop() {
    if (!player2Player) return;
    
    try {
      // Ta bort spelare #2 från databasen
      await set(ref(db, `${ROOM}/players/${player2Player.playerId}`), null);
      
      player2Player = null;
      player2Active = false;
      localCoopEnabled = false;
      player2ColorIndex = null;
      
      console.log('[LOCAL COOP] Player 2 stopped');
    } catch (err) {
      console.error('Failed to stop local coop:', err);
    }
  }

  // Arc ability function - destroys evil flows in an arc in front of player
  function useArcAbility(playerAngle: number, playerLayer: number, isPlayer2: boolean = false) {
    const now = Date.now();
    const cooldownRef = isPlayer2 ? arcCooldownP2 : arcCooldownP1;
    const ARC_COOLDOWN_MS = getArcCooldown();
    
    // Check cooldown
    if (now - cooldownRef < ARC_COOLDOWN_MS) {
      console.debug('[Arc] Ability on cooldown', {
        player: isPlayer2 ? 'P2' : 'P1',
        remainingMs: ARC_COOLDOWN_MS - (now - cooldownRef)
      });
      return;
    }
    
    // Update cooldown
    if (isPlayer2) {
      arcCooldownP2 = now;
    } else {
      arcCooldownP1 = now;
    }
    
    // Add arc animation
    activeArcs.push({
      playerAngle,
      playerLayer,
      startTime: now,
      duration: ARC_ANIMATION_DURATION,
      isPlayer2,
      destroyedFlows: new Set() // Track destroyed flows to avoid duplicates
    });
    activeArcs = activeArcs; // Trigger reactivity
    
    console.log('[Arc] Ability activated', {
      player: isPlayer2 ? 'P2' : 'P1',
      layer: playerLayer,
      angle: (playerAngle * 180 / Math.PI).toFixed(1) + '°'
    });
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
      // Load first visit flag
      const firstVisitSaved = localStorage.getItem('hasVisitedBefore');
      if (firstVisitSaved === '1') {
        isFirstVisit = false; // User has visited before
        console.log('[Splash] User has visited before, will auto-close splash');
      } else {
        console.log('[Splash] First visit detected, will show rules on splash');
      }
      // Now show splash screen after checking first visit status
      showSplash = true;
      // Load VIP settings
      const vipGlowSaved = localStorage.getItem('vipGlow');
      if (vipGlowSaved !== null) {
        vipGlow = vipGlowSaved === '1';
        console.log('[VIP] Loaded glow setting from storage:', vipGlow);
      }
      const vipGoldenSaved = localStorage.getItem('vipGolden');
      if (vipGoldenSaved !== null) {
        vipGolden = vipGoldenSaved === '1';
        console.log('[VIP] Loaded golden setting from storage:', vipGolden);
      }
      const vipBlackStarsSaved = localStorage.getItem('vipBlackStars');
      if (vipBlackStarsSaved !== null) {
        vipBlackStars = vipBlackStarsSaved === '1';
        console.log('[VIP] Loaded black stars setting from storage:', vipBlackStars);
      }
      // Load music volume
      const volumeSaved = localStorage.getItem('musicVolume');
      if (volumeSaved !== null) {
        const vol = parseInt(volumeSaved);
        if (!isNaN(vol) && vol >= 0 && vol <= 100) {
          musicVolume = vol;
          console.log('[Music] Loaded volume from storage:', musicVolume);
        }
      }
      // Load music track index
      const trackSaved = localStorage.getItem('currentMusicIndex');
      if (trackSaved !== null) {
        const track = parseInt(trackSaved);
        if (!isNaN(track) && track >= 0 && track < musicTracks.length) {
          currentMusicIndex = track;
          console.log('[Music] Loaded track index from storage:', currentMusicIndex);
        }
      }
      // Load music playing state
      const musicPlayingSaved = localStorage.getItem('isMusicPlaying');
      if (musicPlayingSaved === '1') {
        // Will be started automatically by createYouTubePlayer when API is ready
        console.log('[Music] Will resume playback (was playing before refresh)');
      }
      storageLoaded = true;
      
      // Auto-start YouTube API
      loadYouTubeAPI();
      
      // Check for version updates
      checkVersion();
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
    localStorage.setItem('vipGlow', vipGlow ? '1' : '0');
    localStorage.setItem('vipGolden', vipGolden ? '1' : '0');
    localStorage.setItem('vipBlackStars', vipBlackStars ? '1' : '0');
    localStorage.setItem('musicVolume', String(musicVolume));
    localStorage.setItem('currentMusicIndex', String(currentMusicIndex));
    if (dev) {
      console.log('[Idle] Saved setting to storage:', idleEnabled);
      console.log('[Blur/Hidden] Saved setting to storage:', markInactiveOnWindowInactive);
      console.log('[Bot] Auto-spawn on join saved to storage:', autoSpawnBotOnJoin);
      console.log('[VIP] Saved settings to storage:', { vipGlow, vipGolden, vipBlackStars });
    }
    // Sync VIP skins to Firebase so other players can see them
    if (myPlayer?.playerId) {
      updateVipSkins(myPlayer.playerId, vipGlow, vipGolden, vipBlackStars);
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
      // Load from cache first for instant display
      if (browser) {
        const cached = localStorage.getItem('highscores_cache');
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed.data && Array.isArray(parsed.data)) {
              highscores = parsed.data;
              console.log('[Highscores] Loaded from cache');
            }
          } catch (e) {
            console.warn('[Highscores] Failed to parse cache', e);
          }
        }
      }

      // Fetch fresh data from Firestore
      const list = await getHighScoresFirestore(100);
      // Convert Firestore format to match old RTDB format for compatibility
      // Use Firestore document ID (item.id) as the key to ensure uniqueness
      highscores = list.map(item => ({
        id: item.id, // Firestore document ID (unique)
        userId: item.userId, // Actual user ID for reference
        totalCatches: item.score,
        evilHits: item.evilHits || 0,
        colorIndex: item.colorIndex,
        country: item.country,
        lastUpdated: item.lastUpdated?.seconds ? item.lastUpdated.seconds * 1000 : Date.now(),
        placements: item.placements || {} // Include placement data (first, second, third)
      }));
      console.log('[Highscores] Loaded from Firestore with placements:', highscores.filter(h => h.placements?.first || h.placements?.second || h.placements?.third).length);
      hsLastLoaded = Date.now();

      // Update cache
      if (browser && highscores.length > 0) {
        try {
          localStorage.setItem('highscores_cache', JSON.stringify({
            data: highscores,
            timestamp: Date.now()
          }));
        } catch (e) {
          console.warn('[Highscores] Failed to save cache', e);
        }
      }
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
  const DIFFICULTY_INTERVAL_MS = 30000; // 30s between automatic difficulty increases
  let difficultyLastAutoIncreaseAt = 0; // timestamp of last automatic difficulty increase
  let pauseAccumulatedMs = 0;           // total paused time since page load
  let pauseStartedAt: number | null = null; // when current pause started
  let pauseAccumAtDiffStart = 0;        // pause total at last difficulty change
  
  // Difficulty-based modifiers
  function getDifficultySpeedMultiplier() {
    if (difficulty === 1) return 1.0;
    if (difficulty === 2) return 1.1;  // +10% speed
    if (difficulty === 3) return 1.1;
    if (difficulty === 4) return 1.1;
    if (difficulty === 5) return 1.1;
    if (difficulty === 6) return 0.85; // -15% speed (slower)
    if (difficulty === 7) return 0.85;
    if (difficulty === 8) return 0.85;
    if (difficulty === 9) return 0.85;
    if (difficulty === 10) return 1.4; // +40% speed
    return 1.0;
  }
  
  function getFlowSpawnMultiplier() {
    if (difficulty === 1) return 1.0;
    if (difficulty === 2) return 1.0;
    if (difficulty === 3) return 1.0;
    if (difficulty === 4) return 1.25; // +25% more flows
    if (difficulty === 5) return 1.5;  // +50% more flows (double base rate)
    if (difficulty >= 6) return 1.5;
    return 1.0;
  }
  
  function getFlowSizeModifier() {
    if (difficulty === 1) return 1.0;
    if (difficulty === 2) return 1.0;
    if (difficulty === 3) return 1.0;
    if (difficulty === 4) return 1.0;
    if (difficulty === 5) return 1.0;
    if (difficulty === 6) return 1.0;
    if (difficulty === 7) return 1.0;
    if (difficulty === 8) return 1.2; // +20% size
    if (difficulty === 9) return 1.2;
    if (difficulty === 10) return 1.2;
    return 1.0;
  }
  
  function getFlowPointValue() {
    if (difficulty === 1) return 1;
    if (difficulty === 2) return 1;
    if (difficulty === 3) return 1;
    if (difficulty === 4) return 1;
    if (difficulty === 5) return 1;
    if (difficulty === 6) return 1;
    if (difficulty === 7) return 1;
    if (difficulty === 8) return 2; // 2 points per catch
    if (difficulty === 9) return 2;
    if (difficulty === 10) return 3; // 3 points per catch
    return 1;
  }
  
  function getEvilFlowPenalty() {
    if (difficulty === 1) return 1;
    if (difficulty === 2) return 1;
    if (difficulty === 3) return 2; // -2 points
    if (difficulty === 4) return 2;
    if (difficulty === 5) return 2;
    if (difficulty === 6) return 2;
    if (difficulty === 7) return 3; // -3 points
    if (difficulty === 8) return 3;
    if (difficulty === 9) return 3;
    if (difficulty === 10) return 5; // -5 points
    return 1;
  }
  
  function getEvilFlowSizeModifier() {
    if (difficulty === 1) return 1.0;
    if (difficulty === 2) return 1.0;
    if (difficulty === 3) return 1.0;
    if (difficulty === 4) return 1.0;
    if (difficulty === 5) return 1.0;
    if (difficulty === 6) return 1.0;
    if (difficulty === 7) return 1.0;
    if (difficulty === 8) return 1.0;
    if (difficulty === 9) return 1.1; // +10% size
    if (difficulty === 10) return 1.2; // +20% size (cumulative with diff 9)
    return 1.0;
  }
  
  function getEvilFlowSpawnMultiplier() {
    if (difficulty === 1) return 0;
    if (difficulty === 2) return 1.0;
    if (difficulty === 3) return 1.0;
    if (difficulty === 4) return 1.0;
    if (difficulty === 5) return 1.0;
    if (difficulty === 6) return 1.0;
    if (difficulty === 7) return 1.0;
    if (difficulty === 8) return 1.0;
    if (difficulty === 9) return 1.3; // +30% more evil flows
    if (difficulty === 10) return 1.3;
    return 1.0;
  }
  
  function getArcCooldown() {
    if (difficulty === 10) return 3000; // 3 seconds at difficulty 10
    return 5000; // 5 seconds otherwise
  }
  
  // Reactive: difficulty multiplier recalculated from difficulty level
  $: difficultySpeedMultiplier = getDifficultySpeedMultiplier();
  
  // Show notification when difficulty changes manually (e.g., debug slider)
  let previousDifficulty = 1;
  $: if (difficulty !== previousDifficulty && previousDifficulty > 0) {
    showDifficultyChange(difficulty);
    previousDifficulty = difficulty;
  }
  
  let gameStartTime = 0;
  let gameSessionStartTime = 0;         // sessions gate scoreboard membership
  let pauseForNoPlayers = false;        // true when no active players
  // Track last known angles to detect inactive players on difficulty changes
  const lastKnownAngles = new Map<string, number>();
  // Game speed multiplier (debug)
  let gameSpeedMultiplier = 1; // 1x to 5x with 0.2 increments
  let lastRealTime = 0; // Track real time for game speed calculation
  let gameTimeAccumulator = 0; // Accumulated game time with speed applied

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
    const spawnDuration = currentFlowDuration(); // Capture duration at spawn time
    
    // Random multiplier: 2x, 2.4x, 2.8x, 3.2x, 3.6x, or 4x
    const multiplierSteps = [2, 2.4, 2.8, 3.2, 3.6, 4];
    const randomMultiplier = multiplierSteps[Math.floor(Math.random() * multiplierSteps.length)];
    const actualCount = Math.ceil(count * randomMultiplier);
    
    for (let i = 0; i < actualCount; i++) {
      const delay = Math.random() * 500; // within .5s
      const isEvil = Math.random() < evilFraction;
      setTimeout(() => {
        // Ultra random angle distribution
        const angle = Math.random() * Math.PI * 2;
        const speedBias = (Math.sin(angle * 3) + 1) / 2; // 0..1
        const extraSpeed = 1 + (speedBias - 0.5) * 0.2; // +/-10%
        spawnFlow(isEvil, { speedBias: Number(extraSpeed.toFixed(3)), duration: spawnDuration });
        recordFlowSpawn();
        if (isEvil) recordEvilFlowSpawn();
      }, delay);
    }
    
    console.debug(`Spawning wave: ${count} base × ${randomMultiplier} = ${actualCount} flows`);
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
  
  // Get the duration for a flow, using stored duration if available (for consistency across game speed changes)
  function getFlowDuration(flow: any): number {
    return flow.duration || currentFlowDuration();
  }
  
  function checkCollision(flowAngle: number, playerAngle: number): boolean {
    // Player arc spans from (angle - COLLISION_WIDTH/2) to (angle + COLLISION_WIDTH/2)
    // COLLISION_WIDTH accounts for the visual round caps on the arc
    const playerStart = normalizeAngle(playerAngle - COLLISION_WIDTH / 2);
    const playerEnd = normalizeAngle(playerAngle + COLLISION_WIDTH / 2);
    const normFlow = normalizeAngle(flowAngle);
    
    // Check if flow angle falls within player arc
    // Handle wrap-around case (arc crosses 0/2π boundary)
    if (playerStart <= playerEnd) {
      return normFlow >= playerStart && normFlow <= playerEnd;
    } else {
      return normFlow >= playerStart || normFlow <= playerEnd;
    }
  }
  
  // Check if two player fragments would overlap on the same layer
  function checkPlayerOverlap(angle1: number, angle2: number): boolean {
    // Each player arc spans PIPE_WIDTH centered on their angle
    const player1Start = normalizeAngle(angle1 - PIPE_WIDTH / 2);
    const player1End = normalizeAngle(angle1 + PIPE_WIDTH / 2);
    const player2Start = normalizeAngle(angle2 - PIPE_WIDTH / 2);
    const player2End = normalizeAngle(angle2 + PIPE_WIDTH / 2);
    
    // Normalize all angles
    const norm1Start = player1Start;
    const norm1End = player1End;
    const norm2Start = player2Start;
    const norm2End = player2End;
    
    // Check if any part of player2's arc overlaps with player1's arc
    // This handles wrap-around cases
    const overlapsStart = 
      (norm1Start <= norm1End) ?
        (norm2Start >= norm1Start && norm2Start <= norm1End) :
        (norm2Start >= norm1Start || norm2Start <= norm1End);
    
    const overlapsEnd = 
      (norm1Start <= norm1End) ?
        (norm2End >= norm1Start && norm2End <= norm1End) :
        (norm2End >= norm1Start || norm2End <= norm1End);
    
    // Also check if player1 is entirely within player2 arc
    const player1InPlayer2 = 
      (norm2Start <= norm2End) ?
        (norm1Start >= norm2Start && norm1Start <= norm2End) :
        (norm1Start >= norm2Start || norm1Start <= norm2End);
    
    return overlapsStart || overlapsEnd || player1InPlayer2;
  }
  
  function checkNestCollisions(flow: Flow) {
    // Check if any active player's nest (in outermost layer) catches this flow
    const flowId = `${flow.spawnTime}_${flow.angle.toFixed(4)}`;
    if (scoredFlows.has(flowId) || flowsToRemove.has(flowId)) return;
    
    const now = Date.now();
    const progress = ((now - flow.spawnTime) / getFlowDuration(flow)) * speedBiasForAngle(flow.angle);
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
              const penalty = getEvilFlowPenalty();
              for (let i = 0; i < penalty; i++) {
                decrementScore(owner.id);
              }
              // recordEvilHit(owner.id); // REMOVED: Now using Firestore high scores
              incrementSessionEvilHits(owner.id); // Session stats
              console.debug('Nest caught evil flow!', { colorIndex: idx, playerId: owner.id, penalty });
            } else {
              const pointValue = getFlowPointValue();
              for (let i = 0; i < pointValue; i++) {
                incrementScore(owner.id);
              }
              // recordCatch(owner.id, idx); // REMOVED: Now using Firestore high scores
              console.debug('Nest caught flow!', { colorIndex: idx, playerId: owner.id, points: pointValue });
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
  const progress = ((now - flow.spawnTime) / getFlowDuration(flow)) * speedBiasForAngle(flow.angle);
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
          const penalty = getEvilFlowPenalty();
          for (let i = 0; i < penalty; i++) {
            decrementScore(myPlayer.playerId);
          }
          // recordEvilHit(myPlayer.playerId); // REMOVED: Now using Firestore high scores
          incrementSessionEvilHits(myPlayer.playerId); // Session stats
          hurtUntil = now + 400; // Blink for 400ms (2 blinks at ~200ms each)
          console.debug('HIT BY EVIL FLOW! Score reduced', {
            flowId,
            flowAngle: flow.angle,
            playerAngle: myAngle,
            layer: myLayer,
            penalty
          });
        } else {
          // Normal flow increases score AND speed boost
          const pointValue = getFlowPointValue();
          for (let i = 0; i < pointValue; i++) {
            incrementScore(myPlayer.playerId);
          }
          mySpeedBoost++; // +1% additive per catch
          
          // Track score increase in PostHog
          if (typeof window !== 'undefined' && window.posthog) {
            const currentPlayer = players.find(p => p.id === myPlayer.playerId);
            const newScore = (currentPlayer?.score || 0) + pointValue; // Score will be incremented
            window.posthog.capture('score_increased', {
              player_id: myPlayer.playerId,
              new_score: newScore,
              speed_boost: mySpeedBoost,
              layer: myLayer,
              color_index: myColorIndex,
              points: pointValue
            });
          }
          
          // REMOVED: RTDB high score tracking, now using Firestore
          // recordCatch(myPlayer.playerId, myColorIndex ?? undefined, ...);
          console.debug('COLLISION! Flow caught at angle', {
            flowId,
            flowAngle: flow.angle,
            playerAngle: myAngle,
            points: pointValue,
            progress: progress.toFixed(3),
            layer: myLayer,
            speedBoost: mySpeedBoost
          });
        }
      }
    }
  }
  
  function checkScorePlayer2(flow: Flow) {
    if (!player2Player || !localCoopEnabled || !player2Active) return;
    
    const flowId = `${flow.spawnTime}_${flow.angle.toFixed(4)}`;
    if (scoredFlows.has(flowId) || flowsToRemove.has(flowId)) return;
    
    const now = Date.now();
    const progress = ((now - flow.spawnTime) / getFlowDuration(flow)) * speedBiasForAngle(flow.angle);
    const flowRadius = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);
    const targetRadius = INNER_R + FIXED_LAYER_SPACING * (player2Layer + 1);
    
    const R_WINDOW = COLLISION_RADIUS_TOLERANCE;
    if (flowRadius >= (targetRadius - R_WINDOW) && flowRadius <= (targetRadius + R_WINDOW)) {
      if (checkCollision(flow.angle, player2Angle)) {
        scoredFlows.add(flowId);
        flowsToRemove.add(flowId);
        
        if (flow.isEvil) {
          const penalty = getEvilFlowPenalty();
          for (let i = 0; i < penalty; i++) {
            decrementScore(player2Player.playerId);
          }
          // recordEvilHit(player2Player.playerId); // REMOVED: Now using Firestore
          incrementSessionEvilHits(player2Player.playerId);
          console.debug('[P2] HIT BY EVIL FLOW!', {
            flowId,
            flowAngle: flow.angle,
            playerAngle: player2Angle,
            layer: player2Layer,
            penalty
          });
        } else {
          const pointValue = getFlowPointValue();
          for (let i = 0; i < pointValue; i++) {
            incrementScore(player2Player.playerId);
          }
          player2SpeedBoost++;
          // recordCatch(player2Player.playerId, ...); // REMOVED: Now using Firestore
          console.debug('[P2] COLLISION! Flow caught', {
            flowId,
            flowAngle: flow.angle,
            playerAngle: player2Angle,
            progress: progress.toFixed(3),
            layer: player2Layer,
            speedBoost: player2SpeedBoost
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
        const progress = ((now - flow.spawnTime) / getFlowDuration(flow)) * speedBiasForAngle(flow.angle);
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
        
        let newAngle: number | null = null;
        if (diff > 0.01 && diff < Math.PI) {
          newAngle = normalizeAngle(botPlayer.angle + turnSpeed);
        } else if (diff < -0.01 || diff > Math.PI) {
          newAngle = normalizeAngle(botPlayer.angle - turnSpeed);
        }
        
        // Check for collision before moving (unless noclip is enabled)
        if (newAngle !== null) {
          let canMove = noclipEnabled;
          
          if (!noclipEnabled) {
            canMove = true;
            
            // Check collision with player 1
            if (myPlayer && myLayer === botPlayer.layer) {
              if (checkPlayerOverlap(newAngle, myAngle)) {
                canMove = false;
              }
            }
            
            // Check collision with player 2
            if (canMove && localCoopEnabled && player2Active && player2Player && player2Layer === botPlayer.layer) {
              if (checkPlayerOverlap(newAngle, player2Angle)) {
                canMove = false;
              }
            }
            
            // Check collision with other players
            if (canMove) {
              players.forEach((p) => {
                if (!p || !p.id || p.id === botPlayer.playerId) return;
                const ls = (p as any)?.lastSeen;
                const activeFlag = (p as any)?.active !== false;
                const fresh = typeof ls === 'number' ? (now - ls) < 30000 : true;
                if (!activeFlag || !fresh) return;
                
                const otherLayer = p.layer ?? 0;
                if (otherLayer === botPlayer.layer) {
                  if (checkPlayerOverlap(newAngle, p.angle)) {
                    canMove = false;
                  }
                }
              });
            }
            
            // Check collision with other bots
            if (canMove) {
              botPlayers.forEach((otherBot) => {
                if (otherBot.playerId === botPlayer.playerId) return;
                if (otherBot.layer === botPlayer.layer) {
                  if (checkPlayerOverlap(newAngle, otherBot.angle)) {
                    canMove = false;
                  }
                }
              });
            }
          }
          
          if (canMove) {
            botPlayer.angle = newAngle;
          }
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
        
        const progress = ((now - flow.spawnTime) / getFlowDuration(flow)) * speedBiasForAngle(flow.angle);
        const flowRadius = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);
        const targetRadius = INNER_R + FIXED_LAYER_SPACING * (botPlayer.layer + 1);
        
        if (flowRadius >= (targetRadius - COLLISION_RADIUS_TOLERANCE) && flowRadius <= (targetRadius + COLLISION_RADIUS_TOLERANCE)) {
          if (checkCollision(flow.angle, botPlayer.angle)) {
            scoredFlows.add(flowId);
            flowsToRemove.add(flowId);
            
            if (flow.isEvil) {
              const penalty = getEvilFlowPenalty();
              for (let i = 0; i < penalty; i++) {
                decrementScore(botPlayer.playerId);
              }
              // recordEvilHit(botPlayer.playerId); // REMOVED: Now using Firestore
              incrementSessionEvilHits(botPlayer.playerId); // Session stats
            } else {
              const pointValue = getFlowPointValue();
              for (let i = 0; i < pointValue; i++) {
                incrementScore(botPlayer.playerId);
              }
              botPlayer.speedBoost++;
              // recordCatch(botPlayer.playerId, ...); // REMOVED: Now using Firestore
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

  // Calculate victory stats for end-of-game screen
  function calculateVictoryStats() {
    // Get top 3 by score (podium)
    const sortedByScore = [...players]
      .filter(p => p.active && !p.isBot) // Exclude bots
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 3);
    
    const podium = sortedByScore.map(p => ({
      id: p.id,
      name: prettyName(p.id),
      score: p.score || 0,
      country: p.meta?.country || null,
      colorIndex: p.colorIndex ?? null
    }));
    
    // Save placements to Firestore
    if (podium.length > 0) {
      podium.forEach((player, index) => {
        const placement = index + 1; // 1st, 2nd, 3rd
        savePlacementFirestore(player.id, placement).catch(err => {
          console.error('[Victory] Failed to save placement:', err);
        });
      });
      console.log('[Victory] Saved placements for top 3 players');
    }
    
    // Most bad hits (evil flows hit)
    const sortedByBadHits = [...players]
      .filter(p => p.active && !p.isBot && (p.sessionEvilHits || 0) > 0)
      .sort((a, b) => (b.sessionEvilHits || 0) - (a.sessionEvilHits || 0));
    const mostBadHits = sortedByBadHits.length > 0 ? {
      id: sortedByBadHits[0].id,
      name: prettyName(sortedByBadHits[0].id),
      hits: sortedByBadHits[0].sessionEvilHits || 0,
      country: sortedByBadHits[0].meta?.country || null
    } : null;
    
    // Most layer moves (track this via a new counter - for now use speed boost as proxy)
    const sortedByBoost = [...players]
      .filter(p => p.active && !p.isBot && (p.speedBoost || 0) > 0)
      .sort((a, b) => (b.speedBoost || 0) - (a.speedBoost || 0));
    const mostLayerMoves = sortedByBoost.length > 0 ? {
      id: sortedByBoost[0].id,
      name: prettyName(sortedByBoost[0].id),
      moves: sortedByBoost[0].speedBoost || 0, // Using speed boost as proxy for activity
      country: sortedByBoost[0].meta?.country || null
    } : null;
    
    // Nearest to the sun (lowest layer number)
    const sortedByLayer = [...players]
      .filter(p => p.active && !p.isBot && p.layer != null)
      .sort((a, b) => (a.layer ?? 999) - (b.layer ?? 999));
    const nearestToSun = sortedByLayer.length > 0 ? {
      id: sortedByLayer[0].id,
      name: prettyName(sortedByLayer[0].id),
      layer: sortedByLayer[0].layer ?? 0,
      country: sortedByLayer[0].meta?.country || null
    } : null;
    
    victoryStats = { podium, mostBadHits, mostLayerMoves, nearestToSun };
  }

  function startNewGame() {
    showVictoryScreen = false;
    const t = Date.now();
    difficulty = 1;
    difficultyLastAutoIncreaseAt = t;
    pauseAccumAtDiffStart = pauseAccumulatedMs;
    gameSessionStartTime = t;
    // Reset game time system
    lastRealTime = t;
    gameTimeAccumulator = t;
    // Reset game speed to normal
    gameSpeedMultiplier = 1;
    try { flowCache.clear(); } catch {}
    try { scoredFlows.clear(); } catch {}
    try { flowsToRemove.clear(); } catch {}
    console.log('[Session] New game started');
  }

  onMount(() => {
    if (!browser) return;
    canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    if (!canvas) {
      console.error('[Canvas] Canvas element not found');
      return;
    }
    ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    if (!ctx) {
      console.error('[Canvas] Could not get 2D context');
      return;
    }
    
    // Make canvas fill viewport
    const updateCanvasSize = () => {
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      // Regenerate stars to match new canvas size
      stars = [];
      for (let i = 0; i < STAR_COUNT; i++) {
        stars.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          size: Math.random() * 1.5 + 0.5,
          opacity: Math.random() * 0.5 + 0.3,
          twinkleSpeed: Math.random() * 0.02 + 0.005,
          twinklePhase: Math.random() * Math.PI * 2
        });
      }
    };
    updateCanvasSize();
    window.addEventListener('resize', updateCanvasSize);
    
    // Check local co-op support
    checkLocalCoopSupport();
    
    // Fade out splash screen: show for 1 second, then fade out over 1 second (only for returning visitors)
    if (!isFirstVisit) {
      setTimeout(() => {
        splashFading = true; // Start fade animation
      }, 1000); // Wait 1 second before starting fade
      
      setTimeout(() => {
        showSplash = false; // Remove from DOM after fade completes
      }, 2100); // 1s visible + 1s fade + 0.1s buffer
    }
    // First-time visitors will see rules and must click "Start Playing"
    
    // Initialize previousDifficulty to avoid showing notification on mount
    previousDifficulty = difficulty;

  let unsubPlayers: () => void = () => {};
  let unsubFlows: () => void = () => {};
  let presenceInterval: any;
    const init = async () => {
  // Clean up stale bots from previous sessions before joining
  await cleanupStaleBots();
  
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
      
      // Sync VIP skins to Firebase immediately after joining
      updateVipSkins(myPlayer.playerId, vipGlow, vipGolden, vipBlackStars);
      
      // Start presence heartbeat (every 5s for better visibility)
      presenceInterval = setInterval(() => {
        if (myPlayer?.playerId) setLastSeen(myPlayer.playerId);
        // Also update Player 2's lastSeen if local coop is active
        if (player2Active && player2Player?.playerId) {
          setLastSeen(player2Player.playerId);
        }
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
    const initTime = Date.now();
    gameStartTime = initTime;
    gameSessionStartTime = initTime;
    difficultyLastAutoIncreaseAt = initTime;
    pauseAccumAtDiffStart = pauseAccumulatedMs;
    // Initialize game time system
    lastRealTime = initTime;
    gameTimeAccumulator = initTime;
    // Initialize lastKnownAngles for all players at start
    players.forEach((pl) => {
      if (pl && pl.id) lastKnownAngles.set(pl.id, pl.angle);
    });

    // Increase difficulty every minute
    const difficultyInterval = setInterval(() => {
      if (pauseForNoPlayers) return; // freeze difficulty while paused
      if (difficulty < 10) {
        difficulty++;
        difficultyLastAutoIncreaseAt = Date.now();
        pauseAccumAtDiffStart = pauseAccumulatedMs;
        // Snapshot current angles for next check
        players.forEach((pl) => {
          if (pl && pl.id) lastKnownAngles.set(pl.id, pl.angle);
        });
        console.log('Difficulty increased to:', difficulty);
        showDifficultyChange(difficulty);
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
      const baseSize = Math.min(12, Math.max(3, numPlayers * 2));
      const burstSize = Math.ceil(baseSize * getFlowSpawnMultiplier());
      spawnBurst(burstSize, 0); // normal flows only
      console.debug(`Burst spawned ${burstSize} normal flows for ${numPlayers} players (multiplier: ${getFlowSpawnMultiplier()})`);
    }, 3000); // 3 seconds between waves

    // Evil burst every 5 seconds if difficulty >=2
    const evilSpawnInterval = setInterval(() => {
      if (pauseForNoPlayers) return; // paused
      if (difficulty >= 2) {
        const numPlayers = countOnlinePlayers();
        if (numPlayers === 0) return;
        
        // Random evil wave size - varies each time
        const baseSize = Math.min(16, Math.max(4, numPlayers * 2));
        const burstSize = Math.ceil(baseSize * getEvilFlowSpawnMultiplier());
        
        // Random evil fraction between 20% and 60%
        const evilFraction = 0.2 + Math.random() * 0.4;
        
        spawnBurst(burstSize, evilFraction);
        console.debug(`Evil burst spawned ${burstSize} flows (${Math.round(burstSize*evilFraction)} evil) difficulty=${difficulty}, multiplier=${getEvilFlowSpawnMultiplier()}`);
      }
    }, 5000); // 5 seconds between evil waves

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
      
      // Arc ability triggers
      if (e.type === 'keydown' && !e.repeat) {
        // Player 1: Spacebar
        if (e.key === ' ' && myPlayer && myColorIndex != null) {
          useArcAbility(myAngle, myLayer, false);
          e.preventDefault();
        }
        // Player 2: Numpad 0
        if ((e.key === '0' || e.code === 'Numpad0') && localCoopEnabled && player2Active && player2ColorIndex != null) {
          useArcAbility(player2Angle, player2Layer, true);
          e.preventDefault();
        }
      }
      
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
      if (showVictoryScreen) {
        // Pause game loop but continue rendering canvas
        raf = requestAnimationFrame(loop);
        return;
      }
      if (!ctx || !canvas) return;
      
      // Get current time at the start of the loop
      const realNow = Date.now();
      currentTime = realNow; // Update reactive timestamp for cooldown displays
      
      // Calculate game time with speed multiplier applied
      if (lastRealTime === 0) lastRealTime = realNow;
      const realDelta = realNow - lastRealTime;
      gameTimeAccumulator += realDelta * gameSpeedMultiplier;
      lastRealTime = realNow;
      const now = gameTimeAccumulator; // Use accelerated game time for all calculations
      
      // Track FPS - count frames and update display values every second
      frameCount++;
      const frameDelta = realNow - lastFrameTime;
      lastFrameTime = realNow;
      
      // Update FPS display once per second (use real time for FPS calculation)
      if (realNow - lastFpsUpdateTime >= 1000) {
        const elapsed = (realNow - lastFpsUpdateTime) / 1000;
        currentFps = Math.round(frameCount / elapsed);
        fpsHistory.push(currentFps);
        if (fpsHistory.length > 60) fpsHistory.shift(); // Keep last 60 seconds
        averageFps = Math.round(fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length);
        frameCount = 0;
        lastFpsUpdateTime = realNow;
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
      
      // Check Player 2 layer validation
      if (localCoopEnabled && player2Active && player2Player && player2Layer < minAllowedLayer) {
        player2Layer = minAllowedLayer;
        player2LayerVisual = player2Layer;
        updateLayer(player2Player.playerId, player2Layer);
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
      if (difficulty === 10 && !showVictoryScreen) {
        const pausedSinceDiffStart = pauseAccumulatedMs - pauseAccumAtDiffStart;
        const effectiveElapsed = Math.max(0, (now - difficultyLastAutoIncreaseAt) - pausedSinceDiffStart);
        if (effectiveElapsed >= DIFFICULTY_INTERVAL_MS) {
          // Calculate victory stats and show victory screen
          calculateVictoryStats();
          showVictoryScreen = true;
          console.log('[Victory] Game completed! Showing victory screen');
        }
      }
      // Reflect keyboard state on mobile control visual pressed states
      mobileUpPressed = !!(keys.ArrowUp || keys.w || keys.W);
      mobileDownPressed = !!(keys.ArrowDown || keys.s || keys.S);
      mobileLeftPressed = !!(keys.ArrowLeft || keys.a || keys.A);
      mobileRightPressed = !!(keys.ArrowRight || keys.d || keys.D);
      
      // Input (with speed boost applied: +1% per boost)
      const effectiveDebugSpeed = debugSpeed * (1 + mySpeedBoost * 0.01);
      
      // Player 1 movement with collision detection (unless noclip is enabled)
      if (keys.ArrowLeft || keys.a || keys.A) {
        const newAngle = normalizeAngle(myAngle - effectiveDebugSpeed);
        let canMove = noclipEnabled; // If noclip is on, always allow movement
        
        if (!noclipEnabled) {
          // Check collision with all other players on the same layer
          canMove = true;
          players.forEach((p) => {
            if (!p || !p.id || !myPlayer || p.id === myPlayer.playerId) return;
            const ls = (p as any)?.lastSeen;
            const activeFlag = (p as any)?.active !== false;
            const fresh = typeof ls === 'number' ? (now - ls) < 30000 : true;
            if (!activeFlag || !fresh) return;
            
            const otherLayer = p.layer ?? 0;
            if (otherLayer === myLayer) {
              if (checkPlayerOverlap(newAngle, p.angle)) {
                canMove = false;
              }
            }
          });
          
          // Check collision with player 2 if active
          if (canMove && localCoopEnabled && player2Active && player2Player && player2Layer === myLayer) {
            if (checkPlayerOverlap(newAngle, player2Angle)) {
              canMove = false;
            }
          }
          
          // Check collision with bots on same layer
          if (canMove) {
            botPlayers.forEach((bot) => {
              if (bot.layer === myLayer) {
                if (checkPlayerOverlap(newAngle, bot.angle)) {
                  canMove = false;
                }
              }
            });
          }
        }
        
        if (canMove) {
          myAngle = newAngle;
          lastMovementTime = Date.now();
        }
      }
      
      if (keys.ArrowRight || keys.d || keys.D) {
        const newAngle = normalizeAngle(myAngle + effectiveDebugSpeed);
        let canMove = noclipEnabled; // If noclip is on, always allow movement
        
        if (!noclipEnabled) {
          // Check collision with all other players on the same layer
          canMove = true;
          players.forEach((p) => {
            if (!p || !p.id || !myPlayer || p.id === myPlayer.playerId) return;
            const ls = (p as any)?.lastSeen;
            const activeFlag = (p as any)?.active !== false;
            const fresh = typeof ls === 'number' ? (now - ls) < 30000 : true;
            if (!activeFlag || !fresh) return;
            
            const otherLayer = p.layer ?? 0;
            if (otherLayer === myLayer) {
              if (checkPlayerOverlap(newAngle, p.angle)) {
                canMove = false;
              }
            }
          });
          
          // Check collision with player 2 if active
          if (canMove && localCoopEnabled && player2Active && player2Player && player2Layer === myLayer) {
            if (checkPlayerOverlap(newAngle, player2Angle)) {
              canMove = false;
            }
          }
          
          // Check collision with bots on same layer
          if (canMove) {
            botPlayers.forEach((bot) => {
              if (bot.layer === myLayer) {
                if (checkPlayerOverlap(newAngle, bot.angle)) {
                  canMove = false;
                }
              }
            });
          }
        }
        
        if (canMove) {
          myAngle = newAngle;
          lastMovementTime = Date.now();
        }
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
        
        // Player 2 controls (numpad on PC, mobile buttons on touch devices)
        if (localCoopEnabled && player2Active && player2Player) {
          const hasTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
          const effectiveP2Speed = debugSpeed * (1 + player2SpeedBoost * 0.01);
          
          // Rotation controls
          // PC: Numpad 4 (left), Numpad 6 (right)
          // Mobile: on-screen buttons
          if (keys['4'] || keys.Numpad4 || mobileP2LeftPressed) {
            const newAngle = normalizeAngle(player2Angle - effectiveP2Speed);
            let canMove = noclipEnabled;
            
            if (!noclipEnabled) {
              canMove = true;
              // Check collision with player 1
              if (myPlayer && myLayer === player2Layer) {
                if (checkPlayerOverlap(newAngle, myAngle)) {
                  canMove = false;
                }
              }
              
              // Check collision with other players
              if (canMove) {
                players.forEach((p) => {
                  if (!p || !p.id || (player2Player && p.id === player2Player.playerId)) return;
                  const ls = (p as any)?.lastSeen;
                  const activeFlag = (p as any)?.active !== false;
                  const fresh = typeof ls === 'number' ? (now - ls) < 30000 : true;
                  if (!activeFlag || !fresh) return;
                  
                  const otherLayer = p.layer ?? 0;
                  if (otherLayer === player2Layer) {
                    if (checkPlayerOverlap(newAngle, p.angle)) {
                      canMove = false;
                    }
                  }
                });
              }
              
              // Check collision with bots
              if (canMove) {
                botPlayers.forEach((bot) => {
                  if (bot.layer === player2Layer) {
                    if (checkPlayerOverlap(newAngle, bot.angle)) {
                      canMove = false;
                    }
                  }
                });
              }
            }
            
            if (canMove) {
              player2Angle = newAngle;
              if (player2Player) updateAngle(player2Player.playerId, player2Angle);
            }
          }
          
          if (keys['6'] || keys.Numpad6 || mobileP2RightPressed) {
            const newAngle = normalizeAngle(player2Angle + effectiveP2Speed);
            let canMove = noclipEnabled;
            
            if (!noclipEnabled) {
              canMove = true;
              // Check collision with player 1
              if (myPlayer && myLayer === player2Layer) {
                if (checkPlayerOverlap(newAngle, myAngle)) {
                  canMove = false;
                }
              }
              
              // Check collision with other players
              if (canMove) {
                players.forEach((p) => {
                  if (!p || !p.id || (player2Player && p.id === player2Player.playerId)) return;
                  const ls = (p as any)?.lastSeen;
                  const activeFlag = (p as any)?.active !== false;
                  const fresh = typeof ls === 'number' ? (now - ls) < 30000 : true;
                  if (!activeFlag || !fresh) return;
                  
                  const otherLayer = p.layer ?? 0;
                  if (otherLayer === player2Layer) {
                    if (checkPlayerOverlap(newAngle, p.angle)) {
                      canMove = false;
                    }
                  }
                });
              }
              
              // Check collision with bots
              if (canMove) {
                botPlayers.forEach((bot) => {
                  if (bot.layer === player2Layer) {
                    if (checkPlayerOverlap(newAngle, bot.angle)) {
                      canMove = false;
                    }
                  }
                });
              }
            }
            
            if (canMove) {
              player2Angle = newAngle;
              if (player2Player) updateAngle(player2Player.playerId, player2Angle);
            }
          }
          
          // Layer switching
          // PC: Numpad 8 (up), Numpad 2 (down)
          // Mobile: on-screen buttons
          if ((keys['8'] || keys.Numpad8 || mobileP2UpPressed || keys['2'] || keys.Numpad2 || mobileP2DownPressed) && now - lastPlayer2LayerChange > 200) {
            if ((keys['8'] || keys.Numpad8 || mobileP2UpPressed) && player2Layer < maxAllowedLayer) {
              player2Layer++;
              lastPlayer2LayerChange = now;
              if (player2Player) updateLayer(player2Player.playerId, player2Layer);
            } else if ((keys['2'] || keys.Numpad2 || mobileP2DownPressed) && player2Layer > minAllowedLayer) {
              player2Layer--;
              lastPlayer2LayerChange = now;
              if (player2Player) updateLayer(player2Player.playerId, player2Layer);
            }
          }
          
          // Smooth layer transition for player 2
          player2LayerVisual += (player2Layer - player2LayerVisual) * layerTransitionSpeed;
          if (Math.abs(player2Layer - player2LayerVisual) < 0.01) {
            player2LayerVisual = player2Layer;
          }
        }

      // Update bot AI (for all active bots)
      if (botPlayers.size > 0) {
        updateBotAI(now);
      }

      // Clear
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Calculate dynamic center and scale to fit game in middle 60% of viewport
      const gameCenterX = canvas.width / 2;
      const gameCenterY = canvas.height / 2;
      
      // Available space: middle 60% of height (20% margin top/bottom for controls)
      const availableHeight = canvas.height * 0.6;
      const availableWidth = canvas.width;
      
      // Determine max radius to fit game (OUTER_R at layer MAX_LAYERS)
      const maxGameRadius = Math.min(availableHeight / 2, availableWidth / 2) - 30; // 30px padding
      const scaleFactor = maxGameRadius / OUTER_R;
      
      // Scale all game radii
      const scaledInnerR = INNER_R * scaleFactor;
      const scaledLayerSpacing = FIXED_LAYER_SPACING * scaleFactor;
      
      // Calculate outer nest radius and control positions for mobile
      const outermostRadius = scaledInnerR + scaledLayerSpacing * MAX_LAYERS;
      // Position controls at same level as side buttons (90px from bottom)
      mobileControlBottomDistance = 90;
      // Top controls: mirror position (distance from TOP of viewport)
      mobileControlTopDistance = 90;
      
      // Draw starfield background with twinkling effect
      stars.forEach(star => {
        star.twinklePhase += star.twinkleSpeed;
        const twinkle = Math.sin(star.twinklePhase) * 0.3 + 0.7; // Oscillate between 0.4 and 1.0
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity * twinkle})`;
        ctx.fillRect(star.x, star.y, star.size, star.size);
      });

      // Center circle (sun)
      if (difficulty >= 10) {
        // Difficulty 10: Red sun with glowing orange aura
        const sunGrad = ctx.createRadialGradient(gameCenterX, gameCenterY, 0, gameCenterX, gameCenterY, scaledInnerR);
        sunGrad.addColorStop(0, '#ff3333');
        sunGrad.addColorStop(0.6, '#ff6633');
        sunGrad.addColorStop(1, '#ff9933');
        ctx.fillStyle = sunGrad;
        ctx.shadowBlur = 30 * scaleFactor;
        ctx.shadowColor = '#ff6600';
        ctx.beginPath();
        ctx.arc(gameCenterX, gameCenterY, scaledInnerR, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        // Normal yellow sun
        ctx.fillStyle = '#ff0';
        ctx.beginPath();
        ctx.arc(gameCenterX, gameCenterY, scaledInnerR, 0, Math.PI * 2);
        ctx.fill();
      }
      
        // Draw layer rings using fixed spacing
        // Layers are numbered 0-11, we only draw layers (MAX_LAYERS - numLayers) through (MAX_LAYERS - 1)
        const minLayerIndex = MAX_LAYERS - numLayers;
        for (let layerIdx = minLayerIndex; layerIdx < MAX_LAYERS; layerIdx++) {
          const innerRadius = scaledInnerR + scaledLayerSpacing * layerIdx;
          const outerRadius = scaledInnerR + scaledLayerSpacing * (layerIdx + 1);
          
          // Map layerIdx to color index (0 to numLayers-1 for the color array)
          const colorIndex = layerIdx - minLayerIndex;
          ctx.fillStyle = layerColors[colorIndex];
          ctx.beginPath();
          ctx.arc(gameCenterX, gameCenterY, outerRadius, 0, Math.PI * 2);
          ctx.arc(gameCenterX, gameCenterY, innerRadius, 0, Math.PI * 2, true); // Draw hole
          ctx.fill();
        }

      // Draw player nests (wheel segments in outermost layer)
      {
        // Nests are always at the fixed outermost position (MAX_LAYERS - 1)
        const outermostRadius = scaledInnerR + scaledLayerSpacing * MAX_LAYERS;
        const nestAngularWidth = (Math.PI * 2) / PLAYER_COLORS.length; // Divide circle evenly, no gaps
        
        PLAYER_COLORS.forEach((colorData, idx) => {
          // Calculate nest position to fill entire circle with no gaps
          const nestStartAngle = (idx * nestAngularWidth) - (Math.PI * 2 / 4); // Start from top, rotate -90°
          const nestEndAngle = nestStartAngle + nestAngularWidth;
          
          // Check if this color is active
          const isActive = activeUsedColorsAll.has(idx);
          
          // Find the player who owns this nest color (check all players including bots)
          const nestOwner = players.find(p => p && p.colorIndex === idx);
          
          // Check if this is my nest and get VIP effects
          const isMyNest = idx === myColorIndex && myPlayer;
          const nestVipGolden = isMyNest ? vipGolden : (nestOwner?.vipSkins?.golden || false);
          const nestVipBlackStars = isMyNest ? vipBlackStars : (nestOwner?.vipSkins?.blackStars || false);
          
          let nestColor = colorData.hex;
          if (nestVipGolden) {
            nestColor = '#FFD700'; // Metallic gold
          } else if (nestVipBlackStars) {
            nestColor = '#000000'; // Black
          }
          
          // Draw main nest arc with low opacity (0.2) - nest background
          if (nestVipGolden) {
            // Golden shimmer effect for nest
            ctx.globalAlpha = 0.3;
            const shimmerProgress = (now % 2500) / 2500; // 2.5 second cycle
            
            // Calculate gradient for arc shimmer
            const midAngle = (nestStartAngle + nestEndAngle) / 2;
            const perpAngle = midAngle + Math.PI / 2;
            const gradientLength = outermostRadius * 0.5;
            const arcMidX = gameCenterX + Math.cos(midAngle) * outermostRadius;
            const arcMidY = gameCenterY + Math.sin(midAngle) * outermostRadius;
            const gradientOffset = (shimmerProgress - 0.5) * outermostRadius * 2;
            const grad1X = arcMidX + Math.cos(perpAngle) * gradientLength + Math.cos(midAngle) * gradientOffset;
            const grad1Y = arcMidY + Math.sin(perpAngle) * gradientLength + Math.sin(midAngle) * gradientOffset;
            const grad2X = arcMidX - Math.cos(perpAngle) * gradientLength + Math.cos(midAngle) * gradientOffset;
            const grad2Y = arcMidY - Math.sin(perpAngle) * gradientLength + Math.sin(midAngle) * gradientOffset;
            
            const gradient = ctx.createLinearGradient(grad1X, grad1Y, grad2X, grad2Y);
            gradient.addColorStop(0, '#B8860B');
            gradient.addColorStop(0.3, '#DAA520');
            gradient.addColorStop(0.5, '#FFFACD');
            gradient.addColorStop(0.7, '#DAA520');
            gradient.addColorStop(1, '#B8860B');
            
            ctx.strokeStyle = gradient;
            ctx.lineWidth = 25 * scaleFactor;
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.arc(gameCenterX, gameCenterY, outermostRadius, nestStartAngle, nestEndAngle);
            ctx.stroke();
            
            // Bright shine overlay
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.15;
            const shineGrad = ctx.createLinearGradient(grad1X, grad1Y, grad2X, grad2Y);
            shineGrad.addColorStop(0, 'transparent');
            shineGrad.addColorStop(0.45, 'transparent');
            shineGrad.addColorStop(0.5, '#FFFFFF');
            shineGrad.addColorStop(0.55, 'transparent');
            shineGrad.addColorStop(1, 'transparent');
            ctx.strokeStyle = shineGrad;
            ctx.lineWidth = 25 * scaleFactor;
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.arc(gameCenterX, gameCenterY, outermostRadius, nestStartAngle, nestEndAngle);
            ctx.stroke();
            ctx.restore();
          } else {
            // Normal nest rendering
            ctx.globalAlpha = 0.2;
            ctx.strokeStyle = nestColor;
            ctx.lineWidth = 25 * scaleFactor;
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.arc(gameCenterX, gameCenterY, outermostRadius, nestStartAngle, nestEndAngle);
            ctx.stroke();
          }
          
          // VIP Black Stars effect - draw stars on nest
          if (nestVipBlackStars) {
            const numStars = 12;
            const arcLength = nestEndAngle - nestStartAngle;
            // Use nest owner's player ID for seeding, or fallback to color index
            const seedPlayerId = nestOwner?.id || String(idx);
            
            for (let i = 0; i < numStars; i++) {
              // Use player ID to seed pseudo-random but consistent positions
              const seed = (seedPlayerId.charCodeAt(i % (seedPlayerId.length || 1)) || 0) + i + 100; // +100 to differentiate from fragment stars
              const randomOffset = (Math.sin(seed) * 0.5 + 0.5); // 0 to 1
              const randomSize = (Math.cos(seed * 1.3) * 0.5 + 0.5); // 0 to 1
              const randomRotation = Math.sin(seed * 2.1) * Math.PI;
              
              // Vary position along the arc (with some randomness)
              const positionRatio = (i / (numStars - 1)) * 0.9 + randomOffset * 0.1;
              const starAngle = nestStartAngle + arcLength * positionRatio;
              
              // Add slight radius variation (stars slightly in/out from nest arc)
              const radiusOffset = (Math.sin(seed * 1.7) - 0.5) * 8 * scaleFactor;
              const starRadius = outermostRadius + radiusOffset;
              
              const starX = gameCenterX + Math.cos(starAngle) * starRadius;
              const starY = gameCenterY + Math.sin(starAngle) * starRadius;
              
              // Vary star size
              const baseSize = 1.5 * scaleFactor;
              const starSize = baseSize + randomSize * baseSize * 0.8;
              
              // Twinkle effect based on time
              const twinkleSpeed = 0.002 + randomOffset * 0.003;
              const twinklePhase = seed + now * twinkleSpeed;
              const twinkle = Math.sin(twinklePhase) * 0.3 + 0.7; // 0.4 to 1.0
              
              // Draw a small white star with varied opacity
              ctx.save();
              ctx.translate(starX, starY);
              ctx.rotate(randomRotation);
              ctx.globalAlpha = twinkle;
              ctx.fillStyle = '#ffffff';
              ctx.beginPath();
              for (let j = 0; j < 5; j++) {
                const pointAngle = (j * 2 * Math.PI) / 5 - Math.PI / 2;
                const x = Math.cos(pointAngle) * starSize;
                const y = Math.sin(pointAngle) * starSize;
                if (j === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
              }
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            }
            ctx.globalAlpha = 1.0; // Reset opacity after stars
          }
          
          // Draw collision border at 0.8 opacity if active (outer edge)
          if (isActive) {
            if (nestVipGolden) {
              // Golden shimmer border
              ctx.globalAlpha = 0.9;
              const shimmerProgress = (now % 2500) / 2500;
              const midAngle = (nestStartAngle + nestEndAngle) / 2;
              const borderRadius = outermostRadius + 12.5 * scaleFactor;
              const perpAngle = midAngle + Math.PI / 2;
              const gradientLength = borderRadius * 0.5;
              const arcMidX = gameCenterX + Math.cos(midAngle) * borderRadius;
              const arcMidY = gameCenterY + Math.sin(midAngle) * borderRadius;
              const gradientOffset = (shimmerProgress - 0.5) * borderRadius * 2;
              const grad1X = arcMidX + Math.cos(perpAngle) * gradientLength + Math.cos(midAngle) * gradientOffset;
              const grad1Y = arcMidY + Math.sin(perpAngle) * gradientLength + Math.sin(midAngle) * gradientOffset;
              const grad2X = arcMidX - Math.cos(perpAngle) * gradientLength + Math.cos(midAngle) * gradientOffset;
              const grad2Y = arcMidY - Math.sin(perpAngle) * gradientLength + Math.sin(midAngle) * gradientOffset;
              
              const borderGradient = ctx.createLinearGradient(grad1X, grad1Y, grad2X, grad2Y);
              borderGradient.addColorStop(0, '#DAA520');
              borderGradient.addColorStop(0.5, '#FFFACD');
              borderGradient.addColorStop(1, '#DAA520');
              
              ctx.strokeStyle = borderGradient;
              ctx.lineWidth = 4 * scaleFactor;
              ctx.lineCap = 'butt';
              ctx.beginPath();
              ctx.arc(gameCenterX, gameCenterY, borderRadius, nestStartAngle, nestEndAngle);
              ctx.stroke();
            } else {
              // Normal border
              ctx.globalAlpha = 0.8;
              ctx.strokeStyle = nestColor;
              ctx.lineWidth = 4 * scaleFactor;
              ctx.lineCap = 'butt';
              ctx.beginPath();
              ctx.arc(gameCenterX, gameCenterY, outermostRadius + 12.5 * scaleFactor, nestStartAngle, nestEndAngle);
              ctx.stroke();
            }
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
  let color = (cIndex != null && PLAYER_COLORS[cIndex]) ? PLAYER_COLORS[cIndex].hex : '#888';
        
        // Get player's VIP skins (either from local settings or from player data in Firebase)
        const playerVipGlow = isMyPlayer ? vipGlow : (p.vipSkins?.glow || false);
        const playerVipGolden = isMyPlayer ? vipGolden : (p.vipSkins?.golden || false);
        const playerVipBlackStars = isMyPlayer ? vipBlackStars : (p.vipSkins?.blackStars || false);
        
        // Apply VIP effects
        if (playerVipGolden) {
          color = '#FFD700'; // Metallic gold
        } else if (playerVipBlackStars) {
          color = '#000000'; // Black
        }
        
  // Get player's layer and corresponding radius
  // For the current player, use smooth visual layer; for others use their actual layer
  const playerLayer = isMyPlayer ? myLayerVisual : (p.layer ?? 0);
    // Use fixed layer spacing - layers are numbered 0-11, where 11 is outermost
    const layerRadius = scaledInnerR + scaledLayerSpacing * (playerLayer + 1);
        
        // Get the player's angle (use myAngle for my player, p.angle for others)
        const angle = isMyPlayer ? myAngle : p.angle;
        const startA = normalizeAngle(angle - PIPE_WIDTH / 2);
        const endA = normalizeAngle(angle + PIPE_WIDTH / 2);
        
        // VIP Glow effect (add outer glow)
        if (playerVipGlow) {
          ctx.save();
          ctx.shadowColor = color;
          ctx.shadowBlur = 30 * scaleFactor;
          ctx.strokeStyle = color;
          ctx.lineWidth = 25 * scaleFactor;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(gameCenterX, gameCenterY, layerRadius, startA, endA);
          ctx.stroke();
          ctx.restore();
        }
        
        // Main player fragment
        
        // VIP Golden shimmer effect
        if (playerVipGolden) {
          // Create animated shimmer gradient
          const shimmerProgress = (now % 2500) / 2500; // 2.5 second cycle
          
          // Calculate arc start and end points in cartesian coordinates
          const startX = gameCenterX + Math.cos(startA) * layerRadius;
          const startY = gameCenterY + Math.sin(startA) * layerRadius;
          const endX = gameCenterX + Math.cos(endA) * layerRadius;
          const endY = gameCenterY + Math.sin(endA) * layerRadius;
          
          // Calculate perpendicular vector for gradient direction
          const midAngle = (startA + endA) / 2;
          const perpAngle = midAngle + Math.PI / 2;
          const gradientLength = layerRadius * 0.5;
          
          // Animate gradient position along the arc
          const arcMidX = gameCenterX + Math.cos(midAngle) * layerRadius;
          const arcMidY = gameCenterY + Math.sin(midAngle) * layerRadius;
          
          // Move gradient from left to right across the arc
          const gradientOffset = (shimmerProgress - 0.5) * layerRadius * 2;
          const grad1X = arcMidX + Math.cos(perpAngle) * gradientLength + Math.cos(midAngle) * gradientOffset;
          const grad1Y = arcMidY + Math.sin(perpAngle) * gradientLength + Math.sin(midAngle) * gradientOffset;
          const grad2X = arcMidX - Math.cos(perpAngle) * gradientLength + Math.cos(midAngle) * gradientOffset;
          const grad2Y = arcMidY - Math.sin(perpAngle) * gradientLength + Math.sin(midAngle) * gradientOffset;
          
          const gradient = ctx.createLinearGradient(grad1X, grad1Y, grad2X, grad2Y);
          
          // Gold shimmer colors - darker gold -> bright highlight -> darker gold
          gradient.addColorStop(0, '#B8860B');    // Dark goldenrod
          gradient.addColorStop(0.3, '#DAA520');  // Goldenrod
          gradient.addColorStop(0.5, '#FFFACD');  // Lemon chiffon (bright highlight)
          gradient.addColorStop(0.7, '#DAA520');  // Goldenrod
          gradient.addColorStop(1, '#B8860B');    // Dark goldenrod
          
          ctx.strokeStyle = gradient;
          ctx.lineWidth = 25 * scaleFactor;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(gameCenterX, gameCenterY, layerRadius, startA, endA);
          ctx.stroke();
          
          // Add metallic shine overlay
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.3;
          const shineGrad = ctx.createLinearGradient(grad1X, grad1Y, grad2X, grad2Y);
          shineGrad.addColorStop(0, 'transparent');
          shineGrad.addColorStop(0.45, 'transparent');
          shineGrad.addColorStop(0.5, '#FFFFFF');
          shineGrad.addColorStop(0.55, 'transparent');
          shineGrad.addColorStop(1, 'transparent');
          ctx.strokeStyle = shineGrad;
          ctx.lineWidth = 25 * scaleFactor;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(gameCenterX, gameCenterY, layerRadius, startA, endA);
          ctx.stroke();
          ctx.restore();
        } else {
          // Normal rendering
          ctx.strokeStyle = color;
          ctx.lineWidth = 25 * scaleFactor;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(gameCenterX, gameCenterY, layerRadius, startA, endA);
          ctx.stroke();
        }
        
        // VIP Black Stars effect - draw stars on the fragment
        if (playerVipBlackStars) {
          const numStars = 12; // More stars for better coverage
          const arcLength = endA - startA;
          // Use the actual player's ID for seeding
          const seedPlayerId = p.id || '';
          
          for (let i = 0; i < numStars; i++) {
            // Use player ID to seed pseudo-random but consistent positions
            const seed = (seedPlayerId.charCodeAt(i % (seedPlayerId.length || 1)) || 0) + i;
            const randomOffset = (Math.sin(seed) * 0.5 + 0.5); // 0 to 1
            const randomSize = (Math.cos(seed * 1.3) * 0.5 + 0.5); // 0 to 1
            const randomRotation = Math.sin(seed * 2.1) * Math.PI;
            
            // Vary position along the arc (with some randomness)
            const positionRatio = (i / (numStars - 1)) * 0.9 + randomOffset * 0.1;
            const starAngle = startA + arcLength * positionRatio;
            
            // Add slight radius variation (stars slightly in/out from arc)
            const radiusOffset = (Math.sin(seed * 1.7) - 0.5) * 8 * scaleFactor;
            const starRadius = layerRadius + radiusOffset;
            
            const starX = gameCenterX + Math.cos(starAngle) * starRadius;
            const starY = gameCenterY + Math.sin(starAngle) * starRadius;
            
            // Vary star size
            const baseSize = 1.5 * scaleFactor;
            const starSize = baseSize + randomSize * baseSize * 0.8;
            
            // Twinkle effect based on time
            const twinkleSpeed = 0.002 + randomOffset * 0.003;
            const twinklePhase = seed + now * twinkleSpeed;
            const twinkle = Math.sin(twinklePhase) * 0.3 + 0.7; // 0.4 to 1.0
            
            // Draw a small white star with varied opacity
            ctx.save();
            ctx.translate(starX, starY);
            ctx.rotate(randomRotation);
            ctx.globalAlpha = twinkle;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            for (let j = 0; j < 5; j++) {
              const pointAngle = (j * 2 * Math.PI) / 5 - Math.PI / 2;
              const x = Math.cos(pointAngle) * starSize;
              const y = Math.sin(pointAngle) * starSize;
              if (j === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
          ctx.globalAlpha = 1.0; // Reset opacity after stars
        }

        // Accent ring
        ctx.lineWidth = 8 * scaleFactor;
        ctx.strokeStyle = color + '44';
        ctx.beginPath();
    ctx.arc(gameCenterX, gameCenterY, layerRadius, startA, endA);
        ctx.stroke();

        // Speed boost indicator (draw small triangles/chevrons if myPlayer has boosts)
        // Max 30 markers arranged in 3 lines (10 per line) spread over more width behind player
        if (isMyPlayer && mySpeedBoost > 0) {
          const midAngle = angle;
          const totalMarkers = Math.min(30, mySpeedBoost); // Max 30 markers
          const markersPerLine = 10; // 10 markers per line
          const numLines = 3; // 3 lines of markers
          
          const chevronGap = 8 * scaleFactor; // Distance between markers in same line
          const lineSpacing = 10 * scaleFactor; // Distance between lines (radially)
          const lateralSpread = 6 * scaleFactor; // How far markers spread perpendicular to radius
          const baseOffset = layerRadius + 18 * scaleFactor; // Starting distance from player
          
          for (let i = 0; i < totalMarkers; i++) {
            // Determine which line this marker is on (0, 1, or 2)
            const lineIndex = Math.floor(i / markersPerLine);
            // Position within the line (0-9)
            const posInLine = i % markersPerLine;
            
            // Radial offset (distance from player fragment)
            const radialOffset = baseOffset + lineIndex * lineSpacing;
            
            // Lateral offset (perpendicular to radius) - spread markers across width
            // Center the markers: range from -4.5 to +4.5 lateralSpread units
            const lateralOffset = (posInLine - 4.5) * (lateralSpread / 2);
            
            // Calculate marker position
            // Base position along radius
            const baseX = gameCenterX + Math.cos(midAngle) * radialOffset;
            const baseY = gameCenterY + Math.sin(midAngle) * radialOffset;
            
            // Apply lateral offset (perpendicular to radius)
            const perpAngle = midAngle + Math.PI / 2;
            const cx = baseX + Math.cos(perpAngle) * lateralOffset;
            const cy = baseY + Math.sin(perpAngle) * lateralOffset;
            
            const size = 5 * scaleFactor; // Slightly smaller markers
            
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
  const overshootPx = 240 * scaleFactor; // keep flows until further past canvas edge (doubled)
      flowCache.forEach((flow, id) => {
        if (flowsToRemove.has(id)) return; // collided -> skip
        const progress = ((now - flow.spawnTime) / getFlowDuration(flow)) * speedBiasForAngle(flow.angle);
  const flowRadius = scaledInnerR + progress * (maxGameRadius - scaledInnerR);
  // If flow exits beyond the canvas (outside render radius), tag it as layer 5 once
  if (flow.layer !== 5 && flowRadius > maxGameRadius) {
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
        if (flowRadius < maxGameRadius + overshootPx) {
          activeFlows.push(flow);
        } else {
          flowCache.delete(id);
        }
      });
      
      activeFlows.forEach(flow => {
        const rawProgress = ((now - flow.spawnTime) / getFlowDuration(flow)) * speedBiasForAngle(flow.angle);
        const r = scaledInnerR + rawProgress * (maxGameRadius - scaledInnerR);
        const headX = gameCenterX + Math.cos(flow.angle) * r;
        const headY = gameCenterY + Math.sin(flow.angle) * r;

        // Fading trail length factor (shortens near end of life)
        const trailFactor = Math.min(1, Math.max(0.15, 1 - rawProgress * 0.7));
        const tailR = scaledInnerR + (rawProgress - trailFactor * 0.25) * (maxGameRadius - scaledInnerR);
        const tailRClamped = Math.max(scaledInnerR, tailR);
        const tailX = gameCenterX + Math.cos(flow.angle) * tailRClamped;
        const tailY = gameCenterY + Math.sin(flow.angle) * tailRClamped;

        // Create gradient for trail fade
        const grad = ctx.createLinearGradient(tailX, tailY, headX, headY);
        if (flow.isEvil) {
          // Evil flow colors based on difficulty
          if (difficulty >= 10) {
            // Difficulty 10: Green with green glow
            grad.addColorStop(0, 'rgba(50,255,50,0)');
            grad.addColorStop(1, 'rgba(50,255,50,0.6)');
          } else if (difficulty >= 7) {
            // Difficulty 7-9: Black with red glow
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(1, 'rgba(0,0,0,0.6)');
          } else if (difficulty >= 3) {
            // Difficulty 3-6: Darker red
            grad.addColorStop(0, 'rgba(200,30,30,0)');
            grad.addColorStop(1, 'rgba(200,30,30,0.5)');
          } else {
            // Difficulty 1-2: Normal red
            grad.addColorStop(0, 'rgba(255,64,64,0)');
            grad.addColorStop(1, 'rgba(255,64,64,0.4)');
          }
        } else {
          // Normal flow colors
          if (difficulty >= 10) {
            // Difficulty 10: Glowing yellow
            grad.addColorStop(0, 'rgba(255,255,100,0)');
            grad.addColorStop(1, 'rgba(255,255,100,0.8)');
          } else {
            grad.addColorStop(0, 'rgba(255,255,0,0)');
            grad.addColorStop(1, 'rgba(255,255,0,0.4)');
          }
        }

        const evilSizeMod = flow.isEvil ? getEvilFlowSizeModifier() : 1.0;
        const normalSizeMod = flow.isEvil ? 1.0 : getFlowSizeModifier();
        const totalSizeMod = evilSizeMod * normalSizeMod;
        
        ctx.lineWidth = flow.isEvil ? 5 * scaleFactor * totalSizeMod : 4 * scaleFactor * totalSizeMod;
        ctx.lineCap = 'round';
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(headX, headY);
        ctx.stroke();

        // Draw head with slight glow effect via double circle
        if (flow.isEvil) {
          if (difficulty >= 10) {
            // Difficulty 10: Green with green glow
            ctx.shadowBlur = 15 * scaleFactor;
            ctx.shadowColor = '#00ff00';
            ctx.fillStyle = '#33ff33';
            ctx.beginPath();
            ctx.arc(headX, headY, 9 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#88ff88';
            ctx.beginPath();
            ctx.arc(headX, headY, 5 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
          } else if (difficulty >= 7) {
            // Difficulty 7-9: Black with red glow
            ctx.shadowBlur = 12 * scaleFactor;
            ctx.shadowColor = '#ff0000';
            ctx.fillStyle = '#000000';
            ctx.beginPath();
            ctx.arc(headX, headY, 9 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#330000';
            ctx.beginPath();
            ctx.arc(headX, headY, 5 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
          } else if (difficulty >= 3) {
            // Difficulty 3-6: Darker red
            ctx.fillStyle = '#cc1111';
            ctx.beginPath();
            ctx.arc(headX, headY, 9 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ff3333';
            ctx.beginPath();
            ctx.arc(headX, headY, 5 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
          } else {
            // Difficulty 1-2: Normal red
            ctx.fillStyle = '#ff3333';
            ctx.beginPath();
            ctx.arc(headX, headY, 9 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ff6666';
            ctx.beginPath();
            ctx.arc(headX, headY, 5 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          // Normal flows
          if (difficulty >= 10) {
            // Difficulty 10: Glowing yellow
            ctx.shadowBlur = 15 * scaleFactor;
            ctx.shadowColor = '#ffff00';
            ctx.fillStyle = '#ffff33';
            ctx.beginPath();
            ctx.arc(headX, headY, 8 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#ffffaa';
            ctx.beginPath();
            ctx.arc(headX, headY, 4 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = '#ffff33';
            ctx.beginPath();
            ctx.arc(headX, headY, 8 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fffacd';
            ctx.beginPath();
            ctx.arc(headX, headY, 4 * scaleFactor * totalSizeMod, 0, Math.PI * 2);
            ctx.fill();
          }
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
      
      // Check collisions for Player 2 (local co-op)
      if (localCoopEnabled && player2Active && player2Player) {
        activeFlows.forEach(checkScorePlayer2);
      }

      // Render arc animations - flowing forward effect (wave moves from player toward sun)
      const nowMs = Date.now();
      activeArcs = activeArcs.filter(arc => nowMs - arc.startTime < arc.duration);
      
      activeArcs.forEach(arc => {
        const progress = (nowMs - arc.startTime) / arc.duration;
        
        // Arc width matches player fragment width (PIPE_WIDTH)
        const arcAngularWidth = PIPE_WIDTH;
        
        // Arc flows forward - starting at player layer, moving INWARD toward sun to intercept flows
        const startLayerRadius = scaledInnerR + scaledLayerSpacing * arc.playerLayer;
        const layerSpan = 3;
        
        // The wave position moves inward (toward sun at layer 0) as progress increases
        const waveCenter = arc.playerLayer - progress * layerSpan; // Moves from playerLayer toward 0
        const waveWidth = 1.5; // How wide the wave is (in layers)
        
        const startAngle = arc.playerAngle - arcAngularWidth / 2;
        const endAngle = arc.playerAngle + arcAngularWidth / 2;
        
        // Color based on player, with VIP golden override for player 1
        let arcColor = arc.isPlayer2 ? 'rgba(100, 150, 255, ' : 'rgba(255, 200, 0, ';
        if (!arc.isPlayer2) {
          // Check if player 1 has VIP golden skin
          const arcOwnerVipGolden = myPlayer ? vipGolden : false;
          if (arcOwnerVipGolden) {
            arcColor = 'rgba(255, 215, 0, '; // Golden arc
          }
        }
        
        // Draw the flowing wave across all potentially visible layers (moving inward toward sun)
        for (let checkLayer = arc.playerLayer; checkLayer >= Math.max(0, arc.playerLayer - layerSpan); checkLayer--) {
          // Calculate how far this layer is from the wave center
          const distanceFromWave = Math.abs(checkLayer - waveCenter);
          
          // Only render if within wave width
          if (distanceFromWave > waveWidth) continue;
          
          // Calculate alpha based on distance from wave center (Gaussian-like falloff)
          const waveFalloff = 1 - (distanceFromWave / waveWidth);
          const layerAlpha = Math.pow(waveFalloff, 2) * (1 - progress * 0.3); // Fade out overall as time progresses
          
          if (layerAlpha <= 0.05) continue;
          
          const currentLayerRadius = scaledInnerR + scaledLayerSpacing * checkLayer;
          
          // Draw multiple arc layers for glow effect
          for (let glowLayer = 0; glowLayer < 3; glowLayer++) {
            const alpha = layerAlpha * (0.7 - glowLayer * 0.15);
            const width = (12 - glowLayer * 3) * scaleFactor;
            
            ctx.strokeStyle = arcColor + alpha + ')';
            ctx.lineWidth = width;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.arc(gameCenterX, gameCenterY, currentLayerRadius + glowLayer * 3 * scaleFactor, startAngle, endAngle);
            ctx.stroke();
          }
          
          // Add particles/sparkles along the arc (more at wave center)
          if (distanceFromWave < 0.8) {
            const particleCount = 8;
            for (let i = 0; i < particleCount; i++) {
              const angle = startAngle + (endAngle - startAngle) * (i / particleCount);
              const particleRadius = currentLayerRadius + Math.sin(progress * Math.PI * 6 + i) * 6 * scaleFactor;
              const px = gameCenterX + Math.cos(angle) * particleRadius;
              const py = gameCenterY + Math.sin(angle) * particleRadius;
              
              ctx.fillStyle = arcColor + (layerAlpha * 0.8) + ')';
              ctx.beginPath();
              ctx.arc(px, py, 3 * scaleFactor * layerAlpha, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      });

      // Arc collision detection - check flows only when the wave reaches them
      if (activeArcs.length > 0) {
        const arcAngularWidth = PIPE_WIDTH; // Match visual arc width
        
        console.log('[Arc] Active arcs:', activeArcs.length, 'Flow cache size:', flowCache.size);
        
        activeArcs.forEach(arc => {
          const progress = (nowMs - arc.startTime) / arc.duration;
          
          // Calculate where the wave currently is
          const layerSpan = 3;
          const waveCenter = arc.playerLayer - progress * layerSpan; // Moves from playerLayer toward 0
          const waveWidth = 1.5; // How wide the wave is (in layers)
          
          let checkedCount = 0;
          let evilCount = 0;
          let passedAngleCheck = 0;
          
          // Check all flows in flowCache
          flowCache.forEach((flow, flowId) => {
            checkedCount++;
            
            if (!flow.isEvil) return;
            evilCount++;
            
            if (arc.destroyedFlows.has(flowId)) return;
            
            const flowAngle = flow.angle;
            const flowLayer = flow.layer ?? 0;
            
            // Check if wave has reached this flow's layer
            const distanceFromWave = Math.abs(flowLayer - waveCenter);
            
            // Only destroy if wave is at this layer (within wave width)
            if (distanceFromWave > waveWidth) return;
            
            // Check angle
            const angleDiff = Math.abs(normalizeAngle(flowAngle - arc.playerAngle));
            const normalizedDiff = angleDiff > Math.PI ? 2 * Math.PI - angleDiff : angleDiff;
            const arcHalfWidth = arcAngularWidth / 2;
            
            // Log first few flows being checked
            if (evilCount <= 3) {
              console.log('[Arc] Checking evil flow:', {
                flowId,
                flowLayer,
                waveCenter: waveCenter.toFixed(2),
                distanceFromWave: distanceFromWave.toFixed(2),
                flowAngle: (flowAngle * 180 / Math.PI).toFixed(1) + '°',
                arcAngle: (arc.playerAngle * 180 / Math.PI).toFixed(1) + '°',
                normalizedDiff: (normalizedDiff * 180 / Math.PI).toFixed(1) + '°',
                arcHalfWidth: (arcHalfWidth * 180 / Math.PI).toFixed(1) + '°',
                willDestroy: normalizedDiff <= arcHalfWidth
              });
            }
            
            if (normalizedDiff <= arcHalfWidth) {
              passedAngleCheck++;
              
              // Destroy this flow
              arc.destroyedFlows.add(flowId);
              
              // Get Firebase key from flow object (flowId has decimals which Firebase doesn't allow)
              const dbKey = (flow as any).key as string | undefined;
              
              console.log('[Arc] 💥 DESTROYING FLOW!', {
                flowId,
                dbKey,
                flowLayer,
                waveCenter: waveCenter.toFixed(2),
                distanceFromWave: distanceFromWave.toFixed(2),
                flowAngle: (flowAngle * 180 / Math.PI).toFixed(1) + '°',
                arcAngle: (arc.playerAngle * 180 / Math.PI).toFixed(1) + '°',
                angleDiff: (normalizedDiff * 180 / Math.PI).toFixed(1) + '°',
                arcHalfWidth: (arcHalfWidth * 180 / Math.PI).toFixed(1) + '°',
                progress: (progress * 100).toFixed(0) + '%'
              });
              
              // Remove from local cache and mark for removal immediately
              flowCache.delete(flowId);
              flowsToRemove.add(flowId);
              
              // Destroy via Firebase using the actual Firebase key
              if (dbKey) {
                import('firebase/database').then(({ ref, set }) => {
                  set(ref(db, `${ROOM}/flows/${dbKey}`), null).catch((err: any) => {
                    console.error('[Arc] Failed to destroy flow:', err);
                  });
                });
              } else {
                console.warn('[Arc] Flow has no Firebase key, cannot delete:', flowId);
              }
            }
          });
          
          console.log('[Arc Check Summary]', {
            progress: (progress * 100).toFixed(0) + '%',
            totalFlows: checkedCount,
            evilFlows: evilCount,
            destroyed: passedAngleCheck,
            arcAngle: (arc.playerAngle * 180 / Math.PI).toFixed(1) + '°',
            arcWidth: (arcAngularWidth * 180 / Math.PI).toFixed(1) + '°'
          });
        });
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
        const isMobile = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
        const dotSize = 12;
        const gap = 6;
        const margin = 60; // Increased from 12 to 60 to avoid overlapping with top buttons
        const panelPadding = 8;
        
        // Count different player types
        let regularPlayers = 0;
        let botPlayerCount = 0;
        let coopPlayers = 0;
        players.forEach(p => {
          if (p?.colorIndex != null && p.active) {
            if (p.isBot) botPlayerCount++;
            else if (p.isLocalCoop) coopPlayers++;
            else regularPlayers++;
          }
        });
        // Don't add from botPlayers Map - they're already in the players array
        // Add Player 2 if active (only if not already counted in players array)
        if (player2Active && player2ColorIndex != null && !players.some(p => p.isLocalCoop && p.colorIndex === player2ColorIndex)) {
          coopPlayers++;
        }
        
        // On mobile: only show text, no dots
        if (isMobile) {
          const panelW = 140;
          const panelH = 36;
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
          // Label - first line (centered)
          ctx.font = 'bold 12px Arial';
          ctx.fillStyle = '#ccc';
          ctx.textAlign = 'center';
          const activeSlots = activeUsedColorsAll.size;
          const textCenterX = panelX + panelW / 2;
          ctx.fillText(`Slots ${activeSlots}/${slotCount}`, textCenterX, panelY + 14);
          // Label - second line (breakdown)
          ctx.font = '10px Arial';
          ctx.fillStyle = '#999';
          let breakdown = [];
          if (regularPlayers > 0) breakdown.push(`${regularPlayers}p`);
          if (botPlayerCount > 0) breakdown.push(`${botPlayerCount}bot`);
          if (coopPlayers > 0) breakdown.push(`${coopPlayers}co-op`);
          if (breakdown.length > 0) {
            ctx.fillText(breakdown.join(' • '), textCenterX, panelY + 28);
          }
          ctx.textAlign = 'left'; // Reset
        } else {
          // Desktop: show dots
          const panelW = slotCount * dotSize + (slotCount - 1) * gap + panelPadding * 2;
          const labelHeight = 28; // Height for the text area above dots
          const panelH = labelHeight + dotSize + panelPadding * 2;
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
          // Label - first line (centered in label area)
          ctx.font = 'bold 11px Arial';
          ctx.fillStyle = '#ccc';
          ctx.textAlign = 'center';
          const activeSlots = activeUsedColorsAll.size;
          const textStartY = panelY + (labelHeight - 12) / 2; // Center the two lines
          const textCenterX = panelX + panelW / 2;
          ctx.fillText(`Slots ${activeSlots}/${slotCount}`, textCenterX, textStartY + 10);
          // Label - second line (breakdown)
          ctx.font = '10px Arial';
          ctx.fillStyle = '#999';
          let breakdown = [];
          if (regularPlayers > 0) breakdown.push(`${regularPlayers} player${regularPlayers > 1 ? 's' : ''}`);
          if (botPlayerCount > 0) breakdown.push(`${botPlayerCount} bot${botPlayerCount > 1 ? 's' : ''}`);
          if (coopPlayers > 0) breakdown.push(`${coopPlayers} co-op`);
          if (breakdown.length > 0) {
            ctx.fillText(breakdown.join(', '), textCenterX, textStartY + 22);
          }
          ctx.textAlign = 'left'; // Reset to default
          // Dots row
          const dotsY = panelY + labelHeight + panelPadding;
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
          
          const isMobile = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
          
          if (isMobile) {
            // Mobile: Show player name on the left at same height as FPS/Playtime (mirrored position)
            ctx.textAlign = 'left';
            ctx.fillStyle = '#fff';
            // Color dot
            ctx.fillStyle = colorHex;
            ctx.beginPath();
            ctx.arc(14, labelY - 26, 5, 0, Math.PI * 2);
            ctx.fill();
            // Name with underline in color
            const textX = 26;
            ctx.fillStyle = '#fff';
            ctx.fillText(myName, textX, labelY - 20);
            const w = ctx.measureText(myName).width;
            ctx.strokeStyle = colorHex + 'cc';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(textX, labelY - 17);
            ctx.lineTo(textX + w, labelY - 17);
            ctx.stroke();
          } else {
            // Desktop: Show player name at bottom as before
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
          }

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

<!-- REMOVED: MigrationButton - migration complete, now using Firestore -->

<!-- Menu Button and Music Controls (always visible top-left) -->
<div style="position: absolute; top: 10px; left: 10px; z-index: 10; display: flex; align-items: center; gap: 10px;">
  <button on:click|stopPropagation={openContextMenu} style="background:#2a4a2a; color:#fff; border:none; border-radius:6px; padding:8px 14px; cursor:pointer; font-size:16px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">
    ☰ Menu
  </button>
  
  {#if youtubePlayer}
  <div style="display: flex; align-items: center; gap: 8px;">
    <button 
      on:click|stopPropagation={toggleBackgroundMusic}
      style="background:#1a1a2a; color:#fff; border:1px solid #3a3a5a; border-radius:6px; padding:8px 14px; cursor:pointer; font-size:20px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); line-height: 1;"
      title={isMusicPlaying ? 'Pause Music' : 'Play Music'}
    >
      {isMusicPlaying ? '⏸️' : '▶️'}
    </button>
    <div style="font-size: 12px; color: #aaa; background: rgba(0,0,0,0.5); padding: 6px 10px; border-radius: 4px;">
      Playing: {musicTracks[currentMusicIndex].name}
    </div>
  </div>
  {/if}
</div>

{#if dev}
<div style="position: absolute; top: 10px; right: 10px; z-index: 10;">
  <button on:click={toggleDebug} style="background:#333; color:#fff; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; width:100%;">
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
    <label for="gameSpeedSlider">Game Speed: {gameSpeedMultiplier.toFixed(1)}×</label>
    <input id="gameSpeedSlider" type="range" min="1" max="5" step="0.2" bind:value={gameSpeedMultiplier} style="width: 100%; margin-top: 8px;" />
    <div style="font-size:12px; opacity:.7; margin-top:4px;">
      Speeds up all game animations (flows, players, etc.)
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
          if (!isNaN(idx)) { 
            myColorIndex = idx; 
            updateColor(myPlayer!.playerId, idx);
            // Move player to new nest
            const nestAngle = getNestAngle(idx);
            myAngle = nestAngle;
            updateAngle(myPlayer!.playerId, nestAngle);
            // Move to outermost layer where nest is
            myLayer = MAX_LAYERS - 1;
            myLayerVisual = myLayer;
            updateLayer(myPlayer!.playerId, myLayer);
            console.log('[COLOR CHANGE] Moved to nest:', idx, 'angle:', (nestAngle * 180 / Math.PI).toFixed(2) + '°');
          }
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
  
  <div style="margin-top: 12px; background: #1a1a2a; padding: 10px; border-radius: 6px; border: 1px solid #3a3a5a;">
    <b style="color: #ffd700;">✨ VIP Features</b>
    <label style="display:flex; align-items:center; gap:6px; margin-top:8px; font-size:12px;">
      <input type="checkbox" bind:checked={vipGlow} />
      Player Glow
    </label>
    <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:12px;">
      <input type="checkbox" bind:checked={vipGolden} on:change={() => { if (vipGolden) vipBlackStars = false; }} />
      Golden Arc (metallic gold player & nest)
    </label>
    <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:12px;">
      <input type="checkbox" bind:checked={vipBlackStars} on:change={() => { if (vipBlackStars) vipGolden = false; }} />
      Black Stars Fragment (starfield player & nest)
    </label>
  </div>
  
  <div style="margin-top: 12px; background: #2a1a1a; padding: 10px; border-radius: 6px; border: 1px solid #5a3a3a;">
    <b style="color: #ff9800;">🔧 Testing Tools</b>
    <button style="margin-top: 8px; width: 100%; padding: 8px; background: #ff9800; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;" on:click={() => { showOutdatedDialog = true; }}>
      Preview Outdated Version Dialog
    </button>
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
  <!-- REMOVED: cleanBotHighscores button - no longer needed with Firestore -->
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
  
  <div style="margin-top:12px; font-size:13px; line-height:1.4; background:#1a1a1a; padding:8px 10px; border-radius:6px;">
    <b>Mobile Emulation</b>
    <br />
    <label style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:12px;">
      <input type="checkbox" bind:checked={emulateMobileTouch} on:change={() => {
        checkLocalCoopSupport();
        console.log('[Mobile Emulation]', emulateMobileTouch ? 'ENABLED' : 'DISABLED');
      }} /> Emulate mobile touch device
    </label>
    <div style="margin-top:4px; font-size:11px; opacity:.65;">
      Makes desktop environment show mobile on-screen controls for Player 1 & 2. Useful for testing local co-op mobile controls without a touch device.
    </div>
  </div>
  
  <div style="margin-top:12px; font-size:13px; line-height:1.4; background:#2a1a1a; padding:8px 10px; border-radius:6px; border: 1px solid #5a3a3a;">
    <b style="color: #ff6b6b;">🎮 Cheats</b>
    <br />
    <label style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:12px;">
      <input type="checkbox" bind:checked={noclipEnabled} on:change={() => {
        console.log('[Noclip]', noclipEnabled ? 'ENABLED' : 'DISABLED');
      }} /> Cheat: No-clip (allow overlap)
    </label>
    <div style="margin-top:4px; font-size:11px; opacity:.65;">
      Allows player fragments on the same layer to overlap and pass through each other. Normally, players cannot step on each other's positions.
    </div>
  </div>
  </div>
</div>
{/if}

<!-- Canvas Container with Scoreboard Overlay -->
<div style="position: relative; display: inline-block; margin: 0 auto;">
  <canvas 
    id="gameCanvas" 
    class="mx-auto block" 
    width={CANVAS_SIZE} 
    height={CANVAS_SIZE}
    on:contextmenu={handleCanvasContextMenu}
  ></canvas>
  
  <!-- Splash Screen Overlay -->
  {#if showSplash}
    <div 
      class:splash-fade={splashFading}
      style="
        position: absolute; 
        top: 50%; 
        left: 50%; 
        transform: translate(-50%, -50%); 
        z-index: 1000; 
        text-align: center;
        pointer-events: {isFirstVisit ? 'auto' : 'none'};
      ">
      <div style="
        background: rgba(0, 0, 0, 0.95); 
        padding: {isFirstVisit ? '30px 40px' : '40px 60px'}; 
        border-radius: 20px; 
        box-shadow: 0 8px 32px rgba(255, 215, 0, 0.3);
        border: 2px solid rgba(255, 215, 0, 0.5);
        max-width: {isFirstVisit ? '600px' : 'none'};
        max-height: {isFirstVisit ? '80vh' : 'none'};
        overflow-y: {isFirstVisit ? 'auto' : 'visible'};
      ">
        <h1 style="
          margin: 0 0 {isFirstVisit ? '15px' : '20px'} 0; 
          font-size: {isFirstVisit ? '40px' : '48px'}; 
          color: #ffd700; 
          font-family: 'Roboto', Arial, sans-serif; 
          font-weight: bold;
          text-shadow: 0 0 20px rgba(255, 215, 0, 0.8);
        ">
          Flow ~together~
        </h1>
        
        {#if isFirstVisit}
          <div style="text-align: left; margin: 20px 0; color: #fff; font-family: 'Roboto', Arial, sans-serif;">
            <h2 style="color: #ffd700; font-size: 24px; margin: 15px 0 10px 0; text-align: center;">🎮 How to Play</h2>
            
            <h3 style="color: #ffeb3b; font-size: 18px; margin: 15px 0 8px 0;">🎯 Objective</h3>
            <p style="margin: 5px 0; line-height: 1.6;">Catch <span style="color: #ffd700;">yellow flows</span> to earn points while avoiding <span style="color: #ff4444;">evil flows</span>. Compete with other players to reach the top of the leaderboard!</p>
            
            <h3 style="color: #ffeb3b; font-size: 18px; margin: 15px 0 8px 0;">🕹️ Controls</h3>
            <ul style="margin: 5px 0; line-height: 1.8; padding-left: 20px;">
              <li><b>Arrow Keys / WASD:</b> Move your fragment clockwise/counterclockwise</li>
              <li><b>Q / E:</b> Move between layers (closer/farther from sun)</li>
              <li><b>Space:</b> Shoot arc to catch flows</li>
              <li><b>Right-Click:</b> Open game menu</li>
            </ul>
            
            <h3 style="color: #ffeb3b; font-size: 18px; margin: 15px 0 8px 0;">⚡ Gameplay</h3>
            <ul style="margin: 5px 0; line-height: 1.8; padding-left: 20px;">
              <li><span style="color: #ffd700;">Yellow flows</span> give you <b>+1 point</b> and increase your speed</li>
              <li><span style="color: #ff4444;">Evil flows</span> subtract points and slow you down</li>
              <li>Higher difficulty = more flows, faster gameplay, bigger rewards</li>
              <li>Claim a nest (colored spot) to become a permanent player</li>
              <li>Players on the same layer cannot overlap positions</li>
            </ul>
            
            <h3 style="color: #ffeb3b; font-size: 18px; margin: 15px 0 8px 0;">🏆 Victory</h3>
            <p style="margin: 5px 0; line-height: 1.6;">The game progresses through <b>10 difficulty levels</b> with increasing challenges. After reaching difficulty 10, the game ends and the player with the highest score wins! Top players get permanent spots in the Hall of Fame.</p>
          </div>
          
          <button 
            on:click={startPlaying}
            style="
              background: linear-gradient(135deg, #ffd700 0%, #ffed4e 100%);
              color: #000;
              border: none;
              border-radius: 12px;
              padding: 15px 40px;
              font-size: 20px;
              font-weight: bold;
              cursor: pointer;
              margin-top: 20px;
              box-shadow: 0 4px 15px rgba(255, 215, 0, 0.4);
              transition: all 0.2s;
            "
            on:mouseenter={(e) => {
              e.currentTarget.style.transform = 'scale(1.05)';
              e.currentTarget.style.boxShadow = '0 6px 20px rgba(255, 215, 0, 0.6)';
            }}
            on:mouseleave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
              e.currentTarget.style.boxShadow = '0 4px 15px rgba(255, 215, 0, 0.4)';
            }}
          >
            🚀 Start Playing!
          </button>
        {:else}
          <p style="
            margin: 10px 0; 
            font-size: 18px; 
            color: #fff; 
            font-family: 'Roboto', Arial, sans-serif;
          ">
            made with 🩸, 💦 & ❤️
          </p>
          <p style="
            margin: 10px 0; 
            font-size: 16px; 
            color: #aaa; 
            font-family: 'Roboto', Arial, sans-serif;
          ">
            by a gothenburgian
          </p>
        {/if}
      </div>
    </div>
  {/if}
  
  <!-- Difficulty Change Notification -->
  {#if showDifficultyNotification}
    <div 
      style="
        position: absolute; 
        top: 50%; 
        left: 50%; 
        transform: translate(-50%, -50%); 
        z-index: 999; 
        text-align: center;
        animation: difficultyPulse 0.5s ease-out;
        pointer-events: none;
      ">
      <div style="
        background: rgba(0, 0, 0, 0.9); 
        padding: 30px 50px; 
        border-radius: 15px; 
        box-shadow: 0 8px 32px rgba(255, 100, 0, 0.5);
        border: 3px solid rgba(255, 150, 0, 0.8);
      ">
        <div style="
          font-size: 28px; 
          color: #ff9933; 
          font-family: 'Roboto', Arial, sans-serif; 
          font-weight: bold;
          text-shadow: 0 0 15px rgba(255, 150, 0, 0.8);
          margin-bottom: 10px;
        ">
          DIFFICULTY {difficulty}
        </div>
        <div style="
          font-size: 18px; 
          color: #fff; 
          font-family: 'Roboto', Arial, sans-serif;
          line-height: 1.4;
        ">
          {difficultyNotification}
        </div>
      </div>
    </div>
  {/if}
  
  <!-- Scoreboard Overlay (top-left of canvas) -->
  <div style="position: absolute; top: 0; left: 0; pointer-events: none; width: 100%; height: 100%;">
    <div style="position: absolute; top: 60px; left: 2.5%; pointer-events: auto;">
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


<!-- Outdated Version Dialog -->
{#if showOutdatedDialog}
<div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 101; display: flex; align-items: center; justify-content: center;">
  <div style="background: #222; color: #fff; padding: 30px 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); text-align: center; max-width: 450px;">
    <h2 style="margin: 0 0 16px 0; font-size: 24px; color: #ff9800;">⚠️ Game Outdated</h2>
    <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.5;">
      A new version of the game is available! Please clear your cache and reload to get the latest features and bug fixes.
    </p>
    <button on:click={reloadPage} style="background: #ff9800; color: #fff; border: none; border-radius: 6px; padding: 12px 24px; font-size: 16px; font-weight: bold; cursor: pointer; transition: background 0.2s;">
      Clear Cache & Reload
    </button>
    <button on:click={() => showOutdatedDialog = false} style="background: transparent; color: #999; border: 1px solid #555; border-radius: 6px; padding: 12px 24px; font-size: 14px; cursor: pointer; margin-left: 12px; transition: all 0.2s;">
      Continue Anyway
    </button>
  </div>
</div>
{/if}

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

<!-- How to Play Dialog -->
{#if showHowToPlay}
<div 
  role="dialog"
  aria-modal="true"
  aria-labelledby="how-to-play-title"
  tabindex="-1"
  style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 101; display: flex; align-items: center; justify-content: center; overflow-y: auto; padding: 20px;"
  on:click={closeHowToPlay}
  on:keydown={(e) => e.key === 'Escape' && closeHowToPlay()}
>
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div 
    role="document"
    style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; padding: 30px 40px; border-radius: 20px; box-shadow: 0 8px 40px rgba(0,0,0,0.7); max-width: 600px; width: 90%; border: 2px solid rgba(255, 215, 0, 0.5);"
    on:click|stopPropagation
    on:keydown|stopPropagation
  >
    <h1 id="how-to-play-title" style="margin: 0 0 20px 0; font-size: 36px; color: #ffd700; text-shadow: 0 0 20px rgba(255, 215, 0, 0.5); text-align: center;">
      🎮 How to Play
    </h1>
    
    <div style="text-align: left; line-height: 1.6;">
      <h2 style="color: #ffeb3b; font-size: 22px; margin: 20px 0 10px 0;">🎯 Objective</h2>
      <p style="margin: 8px 0;">
        Catch <span style="color: #ffd700; font-weight: bold;">yellow flows</span> to earn points while avoiding <span style="color: #ff4444; font-weight: bold;">evil flows</span>. Compete with other players to reach the top of the leaderboard!
      </p>
      
      <h2 style="color: #ffeb3b; font-size: 22px; margin: 20px 0 10px 0;">🕹️ Controls</h2>
      <ul style="margin: 8px 0; padding-left: 20px;">
        <li style="margin: 5px 0;"><b>Arrow Keys / WASD:</b> Move your fragment clockwise/counterclockwise</li>
        <li style="margin: 5px 0;"><b>Q / E:</b> Move between layers (closer/farther from sun)</li>
        <li style="margin: 5px 0;"><b>Space:</b> Shoot arc to catch flows</li>
        <li style="margin: 5px 0;"><b>Right-Click:</b> Open game menu</li>
      </ul>
      
      <h2 style="color: #ffeb3b; font-size: 22px; margin: 20px 0 10px 0;">⚡ Gameplay</h2>
      <ul style="margin: 8px 0; padding-left: 20px;">
        <li style="margin: 5px 0;"><span style="color: #ffd700;">Yellow flows</span> give you <b>+1 point</b> and increase your speed</li>
        <li style="margin: 5px 0;"><span style="color: #ff4444;">Evil flows</span> subtract points and slow you down</li>
        <li style="margin: 5px 0;">Higher difficulty = more flows, faster gameplay, bigger rewards</li>
        <li style="margin: 5px 0;">Claim a nest (colored spot) to become a permanent player</li>
        <li style="margin: 5px 0;">Players on the same layer cannot overlap positions</li>
      </ul>
      
      <h2 style="color: #ffeb3b; font-size: 22px; margin: 20px 0 10px 0;">🏆 Victory</h2>
      <p style="margin: 8px 0;">
        The game progresses through <b>10 difficulty levels</b> with increasing challenges. After reaching difficulty 10, the game ends and the player with the highest score wins! Top players get permanent spots in the Hall of Fame.
      </p>
    </div>
    
    <button 
      on:click={closeHowToPlay}
      style="
        background: linear-gradient(135deg, #ffd700 0%, #ffed4e 100%);
        color: #000;
        border: none;
        border-radius: 12px;
        padding: 12px 30px;
        font-size: 18px;
        font-weight: bold;
        cursor: pointer;
        margin-top: 25px;
        width: 100%;
        box-shadow: 0 4px 15px rgba(255, 215, 0, 0.4);
        transition: all 0.2s;
      "
      on:mouseenter={(e) => {
        e.currentTarget.style.transform = 'scale(1.02)';
        e.currentTarget.style.boxShadow = '0 6px 20px rgba(255, 215, 0, 0.6)';
      }}
      on:mouseleave={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
        e.currentTarget.style.boxShadow = '0 4px 15px rgba(255, 215, 0, 0.4)';
      }}
    >
      Got it! 👍
    </button>
  </div>
</div>
{/if}

<!-- Mobile Controls (bottom-center) -->
{#if browser}
<div style="position: absolute; bottom: {mobileControlBottomDistance}px; left: 50%; transform: translateX(-50%); z-index: 10; display: flex; align-items: flex-end; gap: 16px;">
  <!-- Main directional controls (center) -->
  <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
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
  
  <!-- Right side: Shoot button and Score -->
  {#if myPlayer}
    {@const myScore = players.find(p => p.id === myPlayer.playerId)?.score || 0}
    {@const ARC_COOLDOWN_MS = getArcCooldown()}
    {@const p1CooldownRemaining = Math.max(0, ARC_COOLDOWN_MS - (currentTime - arcCooldownP1))}
    {@const p1OnCooldown = p1CooldownRemaining > 0}
    {@const p1Progress = p1OnCooldown ? (ARC_COOLDOWN_MS - p1CooldownRemaining) / ARC_COOLDOWN_MS : 1}
    <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
      <!-- Score display -->
      <div style="background: rgba(0, 0, 0, 0.7); border: 2px solid #555; border-radius: 8px; padding: 4px 12px; font-size: 14px; font-weight: bold; color: #4f4; text-align: center; min-width: 60px;">
        {myScore}
      </div>
      <!-- Shoot Arc button with progress bar -->
      <div style="position: relative; width: 60px; height: 60px;">
        <button
          aria-label="Shoot Arc"
          aria-pressed={mobileShootPressed}
          disabled={p1OnCooldown}
          on:pointerdown={() => { 
            mobileShootPressed = true;
            if (myColorIndex != null && !p1OnCooldown) {
              useArcAbility(myAngle, myLayer, false);
            }
          }}
          on:pointerup={() => { mobileShootPressed = false; }}
          on:pointerleave={() => { mobileShootPressed = false; }}
          on:pointercancel={() => { mobileShootPressed = false; }}
          style={`position: relative; background:${p1OnCooldown?'#333':mobileShootPressed?'#755':'#533'}; color:${p1OnCooldown?'#666':'#fff'}; border:2px solid ${p1OnCooldown?'#444':mobileShootPressed?'#aaa':'#855'}; border-radius:8px; width:100%; height:100%; font-size:24px; cursor:${p1OnCooldown?'not-allowed':'pointer'}; user-select:none; touch-action:none; box-shadow:${mobileShootPressed?'inset 0 2px 6px rgba(0,0,0,.6)':'0 2px 6px rgba(0,0,0,.3)'}; transform:${mobileShootPressed?'translateY(1px)':'none'}; transition: background .08s, border-color .08s, box-shadow .08s, transform .08s; overflow: hidden;`}>
          <span style="position: relative; z-index: 2;">🌊</span>
          {#if p1OnCooldown}
            <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 100%; background: linear-gradient(to top, rgba(255, 170, 0, 0.4) 0%, rgba(255, 170, 0, 0) 100%); border-radius: 6px; z-index: 1; transform: scaleY({p1Progress}); transform-origin: bottom; transition: transform 0.1s linear;"></div>
          {/if}
        </button>
      </div>
      <!-- Keyboard shortcut indicator (only on desktop) -->
      {#if !emulateMobileTouch && navigator.maxTouchPoints === 0}
      <div style="display: flex; align-items: center; justify-content: center; margin-top: -4px;">
        <kbd style="
          background: {keys[' '] ? 'linear-gradient(180deg, #f9f9f9 0%, #e0e0e0 100%)' : 'linear-gradient(180deg, #2a2a2a 0%, #1a1a1a 100%)'};
          border: 1px solid {keys[' '] ? '#999' : '#555'};
          border-bottom: 2px solid {keys[' '] ? '#777' : '#333'};
          border-radius: 4px;
          padding: 3px 8px;
          font-family: 'Segoe UI', Arial, sans-serif;
          font-size: 11px;
          font-weight: 600;
          color: {keys[' '] ? '#333' : '#ccc'};
          text-shadow: 0 1px 0 {keys[' '] ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)'};
          box-shadow: {keys[' '] ? '0 1px 2px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.7)' : '0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)'};
          min-width: 45px;
          text-align: center;
          transition: all 0.1s ease;
        ">SPACE</kbd>
      </div>
      {/if}
    </div>
  {/if}
</div>
{/if}

<!-- Player 2 Mobile Controls (only show when local coop is active) -->
{#if browser && localCoopEnabled && player2Active}
<div style="position: absolute; top: {mobileControlTopDistance}px; left: 50%; transform: translateX(-50%) rotate(180deg); z-index: 10; display: flex; align-items: flex-end; gap: 16px; opacity: 0.8;">
  <!-- Main directional controls (center) -->
  <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
    <!-- Up button -->
    <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
      <button
        aria-label="Player 2 Up"
        aria-pressed={mobileP2UpPressed}
        on:pointerdown={() => { mobileP2UpPressed = true; }}
        on:pointerup={() => { mobileP2UpPressed = false; }}
        on:pointerleave={() => { mobileP2UpPressed = false; }}
        on:pointercancel={() => { mobileP2UpPressed = false; }}
        style={`background:${mobileP2UpPressed?'#557':'#334'}; color:#fff; border:2px solid ${mobileP2UpPressed?'#aad':'#557'}; border-radius:8px; width:60px; height:60px; font-size:24px; cursor:pointer; user-select:none; touch-action:none; box-shadow:${mobileP2UpPressed?'inset 0 2px 6px rgba(0,0,0,.6)':'0 2px 6px rgba(0,0,0,.3)'}; transform:${mobileP2UpPressed?'translateY(1px)':'none'}; transition: background .08s, border-color .08s, box-shadow .08s, transform .08s;`}>
      ⬆️
      </button>
      <!-- Keyboard shortcut indicator (only on desktop) -->
      {#if !emulateMobileTouch && navigator.maxTouchPoints === 0}
      <div style="display: flex; align-items: center; justify-content: center; margin-top: -4px;">
        <kbd style="
          background: {keys['8'] || keys.Numpad8 ? 'linear-gradient(180deg, #f9f9f9 0%, #e0e0e0 100%)' : 'linear-gradient(180deg, #2a2a2a 0%, #1a1a1a 100%)'};
          border: 1px solid {keys['8'] || keys.Numpad8 ? '#999' : '#555'};
          border-bottom: 2px solid {keys['8'] || keys.Numpad8 ? '#777' : '#333'};
          border-radius: 4px;
          padding: 3px 6px;
          font-family: 'Segoe UI', Arial, sans-serif;
          font-size: 10px;
          font-weight: 600;
          color: {keys['8'] || keys.Numpad8 ? '#333' : '#ccc'};
          text-shadow: 0 1px 0 {keys['8'] || keys.Numpad8 ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)'};
          box-shadow: {keys['8'] || keys.Numpad8 ? '0 1px 2px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.7)' : '0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)'};
          min-width: 35px;
          text-align: center;
          transition: all 0.1s ease;
          transform: rotate(180deg);
        ">8</kbd>
      </div>
      {/if}
    </div>
    <!-- Left, Down, Right buttons -->
    <div style="display: flex; gap: 8px;">
      <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
        <button
          aria-label="Player 2 Left"
          aria-pressed={mobileP2LeftPressed}
          on:pointerdown={() => { mobileP2LeftPressed = true; }}
          on:pointerup={() => { mobileP2LeftPressed = false; }}
          on:pointerleave={() => { mobileP2LeftPressed = false; }}
          on:pointercancel={() => { mobileP2LeftPressed = false; }}
          style={`background:${mobileP2LeftPressed?'#557':'#334'}; color:#fff; border:2px solid ${mobileP2LeftPressed?'#aad':'#557'}; border-radius:8px; width:60px; height:60px; font-size:24px; cursor:pointer; user-select:none; touch-action:none; box-shadow:${mobileP2LeftPressed?'inset 0 2px 6px rgba(0,0,0,.6)':'0 2px 6px rgba(0,0,0,.3)'}; transform:${mobileP2LeftPressed?'translateY(1px)':'none'}; transition: background .08s, border-color .08s, box-shadow .08s, transform .08s;`}>
      ⬅️
        </button>
        <!-- Keyboard shortcut indicator (only on desktop) -->
        {#if !emulateMobileTouch && navigator.maxTouchPoints === 0}
        <div style="display: flex; align-items: center; justify-content: center; margin-top: -4px;">
          <kbd style="
            background: {keys['4'] || keys.Numpad4 ? 'linear-gradient(180deg, #f9f9f9 0%, #e0e0e0 100%)' : 'linear-gradient(180deg, #2a2a2a 0%, #1a1a1a 100%)'};
            border: 1px solid {keys['4'] || keys.Numpad4 ? '#999' : '#555'};
            border-bottom: 2px solid {keys['4'] || keys.Numpad4 ? '#777' : '#333'};
            border-radius: 4px;
            padding: 3px 6px;
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 10px;
            font-weight: 600;
            color: {keys['4'] || keys.Numpad4 ? '#333' : '#ccc'};
            text-shadow: 0 1px 0 {keys['4'] || keys.Numpad4 ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)'};
            box-shadow: {keys['4'] || keys.Numpad4 ? '0 1px 2px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.7)' : '0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)'};
            min-width: 35px;
            text-align: center;
            transition: all 0.1s ease;
            transform: rotate(180deg);
          ">4</kbd>
        </div>
        {/if}
      </div>
      <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
        <button
          aria-label="Player 2 Down"
          aria-pressed={mobileP2DownPressed}
          on:pointerdown={() => { mobileP2DownPressed = true; }}
          on:pointerup={() => { mobileP2DownPressed = false; }}
          on:pointerleave={() => { mobileP2DownPressed = false; }}
          on:pointercancel={() => { mobileP2DownPressed = false; }}
          style={`background:${mobileP2DownPressed?'#557':'#334'}; color:#fff; border:2px solid ${mobileP2DownPressed?'#aad':'#557'}; border-radius:8px; width:60px; height:60px; font-size:24px; cursor:pointer; user-select:none; touch-action:none; box-shadow:${mobileP2DownPressed?'inset 0 2px 6px rgba(0,0,0,.6)':'0 2px 6px rgba(0,0,0,.3)'}; transform:${mobileP2DownPressed?'translateY(1px)':'none'}; transition: background .08s, border-color .08s, box-shadow .08s, transform .08s;`}>
      ⬇️
        </button>
        <!-- Keyboard shortcut indicator (only on desktop) -->
        {#if !emulateMobileTouch && navigator.maxTouchPoints === 0}
        <div style="display: flex; align-items: center; justify-content: center; margin-top: -4px;">
          <kbd style="
            background: {keys['2'] || keys.Numpad2 ? 'linear-gradient(180deg, #f9f9f9 0%, #e0e0e0 100%)' : 'linear-gradient(180deg, #2a2a2a 0%, #1a1a1a 100%)'};
            border: 1px solid {keys['2'] || keys.Numpad2 ? '#999' : '#555'};
            border-bottom: 2px solid {keys['2'] || keys.Numpad2 ? '#777' : '#333'};
            border-radius: 4px;
            padding: 3px 6px;
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 10px;
            font-weight: 600;
            color: {keys['2'] || keys.Numpad2 ? '#333' : '#ccc'};
            text-shadow: 0 1px 0 {keys['2'] || keys.Numpad2 ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)'};
            box-shadow: {keys['2'] || keys.Numpad2 ? '0 1px 2px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.7)' : '0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)'};
            min-width: 35px;
            text-align: center;
            transition: all 0.1s ease;
            transform: rotate(180deg);
          ">2</kbd>
        </div>
        {/if}
      </div>
      <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
        <button
          aria-label="Player 2 Right"
          aria-pressed={mobileP2RightPressed}
          on:pointerdown={() => { mobileP2RightPressed = true; }}
          on:pointerup={() => { mobileP2RightPressed = false; }}
          on:pointerleave={() => { mobileP2RightPressed = false; }}
          on:pointercancel={() => { mobileP2RightPressed = false; }}
          style={`background:${mobileP2RightPressed?'#557':'#334'}; color:#fff; border:2px solid ${mobileP2RightPressed?'#aad':'#557'}; border-radius:8px; width:60px; height:60px; font-size:24px; cursor:pointer; user-select:none; touch-action:none; box-shadow:${mobileP2RightPressed?'inset 0 2px 6px rgba(0,0,0,.6)':'0 2px 6px rgba(0,0,0,.3)'}; transform:${mobileP2RightPressed?'translateY(1px)':'none'}; transition: background .08s, border-color .08s, box-shadow .08s, transform .08s;`}>
      ➡️
        </button>
        <!-- Keyboard shortcut indicator (only on desktop) -->
        {#if !emulateMobileTouch && navigator.maxTouchPoints === 0}
        <div style="display: flex; align-items: center; justify-content: center; margin-top: -4px;">
          <kbd style="
            background: {keys['6'] || keys.Numpad6 ? 'linear-gradient(180deg, #f9f9f9 0%, #e0e0e0 100%)' : 'linear-gradient(180deg, #2a2a2a 0%, #1a1a1a 100%)'};
            border: 1px solid {keys['6'] || keys.Numpad6 ? '#999' : '#555'};
            border-bottom: 2px solid {keys['6'] || keys.Numpad6 ? '#777' : '#333'};
            border-radius: 4px;
            padding: 3px 6px;
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 10px;
            font-weight: 600;
            color: {keys['6'] || keys.Numpad6 ? '#333' : '#ccc'};
            text-shadow: 0 1px 0 {keys['6'] || keys.Numpad6 ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)'};
            box-shadow: {keys['6'] || keys.Numpad6 ? '0 1px 2px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.7)' : '0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)'};
            min-width: 35px;
            text-align: center;
            transition: all 0.1s ease;
            transform: rotate(180deg);
          ">6</kbd>
        </div>
        {/if}
      </div>
    </div>
  </div>
  
  <!-- Right side: Shoot button and Score for Player 2 -->
  {#if player2ColorIndex != null}
    {@const p2Player = players.find(p => p.colorIndex === player2ColorIndex)}
    {#if p2Player}
      {@const p2Score = p2Player.score || 0}
      {@const ARC_COOLDOWN_MS = getArcCooldown()}
      {@const p2CooldownRemaining = Math.max(0, ARC_COOLDOWN_MS - (currentTime - arcCooldownP2))}
      {@const p2OnCooldown = p2CooldownRemaining > 0}
      {@const p2Progress = p2OnCooldown ? (ARC_COOLDOWN_MS - p2CooldownRemaining) / ARC_COOLDOWN_MS : 1}
      <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
        <!-- Score display -->
        <div style="background: rgba(0, 0, 0, 0.7); border: 2px solid #557; border-radius: 8px; padding: 4px 12px; font-size: 14px; font-weight: bold; color: #aaf; text-align: center; min-width: 60px;">
          {p2Score}
        </div>
        <!-- Shoot Arc button with progress bar -->
        <div style="position: relative; width: 60px; height: 60px;">
          <button
            aria-label="Player 2 Shoot Arc"
            aria-pressed={mobileP2ShootPressed}
            disabled={p2OnCooldown}
            on:pointerdown={() => { 
              mobileP2ShootPressed = true;
              if (!p2OnCooldown) {
                useArcAbility(player2Angle, player2Layer, true);
              }
            }}
            on:pointerup={() => { mobileP2ShootPressed = false; }}
            on:pointerleave={() => { mobileP2ShootPressed = false; }}
            on:pointercancel={() => { mobileP2ShootPressed = false; }}
            style={`position: relative; background:${p2OnCooldown?'#334':mobileP2ShootPressed?'#779':'#557'}; color:${p2OnCooldown?'#668':'#fff'}; border:2px solid ${p2OnCooldown?'#446':mobileP2ShootPressed?'#aad':'#88a'}; border-radius:8px; width:100%; height:100%; font-size:24px; cursor:${p2OnCooldown?'not-allowed':'pointer'}; user-select:none; touch-action:none; box-shadow:${mobileP2ShootPressed?'inset 0 2px 6px rgba(0,0,0,.6)':'0 2px 6px rgba(0,0,0,.3)'}; transform:${mobileP2ShootPressed?'translateY(1px)':'none'}; transition: background .08s, border-color .08s, box-shadow .08s, transform .08s; overflow: hidden;`}>
            <span style="position: relative; z-index: 2;">🌊</span>
            {#if p2OnCooldown}
              <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 100%; background: linear-gradient(to top, rgba(170, 170, 255, 0.4) 0%, rgba(170, 170, 255, 0) 100%); border-radius: 6px; z-index: 1; transform: scaleY({p2Progress}); transform-origin: bottom; transition: transform 0.1s linear;"></div>
            {/if}
          </button>
        </div>
        <!-- Keyboard shortcut indicator (only on desktop) -->
        {#if !emulateMobileTouch && navigator.maxTouchPoints === 0}
        <div style="display: flex; align-items: center; justify-content: center; margin-top: -4px;">
          <kbd style="
            background: {keys['0'] || keys.Numpad0 ? 'linear-gradient(180deg, #f9f9f9 0%, #e0e0e0 100%)' : 'linear-gradient(180deg, #2a2a2a 0%, #1a1a1a 100%)'};
            border: 1px solid {keys['0'] || keys.Numpad0 ? '#999' : '#555'};
            border-bottom: 2px solid {keys['0'] || keys.Numpad0 ? '#777' : '#333'};
            border-radius: 4px;
            padding: 3px 6px;
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 10px;
            font-weight: 600;
            color: {keys['0'] || keys.Numpad0 ? '#333' : '#ccc'};
            text-shadow: 0 1px 0 {keys['0'] || keys.Numpad0 ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)'};
            box-shadow: {keys['0'] || keys.Numpad0 ? '0 1px 2px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.7)' : '0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1)'};
            min-width: 35px;
            text-align: center;
            transition: all 0.1s ease;
            transform: rotate(180deg);
          ">NUM 0</kbd>
        </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>
{/if}

<!-- Victory Screen -->
{#if showVictoryScreen}
<div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 100; display: flex; align-items: center; justify-content: center; overflow-y: auto;">
  <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; padding: 40px; border-radius: 20px; box-shadow: 0 8px 40px rgba(0,0,0,0.7); text-align: center; max-width: 700px; width: 90%;">
    <h1 style="margin: 0 0 10px 0; font-size: 48px; color: #ffd700; text-shadow: 0 0 20px rgba(255,215,0,0.5);">🎉 Victory! 🎉</h1>
    <p style="margin: 0 0 40px 0; font-size: 18px; color: #aaa;">Game completed at difficulty 10!</p>
    
    <!-- Podium (Top 3) -->
    <div style="margin-bottom: 50px;">
      <h2 style="margin: 0 0 25px 0; font-size: 28px; color: #fff; border-bottom: 2px solid #ffd700; padding-bottom: 10px;">🏆 Podium</h2>
      {#if victoryStats.podium.length > 0}
        <div style="display: flex; justify-content: center; align-items: flex-end; gap: 20px; margin-bottom: 20px;">
          <!-- 2nd Place (Left) -->
          {#if victoryStats.podium.length >= 2}
            {@const p = victoryStats.podium[1]}
            {@const FlagComp = getFlagComponent(p.country)}
            <div style="flex: 1; max-width: 180px;">
              <div style="background: linear-gradient(135deg, #c0c0c0, #888); border-radius: 10px; padding: 20px 15px; margin-bottom: 10px; box-shadow: 0 4px 15px rgba(192,192,192,0.3);">
                <div style="font-size: 36px; margin-bottom: 5px;">🥈</div>
                <div style="font-size: 14px; font-weight: bold; margin-bottom: 5px; display: flex; align-items: center; justify-content: center; gap: 5px;">
                  {#if FlagComp}<svelte:component this={FlagComp} width="16" />{/if}
                  {p.name}
                </div>
                <div style="font-size: 24px; font-weight: bold; color: #000;">{p.score} pts</div>
              </div>
              <div style="background: #666; height: 80px; border-radius: 5px 5px 0 0;"></div>
            </div>
          {/if}
          
          <!-- 1st Place (Center, Tallest) -->
          {#if victoryStats.podium.length >= 1}
            {@const p = victoryStats.podium[0]}
            {@const FlagComp = getFlagComponent(p.country)}
            <div style="flex: 1; max-width: 200px;">
              <div style="background: linear-gradient(135deg, #ffd700, #ffed4e); border-radius: 10px; padding: 25px 15px; margin-bottom: 10px; box-shadow: 0 6px 20px rgba(255,215,0,0.5);">
                <div style="font-size: 48px; margin-bottom: 5px;">👑</div>
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 5px; display: flex; align-items: center; justify-content: center; gap: 5px; color: #000;">
                  {#if FlagComp}<svelte:component this={FlagComp} width="18" />{/if}
                  {p.name}
                </div>
                <div style="font-size: 32px; font-weight: bold; color: #000;">{p.score} pts</div>
              </div>
              <div style="background: #ffd700; height: 120px; border-radius: 5px 5px 0 0;"></div>
            </div>
          {/if}
          
          <!-- 3rd Place (Right) -->
          {#if victoryStats.podium.length >= 3}
            {@const p = victoryStats.podium[2]}
            {@const FlagComp = getFlagComponent(p.country)}
            <div style="flex: 1; max-width: 180px;">
              <div style="background: linear-gradient(135deg, #cd7f32, #965a38); border-radius: 10px; padding: 20px 15px; margin-bottom: 10px; box-shadow: 0 4px 15px rgba(205,127,50,0.3);">
                <div style="font-size: 36px; margin-bottom: 5px;">🥉</div>
                <div style="font-size: 14px; font-weight: bold; margin-bottom: 5px; display: flex; align-items: center; justify-content: center; gap: 5px;">
                  {#if FlagComp}<svelte:component this={FlagComp} width="16" />{/if}
                  {p.name}
                </div>
                <div style="font-size: 24px; font-weight: bold; color: #000;">{p.score} pts</div>
              </div>
              <div style="background: #cd7f32; height: 60px; border-radius: 5px 5px 0 0;"></div>
            </div>
          {/if}
        </div>
      {:else}
        <p style="color: #888; font-style: italic;">No players to display</p>
      {/if}
    </div>
    
    <!-- Accolades (Awards) -->
    <div style="margin-bottom: 40px;">
      <h2 style="margin: 0 0 20px 0; font-size: 24px; color: #fff; border-bottom: 2px solid #4a9eff; padding-bottom: 10px;">🏅 Special Awards</h2>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
        <!-- Most Bad Hits -->
        {#if victoryStats.mostBadHits}
          {@const FlagComp = getFlagComponent(victoryStats.mostBadHits.country)}
          <div style="background: rgba(255,50,50,0.2); border: 2px solid #ff3232; border-radius: 10px; padding: 15px;">
            <div style="font-size: 28px; margin-bottom: 5px;">💥</div>
            <div style="font-size: 12px; color: #ff8888; text-transform: uppercase; margin-bottom: 5px;">Most Bad Hits</div>
            <div style="font-size: 14px; font-weight: bold; margin-bottom: 3px; display: flex; align-items: center; justify-content: center; gap: 5px;">
              {#if FlagComp}<svelte:component this={FlagComp} width="14" />{/if}
              {victoryStats.mostBadHits.name}
            </div>
            <div style="font-size: 18px; color: #ff3232;">{victoryStats.mostBadHits.hits} hits</div>
          </div>
        {/if}
        
        <!-- Most Layer Moves -->
        {#if victoryStats.mostLayerMoves}
          {@const FlagComp = getFlagComponent(victoryStats.mostLayerMoves.country)}
          <div style="background: rgba(74,158,255,0.2); border: 2px solid #4a9eff; border-radius: 10px; padding: 15px;">
            <div style="font-size: 28px; margin-bottom: 5px;">⚡</div>
            <div style="font-size: 12px; color: #88c8ff; text-transform: uppercase; margin-bottom: 5px;">Most Active</div>
            <div style="font-size: 14px; font-weight: bold; margin-bottom: 3px; display: flex; align-items: center; justify-content: center; gap: 5px;">
              {#if FlagComp}<svelte:component this={FlagComp} width="14" />{/if}
              {victoryStats.mostLayerMoves.name}
            </div>
            <div style="font-size: 18px; color: #4a9eff;">{victoryStats.mostLayerMoves.moves} boost</div>
          </div>
        {/if}
        
        <!-- Nearest to Sun -->
        {#if victoryStats.nearestToSun}
          {@const FlagComp = getFlagComponent(victoryStats.nearestToSun.country)}
          <div style="background: rgba(255,165,0,0.2); border: 2px solid #ffa500; border-radius: 10px; padding: 15px;">
            <div style="font-size: 28px; margin-bottom: 5px;">☀️</div>
            <div style="font-size: 12px; color: #ffcc88; text-transform: uppercase; margin-bottom: 5px;">Nearest to Sun</div>
            <div style="font-size: 14px; font-weight: bold; margin-bottom: 3px; display: flex; align-items: center; justify-content: center; gap: 5px;">
              {#if FlagComp}<svelte:component this={FlagComp} width="14" />{/if}
              {victoryStats.nearestToSun.name}
            </div>
            <div style="font-size: 18px; color: #ffa500;">Layer {victoryStats.nearestToSun.layer}</div>
          </div>
        {/if}
      </div>
    </div>
    
    <!-- Start New Game Button -->
    <button 
      on:click={startNewGame}
      style="background: linear-gradient(135deg, #4CAF50, #45a049); color: #fff; border: none; border-radius: 10px; padding: 18px 40px; font-size: 20px; font-weight: bold; cursor: pointer; transition: all 0.3s; box-shadow: 0 4px 15px rgba(76,175,80,0.4);">
      🎮 Start New Game
    </button>
  </div>
</div>
{/if}

<style>
  :global(html, body) { margin: 0; background: #111; }
  canvas { max-width: 100vw; max-height: 100vh; object-fit: contain; }
  
  .splash-fade {
    animation: fadeOut 1s ease-out forwards;
  }
  
  @keyframes fadeOut {
    0% { opacity: 1; }
    100% { opacity: 0; visibility: hidden; }
  }
  
  @keyframes difficultyPulse {
    0% { 
      transform: translate(-50%, -50%) scale(0.8); 
      opacity: 0; 
    }
    50% { 
      transform: translate(-50%, -50%) scale(1.05); 
    }
    100% { 
      transform: translate(-50%, -50%) scale(1); 
      opacity: 1; 
    }
  }
  
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
  
  /* Context menu items */
  .context-menu-item {
    display: block;
    width: 100%;
    padding: 10px 16px;
    background: transparent;
    border: none;
    border-top: 1px solid #444;
    color: #fff;
    text-align: left;
    cursor: pointer;
    font-size: 14px;
    transition: background 0.1s;
  }
  
  .context-menu-item:first-child {
    border-top: none;
  }
  
  .context-menu-item:hover:not(:disabled) {
    background: #3a3a3a;
  }
  
  .context-menu-item:disabled {
    color: #666;
    cursor: not-allowed;
  }
</style>

<!-- Local Co-op Panel (bottom-left, above highscores) -->
{#if browser && (emulateMobileTouch || navigator.maxTouchPoints > 0)}
  <!-- Mobile: Square icon button on left side -->
  <div style="position: absolute; bottom: 160px; left: 10px; z-index: 9;">
    {#if !localCoopEnabled}
      <button 
        on:click={startLocalCoop}
        disabled={!localCoopSupported}
        title={localCoopSupported ? 'Add Player 2' : 'Not supported'}
        style="background: {localCoopSupported ? '#2d5016' : '#444'}; color: #fff; border: 1px solid {localCoopSupported ? '#4a7c26' : '#666'}; border-radius: 8px; padding: 0; cursor: {localCoopSupported ? 'pointer' : 'not-allowed'}; width: 60px; height: 60px; font-size: 28px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.3); user-select: none; touch-action: none;">
        🎮
      </button>
    {:else}
      <button 
        on:click={stopLocalCoop}
        title="Remove Player 2"
        style="background: #663333; color: #fff; border: 1px solid #884444; border-radius: 8px; padding: 0; cursor: pointer; width: 60px; height: 60px; font-size: 28px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.3); user-select: none; touch-action: none; position: relative;">
        🎮
        <span style="position: absolute; top: -4px; right: -4px; background: #d44; border-radius: 50%; width: 20px; height: 20px; font-size: 14px; line-height: 20px;">✕</span>
      </button>
    {/if}
  </div>
{:else}
  <!-- Desktop: Full panel -->
  <div style="position: absolute; bottom: {hsOpen ? '360px' : '60px'}; left: 10px; z-index: 9; transition: bottom 0.2s ease;">
    {#if !localCoopEnabled}
      <button 
        on:click={startLocalCoop}
        disabled={!localCoopSupported}
        title={localCoopSupported ? 'PC: Använd numpad (8,4,6,2). Mobil: On-screen kontroller.' : 'Lokal flerspelarläge finns på kompatibla enheter'}
        style="background: {localCoopSupported ? '#2d5016' : '#444'}; color: #fff; border: 1px solid {localCoopSupported ? '#4a7c26' : '#666'}; border-radius: 6px; padding: 8px 12px; cursor: {localCoopSupported ? 'pointer' : 'not-allowed'}; width: 320px; text-align: left; font-size: 14px; display: flex; align-items: center; gap: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">
        <span style="font-size: 18px;">🎮</span>
        <span>Lokal Co-op (Spelare #2)</span>
      </button>
    {:else}
      <div style="background: #1d3a1d; border: 1px solid #4a7c26; border-radius: 6px; padding: 10px 12px; width: 320px; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="color: #fff; font-weight: 600; display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 18px;">🎮</span>
            <span>Spelare #2 Aktiv</span>
          </span>
          <button 
            on:click={stopLocalCoop}
            style="background: #663333; color: #fff; border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 12px;">
            Avsluta
          </button>
        </div>
        <div style="color: #aaa; font-size: 12px;">
          Layer: {player2Layer} | Speed Boost: +{player2SpeedBoost}%
        </div>
        <div style="color: #888; font-size: 11px; margin-top: 4px;">
          {#if browser && navigator.maxTouchPoints > 0}
            Kontroller på höger sida
          {:else}
            Numpad: 8↑ 2↓ 4← 6→
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}

<!-- Lifetime Highscores Panel (bottom-left) -->
{#if browser && (emulateMobileTouch || navigator.maxTouchPoints > 0)}
  <!-- Mobile: Square icon button on left side -->
  <div style="position: absolute; bottom: 90px; left: 10px; z-index: 9;">
    <button on:click={() => { hsOpen = !hsOpen; }}
      title={hsOpen ? 'Hide Highscores' : 'Show Highscores'}
      style="background:#333; color:#fff; border:1px solid #555; border-radius:8px; padding: 0; cursor:pointer; width: 60px; height: 60px; font-size: 28px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.3); user-select: none; touch-action: none;">
      🏆
    </button>
  </div>
  <!-- Mobile: Highscores panel (shown when open) -->
  {#if hsOpen}
    <div style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 100; width: 90%; max-width: 400px;">
      <div style="background:#1d1d1d; color:#fff; padding:16px; border-radius:12px; box-shadow: 0 4px 20px rgba(0,0,0,.5);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <div style="font-weight:600; font-size: 18px;">🏆 Highscores</div>
          <button on:click={() => { hsOpen = false; }}
            style="background:#555; color:#fff; border:none; border-radius:6px; padding:8px 12px; cursor:pointer; font-size: 20px;">
            ✕
          </button>
        </div>
        {#if highscores.length === 0}
          <div style="font-size:13px; opacity:.8;">No data yet.</div>
        {:else}
          <div style="max-height: 60vh; overflow-y: auto;">
            {#each highscores as h, i (h.id)}
              {@const FlagComp = getFlagComponent(h.country)}
              <div style="display:flex; align-items:center; gap:8px; padding:8px; border-bottom:1px solid #333; background:{i<3?'#252':'transparent'};"
                   style:opacity={players.some(pl => pl.id === h.userId) ? 1 : 0.55}
                   title={`Last updated: ${h.lastUpdated?new Date(h.lastUpdated).toLocaleString():''}${h.country?`\nCountry: ${h.country}`:''}`}>
                <div style="min-width:24px; font-weight:bold; color:{i===0?'#ffd700':i===1?'#c0c0c0':i===2?'#cd7f32':'#666'};">
                  {i+1}.
                </div>
                {#if FlagComp}
                  <svelte:component this={FlagComp} width="20" style="flex-shrink:0;" />
                {/if}
                <div style="flex:1; min-width:0;">
                  <div>{prettyName(h.userId || h.id)}</div>
                  <div style="font-size:11px; opacity:.8; margin-top:2px;">Catches: {h.totalCatches || 0} · Evil: {h.evilHits || 0}</div>
                  {#if h.placements && (h.placements.first || h.placements.second || h.placements.third)}
                    <div style="font-size:11px; opacity:.7; margin-top:2px;">
                      {#if h.placements.third}{h.placements.third}×🥉{/if}{#if h.placements.third && (h.placements.second || h.placements.first)} | {/if}{#if h.placements.second}{h.placements.second}×🥈{/if}{#if h.placements.second && h.placements.first} | {/if}{#if h.placements.first}{h.placements.first}×🥇{/if}
                    </div>
                  {/if}
                </div>
                <div style="font-weight:bold; color:#4f4; font-size:18px;">{h.score}</div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
{:else}
  <!-- Desktop: Full panel at bottom-left -->
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
               style:opacity={players.some(pl => pl.id === h.userId) ? 1 : 0.55}
               title={`Last updated: ${h.lastUpdated?new Date(h.lastUpdated).toLocaleString():''}${h.country?`\nCountry: ${h.country}`:''}`}>
            <div style="width: 24px; text-align:right; opacity:.8;">{i+1}.</div>
            <div style="flex:1;">
              <div style="font-size:14px; display:flex; align-items:center; gap:6px;">
                {#if FlagComp}
                  <svelte:component this={FlagComp} style="width:16px;height:12px;border-radius:2px; overflow:hidden;" />
                {/if}
                <span>
                  {prettyName(h.userId || h.id)}
                </span>
              </div>
              <div style="font-size:12px; opacity:.8;">
                Catches: {h.totalCatches || 0} · Evil hits: {h.evilHits || 0}
              </div>
              {#if h.placements && (h.placements.first || h.placements.second || h.placements.third)}
                <div style="font-size:11px; opacity:.7; margin-top:2px;">
                  {#if h.placements.third}{h.placements.third}×🥉{/if}{#if h.placements.third && (h.placements.second || h.placements.first)} | {/if}{#if h.placements.second}{h.placements.second}×🥈{/if}{#if h.placements.second && h.placements.first} | {/if}{#if h.placements.first}{h.placements.first}×🥇{/if}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
      <div style="margin-top:6px; font-size:11px; opacity:.7;">Last updated: {new Date(hsLastLoaded).toLocaleTimeString()}</div>
    {/if}
    </div>
  </div>
{/if}

<!-- Custom Context Menu -->
{#if showContextMenu}
  <div 
    role="menu"
    tabindex="-1"
    style="
      position: fixed;
      left: {contextMenuX}px;
      top: {contextMenuY}px;
      background: #2a2a2a;
      border: 1px solid #444;
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      z-index: 10000;
      min-width: 200px;
      font-family: Arial, sans-serif;
    "
    on:click|stopPropagation
    on:keydown|stopPropagation
  >
    <button
      on:click={becomeInactive}
      class="context-menu-item"
    >
      Become Inactive
    </button>
    
    <button
      on:click={openHowToPlay}
      class="context-menu-item"
    >
      📖 How to Play
    </button>
    
    <button
      on:click={mailtoAuthor}
      class="context-menu-item"
    >
      Contact Author
    </button>
    
    <button
      on:click={toggleBackgroundMusic}
      disabled={!isYouTubeReady && !youtubePlayer}
      class="context-menu-item"
    >
      {isMusicPlaying ? '⏸️ Pause' : '▶️ Play'} Background Music
    </button>
    
    <button
      on:click={switchMusicTrack}
      disabled={!youtubePlayer}
      class="context-menu-item"
    >
      🔀 Switch Track ({musicTracks[currentMusicIndex].name})
    </button>
    
    {#if youtubePlayer}
      <div style="padding: 10px 16px; border-top: 1px solid #444;">
        <div style="font-size: 12px; color: #aaa; display: block; margin-bottom: 4px;">
          Volume: {musicVolume}%
        </div>
        <input 
          type="range" 
          min="0" 
          max="100" 
          bind:value={musicVolume}
          on:input={() => youtubePlayer?.setVolume(musicVolume)}
          style="width: 100%;"
          aria-label="Volume control"
        />
      </div>
    {/if}
  </div>
{/if}

<!-- Hidden YouTube Player -->
<div id="youtube-player" style="display: none;"></div>

<svelte:window on:click={closeContextMenu} />