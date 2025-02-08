/*** script index.js ***/
const express = require('express');
const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs').promises;
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const PQueue = require('p-queue').default;

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

// Configura el token de acceso (puedes definirlo también mediante variable de entorno)
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '1305811408';

// Middleware para proteger los endpoints con token (excepto las rutas de socket.io)
app.use((req, res, next) => {
  // Excluir las rutas que usa socket.io para no afectar su funcionamiento
  if (req.path.startsWith('/socket.io/')) {
    return next();
  }
  // Leer el token enviado por GET (?token=...)
  const token = req.query.token;
  if (!token || token !== ACCESS_TOKEN) {
    return res.status(401).json({ error: 'Token inválido o no proporcionado.' });
  }
  next();
});

// Middleware para procesar JSON en el body
app.use(express.json());

/* 
  Objeto "sessions" para almacenar todas las sesiones activas.
  Cada sesión tendrá la siguiente estructura:
  {
    id: <identificador>,
    client: <instancia de Client de whatsapp-web.js>,
    queue: <cola para envío de mensajes>,
    qrCodeData: <código QR en formato DataURL>,
    isClientReady: <boolean>,
    isInitializing: <boolean>
  }
*/
const sessions = {};

/* Función para crear el objeto de sesión */
function createSessionObject(id) {
  return {
    id,
    client: null,
    queue: new PQueue({ concurrency: 3 }),
    qrCodeData: null,
    isClientReady: false,
    isInitializing: false
  };
}

/* Función auxiliar para validar el número de teléfono */
function validatePhoneNumber(phone) {
  return /^\d+$/.test(phone); // Validación básica; ajusta según tus necesidades
}

/* Función auxiliar para crear el chatId de WhatsApp */
function createChatId(phone) {
  return `${phone}@c.us`;
}

/* Función para cerrar una sesión de WhatsApp */
async function closeSession(sessionId) {
  const session = sessions[sessionId];
  if (session && session.client) {
    await session.client.destroy();
    session.client = null;
  }
  if (session) {
    session.isClientReady = false;
    session.isInitializing = false;
    session.qrCodeData = null;
  }
  // Emitir evento de actualización para notificar cambios en tiempo real
  io.emit('session_updated', { id: sessionId, ...session });
}

/* Función para inicializar (o reinicializar) una sesión */
async function initializeSession(sessionId) {
  let session = sessions[sessionId];
  if (!session) {
    session = createSessionObject(sessionId);
    sessions[sessionId] = session;
  }
  // Si la sesión ya está inicializando o lista, se cierra primero
  if (session.isInitializing || session.isClientReady) {
    await closeSession(sessionId);
  }
  session.isInitializing = true;
  session.isClientReady = false;
  session.qrCodeData = null;

  try {
    // (Opcional) Si trabajas con persistencia, elimina el archivo de sesión específico
    // await fs.unlink(`./session-${sessionId}.json`).catch(() => {});

    session.client = new Client({
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      },
      session: null // Por ahora, sin sesión almacenada
    });

    // Eventos del cliente:
    session.client.on('qr', async (qr) => {
      session.qrCodeData = await qrcode.toDataURL(qr);
      io.emit('session_updated', { id: sessionId, qrCodeData: session.qrCodeData, isClientReady: session.isClientReady });
    });

    session.client.on('ready', () => {
      session.isClientReady = true;
      session.qrCodeData = null;
      io.emit('session_updated', { id: sessionId, isClientReady: session.isClientReady });
    });

    session.client.on('message_create', message => {
      if (message.body === '!ping') message.reply('pong');
    });

    await session.client.initialize();
    session.isInitializing = false;
    return session;
  } catch (error) {
    session.isInitializing = false;
    throw error;
  }
}

/* ================================
   RUTAS Y CRUD DE SESIONES
=================================== */

/* Página principal que muestra el estado de las sesiones */
app.get('/', (req, res) => {
  let sessionListHTML = Object.values(sessions).map(session => `
    <li>
      <strong>ID:</strong> ${session.id} - 
      <strong>Estado:</strong> ${session.isClientReady ? 'Conectado' : (session.isInitializing ? 'Inicializando' : 'Desconectado')}
      ${session.qrCodeData ? `<br/><img src="${session.qrCodeData}" alt="QR Code" width="150"/>` : ''}
      <br/>
      <button onclick="closeSession('${session.id}')">Cerrar Sesión</button>
      <button onclick="initializeSession('${session.id}')">Reinicializar Sesión</button>
    </li>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Administración de Sesiones de WhatsApp</title>
      <script src="/socket.io/socket.io.js"></script>
    </head>
    <body>
      <h1>Sesiones de WhatsApp</h1>
      <ul id="sessionList">
        ${sessionListHTML}
      </ul>
      <h2>Crear Nueva Sesión</h2>
      <form id="createSessionForm">
        <input type="text" id="sessionId" placeholder="ID de Sesión" required />
        <button type="submit">Crear Sesión</button>
      </form>
      <script>
        const ACCESS_TOKEN = "${ACCESS_TOKEN}"; // Se incluye el token para las llamadas fetch
        const socket = io();
        socket.on('session_updated', (data) => {
          // Al recibir una actualización se recarga la página
          location.reload();
        });
        document.getElementById('createSessionForm').addEventListener('submit', async function(e) {
          e.preventDefault();
          const sessionId = document.getElementById('sessionId').value;
          const res = await fetch('/sessions?token=' + ACCESS_TOKEN, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ id: sessionId })
          });
          const data = await res.json();
          alert(data.message);
          location.reload();
        });
        async function closeSession(id) {
          const res = await fetch('/sessions/' + id + '?token=' + ACCESS_TOKEN, { method: 'DELETE' });
          const data = await res.json();
          alert(data.message);
          location.reload();
        }
        async function initializeSession(id) {
          const res = await fetch('/sessions/' + id + '/initialize?token=' + ACCESS_TOKEN, { method: 'PUT' });
          const data = await res.json();
          alert(data.message);
          location.reload();
        }
      </script>
    </body>
    </html>
  `);
});

