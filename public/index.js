const express = require('express');
const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const asyncHandler = require('express-async-handler');
const { promisify } = require('util');
const PQueue = require('p-queue');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = 3000;

let client;
let qrCodeData = null;
let isClientReady = false;
let isInitializing = false;

// Cola de solicitudes con máximo 5 concurrentes
const queue = new PQueue.default({ concurrency: 5 });

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <script src="/socket.io/socket.io.js"></script>
        </head>
        <body>
            <h1>WhatsApp Web Authentication</h1>
            <div id="status"></div>
            <div id="qr-container"></div>
            <button id="init-button" onclick="initializeWhatsApp()">Iniciar WhatsApp</button>
            <button id="close-button" onclick="closeWhatsApp()" style="display:none;">Cerrar WhatsApp</button>
            <script>
                const socket = io();

                socket.on('whatsapp_ready', () => {
                    document.getElementById('status').innerHTML = '<h2>Cliente de WhatsApp está listo!</h2>';
                    document.getElementById('qr-container').innerHTML = '';
                    document.getElementById('init-button').style.display = 'none';
                    document.getElementById('close-button').style.display = 'inline';
                });

                socket.on('qr', (qrCode) => {
                    document.getElementById('status').innerHTML = '<h2>Escanea el código QR con tu WhatsApp para iniciar sesión</h2>';
                    document.getElementById('qr-container').innerHTML = '<img src="' + qrCode + '" alt="QR Code" />';
                });

                function initializeWhatsApp() {
                    fetch('/initialize')
                        .then(response => response.json())
                        .then(data => {
                            document.getElementById('status').innerHTML = data.message;
                        });
                }

                function closeWhatsApp() {
                    fetch('/close')
                        .then(response => response.json())
                        .then(data => {
                            document.getElementById('status').innerHTML = data.message;
                            document.getElementById('qr-container').innerHTML = '';
                            document.getElementById('init-button').style.display = 'inline';
                            document.getElementById('close-button').style.display = 'none';
                        });
                }
            </script>
        </body>
        </html>
    `);
});

app.get('/initialize', asyncHandler(async (req, res) => {
    console.log('Solicitud de inicialización recibida.');

    if (isInitializing || isClientReady) {
        console.log('Cerrando sesión anterior...');
        await closeWhatsAppSession();
    }

    isInitializing = true;
    isClientReady = false;
    qrCodeData = null;

    if (fs.existsSync('./session.json')) {
        await promisify(fs.unlink)('./session.json');
    }

    client = new Client({
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        },
        session: null
    });

    client.on('qr', async (qr) => {
        console.log('Nuevo código QR recibido');
        qrCodeData = await qrcode.toDataURL(qr);
        io.emit('qr', qrCodeData);
    });

    client.on('ready', () => {
        console.log('Cliente de WhatsApp está listo!');
        isClientReady = true;
        qrCodeData = null;
        io.emit('whatsapp_ready');
    });

    client.on('message_create', message => {
        console.log('Mensaje recibido:', message.body);
        if (message.body === '!ping') {
            message.reply('pong');
        }
    });

    client.on('error', (error) => {
        console.error('Error del cliente:', error);
    });

    await client.initialize();
    console.log('Cliente de WhatsApp inicializado con éxito.');

    res.json({ message: 'Cliente de WhatsApp inicializado.' });
}));

app.get('/close', asyncHandler(async (req, res) => {
    await closeWhatsAppSession();
    res.json({ message: 'Sesión de WhatsApp cerrada.' });
}));

async function closeWhatsAppSession() {
    if (client) {
        await client.destroy();
        client = null;
    }
    isClientReady = false;
    isInitializing = false;
    qrCodeData = null;
    console.log('Sesión de WhatsApp cerrada.');
}

app.get('/send-message', asyncHandler(async (req, res) => {
    const { phone, message } = req.query;

    if (!phone || !message) {
        throw new Error('Se requieren los parámetros phone y message');
    }

    if (!isClientReady) {
        throw new Error('El cliente de WhatsApp aún no está listo. Por favor, espera.');
    }

    await queue.add(async () => {
        const chatId = `${phone}@c.us`;
        const response = await client.sendMessage(chatId, message);
        console.log('Mensaje enviado:', response);
    });

    res.json({ success: true, message: 'Mensaje enviado con éxito' });
}));

app.get('/send-message_media', asyncHandler(async (req, res) => {
    const { phone, message, fileUrl } = req.query;

    if (!phone || !message || !fileUrl) {
        throw new Error('Se requieren los parámetros phone, message y fileUrl');
    }

    if (!isClientReady) {
        throw new Error('El cliente de WhatsApp aún no está listo. Por favor, espera.');
    }

    await queue.add(async () => {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const fileBuffer = Buffer.from(response.data, 'binary');
        const mimeType = response.headers['content-type'];
        const fileName = fileUrl.split('/').pop();
        const media = new MessageMedia(mimeType, fileBuffer.toString('base64'), fileName);
        const chatId = `${phone}@c.us`;

        await client.sendMessage(chatId, message);
        await client.sendMessage(chatId, media);
    });

    res.json({ success: true, message: 'Mensaje y archivo multimedia enviados con éxito' });
}));

app.get('/statusinstancias', (req, res) => {
    res.send(`
        <h1>Estado de la Instancia de WhatsApp</h1>
        <p>Estado: ${isClientReady ? 'Activa' : 'Inactiva'}</p>
        ${isClientReady ? '<button onclick="cerrarSesion()">Cerrar Sesión</button>' : ''}
        <script>
            function cerrarSesion() {
                fetch('/close')
                    .then(response => response.json())
                    .then(data => {
                        alert(data.message);
                        location.reload();
                    });
            }
        </script>
    `);
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: err.message });
});

server.listen(port, () => {
    console.log(`Servidor API corriendo en http://localhost:${port}`);
});