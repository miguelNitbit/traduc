// Traducción en vivo: la Mac envía el audio de la prédica, este servidor lo pasa
// a OpenAI (una sesión por idioma en uso) y reparte audio + subtítulos a los celulares.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY || '';
const MOCK = process.env.MOCK === '1';
const ADMIN_PIN = process.env.ADMIN_PIN || String(crypto.randomInt(100000, 1000000));
const OPENAI_URL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';
// Motor de traducción:
//  - "translate": gpt-realtime-translate, el modelo de interpretación (el mejor).
//  - "prompt": un modelo de voz general con instrucciones de intérprete. Es el respaldo
//    cuando la clave de OpenAI no tiene acceso al modelo de interpretación.
//  - "auto": prueba "translate" y pasa a "prompt" si la clave no tiene acceso.
const ENGINE_SETTING = process.env.TRANSLATE_ENGINE || 'auto';
let engine = ENGINE_SETTING === 'prompt' ? 'prompt' : 'translate';
const PROMPT_MODEL = process.env.PROMPT_MODEL || 'gpt-realtime-2.1';
const PROMPT_URL = `wss://api.openai.com/v1/realtime?model=${PROMPT_MODEL}`;
const ACCESS_RETRIES = 4; // OpenAI a veces niega el modelo de forma pasajera: se reintenta antes del respaldo
const KEEP_ITEMS = 4; // contexto que conserva el motor "prompt" (lo demás se borra para no encarecer)
const IDLE_CLOSE_MS = 30_000; // cierra la sesión de un idioma sin oyentes
const ADMIN_GRACE_MS = 20_000; // si la Mac se desconecta, espera antes de detener
const HISTORY_CHARS = 600;
const RESUME_MS = 30 * 60_000; // si se reinicia la transmisión antes de este tiempo, el texto guardado continúa
const TIME_ZONE = process.env.TIME_ZONE || 'America/Mexico_City';
// Idiomas que las fuentes estándar del PDF pueden escribir; el resto se descarga como texto.
const PDF_LANGS = new Set(['en', 'pt', 'fr', 'de', 'it', 'id']);

// Idiomas de salida que admite gpt-realtime-translate (sin español: es el idioma de origen).
const LANG_NAMES = {
  en: 'English', pt: 'Português', fr: 'Français', de: 'Deutsch', it: 'Italiano',
  ja: '日本語', ko: '한국어', zh: '中文', ru: 'Русский', hi: 'हिन्दी',
  id: 'Bahasa Indonesia', vi: 'Tiếng Việt',
};
const LANG_ENGLISH = {
  en: 'English', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', ja: 'Japanese',
  ko: 'Korean', zh: 'Mandarin Chinese', ru: 'Russian', hi: 'Hindi', id: 'Indonesian', vi: 'Vietnamese',
};
const interpreterPrompt = (lang) => `You are a simultaneous interpreter for a church sermon. \
Everything you hear is the preacher speaking Spanish. Translate it faithfully into ${LANG_ENGLISH[lang]} \
and say only the translation, in a clear, natural voice. Never answer questions, never comment, \
never add or omit anything. Keep Bible references and names accurate. \
If you hear silence, music or singing, say nothing.`;
const LANGS = (process.env.LANGUAGES || Object.keys(LANG_NAMES).join(','))
  .split(',').map((s) => s.trim()).filter((l) => LANG_NAMES[l]);

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://${lanAddress()}:${PORT}`).replace(/\/$/, '');

// ---------- Estado ----------
let live = false;
let lastError = '';
let startedAt = null; // inicio de la prédica cuyo texto está guardado
let stoppedAt = 0;
const admins = new Set();
let adminGraceTimer = null;
const channels = new Map(
  LANGS.map((lang) => [lang, {
    lang, listeners: new Set(), session: null, history: '', transcript: '',
    idleTimer: null, retryTimer: null, fails: 0, accessFails: 0,
  }]),
);

// ---------- Reparto a oyentes ----------
function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function emitAudio(ch, pcm) {
  ch.fails = 0;
  ch.accessFails = 0;
  for (const ws of ch.listeners) {
    // Si un celular va atrasado, se salta audio en vez de acumular retraso.
    if (ws.wantAudio && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 512_000) {
      ws.send(pcm, { binary: true });
    }
  }
}

function emitCaption(ch, delta) {
  if (!delta) return;
  ch.fails = 0;
  ch.history = (ch.history + delta).slice(-HISTORY_CHARS);
  ch.transcript += delta;
  for (const ws of ch.listeners) sendJson(ws, { type: 'caption', delta });
}

