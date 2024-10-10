const express = require('express');
const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs').promises;
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const PQueue = require('p-queue');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

let client;
let qrCodeData = null;
let isClientReady = false;
let isInitializing = false;

const queue = new PQueue.default({ concurrency: 3 });

app.use(express.static('public'));

app.get('/', (_, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/initialize', async (req, res) => {
    if (isInitializing || isClientReady) {
        await closeWhatsAppSession();
    }

    isInitializing = true;
    isClientReady = false;
    qrCodeData = null;

    try {
        await fs.unlink('./session.json').catch(() => {});

        client = new Client({
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu']
            },
            session: null
        });

        client.on('qr', async (qr) => {
            qrCodeData = await qrcode.toDataURL(qr);
            io.emit('qr', qrCodeData);
        });

        client.on('ready', () => {
            isClientReady = true;
            qrCodeData = null;
            io.emit('whatsapp_ready');
        });

        client.on('message_create', message => {
            if (message.body === '!ping') message.reply('pong');
        });

        await client.initialize();
        res.json({ message: 'Cliente de WhatsApp inicializado.' });
    } catch (error) {
        console.error('Error de inicialización:', error);
        res.status(500).json({ error: 'Error al inicializar el cliente de WhatsApp' });
    } finally {
        isInitializing = false;
    }
});

app.get('/close', async (req, res) => {
    await closeWhatsAppSession();
    res.json({ message: 'Sesión de WhatsApp cerrada.' });
});

async function closeWhatsAppSession() {
    if (client) {
        await client.destroy();
        client = null;
    }
    isClientReady = false;
    isInitializing = false;
    qrCodeData = null;
}

app.get('/send-message', async (req, res) => {
    const { phone, message } = req.query;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Se requieren los parámetros phone y message' });
    }

    if (!isClientReady) {
        return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo.' });
    }

    try {
        await queue.add(async () => {
            const chatId = `${phone}@c.us`;
            await client.sendMessage(chatId, message);
        });
        res.json({ success: true, message: 'Mensaje enviado con éxito' });
    } catch (error) {
        console.error('Error al enviar mensaje:', error);
        res.status(500).json({ error: 'Error al enviar el mensaje' });
    }
});

app.get('/send-message_media', async (req, res) => {
    const { phone, message, fileUrl } = req.query;

    if (!phone || !message || !fileUrl) {
        return res.status(400).json({ error: 'Se requieren los parámetros phone, message y fileUrl' });
    }

    if (!isClientReady) {
        return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo.' });
    }

    try {
        await queue.add(async () => {
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            const media = new MessageMedia(
                response.headers['content-type'],
                Buffer.from(response.data).toString('base64'),
                fileUrl.split('/').pop()
            );
            const chatId = `${phone}@c.us`;
            await client.sendMessage(chatId, message);
            await client.sendMessage(chatId, media);
        });
        res.json({ success: true, message: 'Mensaje y archivo multimedia enviados con éxito' });
    } catch (error) {
        console.error('Error al enviar mensaje multimedia:', error);
        res.status(500).json({ error: 'Error al enviar el mensaje multimedia' });
    }
});

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

server.listen(port, () => {
    console.log(`Servidor API corriendo en http://localhost:${port}`);
});