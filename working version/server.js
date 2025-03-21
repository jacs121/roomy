const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const CHAT_LOG_FILE = "chat-history.json";

// Get host IP address
const hostIP = Object.values(os.networkInterfaces())
    .flat()
    .filter(iface => iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)[0] || '127.0.0.1';

// Store clients and chat history
const clients = new Map();
let messageHistory = [];

// Load previous chat history
if (fs.existsSync(CHAT_LOG_FILE)) {
    try {
        messageHistory = JSON.parse(fs.readFileSync(CHAT_LOG_FILE, "utf8"));
    } catch (err) {
        console.error("Error loading chat history:", err);
    }
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Restrict `manage.html` access to host only
app.get('/manage.html', (req, res) => {
    if (req.ip === hostIP) {
        res.sendFile(path.join(__dirname, 'manage.html'));
    } else {
        res.status(403).send('Forbidden: You are not authorized.');
    }
});

// **Handle WebSocket Connections**
wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substring(7);
    clients.set(clientId, { ws, ip: req.socket.remoteAddress, username: "Unknown" });

    console.log(`New client connected! ID: ${clientId}, IP: ${req.socket.remoteAddress}`);

    // Send chat history to new clients
    ws.send(JSON.stringify({ history: messageHistory }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.username) {
                clients.get(clientId).username = data.username;
            }

            if (data.text) {
                const msgData = { username: data.username, text: data.text, type: "text" };
                messageHistory.push(msgData);
                broadcast(msgData);
            } else if (data.filename && data.result) {
                const fileData = {
                    username: data.username,
                    filename: data.filename,
                    fileType: data.fileType,
                    result: data.result,  
                    type: "file"
                };
                messageHistory.push(fileData);
                broadcast(fileData);
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected: ${clientId}`);
        clients.delete(clientId);
    });
});

// **Broadcast to All Clients**
function broadcast(data) {
    clients.forEach(({ ws }) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    });
}

// **API to Get Connected Clients**
app.get('/clients', (req, res) => {
    res.json(Array.from(clients, ([clientId, { ip, username }]) => ({ clientId, ip, username })));
});

// **API to Get Chat Logs**
app.get('/chat-log', (req, res) => {
    res.json(messageHistory);
});

// **API to Save Chat History**
app.post('/save-chat', (req, res) => {
    try {
        fs.writeFileSync(CHAT_LOG_FILE, JSON.stringify(messageHistory, null, 2));
        res.json({ success: true, message: 'Chat history saved!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to save chat history.' });
    }
});

// **API to Clear Messages**
app.post('/clear-messages', (req, res) => {
    messageHistory = [];
    broadcast({ clearMessages: true });
    res.json({ success: true, message: 'Messages cleared' });
});

// **API to Kick a Client**
app.post('/kick-client', (req, res) => {
    const { clientId } = req.body;
    const client = clients.get(clientId);
    if (client) {
        client.ws.close();
        clients.delete(clientId);
        res.json({ success: true, message: `Client ${clientId} has been kicked.` });
    } else {
        res.status(404).json({ success: false, message: 'Client not found.' });
    }
});

// **API to Delete a Message and Update Clients**
app.post('/delete-message', (req, res) => {
    const { index } = req.body;
    if (index >= 0 && index < messageHistory.length) {
        messageHistory.splice(index, 1);
        broadcast({ history: messageHistory });
        res.json({ success: true, message: 'Message deleted' });
    } else {
        res.status(400).json({ success: false, message: 'Invalid message index' });
    }
});

// **Start the Server**
server.listen(8080, () => {
    console.log(`Server running on http://${hostIP}:8080`);
});
