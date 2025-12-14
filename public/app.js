let socket;
document.addEventListener('DOMContentLoaded', () => {
    console.log("✅ SISTEMA V5 - SINCRONIZADO");
    // --- AUTO-LOGIN CON COOKIES ---
    async function verificarSesion() {
        try {
            const res = await fetch('/api/session');
            if (res.ok) {
                const data = await res.json();
                console.log("🍪 Sesión restaurada:", data.user.username);
                enterLobby(data.user); // ¡Entra directo sin pedir clave!
            }
        } catch (e) {
            console.log("No hay sesión activa.");
        }
    }
    verificarSesion(); // Ejecutar inmediatamente

    try { 
        socket = io(); 

        // --- CORRECCIÓN: RECONEXIÓN AUTOMÁTICA ---
        // Esto arregla el problema de "salirse y volver"
        socket.on('connect', () => {
            console.log("🟢 Socket conectado/reconectado");
            // Si ya sabemos quién es el usuario (porque la sesión de cookie lo cargó),
            // nos registramos de inmediato para que el servidor nos devuelva a la partida.
            if (currentUser) {
                socket.emit('registrar_socket', currentUser);
            }
        });

    } catch (e) { console.error(e); }

    let currentUser = null;
    let currentRoomId = null;
    let maxBetAllowed = 0;
    let chatStorage = { anuncios: [], general: [], clash: [], clash_pics: [], clash_logs: [] };
    let lastDatePainted = { anuncios: null, general: null, clash: null, clash_pics: null, clash_logs: null };
    let resultadoSeleccionado = null;

    // REFERENCIAS DOM
    const authFlow = document.getElementById('auth-flow');
    const discordLobby = document.getElementById('discord-lobby');
    const loginForm = document.getElementById('login-form');
    const registroForm = document.getElementById('registro-form');
    const loginContainer = document.getElementById('login-container');
    const registroContainer = document.getElementById('registro-container');
    const linkToLogin = document.getElementById('ir-a-login');
    const linkToRegister = document.getElementById('ir-a-registro');
    const userNameDisplay = document.getElementById('user-name-display');
    const userBalanceDisplay = document.getElementById('user-balance');
    const btnOpenDeposit = document.getElementById('btn-open-deposit');
    const btnAdminPanel = document.getElementById('btn-admin-panel');
    const btnLogout = document.getElementById('btn-logout');
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const sidebar = document.getElementById('sidebar');
    const mobileOverlay = document.getElementById('mobile-overlay');
    const depositModal = document.getElementById('deposit-modal');
    const closeDepositModal = document.getElementById('close-deposit-modal');
    const btnManualDeposit = document.getElementById('btn-manual-deposit');
    const btnAutoDeposit = document.getElementById('btn-auto-deposit');
    const autoInput = document.getElementById('auto-amount-input');
    const feeDisplay = document.getElementById('fee-display');
    const totalDisplay = document.getElementById('total-pay-display');
    const costBreakdown = document.getElementById('cost-breakdown');
    const adminPanelOverlay = document.getElementById('admin-panel-overlay');
    const btnBuscar = document.getElementById('btn-buscar-partida');
    const btnCancelMatch = document.getElementById('btn-cancel-match');
    const btnStartGame = document.getElementById('btn-start-game');
    const inputGameMode = document.getElementById('input-game-mode');
    const inputBetAmount = document.getElementById('input-bet-amount');
    const validationMsg = document.getElementById('validation-msg');
    const maxBetInfo = document.getElementById('max-bet-info');
    const btnWin = document.getElementById('btn-win');
    const btnLose = document.getElementById('btn-lose');
    const btnConfirmResult = document.getElementById('btn-confirm-result');
    const resultText = document.getElementById('result-selection-text');
    const privateChatForm = document.getElementById('private-chat-form');
    const btnAdminStats = document.getElementById('btn-admin-stats'); 
    const adminStatsOverlay = document.getElementById('admin-stats-overlay');
    // RETIROS UI
    const btnOpenWithdraw = document.getElementById('btn-open-withdraw');
    const withdrawModal = document.getElementById('withdraw-modal');
    const closeWithdrawModal = document.getElementById('close-withdraw-modal');
    const btnSubmitWithdraw = document.getElementById('btn-submit-withdraw');

    // --- VISTAS (IDs CON GUION MEDIO) ---
    const views = {
        anuncios: document.getElementById('view-anuncios'),
        general: document.getElementById('view-general'),
        clash_chat: document.getElementById('view-clash-chat'),
        clash_logs: document.getElementById('view-clash-logs'),
        clash_pics: document.getElementById('view-clash-pics'),
        private: document.getElementById('view-private'),
        game_result: document.getElementById('view-game-result')
    };

    // --- LISTAS DE CHAT (IDs EXPLICITOS) ---
    const chatLists = {
        anuncios: document.getElementById('anuncios-messages-list'),
        general: document.getElementById('general-messages-list'),
        clash: document.getElementById('clash-messages-list'), // General Clash
        clash_pics: document.getElementById('pics-messages-list'), // Fotos
        clash_logs: document.getElementById('logs-messages-list') // Registro
    };

    const chatElements = {
        anuncios: { form: document.getElementById('anuncios-chat-form'), input: document.getElementById('anuncios-msg-input'), fileInput: document.getElementById('anuncios-file-input'), fileName: document.getElementById('anuncios-file-name') },
        general: { form: document.getElementById('general-chat-form'), input: document.getElementById('general-msg-input') },
        clash: { form: document.getElementById('clash-chat-form'), input: document.getElementById('clash-msg-input') },
        clash_pics: { form: document.getElementById('clash-pics-form'), input: document.getElementById('clash-file-input'), nameDisplay: document.getElementById('file-name-display') }
    };

    // --- FUNCIONES GLOBALES ---
    window.toggleDropdown = function(id) { const m=document.getElementById(id); if(m) m.classList.toggle('hidden'); };

    window.switchDepositTab = function(tab) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.deposit-section').forEach(s => s.classList.add('hidden'));
        if (tab === 'manual') {
            const btns = document.querySelectorAll('.tab-btn'); if(btns[0]) btns[0].classList.add('active');
            document.getElementById('tab-manual').classList.remove('hidden');
        } else {
            const btns = document.querySelectorAll('.tab-btn'); if(btns[1]) btns[1].classList.add('active');
            document.getElementById('tab-auto').classList.remove('hidden');
        }
    };

    window.cambiarCanal = function(vista, btn) {
        if (currentUser) {
            if (currentUser.estado === 'jugando_partida' && vista !== 'game_result') { alert("⛔ TERMINA EL PASO 1"); ejecutarCambioVista('game_result', null); return; }
            if (currentUser.estado === 'subiendo_evidencia' && vista !== 'clash_pics') { alert("⛔ TERMINA EL PASO 2"); ejecutarCambioVista('clash_pics', null); return; }
            if (currentUser.estado === 'partida_encontrada' && vista !== 'private') { if(!confirm("⚠️ ¿SALIR? Se cancelará.")) return; socket.emit('cancelar_match', { motivo: 'Salió del chat' }); return; }
        }
        ejecutarCambioVista(vista, btn);
    };

    function ejecutarCambioVista(vistaName, btn) {
        Object.values(views).forEach(v => { if(v) v.classList.add('hidden'); });

        // Mapeo directo
        let target = views[vistaName];
        if (target) target.classList.remove('hidden');

        if (btn) { document.querySelectorAll('.channel').forEach(c=>c.classList.remove('active')); btn.classList.add('active'); }
        if(window.innerWidth<=768) { if(sidebar) sidebar.classList.remove('open'); if(mobileOverlay) mobileOverlay.classList.remove('open'); }
    }

    // --- AUTH ---
    if(linkToLogin) linkToLogin.addEventListener('click', (e)=>{e.preventDefault(); registroContainer.classList.add('hidden'); loginContainer.classList.remove('hidden');});
    if(linkToRegister) linkToRegister.addEventListener('click', (e)=>{e.preventDefault(); loginContainer.classList.add('hidden'); registroContainer.classList.remove('hidden');});

    if(loginForm) loginForm.addEventListener('submit', async(e)=>{ e.preventDefault(); try{const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(loginForm)))}); const r=await res.json(); if(res.ok) { if(!r.user.tipo_suscripcion) r.user.tipo_suscripcion='free'; enterLobby(r.user); } else alert(r.error);}catch(e){} });
    if(registroForm) registroForm.addEventListener('submit', async(e)=>{ e.preventDefault(); try{const res=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(registroForm)))}); if(res.ok){alert('Creado');registroContainer.classList.add('hidden');loginContainer.classList.remove('hidden');}else alert('Error');}catch(e){} });

    function enterLobby(user) {
        currentUser = user;
        // --- NUEVO: AVISAR AL SOCKET QUIÉN SOY ---
        if (socket) socket.emit('registrar_socket', user);
        // Recuperamos el ID de la sala si venimos de un recarga
        if (user.sala_actual) {
            currentRoomId = user.sala_actual;
            console.log("Sala recuperada:", currentRoomId);
        }
        authFlow.classList.add('hidden'); discordLobby.classList.remove('hidden');
        if (user.tipo_suscripcion === 'admin') { userNameDisplay.innerHTML = `👑 ${user.username} <span style="font-size:0.7rem; color:#e94560;">(ADMIN)</span>`; 
        if(btnAdminStats) btnAdminStats.classList.remove('hidden');
        if(chatElements.anuncios.form) chatElements.anuncios.form.classList.remove('hidden'); if(btnAdminPanel) btnAdminPanel.classList.remove('hidden'); } else userNameDisplay.textContent = user.username;
        userBalanceDisplay.textContent = '$'+user.saldo;

        if (user.estado === 'subiendo_evidencia' || user.paso_juego === 2) { currentUser.estado = 'subiendo_evidencia'; currentUser.paso_juego = 2; actualizarEstadoVisual('subiendo_evidencia'); ejecutarCambioVista('clash_pics', null); }
        else if (user.estado === 'jugando_partida' || user.paso_juego === 1) { currentUser.estado = 'jugando_partida'; currentUser.paso_juego = 1; actualizarEstadoVisual('jugando_partida'); ejecutarCambioVista('game_result', null); }
             else if (user.estado === 'partida_encontrada') {
                 // NUEVO: Si entro y estoy en negociación, voy a la sala privada
                 currentUser.estado = 'partida_encontrada';
                 actualizarEstadoVisual('partida_encontrada');
                 ejecutarCambioVista('private', null);
                 // Nota: Los datos del rival llegarán por el socket 'restaurar_partida'
            } else { 
                 actualizarEstadoVisual('normal'); 
            }

        ['anuncios', 'general', 'clash', 'clash_pics', 'clash_logs'].forEach(renderizarChat);
    }

    function actualizarEstadoVisual(estado) {
        if (currentUser) currentUser.estado = estado;

        const badge = document.getElementById('user-status-badge');
        const text = document.getElementById('status-text');

        // CONTROL DEL FORMULARIO DE FOTOS (CLASH PICS)
        const picsForm = document.getElementById('clash-pics-form');
        // Mensaje opcional para espectadores
        const picsContainer = document.getElementById('view-clash_pics'); 

        if (picsForm) {
            // ¿Tiene permiso? (Es Admin O está en el Paso 2)
            const tienePermiso = (estado === 'subiendo_evidencia') || (currentUser && currentUser.tipo_suscripcion === 'admin');

            if (tienePermiso) {
                picsForm.classList.remove('hidden'); // Mostrar botón de enviar
            } else {
                picsForm.classList.add('hidden'); // Ocultar botón de enviar
            }
        }

        // CONTROL DE ETIQUETAS Y BOTÓN JUGAR (Igual que antes)
        if(badge && text) {
            badge.className = 'status-indicator';
            switch(estado) {
                case 'normal': 
                    badge.classList.add('status-normal'); 
                    text.textContent="🟢 Libre"; 
                    if(btnBuscar){
                        btnBuscar.textContent="⚔️ JUGAR";
                        btnBuscar.disabled=false;
                        btnBuscar.classList.remove('btn-cancelar');
                        btnBuscar.style.opacity="1";
                        btnBuscar.style.cursor="pointer";
                    } 
                    break;
                case 'buscando_partida': 
                    badge.classList.add('status-buscando'); 
                    text.textContent="🔍 Buscando..."; 
                    if(btnBuscar){
                        btnBuscar.textContent="❌ CANCELAR";
                        btnBuscar.disabled=false;
                        btnBuscar.classList.add('btn-cancelar');
                        btnBuscar.style.opacity="1";
                        btnBuscar.style.cursor="pointer";
                    } 
                    break;
                case 'partida_encontrada': 
                    badge.classList.add('status-jugando'); 
                    text.textContent="⚠️ Encontrada"; 
                    if(btnBuscar){
                        btnBuscar.textContent="🚫 EN JUEGO";
                        btnBuscar.disabled=true;
                        btnBuscar.classList.remove('btn-cancelar');
                        btnBuscar.style.opacity="0.5";
                        btnBuscar.style.cursor="not-allowed";
                    } 
                    break;
                case 'jugando_partida': 
                    badge.classList.add('status-jugando'); 
                    text.textContent="🎮 Jugando (Paso 1)"; 
                    if(btnBuscar){
                        btnBuscar.textContent="🚫 JUGANDO";
                        btnBuscar.disabled=true;
                        btnBuscar.style.opacity="0.5";
                    } 
                    break;
                case 'subiendo_evidencia': 
                    badge.classList.add('status-jugando'); 
                    text.textContent="📸 Foto (Paso 2)"; 
                    if(btnBuscar){
                        btnBuscar.textContent="🚫 SUBIR FOTO";
                        btnBuscar.disabled=true;
                        btnBuscar.style.opacity="0.5";
                    } 
                    break;
                default: text.textContent=estado;
            }
        }
    }

    // --- PAGOS ---
    if(btnOpenDeposit) btnOpenDeposit.addEventListener('click', () => depositModal.classList.remove('hidden'));
    if(closeDepositModal) closeDepositModal.addEventListener('click', () => depositModal.classList.add('hidden'));
    if (autoInput) {
        autoInput.addEventListener('input', () => {
            const val = parseInt(autoInput.value);

            // Validación mínima
            if (!val || val < 5000) {
                costBreakdown.classList.add('hidden');
                btnAutoDeposit.disabled = true;
                btnAutoDeposit.textContent = "Pagar con Wompi";
                return;
            }

            // --- FÓRMULA DE COMISIÓN (TARIFA CARA) ---
            // Fórmula: ((Valor * 1.3) + 700) * 1.2
            const baseConMargen = val + 840;
            const totalPagar = Math.ceil(baseConMargen / 0.964);

            const comisionTotal = totalPagar - val;

            // Mostrar resultados con separadores de miles (ej: 10.000)
            feeDisplay.textContent = `+ $${comisionTotal.toLocaleString()}`;
            totalDisplay.textContent = `$${totalPagar.toLocaleString()}`;

            costBreakdown.classList.remove('hidden');

            btnAutoDeposit.disabled = false;
            btnAutoDeposit.textContent = `Pagar $${totalPagar.toLocaleString()} con Wompi (Simulado)`;
        });
    }
    if(btnManualDeposit) btnManualDeposit.addEventListener('click', async()=>{const m=document.getElementById('manual-amount').value;const r=document.getElementById('manual-ref').value;if(!m||!r)return alert("Datos?");const res=await fetch('/api/transaction/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:currentUser.id,username:currentUser.username,tipo:'deposito',metodo:'manual_nequi',monto:m,referencia:r})});const d=await res.json();alert(d.message);depositModal.classList.add('hidden');});
    if (btnAutoDeposit) {
        btnAutoDeposit.addEventListener('click', async () => {
            const monto = autoInput.value;
            if (!monto || !currentUser) return;

            btnAutoDeposit.disabled = true;
            btnAutoDeposit.textContent = "Cargando Wompi...";

            try {
                // 1. Pedir datos de transacción al servidor
                const res = await fetch('/api/wompi/init', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: currentUser.id,
                        username: currentUser.username,
                        montoBase: monto
                    })
                });

                const datos = await res.json();

                // 2. Configurar Widget
                const checkout = new WidgetCheckout({
                    currency: datos.moneda,
                    amountInCents: datos.montoCentavos,
                    reference: datos.referencia,
                    publicKey: datos.llavePublica,
                    signature: { integrity: datos.firma }, // ¡Seguridad!
                    redirectUrl: window.location.href, // Opcional: A dónde vuelve al terminar
                });

                // 3. Abrir Widget
                checkout.open(function (result) {
                    const transaction = result.transaction;
                    console.log('Transaction ID: ', transaction.id);
                    console.log('Transaction object: ', transaction);
                    // Aquí solo cerramos el modal, la confirmación real llega por Socket desde el Webhook
                    depositModal.classList.add('hidden');
                    btnAutoDeposit.disabled = false;
                    btnAutoDeposit.textContent = "Pagar con Wompi";
                });

            } catch (error) {
                console.error(error);
                alert("Error iniciando Wompi");
                btnAutoDeposit.disabled = false;
            }
        });
    }

    // --- LÓGICA DE RETIROS ---
    if (btnOpenWithdraw) btnOpenWithdraw.addEventListener('click', () => withdrawModal.classList.remove('hidden'));
    if (closeWithdrawModal) closeWithdrawModal.addEventListener('click', () => withdrawModal.classList.add('hidden'));

    if (btnSubmitWithdraw) {
        btnSubmitWithdraw.addEventListener('click', async () => {
            const monto = document.getElementById('withdraw-amount').value;
            const cuenta = document.getElementById('withdraw-account').value;
            const nombre = document.getElementById('withdraw-name').value;

            if (!monto || !cuenta || !nombre) return alert("Por favor completa todos los datos.");
            if (parseInt(monto) > currentUser.saldo) return alert("Saldo insuficiente.");

            const datosCuenta = `${cuenta} - ${nombre}`;

            const res = await fetch('/api/transaction/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    userId: currentUser.id, 
                    username: currentUser.username, 
                    monto: monto, 
                    datosCuenta: datosCuenta 
                })
            });

            const data = await res.json();
            if (data.success) {
                alert(data.message);
                userBalanceDisplay.textContent = '$' + data.newBalance;
                currentUser.saldo = data.newBalance;
                withdrawModal.classList.add('hidden');
            } else {
                alert("Error: " + data.error);
            }
        });
    }

    // --- ADMIN ---
    if(btnAdminPanel) btnAdminPanel.addEventListener('click', () => { adminPanelOverlay.classList.remove('hidden'); cargarTransaccionesAdmin(); });
    // --- ADMIN PANEL MEJORADO (COLORES) ---
    window.cargarTransaccionesAdmin = async () => { 
        const res=await fetch('/api/admin/transactions'); 
        const list=await res.json(); 
        const c=document.getElementById('admin-transactions-list'); 
        c.innerHTML=''; 

        if(list.length===0) c.innerHTML='<p style="text-align:center;color:#bbb">Nada pendiente.</p>'; 

        list.forEach(t => {
            const div = document.createElement('div');
            div.className = 'trans-item';

            // Definir color y tipo
            let colorMonto = t.tipo === 'retiro' ? '#ed4245' : '#43b581'; // Rojo si sale, Verde si entra
            let icono = t.tipo === 'retiro' ? '💸 RETIRO' : '💰 RECARGA';

            div.innerHTML = `
                <div class="trans-info">
                    <strong style="color:${colorMonto}">${icono}</strong><br>
                    Usuario: <strong>${t.usuario_nombre}</strong><br>
                    Monto: <span style="color:${colorMonto}; font-size:1.1em;">$${t.monto}</span>
                    <br><span style="font-size:0.8em; color:#bbb;">${t.referencia}</span>
                </div>
                <div class="trans-actions">
                    <button class="btn-approve" onclick="procesarTransaccionAdmin(${t.id},'approve')">✅</button>
                    <button class="btn-reject" onclick="procesarTransaccionAdmin(${t.id},'reject')">❌</button>
                </div>
            `;
            c.appendChild(div);
        }); 
    };
    window.procesarTransaccionAdmin = async(id,act)=>{if(!confirm(`¿${act}?`))return;const res=await fetch('/api/admin/transaction/process',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transId:id,action:act})});const d=await res.json();alert(d.message);cargarTransaccionesAdmin();};
    // --- LÓGICA DISPUTAS ADMIN (CON CULPABLE) ---
    window.cargarDisputasAdmin = async () => {
        const res = await fetch('/api/admin/disputes');
        const list = await res.json();
        const c = document.getElementById('admin-disputes-list');
        c.innerHTML = ''; 
        if (list.length === 0) c.innerHTML = '<p style="color:#bbb">Sin disputas.</p>';

        list.forEach(m => {
            const div = document.createElement('div');
            div.className = 'trans-item';
            div.style.flexDirection = "column"; // Para que quepan los controles
            div.style.alignItems = "flex-start";

            div.innerHTML = `
                <div class="trans-info" style="width:100%; margin-bottom:10px;">
                    <strong>Partida #${m.id}</strong>: <span style="color:#4ecca3">${m.jugador1}</span> vs <span style="color:#ed4245">${m.jugador2}</span>
                    <br>Apuesta: $${m.apuesta}
                </div>

                <div style="width:100%; display:flex; gap:10px; align-items:center; margin-bottom:10px;">
                    <div style="flex:1">
                        <label style="font-size:0.7rem; color:#bbb">GANADOR (Recibe $):</label>
                        <select id="ganador-${m.id}" style="width:100%; padding:5px; background:#202225; color:white; border:1px solid #43b581;">
                            <option value="${m.jugador1}">${m.jugador1}</option>
                            <option value="${m.jugador2}">${m.jugador2}</option>
                        </select>
                    </div>
                    <div style="flex:1">
                        <label style="font-size:0.7rem; color:#bbb">CULPABLE (Falta):</label>
                        <select id="culpable-${m.id}" style="width:100%; padding:5px; background:#202225; color:white; border:1px solid #ed4245;">
                            <option value="nadie">-- Nadie --</option>
                            <option value="${m.jugador1}">${m.jugador1}</option>
                            <option value="${m.jugador2}">${m.jugador2}</option>
                        </select>
                    </div>
                </div>

                <button class="btn-approve" style="width:100%;" onclick="resolverDisputa(${m.id})">
                    ⚖️ DICTAR SENTENCIA
                </button>
            `;
            c.appendChild(div);
        });
    };

    window.resolverDisputa = async (id) => {
        // Obtener valores de los selectores por ID único
        const ganador = document.getElementById(`ganador-${id}`).value;
        const culpable = document.getElementById(`culpable-${id}`).value;

        if(!confirm(`SENTENCIA:\n\n🏆 Gana: ${ganador}\n💀 Culpable: ${culpable}\n\n¿Confirmar?`)) return;

        await fetch('/api/admin/resolve-dispute', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                matchId: id, 
                ganadorNombre: ganador,
                culpableNombre: culpable // <--- Dato Nuevo
            })
        });

        alert("Sentencia aplicada.");
        cargarDisputasAdmin();
    };

    // Modifica el botón de abrir panel para cargar ambas listas
    if(btnAdminPanel) btnAdminPanel.addEventListener('click', () => { 
        adminPanelOverlay.classList.remove('hidden'); 
        cargarTransaccionesAdmin(); 
        cargarDisputasAdmin(); // <--- NUEVO
    });
    // --- PANEL FINANCIERO ---
    if(btnAdminStats) btnAdminStats.addEventListener('click', () => { 
        adminStatsOverlay.classList.remove('hidden'); 
        cargarEstadisticasAdmin(); 
    });

    window.cargarEstadisticasAdmin = async () => {
        const res = await fetch('/api/admin/stats');
        const data = await res.json();

        // Llenar cuadros grandes
        document.getElementById('stat-users-money').textContent = '$' + data.totalUsuarios.toLocaleString();
        document.getElementById('stat-admin-money').textContent = '$' + data.totalGanancias.toLocaleString();

        // Llenar lista usuarios
        const lista = document.getElementById('admin-users-list');
        lista.innerHTML = '';

        data.listaUsuarios.forEach(u => {
            const div = document.createElement('div');
            div.className = 'user-card'; // Clase nueva del CSS

            const rol = u.tipo_suscripcion === 'admin' ? '👑' : '👤';

            // Construimos el HTML detallado
            div.innerHTML = `
                <div class="user-header-row">
                    <div class="user-basic">
                        <span style="font-size:1.1rem;">${rol} <strong>${u.username}</strong></span>
                        <br><span style="color:#bbb; font-size:0.8rem;">${u.email}</span>
                    </div>
                    <div class="user-financials">
                        <div style="color:#fff;">Saldo: <span style="color:#4ecca3;">$${u.saldo.toLocaleString()}</span></div>
                        <div style="font-size:0.8rem;">Generado: <span style="color:#faa61a;">+$${(u.ganancia_generada || 0).toLocaleString()}</span></div>
                    </div>
                </div>

                <div class="stats-grid">
                    <!-- FILA 1: GENERAL -->
                    <div class="stat-item"><span class="stat-label">PARTIDAS</span><span class="stat-val">${u.total_partidas || 0}</span></div>
                    <div class="stat-item"><span class="stat-label">VICTORIAS</span><span class="stat-val val-green">${u.total_victorias || 0}</span> <span style="font-size:0.6em">(${u.victorias_normales}/${u.victorias_disputa})</span></div>
                    <div class="stat-item"><span class="stat-label">DERROTAS</span><span class="stat-val val-red">${u.total_derrotas || 0}</span> <span style="font-size:0.6em">(${u.derrotas_normales}/${u.derrotas_disputa})</span></div>

                    <!-- FILA 2: COMPORTAMIENTO -->
                    <div class="stat-item"><span class="stat-label">FALTAS (JUEZ)</span><span class="stat-val val-red">${u.faltas || 0}</span></div>
                    <div class="stat-item"><span class="stat-label">HUIDAS TOTALES</span><span class="stat-val val-gold">${u.salidas_chat || 0}</span></div>
                    <div class="stat-item"><span class="stat-label">DETALLE HUIDAS</span><span class="stat-val" style="font-size:0.65em">X:${u.salidas_x} | Nav:${u.salidas_canal} | Desc:${u.salidas_desconexion}</span></div>
                </div>
            `;
            lista.appendChild(div);
        });
    };

    // --- RENDERIZADO CHAT ---
    function renderizarChat(canal) {
        const lista = chatLists[canal];
        if(!lista) return;
        lista.innerHTML = '';
        lastDatePainted[canal] = null;
        if(chatStorage[canal]) chatStorage[canal].forEach(msg => agregarBurbuja(msg, lista, canal));
    }
    // --- FUNCIÓN PARA DETECTAR LINKS ---
    function convertirLinks(texto) {
        // Busca cualquier cosa que empiece por http:// o https://
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        return texto.replace(urlRegex, function(url) {
            return `<a href="${url}" target="_blank" class="chat-link">${url}</a>`;
        });
    }
    function agregarBurbuja(data, contenedor, canal) {
        if(canal==='clash_logs'){const d=document.createElement('div');d.classList.add('log-msg');const f=new Date(data.fecha);d.innerHTML=`<span>${data.texto}</span><span class="log-time">${f.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>`;contenedor.appendChild(d);contenedor.scrollTop=contenedor.scrollHeight;return;}
        const fechaMsg=data.fecha?new Date(data.fecha):new Date();const diaMsg=fechaMsg.toDateString();
        if(diaMsg!==lastDatePainted[canal]){const sep=document.createElement('div');sep.classList.add('date-separator');sep.textContent=(diaMsg===new Date().toDateString())?"Hoy":fechaMsg.toLocaleDateString();contenedor.appendChild(sep);lastDatePainted[canal]=diaMsg;}
        const div=document.createElement('div');div.classList.add('msg');div.classList.add((currentUser&&data.usuario===currentUser.username)?'own':'other');
        let content='';if(data.tipo==='imagen')content=`<img src="${data.texto}" class="chat-image" onclick="window.open(this.src)">`;else if(data.tipo==='video')content=`<video src="${data.texto}" class="chat-video" controls></video>`;else {
            // AQUÍ ESTÁ EL CAMBIO: Usamos la función convertirLinks
            content = `<span class="msg-text">${convertirLinks(data.texto)}</span>`;
        }

        let userHtml=data.usuario;let styleName="";if(canal==='anuncios'){userHtml="📢 "+data.usuario;styleName="color:#e94560;font-weight:bold;";}
        const hora=data.fecha?new Date(data.fecha).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
        div.innerHTML=`<span class="msg-user" style="${styleName}">${userHtml}</span>${content}<span class="msg-time">${hora}</span>`;
        contenedor.appendChild(div);contenedor.scrollTop=contenedor.scrollHeight;

    }

    function setupChatForm(formId, inputId, canal) { const f=chatElements[canal].form; const i=chatElements[canal].input; if(f&&i){f.addEventListener('submit',(e)=>{e.preventDefault();if(i.value&&currentUser){socket.emit('mensaje_chat',{canal,usuario:currentUser.username,texto:i.value,tipo:'texto'});i.value='';}});}}
    setupChatForm(null, null, 'general'); setupChatForm(null, null, 'clash');

    const anuForm=chatElements.anuncios.form; if(anuForm){anuForm.addEventListener('submit',(e)=>{e.preventDefault();const i=chatElements.anuncios.input;const fi=chatElements.anuncios.fileInput;const f=fi.files[0];if(f&&currentUser){const r=new FileReader();r.onload=(ev)=>{const t=f.type.startsWith('video')?'video':'imagen';socket.emit('mensaje_chat',{canal:'anuncios',usuario:currentUser.username,texto:ev.target.result,tipo:t});i.value='';fi.value='';};r.readAsDataURL(f);}else if(i.value){socket.emit('mensaje_chat',{canal:'anuncios',usuario:currentUser.username,texto:i.value,tipo:'texto'});i.value='';}});}
    const picsUI=chatElements.clash_pics; if(picsUI.input) picsUI.input.addEventListener('change', function() { if(this.files[0]) { picsUI.nameDisplay.textContent=this.files[0].name; picsUI.nameDisplay.style.color="#4ecca3"; } }); if(picsUI.form) picsUI.form.addEventListener('submit', (e) => { e.preventDefault(); const file = picsUI.input.files[0]; if (file && currentUser) { const reader = new FileReader(); reader.onload = function(evt) { socket.emit('mensaje_chat', { canal: 'clash_pics', usuario: currentUser.username, texto: evt.target.result, tipo: 'imagen' }); picsUI.input.value = ''; picsUI.nameDisplay.textContent = 'Ninguna'; }; reader.readAsDataURL(file); } else alert("Selecciona foto."); });

    if(socket) {
        socket.on('historial_chat', (data) => { if (data.canal && chatStorage[data.canal]) { chatStorage[data.canal] = data.mensajes; if (currentUser) renderizarChat(data.canal); } });
        socket.on('mensaje_chat', (data) => { const canal = data.canal || 'general'; if (chatStorage[canal]) { chatStorage[canal].push(data); if (currentUser) agregarBurbuja(data, chatLists[canal], canal); } });
        socket.on('error_busqueda', (m) => { alert(m); actualizarEstadoVisual('normal'); });

        socket.on('partida_encontrada', (data) => {
            alert(`¡RIVAL ENCONTRADO!`);
            currentRoomId = data.salaId; 
            maxBetAllowed = data.maxApuesta;

            // Limpieza
            const privateMsgs = document.getElementById('private-messages');
            if (privateMsgs) privateMsgs.innerHTML = '';

            document.getElementById('max-bet-info').textContent = `Tope: $${maxBetAllowed.toLocaleString()}`;

            inputGameMode.value = ''; 
            inputBetAmount.value = ''; 
            inputGameMode.disabled = false; 
            inputBetAmount.disabled = false; 

            btnStartGame.textContent = "🎮 COMENZAR PARTIDA"; 
            btnStartGame.disabled = true; 
            btnStartGame.classList.remove('enabled'); 
            validationMsg.textContent = "";

            actualizarEstadoVisual('partida_encontrada'); 
            ejecutarCambioVista('private', null);

            // --- LÓGICA DE ESTADÍSTICAS RIVAL ---
            // 1. Identificar cuál objeto es el rival
            const soyP1 = (data.p1.username === currentUser.username);
            const rivalData = soyP1 ? data.p2 : data.p1;

            // 2. Calcular Win Rate (Evitar división por cero)
            let winRate = 0;
            if (rivalData.total_partidas > 0) {
                winRate = Math.round((rivalData.total_victorias / rivalData.total_partidas) * 100);
            }

            // 3. Calcular Huidas Totales
            const huidas = (rivalData.salidas_chat || 0); 

            // 4. Pintar en pantalla
            document.getElementById('rival-name').textContent = `VS ${rivalData.username}`;

            const statsBox = document.getElementById('rival-stats');
            if (statsBox) {
                // Colores dinámicos según qué tan buen jugador sea
                const colorWin = winRate >= 50 ? '#43b581' : '#ed4245';
                const colorFaltas = rivalData.faltas > 0 ? '#ed4245' : '#bbb';

                statsBox.innerHTML = `
                    <span style="color:${colorWin}" title="Win Rate">🏆 ${winRate}%</span>
                    <span style="color:${colorFaltas}" title="Culpable en Disputas">💀 ${rivalData.faltas || 0}</span>
                    <span title="Huidas">🏃 ${huidas}</span>
                `;
            }
        });

        socket.on('juego_iniciado', (data) => {
            currentUser.estado = 'jugando_partida';
            currentUser.paso_juego = 1;

            actualizarEstadoVisual('jugando_partida');
            ejecutarCambioVista('game_result', null);
            alert("¡JUEGO INICIADO! Buena suerte.");
        });
        //eventos de resultado
        socket.on('esperando_rival_resultado', (msg) => {
            alert(msg); // O simplemente dejar el botón en "Esperando..."
        });

        socket.on('error_disputa', (msg) => {
            alert("⛔ " + msg);
            // Restauramos botones para que intenten de nuevo si se equivocaron
            btnConfirmResult.textContent = "REINTENTAR CONFIRMACIÓN";
            btnConfirmResult.disabled = false;
            btnConfirmResult.style.background = "#ed4245"; // Rojo alerta
        });
        socket.on('necesita_evidencia', () => { currentUser.estado = 'subiendo_evidencia'; currentUser.paso_juego = 2; actualizarEstadoVisual('subiendo_evidencia'); ejecutarCambioVista('clash_pics', null); alert("PASO 2: Sube la foto."); btnWin.classList.remove('selected'); btnLose.classList.remove('selected'); btnConfirmResult.textContent = "CONFIRMAR Y SUBIR FOTO"; });
        socket.on('flujo_completado', () => { currentUser.estado = 'normal'; currentUser.paso_juego = 0; actualizarEstadoVisual('normal'); alert("✅ Listo."); ejecutarCambioVista('clash_chat', null); });
        socket.on('match_cancelado', (data) => { alert("⚠️ " + data.motivo); const pm=document.getElementById('private-messages'); if(pm)pm.innerHTML=''; actualizarEstadoVisual('normal'); ejecutarCambioVista('clash_chat', null); });
        socket.on('actualizar_negociacion', (data) => { inputGameMode.value = data.modo; inputBetAmount.value = data.dinero; validarNegociacion(); });
        socket.on('mensaje_privado', (data) => agregarBurbuja(data, document.getElementById('private-messages')));
        // --- NOTIFICACIÓN DE PAGOS (NEQUI) ---
        socket.on('transaccion_completada', (data) => {
            // Esto le saldrá solo al usuario que recargó
            alert(data.mensaje);
        });
    }


    // Game Interactions
    if(btnBuscar) btnBuscar.addEventListener('click', () => { if(!currentUser) return; if (currentUser.saldo < 5000) { alert("Saldo insuficiente"); return; } if (currentUser.estado === 'normal') { actualizarEstadoVisual('buscando_partida'); socket.emit('buscar_partida', currentUser); } else if (currentUser.estado === 'buscando_partida') { actualizarEstadoVisual('normal'); socket.emit('cancelar_busqueda'); } });
    if(btnCancelMatch) btnCancelMatch.addEventListener('click', () => { if(confirm("¿Cancelar?")) socket.emit('cancelar_match', { motivo: 'Oprimió X' }); });

    function validarNegociacion() { 
        // 1. Buscar elementos frescos (Para asegurar que no se pierdan)
        const elTexto = document.getElementById('win-text');
        const elInputModo = document.getElementById('input-game-mode');
        const elInputDinero = document.getElementById('input-bet-amount');

        if (!elInputModo || !elInputDinero) return; // Protección

        const modo = elInputModo.value.trim(); 
        const valorRaw = elInputDinero.value;
        const dinero = parseInt(valorRaw); 

        let error = ""; 

        // 2. Validaciones
        if (modo.length < 3) {} 
        else if (!valorRaw) {} // Si está vacío
        else if (isNaN(dinero)) {} 
        else if (dinero < 5000) { error = "Mínimo $5.000"; } 
        else if (dinero > 25000) { error = "Máximo $25.000"; } 
        else if (dinero > maxBetAllowed) { error = `Tope saldos: $${maxBetAllowed}`; } 

        // Mostrar error si existe
        const elMsg = document.getElementById('validation-msg');
        if (elMsg) elMsg.textContent = error; 

        // 3. CÁLCULO DE GANANCIA (Aquí estaba el problema)
        if (elTexto) {
            if (!isNaN(dinero) && dinero >= 5000) {
                // Hacemos la matemática explícita
                const totalMesa = dinero * 2;
                const comision = totalMesa * 0.20;
                const ganancia = totalMesa - comision;

                console.log(`Calculando: Apuesta ${dinero} -> Gana ${ganancia}`); // MIRA LA CONSOLA SI FALLA

                elTexto.textContent = `Si ganas recibes: $${ganancia}`;
                elTexto.style.color = "#4ecca3"; // Verde
            } else {
                elTexto.textContent = "Ganancia: $0";
                elTexto.style.color = "#bbb"; // Gris
            }
        }

        // 4. Activar botón
        if (btnStartGame) { 
            if (error === "" && modo.length >= 3 && !isNaN(dinero)) { 
                btnStartGame.disabled = false; 
                btnStartGame.classList.add('enabled'); 
            } else { 
                btnStartGame.disabled = true; 
                btnStartGame.classList.remove('enabled'); 
            } 
        } 
    }

    const enviarNegociacion = () => { validarNegociacion(); socket.emit('negociacion_live', { salaId: currentRoomId, modo: inputGameMode.value, dinero: inputBetAmount.value }); };
    if(inputGameMode) inputGameMode.addEventListener('input', enviarNegociacion); if(inputBetAmount) inputBetAmount.addEventListener('input', enviarNegociacion);

    // --- ACTUALIZACIÓN DE SALDO EN VIVO ---
    socket.on('actualizar_saldo', (nuevoSaldo) => {
        if (currentUser) currentUser.saldo = nuevoSaldo;
        if (userBalanceDisplay) userBalanceDisplay.textContent = '$' + nuevoSaldo;
    });

    // --- LÓGICA DOBLE CONFIRMACIÓN ---
    if (btnStartGame) {
        btnStartGame.addEventListener('click', () => {
            if (!currentUser) return;
            // Cambiar texto visualmente
            btnStartGame.textContent = "⏳ ESPERANDO AL RIVAL...";
            btnStartGame.disabled = true;
            btnStartGame.classList.remove('enabled');
            btnStartGame.style.backgroundColor = "#faa61a"; // Amarillo

            // Enviar voto
            socket.emit('iniciar_juego', { 
                dinero: inputBetAmount.value, 
                modo: inputGameMode.value 
            });
        });
    }

    // --- EVENTOS DE DOBLE CONFIRMACIÓN ---
    socket.on('esperando_inicio_rival', () => {
        if (btnStartGame) {
            btnStartGame.textContent = "⏳ ESPERANDO AL RIVAL...";
            btnStartGame.disabled = true;
            btnStartGame.style.backgroundColor = "#faa61a"; // Amarillo
            btnStartGame.classList.remove('enabled');
        }
    });

    socket.on('rival_listo_inicio', () => {
        // Si yo aún no he dado listo, me avisa
        if (btnStartGame && btnStartGame.textContent !== "⏳ ESPERANDO AL RIVAL...") {
            alert("¡Tu rival está listo! Dale a COMENZAR para iniciar.");
        }
    });

    socket.on('error_negociacion', (msg) => {
        alert("⛔ " + msg);
        // Resetear botones
        if (btnStartGame) {
            btnStartGame.textContent = "🎮 COMENZAR PARTIDA";
            btnStartGame.disabled = false;
            btnStartGame.classList.add('enabled');
            btnStartGame.style.backgroundColor = "#43b581";
        }
    });

    // --- MANEJO DE DESCONEXIÓN RIVAL ---

    socket.on('rival_desconectado', (data) => {
        // Mostramos alerta o cambiamos UI
        const statusBadge = document.getElementById('user-status-badge');
        if (statusBadge) {
            statusBadge.className = 'status-indicator status-buscando'; // Color amarillo
            document.getElementById('status-text').textContent = `⚠️ Rival desconectado (Esperando ${data.tiempo}s)`;
        }
        // Opcional: Bloquear botones
        if (btnConfirmResult) btnConfirmResult.disabled = true;
    });

    socket.on('rival_reconectado', (data) => {
        // Restauramos UI
        const rivalName = data && data.username ? data.username : 'Tu rival';
        console.log(`✅ ${rivalName} ha vuelto a la partida`);

        // Restaurar estado visual según el estado actual
        if (currentUser) {
            if (currentUser.estado === 'jugando_partida') actualizarEstadoVisual('jugando_partida');
            else if (currentUser.estado === 'subiendo_evidencia') actualizarEstadoVisual('subiendo_evidencia');
            else actualizarEstadoVisual('partida_encontrada');
        }

        // Desbloquear botones según el contexto
        if (btnStartGame && currentUser && currentUser.estado === 'partida_encontrada') {
            btnStartGame.disabled = false;
            btnStartGame.classList.add('enabled');
        }
        if (btnConfirmResult && !resultadoSeleccionado) btnConfirmResult.disabled = false;
    });

    // --- RESTAURACIÓN DE DATOS AL VOLVER (CORREGIDO) ---
    if(socket) {
        socket.on('restaurar_partida', (data) => {
            console.log("Restaurando datos de partida...", data);

            // 1. Recuperar variables críticas (Esto arregla el chat)
            currentRoomId = data.salaId; 
            maxBetAllowed = data.maxApuesta;

            // 2. Llenar datos visuales
            document.getElementById('max-bet-info').textContent = `Tope: $${maxBetAllowed.toLocaleString()}`;

            // Nombre del Rival
            const rivalObj = data.rival;
            document.getElementById('rival-name').textContent = `VS ${rivalObj.username}`;

            // 3. Calcular y Mostrar Estadísticas del Rival
            let winRate = 0;
            if (rivalObj.total_partidas > 0) {
                winRate = Math.round((rivalObj.total_victorias / rivalObj.total_partidas) * 100);
            }
            const huidas = (rivalObj.salidas_chat || 0);

            const statsBox = document.getElementById('rival-stats');
            if (statsBox) {
                const colorWin = winRate >= 50 ? '#43b581' : '#ed4245';
                const colorFaltas = rivalObj.faltas > 0 ? '#ed4245' : '#bbb';

                statsBox.innerHTML = `
                    <span style="color:${colorWin}" title="Win Rate">🏆 ${winRate}%</span>
                    <span style="color:${colorFaltas}" title="Culpable en Disputas">💀 ${rivalObj.faltas || 0}</span>
                    <span title="Huidas">🏃 ${huidas}</span>
                `;
            }

            // 4. Restaurar Estado de la UI
            // Si la partida ya inició, bloqueamos los inputs de apuesta
            if (data.iniciado) {
                inputGameMode.disabled = true;
                inputBetAmount.disabled = true;
                btnStartGame.textContent = "🎮 PARTIDA EN CURSO...";
                btnStartGame.disabled = true;
                btnStartGame.classList.remove('enabled');
            } else {
                // Si estamos negociando, desbloqueamos
                inputGameMode.disabled = false;
                inputBetAmount.disabled = false;
                btnStartGame.textContent = "🎮 COMENZAR PARTIDA";
                // (La validación normal se encargará de habilitarlo si hay datos)
            }

            // 5. Ir a la vista correcta
            actualizarEstadoVisual(data.estado);

            // Si estamos en negociación, forzamos la vista privada
            if (data.estado === 'partida_encontrada') {
                ejecutarCambioVista('private', null);
            }

            // Aviso suave (Toast o alert)
            // alert("🔄 Conexión recuperada. ¡Sigues en la partida!"); // Opcional, a veces molesta al recargar
            console.log("Conexión recuperada y chat reactivado.");
        });
    }

    if(btnWin && btnLose && btnConfirmResult) { 
        btnWin.addEventListener('click', () => { 
            resultadoSeleccionado = 'gane'; 
            btnWin.classList.add('selected'); 
            btnLose.classList.remove('selected'); 
            resultText.textContent = "VICTORIA 👑"; 
            btnConfirmResult.disabled = false; 
        }); 
        btnLose.addEventListener('click', () => { 
            resultadoSeleccionado = 'perdi'; 
            btnLose.classList.add('selected'); 
            btnWin.classList.remove('selected'); 
            resultText.textContent = "DERROTA 💀"; 
            btnConfirmResult.disabled = false; 
        }); 
        btnConfirmResult.addEventListener('click', () => { 
            if(resultadoSeleccionado) { 
                socket.emit('reportar_resultado', { resultado: resultadoSeleccionado, usuarioId: currentUser.id }); 
                btnConfirmResult.textContent = "⏳ Esperando al rival..."; 
                btnConfirmResult.disabled = true; 
                btnConfirmResult.style.background = "#faa61a";
            } 
        }); 
    }

    // --- CHAT PRIVADO ---
    if(privateChatForm) { 
        privateChatForm.addEventListener('submit', (e) => { 
            e.preventDefault(); 
            const input = document.getElementById('private-input'); 
            if(input.value && currentRoomId && currentUser) { 
                socket.emit('mensaje_privado', {
                    salaId: currentRoomId, 
                    usuario: currentUser.username, 
                    texto: input.value
                }); 
                input.value = ''; 
            } 
        }); 
    }

    // EXTRAS
    if(mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => { sidebar.classList.toggle('open'); mobileOverlay.classList.toggle('open'); });
    if(mobileOverlay) mobileOverlay.addEventListener('click', () => { sidebar.classList.remove('open'); mobileOverlay.classList.remove('open'); });
    if (btnLogout) btnLogout.addEventListener('click', async () => {
        await fetch('/api/logout', { method: 'POST' }); // Borra la cookie
        location.reload();
    });
    // --- ESCUDO CONTRA RECARGAS ACCIDENTALES ---
    window.addEventListener('beforeunload', (e) => {
        // Solo activamos el escudo si el usuario está en algo importante
        if (currentUser && currentUser.estado !== 'normal') {
            // Mensaje estándar (Los navegadores modernos ignoran el texto personalizado y ponen el suyo propio)
            e.preventDefault();
            e.returnValue = ''; 
            return '';
        }
        // Si está en estado 'normal' (Libre), dejamos que recargue sin molestar.
    });
    // --- WAKE LOCK (MANTENER PANTALLA ENCENDIDA) ---
    let wakeLock = null;

    async function activarPantalla() {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('💡 Pantalla mantenida encendida (Wake Lock activo)');
            }
        } catch (err) {
            console.error(`Error al activar Wake Lock: ${err.name}, ${err.message}`);
        }
    }

    // Intentar activar al entrar y al volver a la pestaña
    activarPantalla();

    document.addEventListener('visibilitychange', async () => {
        if (wakeLock !== null && document.visibilityState === 'visible') {
            await activarPantalla();
            socket.emit('registrar_socket', currentUser);
        }
    });
});