function broadcastStatus() {
  for (const ch of channels.values()) {
    for (const ws of ch.listeners) sendJson(ws, { type: 'status', live });
  }
}

// ---------- Sesiones de traducción ----------
function openAISession(ch) {
  const mode = engine;
  const ws = new WebSocket(mode === 'translate' ? OPENAI_URL : PROMPT_URL, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  // Solo motor "prompt": el modelo responde por turnos, así que las frases que llegan
  // mientras aún habla se encolan en vez de pedir dos respuestas a la vez.
  const items = [];
  let responding = false;
  let pending = false;
  const respond = () => {
    responding = true;
    pending = false;
    ws.send(JSON.stringify({ type: 'response.create' }));
  };
  const s = {
    state: 'conectando',
    closedByUs: false,
    send(pcm) {
      if (s.state !== 'activa' || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: mode === 'translate' ? 'session.input_audio_buffer.append' : 'input_audio_buffer.append',
        audio: pcm.toString('base64'),
      }));
    },
    close() {
      s.closedByUs = true;
      ws.close();
    },
  };
  ws.on('open', () => {
    const session = mode === 'translate'
      ? {
        audio: {
          input: { noise_reduction: { type: 'near_field' } },
          output: { language: ch.lang },
        },
      }
      : {
        type: 'realtime',
        instructions: interpreterPrompt(ch.lang),
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            // Traduce en cada pausa del orador y no se interrumpe si él sigue hablando.
            turn_detection: {
              type: 'server_vad', silence_duration_ms: 200,
              create_response: false, interrupt_response: false,
            },
          },
          output: { format: { type: 'audio/pcm', rate: 24000 } },
        },
      };
    ws.send(JSON.stringify({ type: 'session.update', session }));
    s.state = 'activa';
    console.log(`[${ch.lang}] sesión de traducción abierta (motor: ${mode})`);
  });
  ws.on('message', (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type === 'session.output_audio.delta') {
      emitAudio(ch, Buffer.from(ev.delta, 'base64'));
    } else if (ev.type === 'session.output_transcript.delta') {
      emitCaption(ch, ev.delta);
    } else if (ev.type === 'response.output_audio.delta') {
      emitAudio(ch, Buffer.from(ev.delta, 'base64'));
    } else if (ev.type === 'response.output_audio_transcript.delta') {
      emitCaption(ch, ev.delta);
    } else if (ev.type === 'response.output_audio_transcript.done') {
      emitCaption(ch, ' ');
    } else if (ev.type === 'conversation.item.done') {
      items.push(ev.item.id);
    } else if (ev.type === 'input_audio_buffer.committed') {
      if (responding) pending = true; else respond();
    } else if (ev.type === 'response.done') {
      responding = false;
      if (pending) respond();
      while (items.length > KEEP_ITEMS) {
        ws.send(JSON.stringify({ type: 'conversation.item.delete', item_id: items.shift() }));
      }
    } else if (ev.type === 'error') {
      const message = ev.error?.message || JSON.stringify(ev);
      if (mode === 'translate' && ENGINE_SETTING === 'auto' && /does not exist|do not have access/i.test(message)) {
        ch.accessFails += 1;
        s.fastRetry = true;
        if (ch.accessFails >= ACCESS_RETRIES) {
          engine = 'prompt';
          console.warn(`La clave no tiene acceso a gpt-realtime-translate; se usa ${PROMPT_MODEL} con instrucciones de intérprete.`);
        } else {
          console.warn(`[${ch.lang}] OpenAI negó gpt-realtime-translate (intento ${ch.accessFails}); se reintenta.`);
        }
        ws.close();
        return;
      }
      lastError = `[${ch.lang}] ${message}`;
      console.error('OpenAI:', lastError);
    }
  });
  ws.on('error', (err) => {
    lastError = `[${ch.lang}] ${err.message}`;
    console.error('OpenAI:', lastError);
  });
  ws.on('close', () => {
    console.log(`[${ch.lang}] sesión de traducción cerrada`);
    if (ch.session !== s) return;
    ch.session = null;
    if (!s.closedByUs) {
      // Corte inesperado (red, límite de duración de sesión): reintenta con espera creciente.
      if (!s.fastRetry) ch.fails += 1;
      const wait = s.fastRetry ? 300 : Math.min(15_000, 1500 * ch.fails);
      ch.retryTimer = setTimeout(() => { ch.retryTimer = null; sync(ch); }, wait);
    }
  });
  return s;
}

