const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configuração do Socket.IO otimizada para o proxy reverso do Render
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'] // Garante fallback se o WebSocket falhar no Render
});

// O Render define automaticamente a variável PORT
const PORT = process.env.PORT || 3000;

// Servir arquivos estáticos da pasta atual
app.use(express.static(path.join(__dirname, '/')));

// Estrutura de dados: Map<nomeDaSala, Array<{socketId, username}>>
const rooms = new Map();
// Mapeamento rápido: Map<socketId, nomeDaSala>
const userRoomRelation = new Map();

io.on('connection', (socket) => {
    console.log(`[RENDER-SERVER] Cliente conectado: ${socket.id}`);

    // Usuário solicita entrar em uma sala
    socket.on('join_room', ({ username, roomName }) => {
        if (!username || !roomName) return;

        socket.username = username;
        socket.roomName = roomName;

        // Cria a sala se não existir
        if (!rooms.has(roomName)) {
            rooms.set(roomName, []);
        }

        const currentUsers = rooms.get(roomName);
        
        // Evita duplicidade de socket no array
        if (!currentUsers.some(user => user.socketId === socket.id)) {
            currentUsers.push({ socketId: socket.id, username: username });
        }

        userRoomRelation.set(socket.id, roomName);
        socket.join(roomName);

        console.log(`[ROOM] ${username} entrou na sala: ${roomName} (Total: ${currentUsers.length})`);

        // Envia para o usuário atual a lista de quem JÁ ESTAVA na sala
        const existingPeers = currentUsers.filter(user => user.socketId !== socket.id);
        socket.emit('current_room_users', existingPeers);

        // Avisa os usuários antigos que um novo participante chegou
        socket.to(roomName).emit('new_user_joined', {
            socketId: socket.id,
            username: username
        });
    });

    // Troca de assinaturas WebRTC (Sinalização direta P2P)
    socket.on('webrtc_signal', (data) => {
        // Encaminha a oferta/resposta/candidate especificamente para o destino desejado
        io.to(data.to).emit('webrtc_signal', {
            from: socket.id,
            username: socket.username,
            type: data.type,
            payload: data.payload
        });
    });

    // Chat de texto unificado por sala
    socket.on('send_chat_message', (text) => {
        const roomName = userRoomRelation.get(socket.id);
        if (roomName) {
            io.to(roomName).emit('receive_chat_message', {
                sender: socket.username,
                message: text
            });
        }
    });

    // Desconexão voluntária ou fechamento de aba
    socket.on('disconnect', () => {
        handleUserDisconnection(socket);
    });
});

function handleUserDisconnection(socket) {
    const roomName = userRoomRelation.get(socket.id);
    if (roomName && rooms.has(roomName)) {
        let currentUsers = rooms.get(roomName);
        
        // Filtra removendo o usuário desconectado
        currentUsers = currentUsers.filter(user => user.socketId !== socket.id);
        
        if (currentUsers.length === 0) {
            rooms.delete(roomName);
            console.log(`[ROOM] Sala ${roomName} vazia. Deletada.`);
        } else {
            rooms.set(roomName, currentUsers);
            // Avisa os outros membros para destruírem o player de vídeo desse usuário
            socket.to(roomName).emit('peer_left_room', socket.id);
        }
    }
    userRoomRelation.delete(socket.id);
    console.log(`[RENDER-SERVER] Cliente desconectado: ${socket.id}`);
}

server.listen(PORT, () => {
    console.log(`[RENDER] Servidor ativo e operando na porta ${PORT}`);
});