document.addEventListener('DOMContentLoaded', () => {
    // Referências corretas aos elementos do seu DOM Original
    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');
    const usernameInput = document.getElementById('usernameInput');
    const joinLobbyButton = document.getElementById('joinLobbyButton');
    const userSetupSection = document.querySelector('.user-setup-section');
    const liveSection = document.querySelector('.live-section');
    const localUsernameSpan = document.getElementById('localUsername');
    const remoteUsernameSpan = document.getElementById('remoteUsername');
    const setupStatus = document.getElementById('setupStatus');

    const nextCallButton = document.getElementById('nextCallButton');
    const hangUpButton = document.getElementById('hangUpButton');
    const toggleAudioButton = document.getElementById('toggleAudio');
    const toggleVideoButton = document.getElementById('toggleVideo');
    const toggleCameraButton = document.getElementById('toggleCamera');
    const messageInput = document.getElementById('messageInput');
    const sendMessageButton = document.getElementById('sendMessage');
    const messagesDiv = document.getElementById('messages');

    // Variáveis de estado global originais e adaptadas
    let localStream; 
    let peerConnection; 
    let socket = io(); 
    let remotePeerId = null; 
    let currentUsername = '';
    let isAudioEnabled = true;
    let isVideoEnabled = true;
    let currentFacingMode = 'user'; // 'user' = frontal | 'environment' = traseira

    // Configuração WebRTC adaptada para funcionar na mesma rede Wi-Fi e externa
    const rtcConfiguration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ],
        iceTransportPolicy: 'all'
    };

    // Ação do Botão Original de Login
    joinLobbyButton.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        if (!username) {
            showSetupStatus('Por favor, digite um nome de usuário.', 'error');
            return;
        }

        currentUsername = username;
        showSetupStatus('Acessando câmera e microfone...', 'info');

        try {
            // Inicializa captura de mídia local
            localStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: currentFacingMode },
                audio: true
            });

            localVideo.srcObject = localStream;
            localUsernameSpan.textContent = currentUsername;

            // Transiciona a interface
            userSetupSection.classList.add('hidden');
            liveSection.classList.remove('hidden');

            // Ativa controles
            toggleAudioButton.disabled = false;
            toggleVideoButton.disabled = false;
            sendMessageButton.disabled = false;
            messageInput.disabled = false;

            // Comunica com o seu servidor NodeJS
            socket.emit('set_username', currentUsername);
            
            // Verifica se o aparelho possui múltiplas câmeras para exibir o botão de inverter
            checkMultipleCameras();

            // Inicia busca automática de par no Omegle
            startSearchForPeer();

        } catch (err) {
            console.error(err);
            showSetupStatus('Erro ao acessar mídia. Verifique as permissões.', 'error');
        }
    });

    // Detecta se existem duas ou mais câmeras (comum em celulares)
    async function checkMultipleCameras() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(device => device.kind === 'videoinput');
            if (videoDevices.length > 1) {
                toggleCameraButton.classList.remove('hidden');
            }
        } catch (e) {
            console.log("Incapaz de mapear múltiplas câmeras:", e);
        }
    }

    // FUNÇÃO REVOLUCIONÁRIA DE ALTERNAR CÂMERA EM TEMPO REAL
    toggleCameraButton.addEventListener('click', async () => {
        if (!localStream) return;

        currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';

        try {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) videoTrack.stop();

            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: currentFacingMode }
            });

            const newVideoTrack = newStream.getVideoTracks()[0];
            localStream.removeTrack(videoTrack);
            localStream.addTrack(newVideoTrack);

            localVideo.srcObject = localStream;
            // Ajusta o espelhamento: câmeras frontais devem ser espelhadas, traseiras não
            localVideo.style.transform = (currentFacingMode === 'user') ? 'scaleX(-1)' : 'none';

            // Se houver uma chamada ativa, substitui o vídeo enviado para o par instantaneamente
            if (peerConnection) {
                const senders = peerConnection.getSenders();
                const sender = senders.find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(newVideoTrack);
                }
            }

            addMessage('Câmara alternada com sucesso.', 'info');
        } catch (err) {
            console.error(err);
            addMessage('Falha ao inverter câmara.', 'error');
        }
    });

    function startSearchForPeer() {
        remotePeerId = null;
        remoteUsernameSpan.textContent = 'Procurando...';
        remoteVideo.srcObject = null;
        addMessage('Procurando por um par...', 'info');
        socket.emit('find_peer');
    }

    // Inicialização WebRTC Padrão do seu Projeto
    function initWebRTC(peerId, isInitiator) {
        peerConnection = new RTCPeerConnection(rtcConfiguration);

        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        peerConnection.ontrack = (event) => {
            if (remoteVideo.srcObject !== event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
            }
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc_signal', {
                    to: peerId,
                    type: 'candidate',
                    payload: event.candidate
                });
            }
        };

        if (isInitiator) {
            peerConnection.onnegotiationneeded = async () => {
                try {
                    const offer = await peerConnection.createOffer();
                    await peerConnection.setLocalDescription(offer);
                    socket.emit('webrtc_signal', {
                        to: peerId,
                        type: 'offer',
                        payload: offer
                    });
                } catch (err) {
                    console.error(err);
                }
            };
        }
    }

    // Sincronização de Sinais WebRTC
    socket.on('webrtc_signal', async (data) => {
        if (!peerConnection) return;

        try {
            if (data.type === 'offer') {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.payload));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit('webrtc_signal', {
                    to: data.from,
                    type: 'answer',
                    payload: answer
                });
            } else if (data.type === 'answer') {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.payload));
            } else if (data.type === 'candidate') {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.payload));
            }
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('peer_found', (data) => {
        remotePeerId = data.peerId;
        remoteUsernameSpan.textContent = data.username;
        addMessage(`Par encontrado: ${data.username}. Conectando...`, 'success');
        initWebRTC(remotePeerId, data.isInitiator);
    });

    // Envio e Recebimento de Chat
    sendMessageButton.addEventListener('click', () => {
        const message = messageInput.value.trim();
        if (!message) return;

        socket.emit('chat_message', { roomName: '', message: message });
        addMessage(message, 'sent', currentUsername);
        messageInput.value = '';
    });

    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessageButton.click();
    });

    socket.on('chat_message', (data) => {
        if (data.sender !== currentUsername) {
            addMessage(data.message, 'received', data.sender);
        }
    });

    socket.on('peer_disconnected', () => {
        addMessage('Seu par desconectou.', 'warning');
        endCall();
    });

    nextCallButton.addEventListener('click', () => {
        endCall();
        startSearchForPeer();
    });

    hangUpButton.addEventListener('click', () => {
        endCall();
        window.location.reload();
    });

    function endCall() {
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        remoteVideo.srcObject = null;
        remoteUsernameSpan.textContent = 'Ninguém conectado';
    }

    // Controles de mídias locais Mute/Unmute
    toggleAudioButton.addEventListener('click', () => {
        isAudioEnabled = !isAudioEnabled;
        localStream.getAudioTracks()[0].enabled = isAudioEnabled;
        toggleAudioButton.textContent = isAudioEnabled ? 'Mutar Mic' : 'Ativar Mic';
    });

    toggleVideoButton.addEventListener('click', () => {
        isVideoEnabled = !isVideoEnabled;
        localStream.getVideoTracks()[0].enabled = isVideoEnabled;
        toggleVideoButton.textContent = isVideoEnabled ? 'Desligar Cam' : 'Ligará Cam';
    });

    function showSetupStatus(text, type) {
        setupStatus.textContent = text;
        setupStatus.className = `status-message ${type}`;
    }

    function addMessage(msg, type, sender = 'Sistema') {
        const p = document.createElement('p');
        p.className = type;
        p.innerHTML = type === 'sent' || type === 'received' ? `<strong>${sender}:</strong> ${msg}` : msg;
        messagesDiv.appendChild(p);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
});
