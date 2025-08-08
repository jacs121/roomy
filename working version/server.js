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
const connectedUsers = {}
const glBannedIPs = []

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

// Restrict path management to admin (server IP)
function isAdmin(req) {
    console.log("admin request from:", req.socket.remoteAddress, req.socket.localAddress)
    return req.socket.remoteAddress+req.socket.localAddress === "::1::1"
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/control-panel', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    res.sendFile(path.join(__dirname, 'public', 'control-panel.html'));
});

// Load previous chat history
if (fs.existsSync(CHAT_LOG_FILE)) {
    try {
        let chatData = JSON.parse(fs.readFileSync(CHAT_LOG_FILE, "utf8"));
        Object.assign(paths, chatData.paths);
        Object.assign(glBannedIPs, chatData.glBannedIPs);
    } catch (err) {
        console.error("Error loading chat history:", err);
    }
}


// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substring(7);
    connectedUsers[clientId] = { ws, username: "Unknown", roomPath: "", ip: req.socket.remoteAddress};

    ws.on("close", () => {
        let room = getRoom(connectedUsers[clientId].roomPath)
        console.log("connection to client id: '"+clientId+"' closed")
        if (Object.keys(room.clients).includes(clientId)) {
            delete room.clients[clientId]
        };
        delete connectedUsers[clientId];
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === "ping") {
                ws.isAlive = true;
                return
            }

            const {path, username } = data;
            let room = getRoom(path);

            if (!room) {
                console.log("room not found")
                ws.close();
                return;
            }

            if (room.bannedIPs.includes(req.socket.remoteAddress) || glBannedIPs.includes(req.socket.remoteAddress)) {
                ws.close();
                return;
            }
            
            if (data.type === "join") {
                console.log(`New client in path: ${path}, ID: ${clientId}`);
                room.clients[clientId] = { ws, username: username };
                connectedUsers[clientId] = { ws, username: username, roomPath: path}
                // Send chat history and characterLimit to the new client
                ws.send(JSON.stringify({ type: "message", data: {history: getMessages(path)} }));
                console.log({value: room.settings.characterLimit})
                ws.send(JSON.stringify({ type: "characterLimit", data: {value: room.settings.characterLimit}}));
            }
            
            let date = new Date()
            if (data.type === "message") {
                const msgData = {
                    username: room.settings.anonymous ? "ANONYMOUS" : username,
                    text: data.text,
                    type: "text",
                    timestamp: `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()} ${date.getHours()}:${date.getMinutes()}`
                };
                room.messages.push(msgData);
                broadcast("message", path, { history: getMessages(path) });
            } else if (data.type === "file") {
                const fileData = {
                    username: username,
                    filename: data.filename,
                    fileType: data.fileType,
                    result: data.result,
                    type: "file",
                    timestamp: `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()} ${date.getHours()}:${date.getMinutes()}`
                };
                room.messages.push(fileData);
                broadcast("message", path, { history: getMessages(path) });
            } else if (data.type === "delete") {
                if (data.index >= 0 && data.index < room.messages.length && room.messages[data.index].username === room.clients[clientId].username) {
                    room.messages.splice(data.index, 1)
                    broadcast("clear", path, { history: getMessages(path) });
                }
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });
});

function getRoom(path) {
    let parts = path.split("/");
    let node = paths;

    for (let i = 0; i < parts.length; i++) {
        let part = parts[i];

        // If the part does not exist, create an empty object
        if (!node[part]) {
            node[part] = (i === parts.length - 1) 
                ? {_room_: { clients: new Map(), messages: [], settings: { anonymous: false, characterLimit: 100 }, bannedIPs: []}}
                : {}; // Intermediate objects
        }

        node = node[part]; // Move deeper into the object
    }

    return node["_room_"]
}

function createRoom(path) {
    let parts = path.split("/");
    let node = paths;

    for (let i = 0; i < parts.length; i++) {
        let part = parts[i];

        // If the part does not exist, create an empty object
        if (!node[part]) {
            node[part] = (i === parts.length - 1) 
                ? {_room_: { clients: new Map(), messages: [], settings: { anonymous: false, characterLimit: 100 }, bannedIPs: []}}
                : {}; // Intermediate objects
        }

        node = node[part]; // Move deeper into the object
    }
}



function getMessages(path) {
    let room = getRoom(path);
    return room ? room.messages.map(msg => ({
        ...msg,
        username: room.settings.anonymous ? "ANONYMOUS" : msg.username
    })) : [];
}