/* Crear sesión (POST /sessions)  
   Se espera en el body JSON: { id: "nombre_de_sesion" } */
app.post('/sessions', async (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Se requiere un ID de sesión.' });
  }
  if (sessions[id]) {
    return res.status(400).json({ error: 'La sesión ya existe.' });
  }
  try {
    await initializeSession(id);
    res.json({ message: `Sesión ${id} creada e inicializada.` });
  } catch (error) {
    console.error(`Error al inicializar la sesión ${id}:`, error);
    res.status(500).json({ error: `Error al inicializar la sesión ${id}` });
  }
});

/* Listar todas las sesiones (GET /sessions) */
app.get('/sessions', (req, res) => {
  res.json(Object.values(sessions));
});

/* Obtener detalles de una sesión (GET /sessions/:id) */
app.get('/sessions/:id', (req, res) => {
  const session = sessions[req.params.id];
  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada.' });
  }
  res.json(session);
});

/* Inicializar (o reinicializar) una sesión (PUT /sessions/:id/initialize) */
app.put('/sessions/:id/initialize', async (req, res) => {
  const sessionId = req.params.id;
  try {
    await initializeSession(sessionId);
    res.json({ message: `Sesión ${sessionId} inicializada.` });
  } catch (error) {
    console.error(`Error al inicializar la sesión ${sessionId}:`, error);
    res.status(500).json({ error: `Error al inicializar la sesión ${sessionId}` });
  }
});

/* Eliminar una sesión (DELETE /sessions/:id) */
app.delete('/sessions/:id', async (req, res) => {
  const sessionId = req.params.id;
  if (!sessions[sessionId]) {
    return res.status(404).json({ error: 'Sesión no encontrada.' });
  }
  try {
    await closeSession(sessionId);
    delete sessions[sessionId];
    io.emit('session_updated', { id: sessionId, removed: true });
    res.json({ message: `Sesión ${sessionId} eliminada.` });
  } catch (error) {
    console.error(`Error al eliminar la sesión ${sessionId}:`, error);
    res.status(500).json({ error: `Error al eliminar la sesión ${sessionId}` });
  }
});

/* ================================
   ENDPOINTS PARA ENVIAR MENSAJES
=================================== */

/* Envío de mensaje simple para una sesión (GET /sessions/:id/send-message)  
   Parámetros query: phone y message */
app.get('/sessions/:id/send-message', async (req, res) => {
  const sessionId = req.params.id;
  const session = sessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada.' });
  }
  const { phone, message } = req.query;
  if (!phone || !message) {
    return res.status(400).json({ error: 'Se requieren los parámetros phone y message.' });
  }
  if (!validatePhoneNumber(phone)) {
    return res.status(400).json({ error: 'Número de teléfono no válido.' });
  }
  if (!session.isClientReady) {
    return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo.' });
  }
  try {
    await session.queue.add(async () => {
      const chatId = createChatId(phone);
      await session.client.sendMessage(chatId, message);
    });
    res.json({ success: true, message: 'Mensaje enviado con éxito.' });
  } catch (error) {
    console.error('Error al enviar mensaje:', error);
    res.status(500).json({ error: 'Error al enviar el mensaje.' });
  }
});

/* Envío de mensaje con archivo multimedia para una sesión (GET /sessions/:id/send-message_media)  
   Parámetros query: phone, message, fileUrl y opcionalmente fileName */
app.get('/sessions/:id/send-message_media', async (req, res) => {
  const sessionId = req.params.id;
  const session = sessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada.' });
  }
  const { phone, message, fileUrl, fileName } = req.query;
  if (!phone || !message || !fileUrl) {
    return res.status(400).json({ error: 'Se requieren los parámetros phone, message y fileUrl.' });
  }
  if (!validatePhoneNumber(phone)) {
    return res.status(400).json({ error: 'Número de teléfono no válido.' });
  }
  if (!session.isClientReady) {
    return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo.' });
  }
  try {
    await session.queue.add(async () => {
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const fileNameToUse = fileName || fileUrl.split('/').pop();
      const media = new MessageMedia(
        response.headers['content-type'],
        Buffer.from(response.data).toString('base64'),
        fileNameToUse
      );
      const chatId = createChatId(phone);
      await session.client.sendMessage(chatId, message);
      await session.client.sendMessage(chatId, media);
    });
    res.json({ success: true, message: 'Mensaje y archivo multimedia enviados con éxito.' });
  } catch (error) {
    console.error('Error al enviar mensaje multimedia:', error);
    res.status(500).json({ error: 'Error al enviar el mensaje multimedia.' });
  }
});

/* Iniciar el servidor */
server.listen(port, () => {
  console.log(`Servidor API corriendo en http://localhost:${port}`);
});
