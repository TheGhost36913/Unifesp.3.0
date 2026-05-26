document.addEventListener('DOMContentLoaded', () => {
    // Conecta automaticamente ao host atual (importante para o Render)
    const socket = io({
        transports: ['websocket', 'polling'],
        upgrade: true
    });

    // Elementos DOM
    const localVideo = document.getElementById('localVideo');
    const remoteVideosContainer = document.getElementById('remoteVideosContainer');
    const usernameInput = document.getElementById('usernameInput');
    const roomInput = document.getElementById('roomInput');
    const joinRoomButton = document.getElementById('joinRoomButton');
    const userSetupSection = document.querySelector('.user-setup-section');
    const liveSection = document.querySelector('.live-section');
    const localUsernameSpan = document.getElementById('localUsername');
    const setupStatus = document.getElementById('setupStatus');
    const leaveCallButton = document.getElementById('leaveCallButton');
    const toggleAudioButton = document.getElementById('toggleAudio');
    const toggleVideoButton = document.getElementById('toggleVideo');
    const messageInput = document.getElementById('messageInput');
    const sendMessageButton = document.getElementById('sendMessage');
    const messagesDiv = document.getElementById('messages');

    let localStream = null;
    let myUsername = '';
    let myRoom = '';
    
    // Armazena todas as conexões WebRTC ativas: Map<socketId, RTCPeerConnection>
    const peerConnections = new Map();

    // Lista estendida de Servidores STUN públicos (Google) para quebrar firewalls simétricos no Render
    const rtcConfiguration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ]
    };

    // Fluxo de entrada na sala
    joinRoomButton.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const roomName = roomInput.value.trim();

        if (!username || !roomName) {
            updateStatus('Por favor, informe seu Nome e a Sala.', 'warning');
            return;
        }

        myUsername = username;
        myRoom = roomName;
        updateStatus('Solicitando acesso aos periféricos...', 'info');

        try {
            // Captura áudio e vídeo do usuário
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localVideo.srcObject = localStream;
            localUsernameSpan.textContent = myUsername;

            // Altera visibilidade da tela
            userSetupSection.classList.add('hidden');
            liveSection.classList.remove('hidden');

            // Dispara entrada oficial no Servidor hospedado no Render
            socket.emit('join_room', { username: myUsername, roomName: myRoom });
            printSystemMessage(`Conectado à sala: ${myRoom}`, 'success');

        } catch (err) {
            console.error(err);
            updateStatus('Falha ao obter permissão de Câmera/Microfone.', 'error');
        }
    });

    // Inicializa uma conexão WebRTC com um par específico da sala
    function initPeerConnection(peerSocketId, peerUsername, isInitiator) {
        const pc = new RTCPeerConnection(rtcConfiguration);
        peerConnections.set(peerSocketId, pc);

        // Injeta os canais locais (Áudio/Vídeo) na conexão criada
        if (localStream) {
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        }

        // Evento disparado quando o sinal de vídeo do outro usuário chega
        pc.ontrack = (event) => {
            if (document.getElementById(`video_${peerSocketId}`)) return;

            const videoBox = document.createElement('div');
            videoBox.className = 'video-wrapper';
            videoBox.id = `box_${peerSocketId}`;

            const label = document.createElement('h2');
            label.className = 'video-title';
            label.textContent = peerUsername;

            const videoEl = document.createElement('video');
            videoEl.id = `video_${peerSocketId}`;
            videoEl.autoplay = true;
            videoEl.playsInline = true;
            videoEl.srcObject = event.streams[0];

            videoBox.appendChild(label);
            videoBox.appendChild(videoEl);
            remoteVideosContainer.appendChild(videoBox);
        };

        // Envia candidatos de rede gerados para o par remoto
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc_signal', {
                    to: peerSocketId,
                    type: 'candidate',
                    payload: event.candidate
                });
            }
        };

        // Se você for o iniciador, cria a Oferta de SDP automaticamente
        if (isInitiator) {
            pc.onnegotiationneeded = async () => {
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    socket.emit('webrtc_signal', {
                        to: peerSocketId,
                        type: 'offer',
                        payload: offer
                    });
                } catch (e) {
                    console.error('Erro ao processar oferta:', e);
                }
            };
        }

        return pc;
    }

    // Processa os sinais WebRTC recebidos pelo servidor do Render
    async function processIncomingSignal(data) {
        let pc = peerConnections.get(data.from);

        if (!pc) {
            // Se a conexão não existe ainda, cria como receptor (isInitiator = false)
            pc = initPeerConnection(data.from, data.username, false);
        }

        try {
            if (data.type === 'offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit('webrtc_signal', {
                    to: data.from,
                    type: 'answer',
                    payload: answer
                });
            } else if (data.type === 'answer') {
                await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
            } else if (data.type === 'candidate') {
                if (pc.remoteDescription) {
                    await pc.addIceCandidate(new RTCIceCandidate(data.payload));
                }
            }
        } catch (err) {
            console.error('Falha no handshake SDP:', err);
        }
    }

    // --- Sincronização e Handshake via Socket.IO ---

    socket.on('current_room_users', (users) => {
        users.forEach(user => {
            printSystemMessage(`${user.username} já está presente na conferência.`, 'info');
            // Quem entra cria a conexão disparando ofertas (true)
            initPeerConnection(user.socketId, user.username, true);
        });
    });

    socket.on('new_user_joined', (user) => {
        printSystemMessage(`${user.username} entrou na sala de reunião.`, 'success');
        // Quem já estava apenas aceita a chamada criando o par passivo (false)
        initPeerConnection(user.socketId, user.username, false);
    });

    socket.on('webrtc_signal', (data) => {
        processIncomingSignal(data);
    });

    socket.on('peer_left_room', (socketId) => {
        const pc = peerConnections.get(socketId);
        if (pc) {
            pc.close();
            peerConnections.delete(socketId);
        }
        const box = document.getElementById(`box_${socketId}`);
        if (box) box.remove();
    });

    socket.on('receive_chat_message', (data) => {
        const CSSClass = data.sender === myUsername ? 'sent' : 'received';
        printSystemMessage(data.message, CSSClass, data.sender);
    });

    // --- Controles de Chat e UI ---

    sendMessageButton.addEventListener('click', () => {
        const text = messageInput.value.trim();
        if (text) {
            socket.emit('send_chat_message', text);
            messageInput.value = '';
        }
    });

    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessageButton.click();
    });

    leaveCallButton.addEventListener('click', () => {
        window.location.reload(); // Recarrega limpando todos os estados e fechando a conexão
    });

    toggleAudioButton.addEventListener('click', () => {
        if (localStream) {
            const track = localStream.getAudioTracks()[0];
            track.enabled = !track.enabled;
            toggleAudioButton.textContent = track.enabled ? 'Mic ON' : 'Mic OFF';
            toggleAudioButton.style.background = track.enabled ? '#007bff' : '#dc3545';
        }
    });

    toggleVideoButton.addEventListener('click', () => {
        if (localStream) {
            const track = localStream.getVideoTracks()[0];
            track.enabled = !track.enabled;
            toggleVideoButton.textContent = track.enabled ? 'Cam ON' : 'Cam OFF';
            toggleVideoButton.style.background = track.enabled ? '#007bff' : '#dc3545';
        }
    });

    function updateStatus(text, type) {
        setupStatus.textContent = text;
        setupStatus.className = `status-message ${type}`;
    }

    function printSystemMessage(msg, type = 'info', author = 'Sistema') {
        const p = document.createElement('p');
        p.textContent = `[${author}]: ${msg}`;
        p.className = type;
        messagesDiv.appendChild(p);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
});