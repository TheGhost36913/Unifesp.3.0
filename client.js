document.addEventListener('DOMContentLoaded', () => {
    // Configuração automática para o Render (HTTPS/WSS)
    const socket = io({
        transports: ['websocket', 'polling'],
        upgrade: true
    });

    // Referências aos elementos do DOM
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
    
    // Mapa crítico para gerir conexões simultâneas separadas por ID de usuário
    const peerConnections = new Map();

    // Servidores públicos STUN da Google atualizados para quebra de NAT/Firewall
    const rtcConfiguration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ]
    };

    // Ação ao clicar para entrar na sala
    joinRoomButton.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const roomName = roomInput.value.trim();

        if (!username || !roomName) {
            updateStatus('Por favor, indique o seu Nome e a Sala.', 'warning');
            return;
        }

        myUsername = username;
        myRoom = roomName;
        updateStatus('A aceder à câmara e ao microfone...', 'info');

        try {
            // Captura áudio e vídeo do hardware local
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            
            // Muda a interface para o modo ativo de conferência
            userSetupSection.classList.add('hidden');
            liveSection.classList.remove('hidden');

            // Insere o seu próprio quadrado na grelha de mosaico
            createLocalVideoBox();

            // Notifica o servidor no Render para registar a sua entrada na sala
            socket.emit('join_room', { username: myUsername, roomName: myRoom });
            printSystemMessage(`Conectado à sala: ${myRoom}`, 'success');

        } catch (err) {
            console.error(err);
            updateStatus('Erro: Permissão de Câmara/Microfone recusada pelo navegador.', 'error');
        }
    });

    // Cria a sua própria janela de vídeo de forma dinâmica
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
        videoEl.muted = true; // Obrigatoriamente mutado para evitar eco e microfonia local
        videoEl.playsInline = true;
        videoEl.srcObject = localStream;

        // Painel de controlo integrado na janela
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

    // Inicializa uma linha de ligação WebRTC isolada para cada par
    function initPeerConnection(peerSocketId, peerUsername, isInitiator) {
        // Se já existir uma ligação ativa para este ID, reaproveita-a
        if (peerConnections.has(peerSocketId)) {
            return peerConnections.get(peerSocketId);
        }

        const pc = new RTCPeerConnection(rtcConfiguration);
        peerConnections.set(peerSocketId, pc);

        // Alimenta a ligação remota com as suas faixas de áudio e vídeo locais
        if (localStream) {
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        }

        // Evento disparado quando o fluxo de vídeo do utilizador remoto chega
        pc.ontrack = (event) => {
            // Evita duplicar a janela do mesmo utilizador na grelha
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
            videoEl.srcObject = event.streams[0]; // Associa o fluxo de vídeo recebido

            remoteBox.appendChild(label);
            remoteBox.appendChild(videoEl);
            meetingGrid.appendChild(remoteBox); // Adiciona dinamicamente lado a lado
        };

        // Escuta e encaminha os pacotes de rede (ICE) criados para o par destino correto
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc_signal', {
                    to: peerSocketId,
                    type: 'candidate',
                    payload: event.candidate
                });
            }
        };

        // Se você for o criador da chamada com este par, gera a oferta SDP imediatamente
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
                    console.error('Erro na criação da oferta SDP:', e);
                }
            };
        }

        return pc;
    }

    // Processa os dados de sinalização WebRTC direcionados a si
    async function processIncomingSignal(data) {
        const fromSocketId = data.from;
        let pc = peerConnections.get(fromSocketId);

        // Se a ligação ainda não existe para este ID, inicia uma como recetor
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
                await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
            } else if (data.type === 'candidate') {
                if (pc.remoteDescription) {
                    await pc.addIceCandidate(new RTCIceCandidate(data.payload));
                }
            }
        } catch (err) {
            console.error('Falha na sincronização de sinais WebRTC:', err);
        }
    }

    // --- Sincronização via Socket.IO Server ---

    // Disparado para quem ACABOU DE ENTRAR. Recebe a lista de todas as pessoas que já lá estão.
    socket.on('current_room_users', (users) => {
        users.forEach(user => {
            printSystemMessage(`${user.username} está presente na conferência.`, 'info');
            // Como acabou de entrar, você inicia o contacto (isInitiator = true)
            initPeerConnection(user.socketId, user.username, true);
        });
    });

    // Disparado para os utilizadores ANTIGOS avisando que um novo utilizador entrou.
    socket.on('new_user_joined', (user) => {
        printSystemMessage(`${user.username} entrou na videoconferência.`, 'success');
        // Como você já estava na sala, aguarda passivamente a oferta do recém-chegado (isInitiator = false)
        initPeerConnection(user.socketId, user.username, false);
    });

    // Repassa os pacotes SDP/ICE
    socket.on('webrtc_signal', (data) => {
        processIncomingSignal(data);
    });

    // Remove a janela de mosaico e encerra a ligação de quem fechou o separador ou saiu
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

    // --- Controlos de Texto e Fecho ---

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
