const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── static file server ──
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.webm': 'audio/webm', '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.png': 'image/png' };

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  if (req.url === '/api/rooms') {
    const list = [...rooms.entries()].map(([code, room]) => ({
      code,
      players: [...room.players.values()].map(p => p.emoji),
      gameState: room.gameState,
      song: room.selectedSong,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(list));
    return;
  }

  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!path.extname(filePath)) filePath = path.join(filePath, 'index.html');

  // path traversal guard
  if (!filePath.startsWith(path.join(__dirname) + path.sep) && filePath !== path.join(__dirname, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const cc = (ext === '.webm' || ext === '.json') ? 'public, max-age=31536000, immutable'
             : (ext === '.html' || ext === '.css' || ext === '.js') ? 'no-cache'
             : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cc });
    res.end(data);
  });
});

// ── websocket server ──
const wss = new WebSocketServer({ server: httpServer });

const EMOJIS = ['🐸', '🦊', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐙', '🦄', '🐲', '🦋'];
const rooms = new Map(); // roomCode → { players, gameState, selectedSong, countdownTimer }

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { players: new Map(), gameState: 'lobby', selectedSong: 'xiguan_manyao', countdownTimer: null });
  }
  return rooms.get(code);
}

function send(ws, type, payload) {
  ws.send(JSON.stringify({ type, ...payload }));
}

function broadcast(room, type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  room.players.forEach((_, ws) => ws.readyState === ws.OPEN && ws.send(msg));
}

function playerList(room) {
  return [...room.players.values()];
}

function broadcastPlayers(room) {
  broadcast(room, 'players', { players: playerList(room) });
}

function broadcastScoreboard(room) {
  const board = playerList(room).sort((a, b) => b.score - a.score);
  broadcast(room, 'scoreboard', { board });
}

function checkAllReady(room) {
  const all = playerList(room);
  return all.length > 0 && all.every(p => p.ready);
}

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace(/^[^?]*/, ''));
  const code = (params.get('room') || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { ws.close(4000, 'invalid_room'); return; }

  const room = getOrCreateRoom(code);
  if (room.players.size >= EMOJIS.length) { ws.close(4001, 'room_full'); return; }
  if (room.gameState !== 'lobby') { ws.close(4002, 'game_in_progress'); return; }

  const used = playerList(room).map(p => p.emoji);
  const available = EMOJIS.filter(e => !used.includes(e));
  const emoji = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : EMOJIS[Math.floor(Math.random() * EMOJIS.length)];

  room.players.set(ws, { emoji, ready: false, score: 0 });

  send(ws, 'assigned', { emoji, gameState: room.gameState, song: room.selectedSong });
  broadcastPlayers(room);
  broadcastScoreboard(room);

  ws.on('message', (raw) => {
    const { type, ...data } = JSON.parse(raw);
    const player = room.players.get(ws);
    if (!player) return;

    if (type === 'pick_emoji') {
      if (room.gameState !== 'lobby' || player.ready) return;
      const wanted = data.emoji;
      if (!EMOJIS.includes(wanted)) return;
      const taken = playerList(room).some(p => p.emoji === wanted && room.players.get(ws) !== p);
      if (taken) {
        send(ws, 'pick_rejected', { emoji: wanted });
        return;
      }
      player.emoji = wanted;
      send(ws, 'assigned', { emoji: wanted, gameState: room.gameState, song: room.selectedSong });
      broadcastPlayers(room);
      return;
    }

    if (type === 'pick_song') {
      if (room.gameState !== 'lobby') return;
      const SONGS = ['xiguan_manyao', 'trouble_maker', 'golden'];
      if (!SONGS.includes(data.song)) return;
      room.selectedSong = data.song;
      broadcast(room, 'song', { song: room.selectedSong });
      return;
    }

    if (type === 'ready') {
      if (room.gameState !== 'lobby') return;
      player.ready = data.value;
      broadcastPlayers(room);

      if (checkAllReady(room)) {
        room.gameState = 'countdown';
        let n = 5;
        broadcast(room, 'countdown', { n });
        room.countdownTimer = setInterval(() => {
          n--;
          if (n > 0) {
            broadcast(room, 'countdown', { n });
          } else {
            clearInterval(room.countdownTimer);
            room.countdownTimer = null;
            room.gameState = 'playing';
            broadcast(room, 'start', { song: room.selectedSong });
          }
        }, 1000);
      }
    }

    if (type === 'score') {
      player.score = data.total;
      broadcast(room, 'scoreboard', { board: playerList(room).sort((a, b) => b.score - a.score), emoji: player.emoji, label: data.label || null });
    }
  });

  ws.on('close', () => {
    room.players.delete(ws);
    if (room.players.size === 0) {
      if (room.countdownTimer) clearInterval(room.countdownTimer);
      rooms.delete(code);
      return;
    }
    broadcastPlayers(room);
    broadcastScoreboard(room);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`http://localhost:${PORT}`));
