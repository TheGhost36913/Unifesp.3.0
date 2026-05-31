const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '/')));

const rooms = new Map();
const userRoomRelation = new Map();

io.on('connection', (socket) => {
    console.log(`[RENDER] Cliente conectado: ${socket.id}`);

    socket.on('join_room', ({ username, roomName }) => {
        if (!username || !roomName) return;

        socket.username = username;
        socket.roomName = roomName;

        if (!rooms.has(roomName)) {
            rooms.set(roomName, []);
        }

        const currentUsers = rooms.get(roomName);
        
        if (!currentUsers.some(user => user.socketId === socket.id)) {
            currentUsers.push({ socketId: socket.id, username: username });
        }

        userRoomRelation.set(socket.id, roomName);
        socket.join(roomName);

        // 1. Envia para o utilizador atual a lista de quem JÁ ESTAVA na sala
        const existingPeers = currentUsers.filter(user => user.socketId !== socket.id);
        socket.emit('current_room_users', existingPeers);

        // 2. Avisa os utilizadores antigos que uma nova pessoa chegou
        socket.to(roomName).emit('new_user_joined', {
            socketId: socket.id,
            username: username
        });
    });

    // Repassador de Handshake WebRTC Direcionado
    socket.on('webrtc_signal', (data) => {
        if (!data.to) return;
        
        // Encaminha estritamente para o ID de destino (data.to) inserindo quem enviou (data.from = socket.id)
        io.to(data.to).emit('webrtc_signal', {
            from: socket.id,
            username: socket.username,
            type: data.type,
            payload: data.payload
        });
    });

    socket.on('send_chat_message', (text) => {
        const roomName = userRoomRelation.get(socket.id);
        if (roomName) {
            io.to(roomName).emit('receive_chat_message', {
                sender: socket.username,
                message: text
            });
        }
    });

    socket.on('disconnect', () => {
        const roomName = userRoomRelation.get(socket.id);
        if (roomName && rooms.has(roomName)) {
            let currentUsers = rooms.get(roomName);
            currentUsers = currentUsers.filter(user => user.socketId !== socket.id);
            
            if (currentUsers.length === 0) {
                rooms.delete(roomName);
            } else {
                rooms.set(roomName, currentUsers);
                // Notifica a sala para destruir o bloco de vídeo específico deste socket
                socket.to(roomName).emit('peer_left_room', socket.id);
            }
        }
        userRoomRelation.delete(socket.id);
        console.log(`[RENDER] Cliente desconectado: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`[SERVER] Ativo na porta ${PORT}`);
});
