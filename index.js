const express = require('express');
const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios'); // Asegúrate de tener axios instalado

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = 3000;

let client;
let qrCodeData = null;
let isClientReady = false;
let isInitializing = false;

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

app.get('/initialize', (req, res) => {
    console.log('Solicitud de inicialización recibida.');

    if (isInitializing || isClientReady) {
        console.log('Cerrando sesión anterior...');
        closeWhatsAppSession();
    }

    isInitializing = true;
    isClientReady = false;
    qrCodeData = null;

    if (fs.existsSync('./session.json')) {
        fs.unlinkSync('./session.json');
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

    client.initialize()
        .then(() => {
            console.log('Cliente de WhatsApp inicializado con éxito.');
        })
        .catch(err => {
            console.error('Error al inicializar el cliente de WhatsApp:', err);
        });

    res.json({ message: 'Inicializando cliente de WhatsApp...' });
});

app.get('/close', (req, res) => {
    closeWhatsAppSession();
    res.json({ message: 'Sesión de WhatsApp cerrada.' });
});

function closeWhatsAppSession() {
    if (client) {
        client.destroy();
        client = null;
    }
    isClientReady = false;
    isInitializing = false;
    qrCodeData = null;
    console.log('Sesión de WhatsApp cerrada.');
}

app.get('/send-message', async (req, res) => {
    const { phone, message } = req.query;

    if (!phone || !message) {
        console.error('Error: Se requieren los parámetros phone y message');
        return res.status(400).json({ error: 'Se requieren los parámetros phone y message' });
    }

    if (!isClientReady) {
        console.log('Cliente de WhatsApp aún no está listo.');
        return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo. Por favor, espera.' });
    }

    try {
        const chatId = `${phone}@c.us`;
        const response = await client.sendMessage(chatId, message);
        console.log('Mensaje enviado:', response);
        res.json({ success: true, message: 'Mensaje enviado con éxito' });
    } catch (err) {
        console.error('Error al enviar mensaje:', err);
        res.status(500).json({ error: 'Error al enviar el mensaje' });
    }
});

// Nueva ruta para enviar mensajes multimedia
app.get('/send-message_media', async (req, res) => {
    const { phone, message, fileUrl } = req.query;

    if (!phone || !message || !fileUrl) {
        console.error('Error: Se requieren los parámetros phone, message y fileUrl');
        return res.status(400).json({ error: 'Se requieren los parámetros phone, message y fileUrl' });
    }

    if (!isClientReady) {
        console.log('Cliente de WhatsApp aún no está listo.');
        return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo. Por favor, espera.' });
    }

    try {
        // Descargar el archivo multimedia desde la URL
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const fileBuffer = Buffer.from(response.data, 'binary');

        // Determinar el tipo MIME del archivo
        const mimeType = response.headers['content-type'];
        const fileName = fileUrl.split('/').pop(); // Extraer el nombre del archivo de la URL

        // Crear el objeto MessageMedia para el archivo
        const media = new MessageMedia(mimeType, fileBuffer.toString('base64'), fileName);

        const chatId = `${phone}@c.us`;

        // Enviar el mensaje de texto
        await client.sendMessage(chatId, message);
        // Enviar el archivo adjunto
        const sentMedia = await client.sendMessage(chatId, media);

        console.log('Mensaje y archivo multimedia enviados:', sentMedia);
        res.json({ success: true, message: 'Mensaje y archivo multimedia enviados con éxito' });
    } catch (err) {
        console.error('Error al enviar mensaje o archivo multimedia:', err);
        res.status(500).json({ error: 'Error al enviar el mensaje o el archivo multimedia' });
    }
});

server.listen(port, () => {
    console.log(`Servidor API corriendo en http://localhost:${port}`);
});
