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
let settings = {anonymous: false}
let bannedIPs = [];

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
    const clientIp = req.socket.remoteAddress;
    if (bannedIPs.includes(clientIp)) {
        ws.close();
        return;
    }

    const clientId = Math.random().toString(36).substring(7);
    clients.set(clientId, { ws, ip: clientIp, username: "Unknown" });

    console.log(`New client connected! ID: ${clientId}, IP: ${clientIp}`);

    // Send chat history to new clients
    ws.send(JSON.stringify({ history: getAnonymizedMessages() }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.username) {
                clients.get(clientId).username = data.username;
            }
            let date = new Date()

            if (data.text) {
                let msgData = { 
                    username: data.username, 
                    text: data.text, 
                    type: "text",
                    timestamp: `${date.getFullYear()}.${date.getMonth()}.${date.getDate()} ${date.getHours()}:${date.getMinutes()}`
                };
                messageHistory.push(msgData);
                if (settings.anonymous) {
                    msgData.username = "ANONYMOUS"
                }


                broadcast({history: getAnonymizedMessages()});
            } else if (data.filename && data.result) {
                let fileData = {
                    username: data.username,
                    filename: data.filename,
                    fileType: data.fileType,
                    result: data.result,  
                    type: "file",
                    timestamp: `${date.getFullYear()}.${date.getMonth()}.${date.getDate()} ${date.getHours()}:${date.getMinutes()}`
                };
                messageHistory.push(fileData);
                broadcast({history: getAnonymizedMessages()});
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

function getAnonymizedMessages() {
    return messageHistory.map(msg => ({
        ...msg,
        username: settings.anonymous ? "ANONYMOUS" : msg.username
    }));
}

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

app.post('/ban-client', (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ success: false, message: 'No IP provided' });
    
    bannedIPs.push(ip);
    clients.forEach(({ ws, ip: clientIP }, clientId) => {
        if (clientIP === ip) {
            ws.close();
            clients.delete(clientId);
        }
    });

    res.json({ success: true, message: `IP ${ip} has been banned.` });
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


// **API to turn on anonymous mode**
app.post('/anonymous', (req, res) => {
    settings.anonymous = req.body.anonymous === true; // Convert properly
    broadcast({ history: getAnonymizedMessages() });
    res.json({ success: true, message: `Anonymous mode is ${settings.anonymous}` });
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
        broadcast({history: getAnonymizedMessages()});
        res.json({ success: true, message: 'Message deleted' });
    } else {
        res.status(400).json({ success: false, message: 'Invalid message index' });
    }
});

// **Start the Server**
server.listen(8080, () => {
    console.log(`Server running on http://${hostIP}:8080`);
});