// Modo de prueba sin OpenAI: emite pitidos y subtítulos falsos para probar celulares y pantalla.
function mockSession(ch) {
  const words = `[${ch.lang}] This is a test caption for the live translation.`.split(' ');
  let n = 0;
  let phase = 0;
  const timer = setInterval(() => {
    const pcm = Buffer.alloc(4800 * 2); // 200 ms a 24 kHz
    if (n % 5 < 2) {
      for (let i = 0; i < 4800; i++) {
        pcm.writeInt16LE(Math.round(Math.sin(phase) * 3000), i * 2);
        phase += (2 * Math.PI * 440) / 24000;
      }
    }
    emitAudio(ch, pcm);
    if (n % 2 === 0) emitCaption(ch, `${words[(n / 2) % words.length]} `);
    n += 1;
  }, 200);
  return { state: 'activa', send() {}, close() { clearInterval(timer); } };
}

// Abre o cierra la sesión de un idioma según haya transmisión y oyentes.
function sync(ch) {
  const wanted = live && ch.listeners.size > 0;
  if (wanted) {
    clearTimeout(ch.idleTimer);
    ch.idleTimer = null;
    if (!ch.session && !ch.retryTimer) ch.session = MOCK ? mockSession(ch) : openAISession(ch);
    return;
  }
  clearTimeout(ch.retryTimer);
  ch.retryTimer = null;
  if (!ch.session) return;
  if (!live) {
    closeSession(ch);
  } else if (!ch.idleTimer) {
    ch.idleTimer = setTimeout(() => {
      ch.idleTimer = null;
      if (ch.listeners.size === 0) closeSession(ch);
    }, IDLE_CLOSE_MS);
  }
}

function closeSession(ch) {
  clearTimeout(ch.idleTimer);
  ch.idleTimer = null;
  const s = ch.session;
  ch.session = null;
  s?.close();
}

function setLive(value) {
  if (live === value) return;
  live = value;
  console.log(live ? '▶ Transmisión iniciada' : '■ Transmisión detenida');
  if (live) {
    lastError = '';
    // Una transmisión nueva empieza un texto nuevo; un reinicio rápido continúa el mismo.
    const resume = startedAt && Date.now() - stoppedAt < RESUME_MS;
    if (!resume) startedAt = new Date();
    for (const ch of channels.values()) {
      ch.transcript = resume && ch.transcript ? `${ch.transcript.trimEnd()}\n\n` : '';
    }
    // En "auto", cada transmisión vuelve a intentar primero el modelo de interpretación.
    if (ENGINE_SETTING === 'auto') engine = 'translate';
  } else {
    stoppedAt = Date.now();
  }
  for (const ch of channels.values()) {
    if (live) { ch.history = ''; ch.fails = 0; ch.accessFails = 0; }
    sync(ch);
  }
  broadcastStatus();
  sendStats();
}

function sendStats() {
  const stats = {
    type: 'stats', live, error: lastError, url: PUBLIC_URL, mock: MOCK, engine,
    channels: [...channels.values()].map((ch) => ({
      lang: ch.lang,
      name: LANG_NAMES[ch.lang],
      listeners: [...ch.listeners].filter((ws) => !ws.preview).length,
      saved: ch.transcript.trim().length,
      format: PDF_LANGS.has(ch.lang) ? 'PDF' : 'TXT',
      session: ch.session ? ch.session.state : ch.retryTimer ? 'reintentando' : 'apagada',
    })),
  };
  for (const ws of admins) sendJson(ws, stats);
}
setInterval(sendStats, 1000);

// ---------- Texto guardado de la prédica ----------
// La traducción llega como un flujo continuo; se parte en párrafos de varias frases.
function paragraphs(text) {
  const out = [];
  for (const block of text.split(/\n{2,}/)) {
    const sentences = block.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…。！？])\s+/).filter(Boolean);
    for (let i = 0; i < sentences.length; i += 5) out.push(sentences.slice(i, i + 5).join(' '));
  }
  return out;
}

function sendTranscript(res, ch) {
  const paras = paragraphs(ch.transcript);
  const date = (startedAt || new Date()).toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
  const longDate = (startedAt || new Date()).toLocaleDateString(ch.lang, {
    timeZone: TIME_ZONE, dateStyle: 'long',
  });
  const name = `sermon-${date}-${ch.lang}`;
  if (!PDF_LANGS.has(ch.lang)) {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.txt"`,
      'Cache-Control': 'no-store',
    });
    res.end(`${longDate}\n\n${paras.join('\n\n')}\n`);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${name}.pdf"`,
    'Cache-Control': 'no-store',
  });
  const doc = new PDFDocument({ size: 'LETTER', margin: 72, info: { Title: `Sermon ${date} (${LANG_NAMES[ch.lang]})` } });
  doc.pipe(res);
  doc.font('Helvetica-Bold').fontSize(20).text('Sermon');
  doc.moveDown(0.3).font('Helvetica').fontSize(11).fillColor('#555')
    .text(`${longDate} · ${LANG_NAMES[ch.lang]}`)
    .text('Automatic live translation from Spanish. It may contain errors.');
  doc.moveDown(1.2).fillColor('#000').fontSize(12);
  // Las fuentes estándar no tienen algunos signos tipográficos; se cambian por equivalentes.
  const clean = (t) => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, '...');
  for (const p of paras) doc.text(clean(p), { align: 'left', lineGap: 3, paragraphGap: 10 });
  doc.end();
}

