<script>
  import { onMount, onDestroy } from 'svelte';
  import { joinGame, listenPlayers, listenFlows, updateAngle, incrementScore, spawnFlow } from '$lib/firebase.js';
  import { browser } from '$app/environment';

  let canvas, ctx;
  let players = [];
  let flows = [];
  let myPlayer = null;
  let keys = {};
  let lastSpawnCheck = 0;
  const PIPE_WIDTH = 0.4;  // Radians (~23 deg)
  const CENTER_X = 400;
  const CENTER_Y = 300;
  const INNER_R = 60;
  const OUTER_R = 380;
  const FLOW_DURATION = 4000;  // ms
  const ROT_SPEED = 0.08;  // rad/frame

  $: if (myPlayer && keys.ArrowLeft) myAngle = normalizeAngle(myAngle - ROT_SPEED);
  $: if (myPlayer && keys.ArrowRight) myAngle = normalizeAngle(myAngle + ROT_SPEED);
  let myAngle = 0;

  function normalizeAngle(a) {
    return ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  }

  function checkScore(flow) {
    const progress = Math.min(1, (Date.now() - flow.spawnTime) / FLOW_DURATION);
    if (progress >= 1 && myPlayer) {
      const delta = Math.min(Math.abs(flow.angle - myPlayer.angle), Math.PI * 2 - Math.abs(flow.angle - myPlayer.angle));
      if (delta < PIPE_WIDTH / 2) {
        incrementScore(myPlayer.id);
      }
    }
  }

  onMount(async () => {
    if (!browser) return;
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');
    canvas.width = 800;
    canvas.height = 600;

    myPlayer = await joinGame((p) => myPlayer = p);
    myAngle = myPlayer.playerData.angle;

    const unsubPlayers = listenPlayers((p) => players = p);
    const unsubFlows = listenFlows((f) => { 
      flows = f; 
      flows.forEach(checkScore);  // Check for scores
    });

    // Spawn flows periodically
    const spawnInterval = setInterval(() => {
      spawnFlow();
    }, 3500);

    // Keyboard
    const onKey = (e) => keys[e.key] = e.type === 'keydown';
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);

    // Game loop
    let raf;
    function loop() {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Center circle
      ctx.fillStyle = '#ff0';
      ctx.beginPath();
      ctx.arc(CENTER_X, CENTER_Y, INNER_R, 0, Math.PI * 2);
      ctx.fill();

      // Players pipes
      players.forEach(p => {
        if (!p?.id) return; // skip invalid players
        const hash = p.id.slice(-7).padEnd(7, '0'); // ensure 7 chars
        const color = `hsl(${(parseInt(hash, 16) % 360)}, 70%, 50%)`;
        ctx.strokeStyle = color;
        ctx.lineWidth = 25;
        ctx.lineCap = 'round';
        ctx.beginPath();
        const startA = normalizeAngle(p.angle - PIPE_WIDTH / 2);
        const endA = normalizeAngle(p.angle + PIPE_WIDTH / 2);
        ctx.arc(CENTER_X, CENTER_Y, OUTER_R, startA, endA);
        ctx.stroke();

        // Outer ring
        ctx.lineWidth = 8;
        ctx.strokeStyle = color + '44';
        ctx.beginPath();
        ctx.arc(CENTER_X, CENTER_Y, OUTER_R, startA, endA);
        ctx.stroke();
      });

      // Flows
      const now = Date.now();
      flows.forEach(flow => {
        const progress = Math.min(1, (now - flow.spawnTime) / FLOW_DURATION);
        if (progress >= 1) return;

        const r = INNER_R + progress * (OUTER_R - INNER_R);
        ctx.strokeStyle = '#00f';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(CENTER_X, CENTER_Y);
        ctx.lineTo(
          CENTER_X + Math.cos(flow.angle) * r,
          CENTER_Y + Math.sin(flow.angle) * r
        );
        ctx.stroke();

        // Particle head
        ctx.fillStyle = '#0ff';
        ctx.beginPath();
        ctx.arc(
          CENTER_X + Math.cos(flow.angle) * r,
          CENTER_Y + Math.sin(flow.angle) * r,
          6,
          0, Math.PI * 2
        );
        ctx.fill();
      });

      // Update my angle to DB (debounce)
      if (myPlayer) updateAngle(myPlayer.id, myAngle);

      // Scores
      ctx.fillStyle = '#fff';
      ctx.font = '20px Arial';
      ctx.textAlign = 'left';
      players.forEach((p, i) => {
        ctx.fillText(`${p.name}: ${p.score}`, 20, 40 + i * 25);
      });

      raf = requestAnimationFrame(loop);
    }
    loop();

    return () => {
      unsubPlayers();
      unsubFlows();
      clearInterval(spawnInterval);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      cancelAnimationFrame(raf);
      if (myPlayer) set(ref(db, `${ROOM}/players/${myPlayer.id}`), null);
    };
  });
</script>

<canvas id="gameCanvas" class="mx-auto block" width="800" height="600"></canvas>

<style>
  :global(body) { margin: 0; background: #000; }
</style>