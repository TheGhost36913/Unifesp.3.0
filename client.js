document.addEventListener('DOMContentLoaded', () => {
    // Configuração automática para o Render (HTTPS/WSS)
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
    const toggleCameraButton = document.getElementById('toggleCamera');
    const messageInput = document.getElementById('messageInput');
    const sendMessageButton = document.getElementById('sendMessage');
    const messagesDiv = document.getElementById('messages');

    let localStream = null;
    let myUsername = '';
    let myRoom = '';
    let currentFacingMode = 'user'; // 'user' = frontal/selfie | 'environment' = traseira
    
    // Lista de conexões ativas
    const peerConnections = new Map();

    const rtcConfiguration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ],
        iceTransportPolicy: 'all',
        candidateReadyTimeout: 12000
    };

    // Ação ao Entrar na Sala
    joinRoomButton.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const roomName = roomInput.value.trim();

        if (!username || !roomName) {
            updateStatus('Por favor, indique o seu Nome e a Sala.', 'warning');
            return;
        }

        myUsername = username;
        myRoom = roomName;
        updateStatus('A aceder aos periféricos...', 'info');

        try {
            // Inicializa a câmera padrão (frontal no telemóvel)
            localStream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: currentFacingMode }, 
                audio: true 
            });
            
            userSetupSection.classList.add('hidden');
            liveSection.classList.remove('hidden');

            createLocalVideoBox();
            checkMultipleCameras(); // Verifica se o dispositivo possui mais de uma câmera (ex: telemóveis)

            socket.emit('join_room', { username: myUsername, roomName: myRoom });
            printSystemMessage(`Conectado à sala: ${myRoom}`, 'success');

        } catch (err) {
            console.error(err);
            updateStatus('Erro: Ative as permissões de áudio e vídeo no navegador.', 'error');
        }
    });

    // Mostra o botão de inverter câmara apenas se o aparelho tiver múltiplas câmaras
    async function checkMultipleCameras() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(device => device.kind === 'videoinput');
            if (videoDevices.length > 1) {
                toggleCameraButton.classList.remove('hidden');
            }
        } catch (e) {
            console.log("Não foi possível listar as câmeras:", e);
        }
    }

    // FUNÇÃO PARA ALTERNAR ENTRE CÂMERA FRONTAL E TRASEIRA
    toggleCameraButton.addEventListener('click', async () => {
        if (!localStream) return;

        // Alterna o estado
        currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';
        
        try {
            // Para a faixa de vídeo antiga antes de solicitar a nova
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) videoTrack.stop();

            // Solicita o novo fluxo de vídeo baseado no facingMode correto
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: currentFacingMode }
            });

            const newVideoTrack = newStream.getVideoTracks()[0];
            
            // Substitui a faixa no fluxo local para que você se veja com a nova câmera
            localStream.removeTrack(videoTrack);
            localStream.addTrack(newVideoTrack);

            const myVideoEl = document.querySelector('#myVideoBox video');
            if (myVideoEl) {
                myVideoEl.srcObject = localStream;
                // Efeito espelho apenas na câmera frontal (user)
                myVideoEl.style.transform = (currentFacingMode === 'user') ? 'scaleX(-1)' : 'none';
            }

            // ATUALIZA O VÍDEO PARA TODOS OS OUTROS PARTICIPANTES EM TEMPO REAL (RTCRtpSender)
            peerConnections.forEach((pc) => {
                const senders = pc.getSenders();
                const sender = senders.find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(newVideoTrack);
                }
            });

            printSystemMessage("Câmara alternada com sucesso.", "info");

        } catch (err) {
            console.error("Erro ao alternar câmera:", err);
            printSystemMessage("Falha ao alternar para a outra câmara.", "error");
        }
    });

    function createLocalVideoBox() {
        if(document.getElementById('myVideoBox')) return;

        const myBox = document.createElement('div');
        myBox.className = 'video-wrapper my-stream';
        myBox.id = 'myVideoBox';

        const label = document.createElement('h2');
        label.className = 'video-title';
        label.textContent = `${myUsername} (Você)`;

        const videoEl = document.createElement('video');
        videoEl.autoplay = true;
        videoEl.muted = true;
        videoEl.playsInline = true;
        videoEl.srcObject = localStream;
        videoEl.style.transform = 'scaleX(-1)'; // Espelhado por padrão (frontal)

        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'controls';

        const btnAudio = document.createElement('button');
        btnAudio.className = 'control-button';
        btnAudio.textContent = 'Mic ON';
        btnAudio.onclick = () => {
            const track = localStream.getAudioTracks()[0];
            track.enabled = !track.enabled;
            btnAudio.textContent = track.enabled ? 'Mic ON' : 'Mic OFF';
            btnAudio.style.background = track.enabled ? 'rgba(0, 0, 0, 0.65)' : '#eb445a';
        };

        const btnVideo = document.createElement('button');
        btnVideo.className = 'control-button';
        btnVideo.textContent = 'Cam ON';
        btnVideo.onclick = () => {
            const track = localStream.getVideoTracks()[0];
            track.enabled = !track.enabled;
            btnVideo.textContent = track.enabled ? 'Cam ON' : 'Cam OFF';
            btnVideo.style.background = track.enabled ? 'rgba(0, 0, 0, 0.65)' : '#eb445a';
        };

        controlsDiv.appendChild(btnAudio);
        controlsDiv.appendChild(btnVideo);
        
        myBox.appendChild(label);
        myBox.appendChild(videoEl);
        myBox.appendChild(controlsDiv);
        meetingGrid.appendChild(myBox);
    }

    // Inicialização da conexão estável e compassada
    function initPeerConnection(peerSocketId, peerUsername, isInitiator) {
        if (peerConnections.has(peerSocketId)) {
            return peerConnections.get(peerSocketId);
        }

        const pc = new RTCPeerConnection(rtcConfiguration);
        peerConnections.set(peerSocketId, pc);

        if (localStream) {
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        }

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
            meetingGrid.appendChild(remoteBox);
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

    // RESOLUÇÃO DE FLUXO SEGURO: Fila assíncrona para evitar congelamento de telas pretas
    async function processIncomingSignal(data) {
        const fromSocketId = data.from;
        let pc = peerConnections.get(fromSocketId);

        if (!pc) {
            pc = initPeerConnection(fromSocketId, data.username, false);
        }

        try {
            if (data.type === 'offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit('webrtc_signal', {
                    to: fromSocketId,
                    type: 'answer',
                    payload: answer
                });
            } else if (data.type === 'answer') {
                // Só aplica a resposta se houver uma descrição local pendente
                if (pc.signalingState === "have-local-offer") {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
                }
            } else if (data.type === 'candidate') {
                // Aguarda a descrição remota estar pronta antes de injetar o candidato ICE
                if (pc.remoteDescription && pc.remoteDescription.type) {
                    await pc.addIceCandidate(new RTCIceCandidate(data.payload));
                }
            }
        } catch (err) {
            console.error('Sincronização pendente resolvida automaticamente:', err);
        }
    }

    // Chamadas de Socket
    socket.on('current_room_users', (users) => {
        users.forEach((user, index) => {
            // Cria um pequeno atraso artificial (delay) para a entrada de múltiplos usuários simultâneos
            setTimeout(() => {
                printSystemMessage(`${user.username} sincronizando vídeo...`, 'info');
                initPeerConnection(user.socketId, user.username, true);
            }, index * 400); 
        });
    });

    socket.on('new_user_joined', (user) => {
        printSystemMessage(`${user.username} entrou na videoconferência.`, 'success');
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
