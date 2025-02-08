/*** Primera parte - index.js ***/
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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

// Configura el token de acceso
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '1305811408';

// Middleware para proteger los endpoints
app.use((req, res, next) => {
  if (req.path.startsWith('/socket.io/')) {
    return next();
  }
  const token = req.query.token;
  if (!token || token !== ACCESS_TOKEN) {
    return res.status(401).json({ error: 'Token inválido o no proporcionado.' });
  }
  next();
});

app.use(express.json());

const sessions = {};

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

function validatePhoneNumber(phone) {
  return /^\d+$/.test(phone);
}

function createChatId(phone) {
  return `${phone}@c.us`;
}

async function closeSession(sessionId) {
  const session = sessions[sessionId];
  if (session) {
    if (session.client && session.client.pupPage) {
      try {
        await session.client.destroy();
      } catch (error) {
        console.error('Error al destruir la sesión:', error);
      }
    }
    session.client = null;
    session.isClientReady = false;
    session.isInitializing = false;
    session.qrCodeData = null;
    
    io.emit('session_updated', { id: sessionId, ...session });
  }
}

async function initializeSession(sessionId) {
  let session = sessions[sessionId];
  if (!session) {
    session = createSessionObject(sessionId);
    sessions[sessionId] = session;
  }

  if (session.isInitializing) {
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  try {
    await closeSession(sessionId);
    
    session.isInitializing = true;
    session.isClientReady = false;
    session.qrCodeData = null;

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
          '--disable-gpu',
          '--disable-extensions',
          '--disable-software-rasterizer'
        ],
        timeout: 60000,
        protocolTimeout: 60000,
        defaultViewport: {
          width: 1280,
          height: 720
        }
      },
      authStrategy: new LocalAuth({
        clientId: sessionId
      }),
      qrMaxRetries: 3,
      restartOnAuthFail: true
    });

    session.client.on('qr', async (qr) => {
      session.qrCodeData = await qrcode.toDataURL(qr);
      io.emit('session_updated', { 
        id: sessionId, 
        qrCodeData: session.qrCodeData, 
        isClientReady: session.isClientReady 
      });
    });

    session.client.on('ready', () => {
      session.isClientReady = true;
      session.qrCodeData = null;
      io.emit('session_updated', { id: sessionId, isClientReady: session.isClientReady });
    });

    session.client.on('disconnected', async () => {
      console.log(`Sesión ${sessionId} desconectada`);
      await closeSession(sessionId);
    });

    session.client.on('auth_failure', async () => {
      console.log(`Fallo de autenticación en sesión ${sessionId}`);
      await closeSession(sessionId);
    });

    session.client.on('message_create', message => {
      if (message.body === '!ping') message.reply('pong');
    });

    await session.client.initialize();
    session.isInitializing = false;
    return session;
  } catch (error) {
    session.isInitializing = false;
    console.error(`Error al inicializar sesión ${sessionId}:`, error);
    throw error;
  }
}

/*** Segunda parte - index.js ***/

app.get('/creasessions', async (req, res) => {
  const sessionName = req.query.name;
  if (!sessionName) {
    return res.status(400).send("Debe proporcionar el parámetro 'name' con el nombre de la sesión.");
  }
  try {
    const session = await initializeSession(sessionName);
    const status = session.isClientReady
      ? "Conectado"
      : (session.isInitializing ? "Inicializando" : "Desconectado");
      
    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <title>Sesión ${sessionName}</title>
        <script src="/socket.io/socket.io.js"></script>
      </head>
      <body>
        <h1>Sesión: ${sessionName}</h1>
        <p>
          <strong>ID:</strong> ${sessionName} - 
          <strong>Estado:</strong> ${status}
        </p>
        ${session.qrCodeData ? `<img src="${session.qrCodeData}" alt="QR Code" width="150"/>` : '<p>Esperando QR...</p>'}
        <br/><br/>
        <button onclick="cerrarSesion()">Cerrar Sesión</button>
        <script>
          const token = "${ACCESS_TOKEN}";
          const sessionName = "${sessionName}";
          const socket = io();
          socket.on('session_updated', (data) => {
            if(data.id === sessionName) {
              location.reload();
            }
          });
          function cerrarSesion() {
            fetch("/sessions/" + sessionName + "?token=" + token, { method: "DELETE" })
              .then(response => response.json())
              .then(data => { 
                if(data.message) {
                  alert(data.message);
                } else if(data.error) {
                  alert("Error: " + data.error);
                }
                location.reload();
              })
              .catch(err => {
                console.error(err);
                alert("Ocurrió un error al cerrar la sesión.");
              });
          }
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Error al crear la sesión:", error);
    res.status(500).send("Error al crear la sesión: " + error.message);
  }
});

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
        const ACCESS_TOKEN = "${ACCESS_TOKEN}";
        const socket = io();
        socket.on('session_updated', (data) => {
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
          if(data.message) {
            alert(data.message);
          } else if(data.error) {
            alert("Error: " + data.error);
          }
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

// Rutas API
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

app.get('/sessions', (req, res) => {
  res.json(Object.values(sessions));
});

app.get('/sessions/:id', (req, res) => {
  const session = sessions[req.params.id];
  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada.' });
  }
  res.json(session);
});

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

server.listen(port, () => {
  console.log(`Servidor API corriendo en http://localhost:${port}`);
});


