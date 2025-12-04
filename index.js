const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bcrypt = require('bcrypt');
const db = require('./db');
const app = express();
const server = http.createServer(app);
const cookieParser = require('cookie-parser');
const io = new Server(server, { maxHttpBufferSize: 2e8 });
const PORT = process.env.PORT || 5000;

const nodemailer = require('nodemailer');

// --- CONFIGURACIÓN DEL CORREO SEGURA ---
// Usamos process.env para leer las variables ocultas de Render
const transporter = nodemailer.createTransport({
    service: 'gmail', // Usamos el servicio predefinido para que él elija el mejor puerto
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS.replace(/\s/g, '') // TRUCO: Quitamos espacios automáticamente por si acaso
    },
    tls: {
        rejectUnauthorized: false // Permite conexiones aunque el certificado SSL del host sea raro
    }
});

function notificarAdmin(asunto, mensaje) {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
        console.log("⚠️ Sin credenciales de correo. Saltando.");
        return;
    }

    const mailOptions = {
        from: '"Torneos Flash Bot" <' + process.env.GMAIL_USER + '>',
        to: process.env.GMAIL_USER,
        subject: `🔔 ALERTA: ${asunto}`,
        text: mensaje
    };

    // Usamos una promesa desconectada para que no frene el resto del código
    transporter.sendMail(mailOptions).then(info => {
        console.log('📧 Correo enviado: ' + info.response);
    }).catch(error => {
        // Si falla, solo lo registramos en consola, PERO NO DETENEMOS NADA MÁS
        console.error('❌ Error enviando correo (Ignorado para no romper flujo):', error.message);
    });
}
app.use(express.json({ limit: '200mb' }));
app.use(express.static('public'));
app.use(cookieParser('secreto_super_seguro'));

let colaEsperaClash = []; 
let activeMatches = {}; 
// --- REPORTERO (LOGS) ---
function logClash(texto) {
    const fecha = new Date().toISOString();
    db.run(`INSERT INTO messages (canal, usuario, texto, tipo, fecha) VALUES (?, ?, ?, ?, ?)`, 
        ['clash_logs', 'SISTEMA', texto, 'log', fecha]);
    io.emit('mensaje_chat', { canal: 'clash_logs', usuario: 'SISTEMA', texto: texto, tipo: 'log', fecha: fecha });
}

// --- volverme admin ---
app.get('/secret-admin/:username', (req, res) => {
    const usuario = req.params.username;
    db.run(`UPDATE users SET tipo_suscripcion = 'admin' WHERE username = ?`, [usuario], function(err) {
        res.send(`<h1>¡Éxito! 👑</h1><p>El usuario <b>${usuario}</b> ahora es ADMIN.</p><p>Cierra sesión y vuelve a entrar.</p>`);
    });
});

// --- HERRAMIENTA ADMIN DE RESETEO (SIN LOG) ---
app.get('/admin-fix-status/:targetUser/:adminUser', (req, res) => {
    const target = req.params.targetUser;
    const admin = req.params.adminUser;

    // Verificar si quien ejecuta es admin
    db.get(`SELECT tipo_suscripcion FROM users WHERE username = ?`, [admin], (err, row) => {
        if (err || !row || row.tipo_suscripcion !== 'admin') {
            return res.send("<h1>⛔ ACCESO DENEGADO</h1>");
        }

        // Resetear al usuario objetivo
        db.run(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE username = ?`, [target], function(err) {
            if (err) return res.send("Error BD");
            if (this.changes === 0) return res.send("Usuario no encontrado");

            // NO HACEMOS LOG PÚBLICO AQUÍ
            res.send(`<h1>✅ CUENTA LIBERADA</h1><p>El usuario <b>${target}</b> ha sido reseteado.</p>`);
        });
    });
});

// --- RUTAS HTTP (Igual) ---
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const h = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, email, password) VALUES (?,?,?)`, [username, email, h], function(err) {
            if(err) return res.status(400).json({error:'Existe'});
            res.cookie('userId', this.lastID, { httpOnly: true, signed: true, maxAge: 86400000 });
            res.json({message:'Ok', userId:this.lastID});
        });
    } catch (e) { res.status(500).json({error:'Error'}); }
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if(!user || !await bcrypt.compare(password, user.password)) return res.status(400).json({error:'Error'});

        // CORRECCIÓN CRÍTICA:
        // Si está en 'partida_encontrada' (Negociando), NO LO BORRAMOS.
        // Dejamos que la lógica de 'registrar_socket' maneje la reconexión o el timeout.
        if (user.estado === 'buscando_partida') {
            db.run(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE id = ?`, [user.id]);
            user.estado = 'normal';
            user.paso_juego = 0;
            user.sala_actual = null;
        }
        res.cookie('userId', user.id, { httpOnly: true, signed: true, maxAge: 86400000 });
        res.json({
            message:'Ok', 
            user: {
                id: user.id, username: user.username, saldo: user.saldo, 
                tipo_suscripcion: user.tipo_suscripcion, estado: user.estado, 
                sala_actual: user.sala_actual, paso_juego: user.paso_juego
            }
        });
    });
});

// --- RUTA DE VERIFICACIÓN DE SESIÓN (COOKIES) ---
app.get('/api/session', (req, res) => {
    const userId = req.signedCookies.userId;
    if (!userId) return res.status(401).json({ error: 'No hay sesión' });

    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Usuario no encontrado' });

        // Limpieza: Si estaba solo "buscando", lo sacamos de la cola.
        // Si estaba en partida (encontrada o jugando), lo dejamos para que reconecte.
        if (user.estado === 'buscando_partida') {
            db.run(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE id = ?`, [user.id]);
            user.estado = 'normal';
            user.sala_actual = null;
            user.paso_juego = 0;
        }

        res.json({
            user: {
                id: user.id, username: user.username, saldo: user.saldo, 
                tipo_suscripcion: user.tipo_suscripcion, estado: user.estado, 
                sala_actual: user.sala_actual, paso_juego: user.paso_juego
            }
        });
    });
});