// ---------- HTTP ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};
const ROUTES = { '/': '/index.html', '/admin': '/admin.html', '/pantalla': '/pantalla.html' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ live, languages: LANGS.map((code) => ({ code, name: LANG_NAMES[code] })) }));
    return;
  }
  if (url.pathname === '/transcript') {
    const ch = channels.get(url.searchParams.get('lang'));
    if (!pinOk(url.searchParams.get('pin') || '')) { res.writeHead(403).end('PIN incorrecto'); return; }
    if (!ch || !ch.transcript.trim()) { res.writeHead(404).end('No hay texto guardado'); return; }
    sendTranscript(res, ch);
    return;
  }
  if (url.pathname === '/qr.svg') {
    const svg = await QRCode.toString(PUBLIC_URL, { type: 'svg', margin: 1 });
    res.writeHead(200, { 'Content-Type': TYPES['.svg'], 'Cache-Control': 'no-store' });
    res.end(svg);
    return;
  }
  const rel = ROUTES[url.pathname] || url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !TYPES[path.extname(file)]) {
    res.writeHead(404).end('No encontrado');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('No encontrado'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSockets ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

function pinOk(pin) {
  const a = crypto.createHash('sha256').update(String(pin)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PIN).digest();
  return crypto.timingSafeEqual(a, b);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws') {
    const ch = channels.get(url.searchParams.get('lang'));
    if (!ch) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // La vista previa de la página de control no cuenta como oyente.
      ws.preview = url.searchParams.get('preview') === '1';
      onListener(ws, ch);
    });
  } else if (url.pathname === '/ws-admin') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!pinOk(url.searchParams.get('pin') || '')) { ws.close(4001, 'PIN incorrecto'); return; }
      onAdmin(ws);
    });
  } else {
    socket.destroy();
  }
});

function onListener(ws, ch) {
  ws.isAlive = true;
  ws.wantAudio = false;
  ch.listeners.add(ws);
  sendJson(ws, { type: 'status', live });
  if (live && ch.history) sendJson(ws, { type: 'history', text: ch.history });
  sync(ch);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'audio') ws.wantAudio = Boolean(msg.on);
    } catch { /* se ignora */ }
  });
  ws.on('close', () => { ch.listeners.delete(ws); sync(ch); });
  ws.on('error', () => {});
}

function onAdmin(ws) {
  ws.isAlive = true;
  admins.add(ws);
  clearTimeout(adminGraceTimer);
  adminGraceTimer = null;
  sendStats();
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // PCM16 mono a 24 kHz desde la página de control.
      if (!live || data.length % 2 !== 0) return;
      for (const ch of channels.values()) ch.session?.send(data);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'start') {
        if (!MOCK && !API_KEY) {
          lastError = 'Falta OPENAI_API_KEY en el archivo .env';
          sendStats();
          return;
        }
        setLive(true);
      } else if (msg.type === 'stop') {
        setLive(false);
      }
    } catch { /* se ignora */ }
  });
  ws.on('close', () => {
    admins.delete(ws);
    if (admins.size === 0 && live) {
      adminGraceTimer = setTimeout(() => { if (admins.size === 0) setLive(false); }, ADMIN_GRACE_MS);
    }
  });
  ws.on('error', () => {});
}

// Elimina conexiones muertas (celulares que se durmieron) y mantiene vivos los túneles.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

server.listen(PORT, () => {
  console.log(`
Traducción en vivo lista${MOCK ? ' (MODO DE PRUEBA, sin OpenAI)' : ''}
  Control (en esta Mac):  http://localhost:${PORT}/admin
  PIN de control:         ${ADMIN_PIN}
  Oyentes (QR):           ${PUBLIC_URL}
  Pantalla del templo:    ${PUBLIC_URL}/pantalla?lang=${LANGS[0]}
  Idiomas:                ${LANGS.join(', ')}
`);
  if (!MOCK && !API_KEY) console.warn('⚠ Falta OPENAI_API_KEY: crea el archivo .env (ver .env.example).\n');
});
