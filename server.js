const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const CHAT_LOG_FILE = "SC-history.json";
const paths = {}; // Store nested paths of categories and rooms

// Get host IP address
const hostIP = Object.values(os.networkInterfaces())
    .flat()
    .filter(iface => iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)[0] || '127.0.0.1';

app.use(express.json());

app.use((req, res, next) => {
    if (req.path.endsWith('.html')) {
        res.status(404).send(req.path + ' Not Found');
    } else {
        next();
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/control-panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'control-panel.html'));
});

// Load previous chat history
if (fs.existsSync(CHAT_LOG_FILE)) {
    try {
        let chatData = JSON.parse(fs.readFileSync(CHAT_LOG_FILE, "utf8"));
        Object.assign(rooms, chatData);
    } catch (err) {
        console.error("Error loading chat history:", err);
    }
}


// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substring(7);
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { path, username } = data;
            let room = getRoom(path);

            if (!room) {
                ws.close();
                return;
            }

            if (room.bannedIPs.includes(req.socket.remoteAddress)) {
                ws.close();
                return;
            }

            if (data.ping) {
                ws.isAlive = true;
                return
            }

            if (data.username) {
                room.clients.get(clientId).username = data.username;
            }

            room.clients.set(clientId, { ws, username: username || "Unknown" });

            console.log(`New client in path: ${path}, ID: ${clientId}`);

            // Send chat history to the new client
            ws.send(JSON.stringify({ history: getAnonymizedMessages(path) }));
            
            let date = new Date()
            if (data.text) {
                const msgData = {
                    username: room.settings.anonymous ? "ANONYMOUS" : username,
                    text: data.text,
                    timestamp: `${date.getFullYear()}.${date.getMonth()}.${date.getDate()} ${date.getHours()}:${date.getMinutes()}`
                };
                room.messages.push(msgData);
                broadcast(path, { history: getAnonymizedMessages(path) });
            } else if (data.filename && data.result) {
                const fileData = {
                    username: username,
                    filename: data.filename,
                    fileType: data.fileType,
                    result: data.result,
                    type: "file",
                    timestamp: `${date.getFullYear()}.${date.getMonth()}.${date.getDate()} ${date.getHours()}:${date.getMinutes()}`
                };
                room.messages.push(fileData);
                broadcast(path, { history: getAnonymizedMessages(path) });
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });
});

function getRoom(path) {
    let parts = path.split("/");
    let node = paths;
    for (let part of parts) {
        if (!node[part]) return null;
        node = node[part];
    }
    return node.__room || null;
}

function createPath(path) {
    let parts = path.split("/");
    let node = paths;
    for (let part of parts) {
        if (!node[part]) node[part] = {};
        node = node[part];
    }
    return node;
}

function getAnonymizedMessages(path) {
    let room = getRoom(path);
    return room ? room.messages.map(msg => ({
        ...msg,
        username: room.settings.anonymous ? "ANONYMOUS" : msg.username
    })) : [];
}

function broadcast(path, data) {
    let room = getRoom(path);
    room?.clients.forEach(({ ws }) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    });
}


// Restrict path management to admin (server IP)
function isAdmin(req) {
    return req.socket.remoteAddress.includes(hostIP);
}

// Get the structure of paths
app.get('/paths', (req, res) => {
    res.json(paths);
});

// Add a new category (Admin Only)
app.post('/add-category', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

    const { path } = req.body;
    createPath(path);
    res.json({ success: true, message: `Category ${path} added.` });
});

// Add a new chat room (Admin Only)
app.post('/add-room', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

    const { path } = req.body;
    let node = createPath(path);
    node.__room = { clients: new Map(), messages: [], settings: { anonymous: false }, bannedIPs: [] };

    res.json({ success: true, message: `Room ${path} added.` });
});


// **RESTORED API ROUTES BELOW**

// Get connected clients in a room
app.get('/clients/:path', (req, res) => {
    const path = req.params.path;
    let room = getRoom(path);
    res.json(room ? Array.from(room.clients, ([clientId, { ip, username }]) => ({ clientId, ip, username })) : []);
});

// Get chat logs from a room
app.get('/chat-logs/:path', (req, res) => {
    const path = req.params.path;
    let room = getRoom(path);
    res.json(room?.messages || []);
});

// Clear all messages in a room
app.post('/clear-messages/:path', (req, res) => {
    const path = req.params.path;
    let room = getRoom(path);
    if (room) {
        room.messages = [];
        broadcast(path, { clearMessages: true });
        res.json({ success: true, message: `Messages cleared for room ${path}` });
    } else {
        res.status(400).json({ success: false, message: 'Room not found' });
    }
});

// Ban a user from a room
app.post('/ban-client/:path', (req, res) => {
    const path = req.params.path;
    let room = getRoom(path);
    const { ip } = req.body;
    if (!ip || !room) return res.status(400).json({ success: false, message: 'Invalid room or IP' });

    room.bannedIPs.push(ip);
    room.clients.forEach(({ ws, ip: clientIP }, clientId) => {
        if (clientIP === ip) {
            ws.close();
            room.clients.delete(clientId);
        }
    });

    res.json({ success: true, message: `IP ${ip} has been banned from room ${path}` });
});

// Save chat history
app.post('/save-chat', (req, res) => {
    try {
        fs.writeFileSync(CHAT_LOG_FILE, JSON.stringify(paths, null, 2));
        res.json({ success: true, message: 'Chat saved!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to save chat.' });
    }
});

// Delete a specific message from a room
app.post('/delete-message/:path', (req, res) => {
    const path = req.params.path;
    let room = getRoom(path);
    const { index } = req.body;
    if (index >= 0 && index < room.messages.length) {
        room.messages.splice(index, 1);
        broadcast(path, { history: getAnonymizedMessages(path) });
        res.json({ success: true, message: 'Message deleted' });
    } else {
        res.status(400).json({ success: false, message: 'Invalid message index' });
    }
});

// Toggle anonymous mode
app.post('/anonymous/:path', (req, res) => {
    const path = req.params.path;
    let room = getRoom(path);
    room.settings.anonymous = req.body.anonymous === true;
    broadcast(path, { history: getAnonymizedMessages(path) });
    res.json({ success: true, message: `Anonymous mode is ${room.settings.anonymous}` });
});

// Kick a user from a room
app.post('/kick-client/:path', (req, res) => {
    const path = req.params.path;
    let room = getRoom(path);
    const { clientId } = req.body;
    if (room.clients.has(clientId)) {
        room.clients.get(clientId).ws.close();
        room.clients.delete(clientId);
        res.json({ success: true, message: `Client ${clientId} kicked.` });
    } else {
        res.status(404).json({ success: false, message: 'Client not found.' });
    }
});


server.listen(8080, () => {
    console.log(`Server running on http://${hostIP}:8080`);
});