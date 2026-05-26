document.addEventListener('DOMContentLoaded', () => {
    const socket = io({
        transports: ['websocket', 'polling'],
        upgrade: true
    });

    // Elementos do DOM
    const meetingGrid = document.getElementById('meetingGrid');
    const usernameInput = document.getElementById('usernameInput');
    const roomInput = document.getElementById('roomInput');
    const joinRoomButton = document.getElementById('joinRoomButton');
    const userSetupSection = document.querySelector('.user-setup-section');
    const liveSection = document.querySelector('.live-section');
    const setupStatus = document.getElementById('setupStatus');
    const leaveCallButton = document.getElementById('leaveCallButton');
    const messageInput = document.getElementById('messageInput');
    const sendMessageButton = document.getElementById('sendMessage');
    const messagesDiv = document.getElementById('messages');

    let localStream = null;
    let myUsername = '';
    let myRoom = '';
    
    const peerConnections = new Map();

    const rtcConfiguration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    };

    // Ação do Botão Entrar
    joinRoomButton.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const roomName = roomInput.value.trim();

        if (!username || !roomName) {
            updateStatus('Informe seu Nome e a Sala para prosseguir.', 'warning');
            return;
        }

        myUsername = username;
        myRoom = roomName;
        updateStatus('Configurando dispositivos...', 'info');

        try {
            // Captura o hardware local
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            
            // Transiciona a interface para o modo Reunião
            userSetupSection.classList.add('hidden');
            liveSection.classList.remove('hidden');

            // CRIA A SUA PRÓPRIA JANELA NO MOSAICO (Como no Google Meet)
            createLocalVideoBox();

            // Sincroniza a entrada com o Render
            socket.emit('join_room', { username: myUsername, roomName: myRoom });
            printSystemMessage(`Você se conectou à sala: ${myRoom}`, 'success');

        } catch (err) {
            console.error(err);
            updateStatus('Acesso à Câmera ou Microfone foi recusado.', 'error');
        }
    });

    // Função interna que monta o seu bloco de vídeo dentro do grid coletivo
    function createLocalVideoBox() {
        const myBox = document.createElement('div');
        myBox.className = 'video-wrapper my-stream';
        myBox.id = 'myVideoBox';

        const label = document.createElement('h2');
        label.className = 'video-title';
        label.textContent = `${myUsername} (Você)`;

        const videoEl = document.createElement('video');
        videoEl.autoplay = true;
        videoEl.muted = true; // Mutado para evitar eco nas suas próprias caixas de som
        videoEl.playsInline = true;
        videoEl.srcObject = localStream;

        // Cria botões de controle integrados à janela
        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'controls';

        const btnAudio = document.createElement('button');
        btnAudio.className = 'control-button';
        btnAudio.textContent = 'Mic ON';
        btnAudio.onclick = () => {
            const track = localStream.getAudioTracks()[0];
            track.enabled = !track.enabled;
            btnAudio.textContent = track.enabled ? 'Mic ON' : 'Mic OFF';
            btnAudio.style.background = track.enabled ? 'rgba(0, 0, 0, 0.6)' : '#eb445a';
        };

        const btnVideo = document.createElement('button');
        btnVideo.className = 'control-button';
        btnVideo.textContent = 'Cam ON';
        btnVideo.onclick = () => {
            const track = localStream.getVideoTracks()[0];
            track.enabled = !track.enabled;
            btnVideo.textContent = track.enabled ? 'Cam ON' : 'Cam OFF';
            btnVideo.style.background = track.enabled ? 'rgba(0, 0, 0, 0.6)' : '#eb445a';
        };

        controlsDiv.appendChild(btnAudio);
        controlsDiv.appendChild(btnVideo);
        
        myBox.appendChild(label);
        myBox.appendChild(videoEl);
        myBox.appendChild(controlsDiv);
        meetingGrid.appendChild(myBox);
    }

    // Inicializa a conexão de novos integrantes na sala mesh
    function initPeerConnection(peerSocketId, peerUsername, isInitiator) {
        const pc = new RTCPeerConnection(rtcConfiguration);
        peerConnections.set(peerSocketId, pc);

        if (localStream) {
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        }

        // Quando o sinal de vídeo de terceiros chega, cria uma pequena janela para ele no mosaico
        pc.ontrack = (event) => {
            if (document.getElementById(`box_${peerSocketId}`)) return;

            const remoteBox = document.createElement('div');
            remoteBox.className = 'video-wrapper';
            remoteBox.id = `box_${peerSocketId}`;

            const label = document.createElement('h2');
            label.className = 'video-title';
            label.textContent = peerUsername;

            const videoEl = document.createElement('video');
            videoEl.id = `video_${peerSocketId}`;
            videoEl.autoplay = true;
            videoEl.playsInline = true;
            videoEl.srcObject = event.streams[0];

            remoteBox.appendChild(label);
            remoteBox.appendChild(videoEl);
            meetingGrid.appendChild(remoteBox); // Adiciona no mesmo container compartilhado
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc_signal', {
                    to: peerSocketId,
                    type: 'candidate',
                    payload: event.candidate
                });
            }
        };

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
                    console.error(e);
                }
            };
        }

        return pc;
    }

    async function processIncomingSignal(data) {
        let pc = peerConnections.get(data.from);
        if (!pc) {
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
            console.error(err);
        }
    }

    // --- Sincronismo Socket.IO ---

    socket.on('current_room_users', (users) => {
        users.forEach(user => {
            printSystemMessage(`${user.username} está na reunião.`, 'info');
            initPeerConnection(user.socketId, user.username, true);
        });
    });

    socket.on('new_user_joined', (user) => {
        printSystemMessage(`${user.username} conectou à conferência.`, 'success');
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

    // --- Chat e Encerramento ---

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
        window.location.reload();
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
