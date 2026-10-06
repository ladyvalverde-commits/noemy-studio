const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vip2026';
// En Railway, DATA_DIR puede apuntar a un volumen para que data.json sobreviva a los redespliegues
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');

// Detrás del proxy de Railway, para que el QR use https:// y el dominio público
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Datos en memoria, con copia en data.json ----
// status: 'waiting' | 'serving' | 'done'
let queue = [];
let nextId = 1;

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(data.queue)) queue = data.queue;
    nextId = Math.max(Number(data.nextId) || 1, ...queue.map(e => e.id + 1));
    console.log(`Lista recuperada: ${queue.length} registro(s) desde data.json`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('No se pudo leer data.json, se empieza con lista vacía:', err.message);
  }
}

// Escribe a un archivo temporal y luego lo renombra, para no dejar
// data.json a medias si el equipo se apaga justo al guardar.
function saveData() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ nextId, queue }, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('No se pudo guardar data.json:', err.message);
  }
}

loadData();

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

function publicEntry(e) {
  return {
    id: e.id,
    name: e.name,
    partySize: e.partySize,
    status: e.status,
    joinedAt: e.joinedAt,
    servedAt: e.servedAt,
  };
}

function getStats() {
  const waiting = queue.filter(e => e.status === 'waiting');
  const serving = queue.filter(e => e.status === 'serving');
  const done = queue.filter(e => e.status === 'done');
  const served = queue.filter(e => e.servedAt);
  const avgWaitMs = served.length
    ? served.reduce((sum, e) => sum + (e.servedAt - e.joinedAt), 0) / served.length
    : 0;
  return {
    waiting: waiting.length,
    serving: serving.length,
    completed: done.length,
    avgWaitMinutes: Math.round(avgWaitMs / 60000),
  };
}

function requireAdmin(req, res, next) {
  if (req.get('x-admin-password') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ---- API pública ----
app.post('/api/join', (req, res) => {
  const name = clean(req.body.name, 50);
  const phone = clean(req.body.phone, 20);
  const partySize = parseInt(req.body.partySize, 10);

  if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 10) {
    return res.status(400).json({ error: 'El tamaño del grupo debe ser entre 1 y 10' });
  }

  const entry = {
    id: nextId++,
    name,
    phone,
    partySize,
    status: 'waiting',
    joinedAt: Date.now(),
    servedAt: null,
    completedAt: null,
  };
  queue.push(entry);
  saveData();
  res.status(201).json({ id: entry.id });
});

app.get('/api/status/:id', (req, res) => {
  const entry = queue.find(e => e.id === Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  const waiting = queue.filter(e => e.status === 'waiting');
  const position = entry.status === 'waiting' ? waiting.indexOf(entry) + 1 : 0;
  res.json({ ...publicEntry(entry), position, stats: getStats() });
});

app.delete('/api/status/:id', (req, res) => {
  const idx = queue.findIndex(e => e.id === Number(req.params.id) && e.status === 'waiting');
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  queue.splice(idx, 1);
  saveData();
  res.json({ ok: true });
});

app.get('/api/queue', (req, res) => {
  res.json({
    waiting: queue.filter(e => e.status === 'waiting').map(publicEntry),
    serving: queue.filter(e => e.status === 'serving').map(publicEntry),
    stats: getStats(),
  });
});

app.get('/api/qr', async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/`;
  try {
    const dataUrl = await QRCode.toDataURL(url, {
      width: 320,
      margin: 1,
      color: { dark: '#0f5e57', light: '#ffffff' },
    });
    res.json({ url, dataUrl });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo generar el QR' });
  }
});

// ---- API de administración ----
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: 'Contraseña incorrecta' });
});

app.get('/api/admin/queue', requireAdmin, (req, res) => {
  res.json({ queue, stats: getStats() });
});

app.post('/api/admin/:id/serve', requireAdmin, (req, res) => {
  const entry = queue.find(e => e.id === Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  entry.status = 'serving';
  entry.servedAt = entry.servedAt || Date.now();
  saveData();
  res.json(entry);
});

app.post('/api/admin/:id/complete', requireAdmin, (req, res) => {
  const entry = queue.find(e => e.id === Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  entry.status = 'done';
  entry.servedAt = entry.servedAt || Date.now();
  entry.completedAt = Date.now();
  saveData();
  res.json(entry);
});

app.delete('/api/admin/:id', requireAdmin, (req, res) => {
  const idx = queue.findIndex(e => e.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  queue.splice(idx, 1);
  saveData();
  res.json({ ok: true });
});

app.post('/api/admin/clear-completed', requireAdmin, (req, res) => {
  queue = queue.filter(e => e.status !== 'done');
  saveData();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Noemy Studio escuchando en http://localhost:${PORT}`);
  console.log(`  Cliente: http://localhost:${PORT}/`);
  console.log(`  Admin:   http://localhost:${PORT}/admin.html`);
  console.log(`  TV:      http://localhost:${PORT}/display.html`);
});