function broadcast(type, path, data) {
    let room = getRoom(path);
    console.log({type, data})
    Object.values(room?.clients).forEach(({ ws }) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({type, data}));
        }
    });
}

// Get the structure of paths
app.get('/paths', (req, res) => {
    res.json(paths);
});

// Add a new chat room (Admin Only)
app.post('/add-room', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

    const { path } = req.body;
    createRoom(path);

    res.json({ success: true, message: `Room ${path} added.` });
    broadcastAll("paths", paths)
});


// Get connected clients in a room
app.get('/clients/:path', (req, res) => {
    const path = req.params.path;
    let room = getRoom(path);
    if (!room || !room.clients) {
        res.json([])
    } else {
        if (isAdmin(req)) {
            let data = Array.from(Object.entries(room.clients)).map(([clientId, value]) => ({
                clientId: clientId,
                ws: value.ws,
                username: value.username
            }));
            res.json(Array.from(data));
        } else {
            let data = Array.from(Object.entries(room.clients)).map(([clientId, value]) => ({
                clientId: clientId,
                ws: null,
                username: value.username
            }));
            res.json(Array.from(data));
        }
    }
});

app.get('/chat-logs/:path', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    
    const path = req.params.path;
    let room = getRoom(path);
    if (!room || !room.messages || room.messages.length === 0) res.json([])
    else res.json(Array.from(room.messages)); // ✅ No need for JSON.stringify
});


// Clear all messages in a room
app.post('/clear-messages/:path', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const path = req.params.path;
    let room = getRoom(path);
    if (room) {
        room.messages = [];
        broadcast("clear", path, { clearMessages: true });
        res.json({ success: true, message: `Messages cleared for room ${path}` });
    } else {
        res.status(400).json({ success: false, message: 'Room not found' });
    }
});

// Ban a user from a room
app.post('/ban-client/:path', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const path = req.params.path;
    let room = getRoom(path);
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ success: false, message: 'Invalid IP' });

    room.BannedIPs.push(ip);
    connectedUsers.forEach((client, clientId) => {
        if (client.ip === ip) {
            client.ws.close();
        }
    });

    res.json({ success: true, message: `IP ${ip} has been banned from room ${path}` });
});

// Ban a user from a room
app.post('/gl-ban-client/', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ success: false, message: 'Invalid IP' });

    glBannedIPs.push(ip);
    connectedUsers.forEach((client, clientId) => {
        if (client.ip === ip) {
            client.ws.close();
        }
    });

    res.json({ success: true, message: `IP ${ip} has been banned from the server` });
});

// Save chat history
app.post('/save-chat', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    try {
        fs.writeFileSync(CHAT_LOG_FILE, JSON.stringify({paths: paths, glBannedIPs: glBannedIPs}, null, 2));
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
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    if (index >= 0 && index < room.messages.length) {
        room.messages.splice(index, 1)
        broadcast("clear", path, { history: getMessages(path) });
        res.json({ success: true, message: 'Message deleted' });
    } else {
        res.status(400).json({ success: false, message: 'Invalid message index' });
    }
});

// Toggle anonymous mode
app.post('/anonymous/:path', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const path = req.params.path;
    let room = getRoom(path);
    room.settings.anonymous = req.body.anonymous === true;
    broadcast("anonymous", path, { history: getMessages(path) });
    res.json({ success: true, message: `Anonymous mode is ${room.settings.anonymous}` });
});

// Toggle anonymous mode
app.post('/characterLimit/:path', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const path = req.params.path;
    let room = getRoom(path);
    room.settings.characterLimit = req.body.characterLimit;
    broadcast("characterLimit", path, { value: characterLimit });
    res.json({ success: true, message: `characterLimit mode is ${room.settings.characterLimit}` });
});

// Kick a user from a room
app.post('/kick-client/:path', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const path = req.params.path;
    let room = getRoom(path);
    const { clientId } = req.body;
    if (room.clients.has(clientId)) {
        room.clients.get(clientId).ws.close()
        res.json({ success: true, message: `Client ${clientId} kicked.` });
    } else {
        res.status(404).json({ success: false, message: 'Client not found.' });
    }
});

function broadcastAll(type, data) {
    Object.values(connectedUsers).forEach(({ ws }) => {
        console.log("sending...")
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type, data }));
        }
    });
}


server.listen(8080, () => {
    console.log(`Server running on http://${hostIP}:8080`);
});
