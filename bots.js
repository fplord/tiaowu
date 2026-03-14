const WebSocket = require('ws');
const fs = require('fs');

const N_BOTS = 3;
const SERVER = 'ws://localhost:3000';
const beats = JSON.parse(fs.readFileSync('beatsmatched.json')).map(b => b.beat);

function humanError() {
  // Box-Muller for gaussian-ish spread, clamped to ±400ms
  const u = 1 - Math.random(), v = Math.random();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return n * 120; // stddev ~120ms
}

function createBot(index) {
  const ws = new WebSocket(SERVER);
  let score = 0;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.type === 'assigned') {
      setTimeout(() => ws.send(JSON.stringify({ type: 'ready', value: true })), 1000 + index * 200);
    }

    if (msg.type === 'start') {
      const startTime = Date.now();

      beats.forEach(beat => {
        const error = humanError();
        const delay = beat * 1000 + error;
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const diff = Math.abs(error);
          let label, points;
          if      (diff < 80)  { label = 'PERFECT'; points = 100; }
          else if (diff < 100) { label = 'GREAT';   points = 60;  }
          else if (diff < 180) { label = 'GOOD';    points = 30;  }
          else                 { label = 'BAD';      points = 0;   }
          score += points;
          ws.send(JSON.stringify({ type: 'score', total: score, label }));
        }, Math.max(0, delay));
      });
    }
  });

  ws.on('error', (err) => console.error(`bot ${index} error:`, err.message));
  ws.on('close', () => console.log(`bot ${index} disconnected`));
}

for (let i = 0; i < N_BOTS; i++) {
  setTimeout(() => createBot(i), i * 300);
}

console.log(`spawning ${N_BOTS} bots → ${SERVER}`);
