const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── static file server ──
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.webm': 'audio/webm', '.wav': 'audio/wav' };

const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : decodeURIComponent(req.url));
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── websocket server ──
const wss = new WebSocketServer({ server: httpServer });

const EMOJIS = ['🐸', '🦊', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐙', '🦄', '🐲', '🦋'];
const players = new Map(); // ws → { emoji, ready, score }
let gameState = 'lobby'; // 'lobby' | 'countdown' | 'playing'

function send(ws, type, payload) {
  ws.send(JSON.stringify({ type, ...payload }));
}

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  wss.clients.forEach(ws => ws.readyState === ws.OPEN && ws.send(msg));
}

function playerList() {
  return [...players.values()];
}

function broadcastPlayers() {
  broadcast('players', { players: playerList() });
}

function broadcastScoreboard() {
  const board = playerList().sort((a, b) => b.score - a.score);
  broadcast('scoreboard', { board });
}

function checkAllReady() {
  const all = playerList();
  return all.length > 0 && all.every(p => p.ready);
}

wss.on('connection', (ws) => {
  const used = playerList().map(p => p.emoji);
  const available = EMOJIS.filter(e => !used.includes(e));
  const emoji = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : EMOJIS[Math.floor(Math.random() * EMOJIS.length)];

  players.set(ws, { emoji, ready: false, score: 0 });

  send(ws, 'assigned', { emoji, gameState });
  broadcastPlayers();
  broadcastScoreboard();

  ws.on('message', (raw) => {
    const { type, ...data } = JSON.parse(raw);
    const player = players.get(ws);
    if (!player) return;

    if (type === 'ready') {
      if (gameState !== 'lobby') return;
      player.ready = data.value;
      broadcastPlayers();

      if (checkAllReady()) {
        gameState = 'countdown';
        let n = 5;
        broadcast('countdown', { n });
        const iv = setInterval(() => {
          n--;
          if (n > 0) {
            broadcast('countdown', { n });
          } else {
            clearInterval(iv);
            gameState = 'playing';
            broadcast('start', {});
          }
        }, 1000);
      }
    }

    if (type === 'score') {
      player.score = data.total;
      broadcast('scoreboard', { board: playerList().sort((a, b) => b.score - a.score), emoji: player.emoji, label: data.label || null });
    }
  });

  ws.on('close', () => {
    players.delete(ws);
    broadcastPlayers();
    broadcastScoreboard();
    // reset to lobby if everyone left
    if (players.size === 0) gameState = 'lobby';
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`http://localhost:${PORT}`));