// Ruta para Cerrar Sesión
app.post('/api/logout', (req, res) => {
    res.clearCookie('userId');
    res.json({ message: 'Logout exitoso' });
});

app.post('/api/deposit', (req, res) => {
    const { userId, amount } = req.body;
    db.run(`UPDATE users SET saldo = saldo + ? WHERE id = ?`, [amount, userId], function(err) {
        db.get(`SELECT saldo FROM users WHERE id = ?`, [userId], (err, r) => res.json({newBalance:r.saldo}));
    });
});

// SOLICITUD DE RETIRO
// --- SOLICITUD DE RETIRO ---
app.post('/api/transaction/withdraw', (req, res) => {
    const { userId, username, monto, datosCuenta } = req.body;

    // 1. Verificar saldo suficiente
    db.get(`SELECT saldo FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err || !user) return res.status(500).json({error: 'Error usuario'});
        if (user.saldo < monto) return res.status(400).json({error: 'Saldo insuficiente'});

        // 2. Descontar saldo INMEDIATAMENTE (Congelar fondos)
        db.run(`UPDATE users SET saldo = saldo - ? WHERE id = ?`, [monto, userId], (err) => {
            if (err) return res.status(500).json({error: 'Error al descontar'});

            // 3. Crear transacción pendiente tipo 'retiro'
            db.run(`INSERT INTO transactions (usuario_id, usuario_nombre, tipo, metodo, monto, referencia, estado) VALUES (?,?,?,?,?,?, 'pendiente')`,
                [userId, username, 'retiro', 'nequi_retiro', monto, datosCuenta]);

            // --- NUEVO: NOTIFICAR CORREO ---
            notificarAdmin(
                "Solicitud de RETIRO", 
                `El usuario ${username} quiere retirar $${monto}. Datos: ${datosCuenta}.`
            );

            // 4. Responder con saldo actualizado
            db.get(`SELECT saldo FROM users WHERE id = ?`, [userId], (err, row) => {
                res.json({ success: true, message: 'Solicitud enviada. Saldo descontado temporalmente.', newBalance: row.saldo });
            });
        });
    });
});

// Transacciones
app.post('/api/transaction/create', (req, res) => {
    const { userId, username, tipo, metodo, monto, referencia } = req.body;
    if (metodo === 'auto_wompi') {
        const montoReal = parseInt(monto);
        // 1. Lo que le cobramos al usuario (Tarifa Cara)
        // Fórmula: ((Monto * 1.3) + 700) * 1.2
        const baseCara = montoReal + 840;
        const totalCobrado = Math.ceil(baseCara / 0.964);

        // 2. Lo que te cobra Wompi a ti (Costo Real Estimado)
        // Fórmula Estándar: ((Monto * 2.65%) + 700) * 1.19 (IVA sobre comisión)
        // Ajusta estos valores si tu contrato es diferente
        const costoBaseWompi = (totalCobrado * 0.0265) + 700;
        const costoRealTotal = Math.ceil(costoBaseWompi + (costoBaseWompi * 0.19));

        // 3. Tu Ganancia Real (Excedente)
        // Ganancia = Lo que pagó el usuario - (Lo que recibe el usuario + Lo que se lleva Wompi)
        const gananciaDueño = totalCobrado - (montoReal + costoRealTotal);

        db.run(`UPDATE users SET saldo = saldo + ? WHERE id = ?`, [monto, userId], (err) => {
            if (err) return res.status(500).json({error: 'Error BD'});


            db.run(`INSERT INTO transactions (usuario_id, usuario_nombre, tipo, metodo, monto, referencia, estado) VALUES (?,?,?,?,?,?, 'completado')`,
                [userId, username, tipo, metodo, monto, 'AUTO-'+Date.now()]);

            // GUARDAR SOLO LA GANANCIA NETA
            if (gananciaDueño > 0) {
                db.run(`INSERT INTO admin_wallet (monto, razon, detalle) VALUES (?, ?, ?)`, 
                    [gananciaDueño, 'excedente_recarga', `Recarga ${username} ($${monto})`]);
            }

            db.get(`SELECT saldo FROM users WHERE id = ?`, [userId], (err, row) => {
                res.json({ success: true, message: `¡Recarga de $${monto} exitosa!`, newBalance: row.saldo });
            });
        });
    } else {
        db.run(`INSERT INTO transactions (usuario_id, usuario_nombre, tipo, metodo, monto, referencia, estado) VALUES (?,?,?,?,?,?, 'pendiente')`, [userId, username, tipo, metodo, monto, referencia], (err) => res.json({ success: true, message: 'Solicitud enviada.' }));
        notificarAdmin(
            "Nueva Recarga Nequi Pendiente", 
            `El usuario ${username} dice que envió $${monto}. Referencia: ${referencia}. Entra al panel para aprobar.`
        );
    }
});
app.get('/api/admin/transactions', (req, res) => { db.all(`SELECT * FROM transactions WHERE estado = 'pendiente' ORDER BY id DESC`, [], (err, rows) => res.json(rows || [])); });
// 3. PROCESAR SOLICITUD (CON NOTIFICACIÓN AL CLIENTE)
// PROCESAR SOLICITUD (ACTUALIZADO PARA RETIROS)
app.post('/api/admin/transaction/process', (req, res) => {
    const { transId, action } = req.body; // action: 'approve' | 'reject'

    db.get(`SELECT * FROM transactions WHERE id = ?`, [transId], (err, trans) => {
        if (!trans || trans.estado !== 'pendiente') return res.status(400).json({error: 'No válida'});

        // Función auxiliar de notificación (Misma de antes)
        const notificarCliente = (uid, mensaje, nuevoSaldo = null) => {
            const allSockets = io.sockets.sockets;
            for (const [_, s] of allSockets) {
                if (s.userData && s.userData.id == uid) {
                    s.emit('transaccion_completada', { mensaje });
                    if (nuevoSaldo !== null) {
                        s.userData.saldo = nuevoSaldo;
                        s.emit('actualizar_saldo', nuevoSaldo);
                    }
                    break;
                }
            }
        };

        if (action === 'reject') {
            // RECHAZAR
            if (trans.tipo === 'retiro') {
                // SI ERA RETIRO, HAY QUE DEVOLVER LA PLATA
                db.run(`UPDATE users SET saldo = saldo + ? WHERE id = ?`, [trans.monto, trans.usuario_id], () => {
                    db.run(`UPDATE transactions SET estado = 'rechazado' WHERE id = ?`, [transId]);

                    // Notificar devolución
                    db.get(`SELECT saldo FROM users WHERE id = ?`, [trans.usuario_id], (e, u) => {
                        if(u) notificarCliente(trans.usuario_id, "❌ Retiro rechazado. Dinero devuelto.", u.saldo);
                    });
                    res.json({success: true, message: 'Rechazada y dinero devuelto'});
                });
            } else {
                // SI ERA DEPÓSITO, SOLO MARCAR RECHAZADO
                db.run(`UPDATE transactions SET estado = 'rechazado' WHERE id = ?`, [transId]);
                notificarCliente(trans.usuario_id, "❌ Recarga rechazada.");
                res.json({success: true, message: 'Recarga rechazada'});
            }

        } else if (action === 'approve') {
            // APROBAR
            if (trans.tipo === 'retiro') {
                // SI ES RETIRO, EL DINERO YA SE DESCONTÓ. SOLO MARCAMOS COMPLETADO.
                db.run(`UPDATE transactions SET estado = 'completado' WHERE id = ?`, [transId]);
                notificarCliente(trans.usuario_id, "✅ Tu retiro ha sido enviado.");
                res.json({success: true, message: 'Retiro marcado como enviado'});
            } else {
                // SI ES DEPÓSITO, SUMAMOS EL SALDO
                db.run(`UPDATE users SET saldo = saldo + ? WHERE id = ?`, [trans.monto, trans.usuario_id], () => {
                    db.run(`UPDATE transactions SET estado = 'completado' WHERE id = ?`, [transId]);
                    db.get(`SELECT saldo FROM users WHERE id = ?`, [trans.usuario_id], (e, u) => {
                        if(u) notificarCliente(trans.usuario_id, `✅ Recarga aprobada.`, u.saldo);
                    });
                    res.json({success: true, message: 'Recarga aprobada'});
                });
            }
        }
    });
});

// VER DISPUTAS
app.get('/api/admin/disputes', (req, res) => {
    db.all(`SELECT * FROM matches WHERE estado = 'disputa'`, [], (err, rows) => {
        res.json(rows || []);
    });
});

// RESOLVER DISPUTA (CON CULPABLE Y FALTAS)
app.post('/api/admin/resolve-dispute', (req, res) => {
    const { matchId, ganadorNombre, culpableNombre } = req.body;

    db.get(`SELECT * FROM matches WHERE id = ?`, [matchId], (err, match) => {
        if (!match) return res.json({error: 'No existe'});

        db.get(`SELECT id, saldo FROM users WHERE username = ?`, [ganadorNombre], (err, winner) => {
            if (!winner) return res.json({error: 'Usuario no encontrado'});

            const pozo = match.apuesta * 2;
            const comision = pozo * 0.20; 
            const premio = pozo - comision;

            // 1. Pagar al ganador
            db.run(`UPDATE users SET saldo = saldo + ? WHERE id = ?`, [premio, winner.id], () => {

                // --- ESTADÍSTICAS: GANADOR (Disputa) ---
                db.run(`UPDATE users SET total_victorias = total_victorias + 1, victorias_disputa = victorias_disputa + 1, total_partidas = total_partidas + 1 WHERE id = ?`, [winner.id]);

                // --- ESTADÍSTICAS: PERDEDOR (Disputa) ---
                // Buscamos al perdedor por nombre (el que no es winner)
                const perdedorNombre = (winner.username === match.jugador1) ? match.jugador2 : match.jugador1;
                db.run(`UPDATE users SET total_derrotas = total_derrotas + 1, derrotas_disputa = derrotas_disputa + 1, total_partidas = total_partidas + 1 WHERE username = ?`, [perdedorNombre]);
                // Notificación en vivo (Saldo)
                const allSockets = io.sockets.sockets;
                for (const [_, socket] of allSockets) {
                    if (socket.userData) {
                        if (socket.userData.id === winner.id) {
                            socket.userData.saldo += premio;
                            socket.emit('actualizar_saldo', socket.userData.saldo);
                        }
                        // Liberar a ambos
                        if (socket.userData.username === match.jugador1 || socket.userData.username === match.jugador2) {
                            socket.emit('flujo_completado');
                            socket.userData.estado = 'normal';
                        }
                    }
                }

                // 2. Contabilidad Admin
                // Dividimos la comisión para el LTV de ambos jugadores (Independiente del resultado)
                const utilidadPorJugador = comision / 2;
                db.run(`UPDATE users SET ganancia_generada = ganancia_generada + ? WHERE username IN (?, ?)`, 
                    [utilidadPorJugador, match.jugador1, match.jugador2]);

                // Guardar en Bóveda
                db.run(`INSERT INTO admin_wallet (monto, razon, detalle) VALUES (?, ?, ?)`, 
                    [comision, 'comision_disputa', `Resolución Match #${matchId}`]);

                // 3. CASTIGAR AL CULPABLE (Nuevo)
                if (culpableNombre && culpableNombre !== 'nadie') {
                    db.run(`UPDATE users SET faltas = faltas + 1 WHERE username = ?`, [culpableNombre], (err) => {
                        if (!err) console.log(`⚠️ Falta sumada a ${culpableNombre}`);
                    });
                }

                // 4. Cerrar Partida
                db.run(`UPDATE matches SET estado = 'finalizada', ganador = ? WHERE id = ?`, [ganadorNombre, matchId]);

                // 5. Liberar Estados BD
                db.run(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE username IN (?, ?)`, 
                    [match.jugador1, match.jugador2]);

                logClash(`👮‍♂️ JUEZ: Ganó ${ganadorNombre}. Culpable: ${culpableNombre}.`);
                res.json({success: true, message: 'Sentencia aplicada'});
            });
        });
    });
});

// --- ESTADÍSTICAS FINANCIERAS (NUEVO) ---
app.get('/api/admin/stats', (req, res) => {
    // 1. Total Dinero de Usuarios (Pasivo)
    db.get(`SELECT SUM(saldo) as total_usuarios FROM users WHERE tipo_suscripcion != 'admin'`, [], (err, rowUser) => {
        // 2. Total Dinero Ganado por la Casa (Activo)
        db.get(`SELECT SUM(monto) as total_admin FROM admin_wallet`, [], (err, rowAdmin) => {
            // 3. Lista de usuarios con TODAS las estadísticas
            db.all(`SELECT * FROM users ORDER BY ganancia_generada DESC`, [], (err, users) => {
                res.json({
                    totalUsuarios: rowUser.total_usuarios || 0,
                    totalGanancias: rowAdmin.total_admin || 0,
                    listaUsuarios: users
                });
            });
        });
    });
});

// --- SOCKETS ---

io.on('connection', (socket) => {
    // --- VINCULAR USUARIO Y RECONEXIÓN INTELIGENTE (CORREGIDO) ---
    socket.on('registrar_socket', (user) => {
        socket.userData = user;
        console.log(`🔗 Socket ${socket.id} intentando registrar a: ${user.username} (ID: ${user.id})`);

        // VERIFICAR SI ESTABA EN UNA SALA ACTIVA
        if (user.sala_actual && activeMatches[user.sala_actual]) {
            const salaId = user.sala_actual;
            const match = activeMatches[salaId];
            const userId = user.id;

            console.log(`   -> El usuario pertenece a la sala activa: ${salaId}`);

            // 1. CANCELAR TEMPORIZADOR (SALVAVIDAS)
            if (match.disconnectTimers && match.disconnectTimers[userId]) {
                console.log(`   -> ⏰ ¡Temporizador encontrado! Cancelando desconexión para ${user.username}...`);
                clearTimeout(match.disconnectTimers[userId]);
                delete match.disconnectTimers[userId];
            }

            // 2. RECONECTAR SOCKET A LA SALA
            socket.join(salaId);
            socket.currentRoom = salaId;

            // Actualizar la referencia del socket en la partida (CRÍTICO)
            const index = match.players.findIndex(p => p.userData && p.userData.id == userId);

            if (index !== -1) {
                match.players[index] = socket;
                console.log(`   -> Socket actualizado en la memoria del match.`);
            } else {
                console.log(`   -> ⚠️ ERROR: No se encontró al jugador en la lista del match.`);
            }

            // 3. PREPARAR DATOS DEL RIVAL (Buscar datos frescos)
            const rivalSocket = match.players.find(p => p.userData && p.userData.id != userId);

            let rivalDatos = { username: "Rival", total_partidas: 0, total_victorias: 0, faltas: 0, salidas_chat: 0 };
            let saldoRival = 0;

            if (rivalSocket && rivalSocket.userData) {
                rivalDatos = rivalSocket.userData;
                saldoRival = rivalSocket.userData.saldo;
            }

            // Calcular tope de apuesta de nuevo
            let maxApuesta = 0;
            if (match.iniciado) {
                maxApuesta = match.apuesta; 
            } else {
                maxApuesta = Math.min(user.saldo, saldoRival);
            }

            // 4. ENVIAR DATOS DE RESTAURACIÓN AL CLIENTE RECONECTADO
            socket.emit('restaurar_partida', {
                salaId: salaId,
                rival: rivalDatos,
                maxApuesta: maxApuesta,
                estado: user.estado,
                iniciado: match.iniciado
            });

            // 5. AVISAR AL RIVAL QUE VOLVIMOS (Usando io.to para asegurar que llegue)
            io.to(salaId).emit('rival_reconectado', { username: user.username });

            console.log(`   -> 🔄 Datos de restauración enviados. Rival avisado.`);
        } else {
            console.log(`   -> El usuario no tiene sala activa o la sala ya no existe.`);
        }
    });
    // FUNCIÓN CENTRAL DE CANCELACIÓN (REFACTORIZADA - No depende de sockets muertos)
    const handleCancelMatch = (socket, motivo) => {
        const salaId = socket.currentRoom;

        if (salaId && activeMatches[salaId]) {
            const match = activeMatches[salaId];

            // Si ya inició, no cancelamos la partida
            if (match.iniciado) return;

            // Identificar al culpable para sumarle la estadística
            if (socket.userData) {
                const uid = socket.userData.id;
                db.run(`UPDATE users SET salidas_chat = salidas_chat + 1 WHERE id = ?`, [uid]);

                if (motivo === 'Oprimió X') {
                    db.run(`UPDATE users SET salidas_x = salidas_x + 1 WHERE id = ?`, [uid]);
                } else if (motivo === 'Salió del chat') {
                    db.run(`UPDATE users SET salidas_canal = salidas_canal + 1 WHERE id = ?`, [uid]);
                } else if (motivo.includes('Desconexión')) {
                    db.run(`UPDATE users SET salidas_desconexion = salidas_desconexion + 1 WHERE id = ?`, [uid]);
                }
            }

            // Recopilar nombres de usuarios de forma segura
            const usernames = match.players
                .filter(p => p && p.userData)
                .map(p => p.userData.username);
            const usersStr = usernames.join(' vs ') || 'Desconocidos';
            const culpable = socket.userData ? socket.userData.username : 'Desconexión';

            logClash(`⚠️ Cancelada (${usersStr}): ${motivo} (Causa: ${culpable})`);

            // Notificar a todos usando io.to (funciona incluso con sockets muertos)
            io.to(salaId).emit('match_cancelado', { motivo: motivo || 'Abandonado.' });

            // Limpiar jugadores de forma segura (verificar que el socket esté vivo)
            match.players.forEach(j => { 
                if (j) {
                    // Solo intentar leave si el socket está conectado
                    if (j.connected && j.leave) {
                        try { j.leave(salaId); } catch(e) { }
                    }
                    j.currentRoom = null;
                    if (j.userData) {
                        db.run(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE id = ?`, [j.userData.id]); 
                    }
                }
            });

            delete activeMatches[salaId];
        }
    };

    // --- AHORA SÍ, LOS EVENTOS ---

    // Historial
    ['anuncios', 'general', 'clash', 'clash_pics', 'clash_logs'].forEach(canal => {
        db.all(`SELECT * FROM (SELECT * FROM messages WHERE canal = ? ORDER BY id DESC LIMIT 50) ORDER BY id ASC`, [canal], (err, rows) => {
            if (!err && rows) socket.emit('historial_chat', { canal: canal, mensajes: rows });
        });
    });

    socket.on('mensaje_chat', (data) => {
        const fecha = new Date().toISOString();
        const tipo = data.tipo || 'texto';
        db.run(`INSERT INTO messages (canal, usuario, texto, tipo, fecha) VALUES (?, ?, ?, ?, ?)`, 
            [data.canal, data.usuario, data.texto, tipo, fecha]);
        io.emit('mensaje_chat', { ...data, fecha });

        // Liberación Paso 2 (Fotos)
        if (data.canal === 'clash_pics' && tipo === 'imagen') {
            db.get(`SELECT estado, paso_juego FROM users WHERE username = ?`, [data.usuario], (err, user) => {
                if (user && user.estado === 'subiendo_evidencia') {
                    db.run(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE username = ?`, [data.usuario]);
                    socket.emit('flujo_completado');
                    logClash(`✅ ${data.usuario} completó la evidencia.`);
                }
            });
        }
    });

    // Matchmaking
    // --- MATCHMAKING CON ESTADÍSTICAS ---
    socket.on('buscar_partida', (usuario) => {
        // 1. Traer TODOS los datos frescos (Saldo + Estadísticas)
        db.get(`SELECT * FROM users WHERE id = ?`, [usuario.id], (err, row) => {
            if (err || !row || row.saldo < 5000) { 
                socket.emit('error_busqueda', 'Saldo insuficiente o error de cuenta.'); 
                return; 
            }

            // Actualizamos los datos en el socket con lo que trajo la BD
            socket.userData = row; 

            const yaEsta = colaEsperaClash.find(s => s.id === socket.id);
            if (yaEsta) return;

            colaEsperaClash.push(socket);
            db.run(`UPDATE users SET estado = 'buscando_partida' WHERE id = ?`, [usuario.id]);

            if (colaEsperaClash.length === 1) logClash(`🔍 ${row.username} busca rival...`);

            if (colaEsperaClash.length >= 2) {
                const j1 = colaEsperaClash.shift();
                const j2 = colaEsperaClash.shift();
                const salaId = 'sala_' + Date.now();

                j1.currentRoom = salaId; j2.currentRoom = salaId;
                j1.join(salaId); j2.join(salaId);

                activeMatches[salaId] = { players: [j1, j2], apuesta: 0, iniciado: false };
                const maxApuesta = Math.min(j1.userData.saldo, j2.userData.saldo);

                db.run(`UPDATE users SET estado = 'partida_encontrada' WHERE id IN (?, ?)`, [j1.userData.id, j2.userData.id]);

                logClash(`⚔️ ¡PARTIDA ENCONTRADA! ${j1.userData.username} VS ${j2.userData.username}`);

                // ENVIAMOS LOS DATOS COMPLETOS DE AMBOS JUGADORES PARA CALCULAR ESTADÍSTICAS EN EL FRONTEND
                io.to(salaId).emit('partida_encontrada', { 
                    salaId, 
                    p1: j1.userData, // Datos completos jugador 1
                    p2: j2.userData, // Datos completos jugador 2
                    maxApuesta 
                });
            }
        });
    });

    socket.on('cancelar_busqueda', () => {
        if (socket.userData) {
            colaEsperaClash = colaEsperaClash.filter(s => s.id !== socket.id);
            db.run(`UPDATE users SET estado = 'normal' WHERE id = ?`, [socket.userData.id]);
            logClash(`🚫 ${socket.userData.username} canceló búsqueda.`);
        }
    });

    socket.on('negociacion_live', (data) => { socket.to(data.salaId).emit('actualizar_negociacion', data); });

    // --- INICIO DE JUEGO BLINDADO (DOBLE CONFIRMACIÓN) ---
    socket.on('iniciar_juego', (data) => {
        const salaId = socket.currentRoom; 
        if (salaId && activeMatches[salaId]) {
            const match = activeMatches[salaId];

            // Si ya inició, ignorar totalmente para no descontar doble
            if (match.iniciado) return;

            // Guardar la intención de este usuario
            if (!match.votosInicio) match.votosInicio = {};
            match.votosInicio[socket.userData.id] = {
                listo: true,
                dinero: parseInt(data.dinero),
                modo: data.modo
            };

            // Avisar al rival que uno ya está listo (para que se ponga las pilas)
            socket.to(salaId).emit('rival_listo_inicio');

            // Verificar si AMBOS están listos
            const ids = match.players.map(p => p.userData.id);

            if (match.votosInicio[ids[0]] && match.votosInicio[ids[1]]) {

                // Validar que ambos pusieron el mismo dinero (seguridad extra)
                const apuesta1 = match.votosInicio[ids[0]].dinero;
                const apuesta2 = match.votosInicio[ids[1]].dinero;

                if (apuesta1 !== apuesta2) {
                    io.to(salaId).emit('error_negociacion', 'Los montos no coinciden. Negocien de nuevo.');
                    match.votosInicio = {}; // Resetear votos
                    return;
                }

                // --- AHORA SÍ INICIAMOS DE VERDAD ---
                match.iniciado = true; // Bloqueo inmediato
                match.apuesta = apuesta1;
                const modoFinal = match.votosInicio[ids[0]].modo;
                match.reportes = {}; 

                // 1. DESCONTAR SALDO (Una sola vez por usuario)
                match.players.forEach(p => {
                    // Restamos en BD
                    db.run(`UPDATE users SET saldo = saldo - ?, estado = 'jugando_partida', paso_juego = 1, sala_actual = ? WHERE id = ?`, 
                        [match.apuesta, salaId, p.userData.id]);

                    // Actualizamos memoria y avisamos al cliente el nuevo saldo real
                    p.userData.saldo = p.userData.saldo - match.apuesta;
                    p.emit('actualizar_saldo', p.userData.saldo); // <--- ESTO ACTUALIZA TU PANTALLA AL INSTANTE
                });

                // 2. CREAR PARTIDA EN BD Y AVISAR
                db.run(`INSERT INTO matches (jugador1, jugador2, modo, apuesta) VALUES (?, ?, ?, ?)`, 
                    [match.players[0].userData.username, match.players[1].userData.username, modoFinal, match.apuesta], 
                    function(err) {
                        const num = this.lastID;
                        match.dbId = num;

                        io.to(salaId).emit('juego_iniciado', { monto: match.apuesta, matchId: num });

                        logClash(`🎮 PARTIDA #${num}: ${match.players[0].userData.username} vs ${match.players[1].userData.username} | ${modoFinal} | $${match.apuesta}`);
                    }
                );
            } else {
                // Solo uno está listo, le avisamos que espere
                socket.emit('esperando_inicio_rival');
            }
        }
    });

    // --- REPORTE DE RESULTADOS (CORREGIDO: NO LIBERA HASTA SUBIR FOTO) ---
    socket.on('reportar_resultado', (data) => {
        const salaId = socket.currentRoom;
        const match = activeMatches[salaId];
        if (!match || !match.iniciado) return;

        // 1. Asegurar que el usuario pase al Paso 2 (Visualmente y en BD)
        db.run(`UPDATE users SET estado = 'subiendo_evidencia', paso_juego = 2 WHERE id = ?`, [data.usuarioId], (err) => {
            if(!err) socket.emit('necesita_evidencia');
        });

        // 2. Guardar el voto
        match.reportes[data.usuarioId] = data.resultado;

        const ids = match.players.map(p => p.userData.id);
        const rep1 = match.reportes[ids[0]];
        const rep2 = match.reportes[ids[1]];

        // 3. Verificar si ambos votaron
        if (rep1 && rep2) {
            if ((rep1 === 'gane' && rep2 === 'perdi') || (rep1 === 'perdi' && rep2 === 'gane')) {
                // --- CONSENSO (SÍ se paga, pero NO se libera aún) ---
                const idGanador = (rep1 === 'gane') ? ids[0] : ids[1];
                const premio = (match.apuesta * 2) * 0.80; // 20% Comisión
                const comision = (match.apuesta * 2) * 0.20;
                // --- NUEVO: ACTUALIZAR GANANCIA GENERADA POR USUARIO ---
                const utilidadPorJugador = comision / 2;
                match.players.forEach(p => {
                    db.run(`UPDATE users SET ganancia_generada = ganancia_generada + ? WHERE id = ?`, 
                        [utilidadPorJugador, p.userData.id]);
                });

                // GUARDAR GANANCIA EN BÓVEDA ADMIN
                db.run(`INSERT INTO admin_wallet (monto, razon, detalle) VALUES (?, ?, ?)`, 
                    [comision, 'comision_match', `Match #${match.dbId}`]);
                // A. Pagar al ganador
                db.run(`UPDATE users SET saldo = saldo + ? WHERE id = ?`, [premio, idGanador], () => {

                    // --- ESTADÍSTICAS: GANADOR (Normal) ---
                    db.run(`UPDATE users SET total_victorias = total_victorias + 1, victorias_normales = victorias_normales + 1, total_partidas = total_partidas + 1 WHERE id = ?`, [idGanador]);

                    // --- ESTADÍSTICAS: PERDEDOR (Normal) ---
                    const idPerdedor = (idGanador === ids[0]) ? ids[1] : ids[0];
                    db.run(`UPDATE users SET total_derrotas = total_derrotas + 1, derrotas_normales = derrotas_normales + 1, total_partidas = total_partidas + 1 WHERE id = ?`, [idPerdedor]);

                    // ... (Aquí sigue la actualización visual de saldo y logs que ya tenías) ...
                    const socketGanador = match.players.find(p => p.userData.id === idGanador);
                    if (socketGanador) {
                        socketGanador.userData.saldo += premio;
                        socketGanador.emit('actualizar_saldo', socketGanador.userData.saldo);
                    }

                    // B. Registrar ganador en historial de partidas
                    const nombreGanador = socketGanador ? socketGanador.userData.username : "Jugador";
                    db.run(`UPDATE matches SET estado = 'finalizada', ganador = ? WHERE id = ?`, [nombreGanador, match.dbId]);

                    logClash(`🏆 GANADOR Partida #${match.dbId}: ${nombreGanador} (Se pagaron $${premio})`);

                    // C. ¡IMPORTANTE! NO LIBERAMOS A LOS JUGADORES AQUÍ.
                    // Ellos siguen en estado 'subiendo_evidencia'.
                    // La liberación ocurrirá en el evento 'mensaje_chat' cuando detecte la foto.

                    // Opcional: Borrar de memoria activa para ahorrar RAM, 
                    // ya que la validación de fotos es por base de datos.
                    delete activeMatches[salaId];
                });

            } else {
                // --- DISPUTA ---
                db.run(`UPDATE matches SET estado = 'disputa' WHERE id = ?`, [match.dbId]);
                // --- NUEVO: NOTIFICAR CORREO ---
                notificarAdmin(
                    "¡DISPUTA EN CURSO!", 
                    `Conflicto en la Partida #${match.dbId}. Ambos jugadores reportaron resultados diferentes. Se requiere tu intervención inmediata.`
                );
                logClash(`🚨 DISPUTA Partida #${match.dbId}.`);
                io.to(salaId).emit('error_disputa', "CONFLICTO: Resultados no coinciden.");
            }
        }
    });

    // Evento para cancelar manualmente (Botón X o Salir)
    socket.on('cancelar_match', (data) => {
        handleCancelMatch(socket, data ? data.motivo : 'Salida manual');
    });

    socket.on('mensaje_privado', (data) => { 
        try { 
            if (data && data.salaId) { 
                data.fecha = new Date().toISOString(); 
                io.to(data.salaId).emit('mensaje_privado', data); 
            } 
        } catch (e) {} 
    });

    socket.on('disconnect', () => {
        // Limpiar cola de espera (eso es inmediato)
        colaEsperaClash = colaEsperaClash.filter(s => s.id !== socket.id);

        // LÓGICA DE GRACIA (15 SEGUNDOS)
        const salaId = socket.currentRoom;
        const disconnectedUsername = socket.userData ? socket.userData.username : null;
        const disconnectedUserId = socket.userData ? socket.userData.id : null;

        if (salaId && activeMatches[salaId] && disconnectedUserId) {
            const match = activeMatches[salaId];

            // Si la partida ya inició (dinero apostado), NO cancelamos por desconexión
            // La partida sigue viva para que puedan volver
            if (match.iniciado) {
                console.log(`🔌 ${disconnectedUsername} desconectado de partida INICIADA. No se cancela.`);
                io.to(salaId).emit('rival_desconectado', { tiempo: 15, mensaje: 'Tu rival se desconectó. Esperando...' });
                return;
            }

            console.log(`🔌 ${disconnectedUsername} se desconectó. Esperando 15s...`);

            // Inicializar objeto de timers si no existe
            if (!match.disconnectTimers) match.disconnectTimers = {};

            // Avisar al rival que espere (usando io.to en lugar del socket muerto)
            io.to(salaId).emit('rival_desconectado', { tiempo: 15 });

            // ACTIVAR TEMPORIZADOR
            match.disconnectTimers[disconnectedUserId] = setTimeout(() => {
                // Si este código se ejecuta, es que NO volvió a tiempo.
                console.log(`⏰ Tiempo agotado para ${disconnectedUsername}. Cancelando partida.`);

                if (activeMatches[salaId]) {
                    const matchToCancel = activeMatches[salaId];

                    // Sumar estadística de huida por desconexión
                    db.run(`UPDATE users SET salidas_chat = salidas_chat + 1, salidas_desconexion = salidas_desconexion + 1 WHERE id = ?`, [disconnectedUserId]);

                    logClash(`⚠️ Cancelada: ${disconnectedUsername} no volvió a tiempo (15s)`);

                    // Notificar a todos en la sala usando io.to (funciona aunque el socket original murió)
                    io.to(salaId).emit('match_cancelado', { motivo: `${disconnectedUsername} no volvió a tiempo` });

                    // Liberar a todos los jugadores
                    matchToCancel.players.forEach(j => { 
                        if (j && j.leave) j.leave(salaId);
                        if (j) j.currentRoom = null; 
                        if (j && j.userData) {
                            db.run(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE id = ?`, [j.userData.id]); 
                        }
                    });

                    delete activeMatches[salaId];
                }
            }, 15000); // 15 segundos
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server OK en puerto ${PORT}`);
});


