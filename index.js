const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs').promises;
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const PQueue = require('p-queue').default;

// Crear directorio de sesiones si no existe
const fs_sync = require('fs');
if (!fs_sync.existsSync('./sessions')) {
  fs_sync.mkdirSync('./sessions', { recursive: true });
}

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
    try {
      if (session.client) {
        if (session.client.pupPage) {
          try {
            await session.client.pupPage.close();
          } catch (err) {
            console.error('Error al cerrar la página:', err);
          }
        }
        if (session.client.browser) {
          try {
            await session.client.browser.close();
          } catch (err) {
            console.error('Error al cerrar el navegador:', err);
          }
        }
        try {
          await session.client.destroy();
        } catch (err) {
          console.error('Error al destruir el cliente:', err);
        }
      }
    } catch (error) {
      console.error('Error al cerrar la sesión:', error);
    } finally {
      session.client = null;
      session.isClientReady = false;
      session.isInitializing = false;
      session.qrCodeData = null;
      io.emit('session_updated', { id: sessionId, ...session });
    }
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
          '--disable-gpu',
          '--disable-extensions',
          '--disable-software-rasterizer',
          '--disable-features=site-per-process',
          '--disable-web-security',
          '--disable-notifications',
          '--ignore-certificate-errors',
          '--allow-running-insecure-content'
        ],
        timeout: 100000,
        protocolTimeout: 100000,
        browserWSEndpoint: null,
        ignoreHTTPSErrors: true,
        defaultViewport: {
          width: 1280,
          height: 720
        },
        handleSIGINT: true,
        handleSIGTERM: true,
        handleSIGHUP: true
      },
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: './sessions'
      }),
      qrMaxRetries: 5,
      restartOnAuthFail: true,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 60000
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

    session.client.on('disconnected', async (reason) => {
      console.log(`Sesión ${sessionId} desconectada. Razón:`, reason);
      await closeSession(sessionId);
    });

    session.client.on('auth_failure', async (msg) => {
      console.log(`Fallo de autenticación en sesión ${sessionId}:`, msg);
      await closeSession(sessionId);
    });

    session.client.on('error', async (error) => {
      console.error(`Error en sesión ${sessionId}:`, error);
      if (error.message.includes('Protocol error') || error.message.includes('Target closed')) {
        await closeSession(sessionId);
        session.isInitializing = false;
      }
    });

    let retries = 3;
    while (retries > 0) {
      try {
        await session.client.initialize();
        break;
      } catch (error) {
        retries--;
        console.error(`Error al inicializar (intento ${3-retries}/3):`, error);
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    session.isInitializing = false;
    return session;
  } catch (error) {
    session.isInitializing = false;
    console.error(`Error al inicializar sesión ${sessionId}:`, error);
    throw error;
  }
}

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
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .qr-container { margin: 20px 0; }
          button { padding: 10px 20px; margin: 10px 0; }
        </style>
      </head>
      <body>
        <h1>Sesión: ${sessionName}</h1>
        <p>
          <strong>ID:</strong> ${sessionName}<br>
          <strong>Estado:</strong> <span id="status">${status}</span>
        </p>
        <div class="qr-container">
          ${session.qrCodeData ? 
            `<img src="${session.qrCodeData}" alt="QR Code" width="200"/>` : 
            '<p>Esperando QR...</p>'}
        </div>
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
            if(confirm('¿Está seguro de cerrar la sesión?')) {
              fetch("/sessions/" + sessionName + "?token=" + token, { 
                method: "DELETE" 
              })
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
    <li class="session-item">
      <strong>ID:</strong> ${session.id}<br>
      <strong>Estado:</strong> ${session.isClientReady ? 'Conectado' : (session.isInitializing ? 'Inicializando' : 'Desconectado')}
      <div class="qr-container">
        ${session.qrCodeData ? `<img src="${session.qrCodeData}" alt="QR Code" width="200"/>` : ''}
      </div>
      <div class="button-container">
        <button onclick="closeSession('${session.id}')">Cerrar Sesión</button>
        <button onclick="initializeSession('${session.id}')">Reinicializar Sesión</button>
      </div>
    </li>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Administración de Sesiones de WhatsApp</title>
      <script src="/socket.io/socket.io.js"></script>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .session-item { margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; }
        .qr-container { margin: 10px 0; }
        .button-container { margin-top: 10px; }
        button { padding: 8px 16px; margin-right: 10px; }
        #createSessionForm { margin-top: 20px; }
      </style>
    </head>
    <body>
      <h1>Sesiones de WhatsApp</h1>
      <ul id="sessionList" style="list-style: none; padding: 0;">
        ${sessionListHTML}
      </ul>
      <h2>Crear Nueva Sesión</h2>
      <form id="createSessionForm">
        <input type="text" id="sessionId" placeholder="ID de Sesión" required 
               style="padding: 8px; margin-right: 10px;" />
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
          try {
            const res = await fetch('/sessions?token=' + ACCESS_TOKEN, {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ id: sessionId })
            });
            const data = await res.json();
            alert(data.message);
            location.reload();
          } catch (error) {
            alert('Error al crear la sesión');
            console.error(error);
          }
        });

        async function closeSession(id) {
          if(confirm('¿Está seguro de cerrar la sesión?')) {
            try {
              const res = await fetch('/sessions/' + id + '?token=' + ACCESS_TOKEN, { 
                method: 'DELETE' 
              });
              const data = await res.json();
              if(data.message) {
                alert(data.message);
              } else if(data.error) {
                alert("Error: " + data.error);
              }
              location.reload();
            } catch (error) {
              alert('Error al cerrar la sesión');
              console.error(error);
            }
          }
        }

        async function initializeSession(id) {
          try {
            const res = await fetch('/sessions/' + id + '/initialize?token=' + ACCESS_TOKEN, { 
              method: 'PUT' 
            });
            const data = await res.json();
            alert(data.message);
            location.reload();
          } catch (error) {
            alert('Error al inicializar la sesión');
            console.error(error);
          }
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