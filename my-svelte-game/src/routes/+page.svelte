<script lang="ts">
  import { onMount } from 'svelte';
  import { joinGame, listenPlayers as origListenPlayers, listenFlows as origListenFlows, updateAngle, updateLayer, updateColor, incrementScore, decrementScore, spawnFlow, db, ROOM } from '$lib/firebase.js';
  import { ref, set } from 'firebase/database';
  import { browser } from '$app/environment';

  // Types (lightweight to silence TS diagnostics)
  type Player = { id: string; name: string; angle: number; score: number; layer?: number; colorIndex?: number };
  type Flow = { angle: number; spawnTime: number; scored?: boolean; isEvil?: boolean; layer?: number };

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
    return origListenFlows((data: any) => {
      dbBytesDownloaded += countBytes(data);
      const flowsObj = data || {};
      cb(Object.values(flowsObj));
    });
  }

  // Game state
  let canvas!: HTMLCanvasElement;
  let ctx!: CanvasRenderingContext2D;
  let players: Player[] = [];
  let flows: Flow[] = [];
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
  const FLOW_DURATION = 8000;
  const MAX_FLOW_RADIUS = CANVAS_SIZE / 2; // Allow flows to reach canvas edge
  // Collision tolerance for radius matching the layer ring (in pixels)
  const COLLISION_RADIUS_TOLERANCE = 4;
  let debugSpeed = 0.005;
  let myAngle = 0;
  let myLayer = 0; // Current layer (0-4)
  let myColorIndex: number | null = null;
  let debugOpen = true; // debug panel visibility

  // Fixed palette with animal-themed names
  const PLAYER_COLORS = [
    { name: 'Night Owl', hex: '#5E35B1' },          // Deep Purple
    { name: 'Mystic Moth', hex: '#7E57C2' },        // Medium Purple
    { name: 'Indigo Heron', hex: '#3949AB' },       // Indigo Blue
    { name: 'Blue Jay', hex: '#1E88E5' },           // Bright Blue
    { name: 'Teal Turtle', hex: '#00897B' },        // Teal
    { name: 'Forest Wolf', hex: '#43A047' },        // Forest Green
    { name: 'Lime Lizard', hex: '#7CB342' },        // Lime Green
    { name: 'Meadow Finch', hex: '#D4E157' },       // Yellow-Green
    { name: 'Golden Fox', hex: '#FFCA28' },         // Golden Yellow
    { name: 'Solar Lynx', hex: '#FB8C00' },         // Orange
    { name: 'Ember Falcon', hex: '#E64A19' },       // Red-Orange
    { name: 'Crimson Panda', hex: '#D32F2F' }       // Red
  ];

  // Reactive: compute used colors by other players
  $: usedColors = new Set<number>(
    players.filter(pl => pl && (!myPlayer || pl.id !== myPlayer.playerId) && pl.colorIndex != null).map(pl => pl.colorIndex as number)
  );

  // Persist debug panel state in session storage
  onMount(() => {
    if (browser) {
      const saved = sessionStorage.getItem('debugOpen');
      if (saved === '0') debugOpen = false;
    }
  });
  $: if (browser) sessionStorage.setItem('debugOpen', debugOpen ? '1' : '0');
  function toggleDebug() { debugOpen = !debugOpen; }
    let lastLayerChange = 0; // Timestamp of last layer change to prevent rapid switching

  // Difficulty system
  let difficulty = 1;
  let gameStartTime = 0;

  // Hurt animation state
  let hurtUntil = 0; // Timestamp when hurt animation ends
  
  // Track which flows have already been scored to prevent duplicate scoring
  const scoredFlows = new Set<string>();
  
  // Track flows to remove (collided flows)
  const flowsToRemove = new Set<string>();

  // Flow ball stats
  let flowBallsSpawned = 0;
  let flowBallsSpawnedHistory: number[] = [];
  let flowBallsSpawnedLastMinute = 0;
  function recordFlowSpawn() {
    flowBallsSpawned++;
    flowBallsSpawnedHistory.push(Date.now());
    const cutoff = Date.now() - 60000;
    flowBallsSpawnedHistory = flowBallsSpawnedHistory.filter(t => t > cutoff);
    flowBallsSpawnedLastMinute = flowBallsSpawnedHistory.length;
  }

  function normalizeAngle(a: number) {
    return ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
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
    const progress = (now - flow.spawnTime) / FLOW_DURATION;
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
    const init = async () => {
  const joined = await joinGame(() => {});
  myPlayer = joined as any;
  if (myPlayer) {
    myAngle = myPlayer.playerData.angle;
    myLayer = (myPlayer.playerData as any).layer ?? 0;
        myColorIndex = (myPlayer.playerData as any).colorIndex ?? null;
    console.log('Player joined:', myPlayer.playerId);
  }

      unsubPlayers = listenPlayers(p => {
        players = p;
        // If my color isn't set yet or conflicts and there's a free color, pick one.
        if (myPlayer) {
          const used = new Set<number>();
          players.forEach(pl => { if (pl?.colorIndex != null) used.add(pl.colorIndex); });
          if (myColorIndex == null || (used.has(myColorIndex) && players.some(pl => pl.id !== myPlayer!.playerId && pl.colorIndex === myColorIndex))) {
            // find first free color
            let chosen: number | null = null;
            for (let i = 0; i < PLAYER_COLORS.length; i++) {
              if (!used.has(i)) { chosen = i; break; }
            }
            if (chosen == null) {
              // fallback to random if all used
              chosen = Math.floor(Math.random() * PLAYER_COLORS.length);
            }
            myColorIndex = chosen;
            updateColor(myPlayer.playerId, chosen);
          }
        }
      }) as any;
      unsubFlows = listenFlows(f => {
        flows = f;
        // Collision checking now happens in game loop, not here
        
        // Clean up old flow IDs that are too old (older than 30 seconds)
        const now = Date.now();
        const oldFlowIds = Array.from(scoredFlows).filter(id => {
          const [timestamp] = id.split('_');
          return now - parseInt(timestamp) > 30000;
        });
        oldFlowIds.forEach(id => {
          scoredFlows.delete(id);
          flowsToRemove.delete(id);
        });
      }) as any;
    };
    
    // Start async init but don't block
    init();

    // Set game start time
    gameStartTime = Date.now();

    // Increase difficulty every minute
    const difficultyInterval = setInterval(() => {
      if (difficulty < 10) {
        difficulty++;
        console.log('Difficulty increased to:', difficulty);
      }
    }, 60000); // Every minute

    // Auto spawn X flow balls every 10 seconds (X = number of online players)
    const spawnInterval = setInterval(() => {
      const numPlayers = players.length || 1; // At least 1
      for (let i = 0; i < numPlayers; i++) {
        spawnFlow(false); // Normal flows
        recordFlowSpawn();
      }
      console.debug(`Spawned ${numPlayers} flow balls for ${numPlayers} players`);
    }, 10000); // Every 10 seconds

    // Spawn evil flows every minute if difficulty >= 2
    const evilSpawnInterval = setInterval(() => {
      if (difficulty >= 2) {
        const numPlayers = players.length || 1;
        const evilCount = numPlayers * 2;
        for (let i = 0; i < evilCount; i++) {
          spawnFlow(true); // Evil flows
          recordFlowSpawn();
        }
        console.debug(`Spawned ${evilCount} evil flow balls (difficulty ${difficulty})`);
      }
    }, 60000); // Every minute

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
      if (!ctx || !canvas) return;
      
      // Get current time at the start of the loop
      const now = Date.now();
      
      // Input
      if (keys.ArrowLeft) myAngle = normalizeAngle(myAngle - debugSpeed);
      if (keys.ArrowRight) myAngle = normalizeAngle(myAngle + debugSpeed);
      
        // Layer switching with debounce (200ms between changes)
        if ((keys.ArrowUp || keys.ArrowDown) && now - lastLayerChange > 200) {
          if (keys.ArrowUp && myLayer > 0) {
            myLayer--;
            lastLayerChange = now;
            if (myPlayer?.playerId) updateLayer(myPlayer.playerId, myLayer);
          } else if (keys.ArrowDown && myLayer < NUM_LAYERS - 1) {
            myLayer++;
            lastLayerChange = now;
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

      // Flows - only render active flows (not expired and not collided)
      const activeFlows = flows.filter(flow => {
        const flowId = `${flow.spawnTime}_${flow.angle.toFixed(4)}`;
        
        // Remove flows that have collided
        if (flowsToRemove.has(flowId)) return false;
        
        const age = now - flow.spawnTime;
        const progress = age / FLOW_DURATION;
        const flowRadius = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);
        
        // Keep flows until they reach canvas edge
        return flowRadius < MAX_FLOW_RADIUS;
      });
      
      activeFlows.forEach(flow => {
        const age = now - flow.spawnTime;
        const progress = age / FLOW_DURATION;
        const r = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);
        const headX = CENTER_X + Math.cos(flow.angle) * r;
        const headY = CENTER_Y + Math.sin(flow.angle) * r;

        // Fading trail length factor (shortens near end of life)
        const trailFactor = Math.min(1, Math.max(0.15, 1 - progress * 0.7));
        const tailR = INNER_R + (progress - trailFactor * 0.25) * (MAX_FLOW_RADIUS - INNER_R);
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
      }

      // Scores overlay
      ctx.fillStyle = '#fff';
      ctx.font = '20px Arial';
      ctx.textAlign = 'left';
      players.forEach((p, i) => {
        if (!p) return;
        const name = p.name ?? `Player-${i+1}`;
        const score = typeof p.score === 'number' ? p.score : 0;
        ctx.fillText(`${name}: ${score}`, 20, 40 + i * 25);
      });

      // Throttled angle sync
      if (myPlayer && myPlayer.playerId) {
        const now2 = Date.now();
        if (now2 - lastAngleUpdateTime > 100 && myAngle !== lastAngleSent) {
          updateAngle(myPlayer.playerId, myAngle);
          lastAngleUpdateTime = now2;
          lastAngleSent = myAngle;
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
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      cancelAnimationFrame(raf);
      if (myPlayer) set(ref(db, `${ROOM}/players/${myPlayer.playerId}`), null);
    };
  });
</script>

<div style="position: absolute; top: 10px; right: 10px; z-index: 10;">
  <button on:click={toggleDebug} style="position:absolute; right:0; top:0; transform: translateY(-100%); background:#333; color:#fff; border:none; border-radius:6px; padding:6px 10px; cursor:pointer;">
    {debugOpen ? 'Hide Debug' : 'Show Debug'}
  </button>
  <div style="background: #222; color: #fff; padding: 12px 18px; border-radius: 8px; width: 300px; overflow:hidden; transition: max-height 0.25s ease, opacity 0.25s ease;"
       style:max-height={debugOpen ? '800px' : '0px'}
       style:opacity={debugOpen ? 1 : 0}
  >
  <label for="difficultySlider">Difficulty: {difficulty}/10 {difficulty >= 2 ? '⚠️ Evil flows active' : ''}</label>
  <input id="difficultySlider" type="range" min="1" max="10" step="1" bind:value={difficulty} style="width: 100%; margin-top: 8px;" />
  
  <div style="margin-top: 12px;">
    <label for="speedSlider">Player Speed: {debugSpeed.toFixed(3)}</label>
    <input id="speedSlider" type="range" min="0.001" max="0.2" step="0.001" bind:value={debugSpeed} style="width: 100%; margin-top: 8px;" />
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
          {#if !usedColors.has(idx) || idx === myColorIndex}
            <option value={idx} selected={idx === myColorIndex}>
              {c.name}
            </option>
          {/if}
        {/each}
      </select>
      <div style="margin-top:6px; display:flex; gap:6px; align-items:center;">
        <div style={`width:16px;height:16px;border-radius:50%;background:${myColorIndex!=null?PLAYER_COLORS[myColorIndex].hex:'#888'};`}></div>
        <span style="font-size:13px;opacity:.8;">{myColorIndex!=null?PLAYER_COLORS[myColorIndex].name:'Unassigned'}</span>
      </div>
    {/if}
  </div>
  
  <div style="margin-top: 12px; font-size: 14px;">
    <b>DB Download:</b><br />
    { (dbBytesPerSecond/1024).toFixed(2) } KB/s<br />
    { (dbBytesPerSecond/1024/1024).toFixed(3) } MB/s<br />
    <span style="font-size:13px;">Last minute: { (dbBytesLastMinute/1024).toFixed(1) } KB / { (dbBytesLastMinute/1024/1024).toFixed(3) } MB</span>
  </div>
  <button style="margin-top: 14px; width: 100%; padding: 8px; background: #444; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={() => { spawnFlow(false); recordFlowSpawn(); }}>
    Create Flow Ball
  </button>
  <button style="margin-top: 8px; width: 100%; padding: 8px; background: #661111; color: #fff; border: none; border-radius: 4px; cursor: pointer;" on:click={() => { spawnFlow(true); recordFlowSpawn(); }}>
    Create Evil Flow Ball
  </button>
  <div style="margin-top: 10px; font-size: 13px;">
    <b>Flow Balls:</b> {flowBallsSpawned} total<br />
    Last minute: {flowBallsSpawnedLastMinute}
  </div>
  </div>
</div>
<canvas id="gameCanvas" class="mx-auto block" width={CANVAS_SIZE} height={CANVAS_SIZE}></canvas>

<style>
  :global(body) { margin: 0; background: #000; }
  canvas { max-width: 100vw; max-height: 100vh; object-fit: contain; }
</style>