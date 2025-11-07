<script lang="ts">
  import { onMount } from 'svelte';
  import { joinGame, listenPlayers as origListenPlayers, listenFlows as origListenFlows, updateAngle, incrementScore, decrementScore, spawnFlow, db, ROOM } from '$lib/firebase.js';
  import { ref, set } from 'firebase/database';
  import { browser } from '$app/environment';

  // Types (lightweight to silence TS diagnostics)
  type Player = { id: string; name: string; angle: number; score: number; layer?: number };
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
  let debugSpeed = 0.005;
  let myAngle = 0;
  let myLayer = 0; // Current layer (0-4)

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
    
    // Check collision when flow is between OUTER_R and canvas edge
    // This gives a wider window since flows travel beyond OUTER_R
    const flowRadius = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);
    
    // Only check collision when flow is near or at the outer ring
    if (flowRadius >= OUTER_R * 0.95 && flowRadius <= OUTER_R * 1.1) {
      // Use current myAngle instead of stale myPlayer.playerData.angle
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
            playerAngle: myAngle
          });
        } else {
          // Normal flow increases score
          incrementScore(myPlayer.playerId);
          console.debug('COLLISION! Flow caught at angle', {
            flowId,
            flowAngle: flow.angle,
            playerAngle: myAngle,
            progress: progress.toFixed(3)
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
    console.log('Player joined:', myPlayer.playerId);
  }

      unsubPlayers = listenPlayers(p => (players = p)) as any;
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

      // Clear
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Center circle
      ctx.fillStyle = '#ff0';
      ctx.beginPath();
      ctx.arc(CENTER_X, CENTER_Y, INNER_R, 0, Math.PI * 2);
      ctx.fill();

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
        const idFrag = (p.id || '').slice(-8) || '00000000';
        const hue = parseInt(idFrag, 16) % 360;
        const saturation = 65 + (parseInt(idFrag.slice(2, 4), 16) % 20); // 65-85%
        const lightness = 45 + (parseInt(idFrag.slice(4, 6), 16) % 15); // 45-60%
        const color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
        
        ctx.strokeStyle = color;
        ctx.lineWidth = 25;
        ctx.lineCap = 'round';
        ctx.beginPath();
        const angle = i === 0 ? myAngle : p.angle;
        const startA = normalizeAngle(angle - PIPE_WIDTH / 2);
        const endA = normalizeAngle(angle + PIPE_WIDTH / 2);
        ctx.arc(CENTER_X, CENTER_Y, OUTER_R, startA, endA);
        ctx.stroke();

        // Accent ring
        ctx.lineWidth = 8;
        ctx.strokeStyle = color + '44';
        ctx.beginPath();
        ctx.arc(CENTER_X, CENTER_Y, OUTER_R, startA, endA);
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
        const progress = (now - flow.spawnTime) / FLOW_DURATION;
        const r = INNER_R + progress * (MAX_FLOW_RADIUS - INNER_R);
        
        if (flow.isEvil) {
          // Evil flow: light red with glow
          ctx.shadowBlur = 15;
          ctx.shadowColor = '#ff6666';
          ctx.strokeStyle = '#ff4444';
          ctx.lineWidth = 5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(CENTER_X, CENTER_Y);
          ctx.lineTo(CENTER_X + Math.cos(flow.angle) * r, CENTER_Y + Math.sin(flow.angle) * r);
          ctx.stroke();
          
          // Evil particle head with stronger glow
          ctx.fillStyle = '#ff3333';
          ctx.shadowBlur = 20;
          ctx.shadowColor = '#ff0000';
          ctx.beginPath();
          ctx.arc(CENTER_X + Math.cos(flow.angle) * r, CENTER_Y + Math.sin(flow.angle) * r, 8, 0, Math.PI * 2);
          ctx.fill();
          
          // Reset shadow
          ctx.shadowBlur = 0;
        } else {
          // Normal flow: blue
          ctx.strokeStyle = '#00f';
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(CENTER_X, CENTER_Y);
          ctx.lineTo(CENTER_X + Math.cos(flow.angle) * r, CENTER_Y + Math.sin(flow.angle) * r);
          ctx.stroke();
          ctx.fillStyle = '#0ff';
          ctx.beginPath();
          ctx.arc(CENTER_X + Math.cos(flow.angle) * r, CENTER_Y + Math.sin(flow.angle) * r, 6, 0, Math.PI * 2);
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

<div style="position: absolute; top: 10px; right: 10px; background: #222; color: #fff; padding: 12px 18px; border-radius: 8px; z-index: 10; width: 300px;">
  <label for="difficultySlider">Difficulty: {difficulty}/10 {difficulty >= 2 ? '⚠️ Evil flows active' : ''}</label>
  <input id="difficultySlider" type="range" min="1" max="10" step="1" bind:value={difficulty} style="width: 100%; margin-top: 8px;" />
  
  <div style="margin-top: 12px;">
    <label for="speedSlider">Player Speed: {debugSpeed.toFixed(3)}</label>
    <input id="speedSlider" type="range" min="0.001" max="0.2" step="0.001" bind:value={debugSpeed} style="width: 100%; margin-top: 8px;" />
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
<canvas id="gameCanvas" class="mx-auto block" width={CANVAS_SIZE} height={CANVAS_SIZE}></canvas>

<style>
  :global(body) { margin: 0; background: #000; }
  canvas { max-width: 100vw; max-height: 100vh; object-fit: contain; }
</style>