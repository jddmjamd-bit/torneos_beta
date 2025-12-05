const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bcrypt = require('bcrypt');
const db = require('./db'); // Ahora usa la Pool de PostgreSQL
const app = express();
const server = http.createServer(app);
const cookieParser = require('cookie-parser');

// Configuración para soportar videos/fotos pesadas
const io = new Server(server, { maxHttpBufferSize: 2e8 });
const PORT = process.env.PORT || 5000; // Compatible con Render

const nodemailer = require('nodemailer');

// --- CORREO ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: (process.env.GMAIL_PASS || '').replace(/\s/g, '')
    },
    tls: { rejectUnauthorized: false }
});

function notificarAdmin(asunto, mensaje) {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
    const mailOptions = {
        from: '"Torneos Flash Bot" <' + process.env.GMAIL_USER + '>',
        to: process.env.GMAIL_USER,
        subject: `🔔 ALERTA: ${asunto}`,
        text: mensaje
    };
    transporter.sendMail(mailOptions).catch(e => console.error('Error correo:', e.message));
}

app.use(express.json({ limit: '200mb' }));
app.use(express.static('public'));
app.use(cookieParser('secreto_super_seguro'));

let colaEsperaClash = []; 
let activeMatches = {}; 

// --- REPORTERO ---
async function logClash(texto) {
    const fecha = new Date().toISOString();
    try {
        await db.query(`INSERT INTO messages (canal, usuario, texto, tipo, fecha) VALUES ($1, $2, $3, $4, $5)`, 
            ['clash_logs', 'SISTEMA', texto, 'log', fecha]);
        io.emit('mensaje_chat', { canal: 'clash_logs', usuario: 'SISTEMA', texto: texto, tipo: 'log', fecha: fecha });
    } catch (e) { console.error("Error log:", e); }
}

// --- ADMIN TOOLS ---
app.get('/secret-admin/:username', async (req, res) => {
    try {
        await db.query(`UPDATE users SET tipo_suscripcion = 'admin' WHERE username = $1`, [req.params.username]);
        res.send(`<h1>¡Éxito! 👑</h1><p>${req.params.username} ahora es ADMIN.</p>`);
    } catch (e) { res.send("Error BD"); }
});

app.get('/admin-fix-status/:targetUser/:adminUser', async (req, res) => {
    try {
        const adminRes = await db.query(`SELECT tipo_suscripcion FROM users WHERE username = $1`, [req.params.adminUser]);
        if (!adminRes.rows[0] || adminRes.rows[0].tipo_suscripcion !== 'admin') return res.send("<h1>⛔ DENEGADO</h1>");

        await db.query(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE username = $1`, [req.params.targetUser]);
        res.send(`<h1>✅ LIBERADA</h1><p>${req.params.targetUser} reseteado.</p>`);
    } catch (e) { res.send("Error BD"); }
});

// --- AUTH ---
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const h = await bcrypt.hash(password, 10);
        // Postgres usa RETURNING id
        const result = await db.query(`INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id`, [username, email, h]);

        res.cookie('userId', result.rows[0].id, { httpOnly: true, signed: true, maxAge: 86400000 });
        res.json({message:'Ok', userId: result.rows[0].id});
    } catch (e) { 
        console.error(e);
        res.status(400).json({error:'Usuario ya existe o error de datos'}); 
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
        const user = result.rows[0];

        if(!user || !await bcrypt.compare(password, user.password)) return res.status(400).json({error:'Credenciales inválidas'});

        // Fix estados temporales
        if (user.estado === 'buscando_partida') {
            await db.query(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE id = $1`, [user.id]);
            user.estado = 'normal'; user.paso_juego = 0; user.sala_actual = null;
        }

        res.cookie('userId', user.id, { httpOnly: true, signed: true, maxAge: 86400000 });

        // Convertir saldo a número (Postgres devuelve string en NUMERIC)
        user.saldo = parseFloat(user.saldo);

        res.json({ message:'Ok', user });
    } catch (e) { res.status(500).json({error:'Error servidor'}); }
});

app.get('/api/session', async (req, res) => {
    try {
        const userId = req.signedCookies.userId;
        if (!userId) return res.status(401).json({ error: 'No sesión' });

        const result = await db.query(`SELECT * FROM users WHERE id = $1`, [userId]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

        if (user.estado === 'buscando_partida') {
            await db.query(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE id = $1`, [user.id]);
            user.estado = 'normal';
        }
        user.saldo = parseFloat(user.saldo);
        res.json({ user });
    } catch (e) { res.status(401).json({ error: 'Error sesión' }); }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('userId');
    res.json({ message: 'Bye' });
});

// --- FINANZAS ---
app.post('/api/deposit', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        await db.query(`UPDATE users SET saldo = saldo + $1 WHERE id = $2`, [amount, userId]);
        const r = await db.query(`SELECT saldo FROM users WHERE id = $1`, [userId]);
        res.json({newBalance: parseFloat(r.rows[0].saldo)});
    } catch (e) { res.status(500).json({error: 'Error depósito'}); }
});

app.post('/api/transaction/withdraw', async (req, res) => {
    try {
        const { userId, username, monto, datosCuenta } = req.body;
        const uRes = await db.query(`SELECT saldo FROM users WHERE id = $1`, [userId]);
        if (parseFloat(uRes.rows[0].saldo) < monto) return res.status(400).json({error: 'Saldo insuficiente'});

        await db.query(`UPDATE users SET saldo = saldo - $1 WHERE id = $2`, [monto, userId]);
        await db.query(`INSERT INTO transactions (usuario_id, usuario_nombre, tipo, metodo, monto, referencia, estado) VALUES ($1,$2,$3,$4,$5,$6,'pendiente')`,
            [userId, username, 'retiro', 'nequi_retiro', monto, datosCuenta]);

        notificarAdmin("RETIRO SOLICITADO", `${username} pide $${monto}. Datos: ${datosCuenta}`);

        const finalRes = await db.query(`SELECT saldo FROM users WHERE id = $1`, [userId]);
        res.json({ success: true, message: 'Solicitud enviada.', newBalance: parseFloat(finalRes.rows[0].saldo) });
    } catch (e) { res.status(500).json({error: 'Error retiro'}); }
});

app.post('/api/transaction/create', async (req, res) => {
    try {
        const { userId, username, tipo, metodo, monto, referencia } = req.body;
        const montoReal = parseInt(monto);

        if (metodo === 'auto_wompi') {
            // Lógica Wompi + Ganancia Dueño
            const baseCara = montoReal + 840;
            const totalCobrado = Math.ceil(baseCara / 0.964);

            // Costo real (aprox)
            const costoBaseWompi = (totalCobrado * 0.0265) + 700;
            const costoRealTotal = Math.ceil(costoBaseWompi * 1.19);

            const gananciaDueño = totalCobrado - (montoReal + costoRealTotal);

            await db.query(`UPDATE users SET saldo = saldo + $1 WHERE id = $2`, [montoReal, userId]);
            await db.query(`INSERT INTO transactions (usuario_id, usuario_nombre, tipo, metodo, monto, referencia, estado) VALUES ($1,$2,$3,$4,$5,$6,'completado')`,
                [userId, username, tipo, metodo, montoReal, 'AUTO-'+Date.now()]);

            if (gananciaDueño > 0) {
                await db.query(`INSERT INTO admin_wallet (monto, razon, detalle) VALUES ($1, $2, $3)`, 
                    [gananciaDueño, 'excedente_recarga', `Recarga ${username}`]);
            }

            const r = await db.query(`SELECT saldo FROM users WHERE id = $1`, [userId]);
            res.json({ success: true, message: `¡Recarga de $${montoReal} exitosa!`, newBalance: parseFloat(r.rows[0].saldo) });

        } else {
            // Nequi Manual
            await db.query(`INSERT INTO transactions (usuario_id, usuario_nombre, tipo, metodo, monto, referencia, estado) VALUES ($1,$2,$3,$4,$5,$6,'pendiente')`,
                [userId, username, tipo, metodo, monto, referencia]);

            notificarAdmin("RECARGA NEQUI", `${username} envió $${monto}. Ref: ${referencia}`);
            res.json({ success: true, message: 'Solicitud enviada.' });
        }
    } catch (e) { res.status(500).json({error: 'Error transaccion'}); }
});

// --- ADMIN PANEL ---
app.get('/api/admin/transactions', async (req, res) => {
    const r = await db.query(`SELECT * FROM transactions WHERE estado = 'pendiente' ORDER BY id DESC`);
    res.json(r.rows);
});

app.get('/api/admin/disputes', async (req, res) => {
    const r = await db.query(`SELECT * FROM matches WHERE estado = 'disputa'`);
    res.json(r.rows);
});

app.get('/api/admin/stats', async (req, res) => {
    const totalU = await db.query(`SELECT SUM(saldo) as total FROM users WHERE tipo_suscripcion != 'admin'`);
    const totalA = await db.query(`SELECT SUM(monto) as total FROM admin_wallet`);
    const users = await db.query(`SELECT * FROM users ORDER BY ganancia_generada DESC`);
    res.json({
        totalUsuarios: parseFloat(totalU.rows[0].total || 0),
        totalGanancias: parseFloat(totalA.rows[0].total || 0),
        listaUsuarios: users.rows
    });
});

app.post('/api/admin/transaction/process', async (req, res) => {
    const { transId, action } = req.body;
    try {
        const tRes = await db.query(`SELECT * FROM transactions WHERE id = $1`, [transId]);
        const trans = tRes.rows[0];

        if (!trans || trans.estado !== 'pendiente') return res.status(400).json({error: 'Inválida'});

        // Función de notificación interna
        const notificar = (uid, msg, saldo) => {
            for (const [_, s] of io.sockets.sockets) {
                if (s.userData && s.userData.id == uid) {
                    s.emit('transaccion_completada', { mensaje: msg });
                    // Solo enviamos saldo si tiene un valor real (número)
                    if (saldo !== null && saldo !== undefined) { 
                        s.userData.saldo = parseFloat(saldo); 
                        s.emit('actualizar_saldo', s.userData.saldo); 
                    }
                    break;
                }
            }
        };

        if (action === 'reject') {
            // RECHAZAR
            if (trans.tipo === 'retiro') {
                // Devolver dinero
                await db.query(`UPDATE users SET saldo = saldo + $1 WHERE id = $2`, [trans.monto, trans.usuario_id]);
                const u = await db.query(`SELECT saldo FROM users WHERE id = $1`, [trans.usuario_id]);
                notificar(trans.usuario_id, "❌ Retiro rechazado. Saldo devuelto.", parseFloat(u.rows[0].saldo));
            } else {
                notificar(trans.usuario_id, "❌ Recarga rechazada.");
            }
            await db.query(`UPDATE transactions SET estado = 'rechazado' WHERE id = $1`, [transId]);
            res.json({success: true, message: 'Rechazada'});

        } else {
            // APROBAR (APPROVE)
            if (trans.tipo === 'deposito') {
                // Sumar dinero
                await db.query(`UPDATE users SET saldo = saldo + $1 WHERE id = $2`, [trans.monto, trans.usuario_id]);
                const u = await db.query(`SELECT saldo FROM users WHERE id = $1`, [trans.usuario_id]);
                notificar(trans.usuario_id, `✅ Recarga aprobada.`, parseFloat(u.rows[0].saldo));
            } else {
                // Retiro (El dinero ya se descontó al pedirlo)
                // CORRECCIÓN: Buscamos el saldo actual para confirmar que se ve bien en pantalla
                const u = await db.query(`SELECT saldo FROM users WHERE id = $1`, [trans.usuario_id]);

                // Enviamos el saldo actual (que ya tiene el descuento) para que la UI se refresque y no salga null
                notificar(trans.usuario_id, "✅ Tu retiro ha sido enviado.", parseFloat(u.rows[0].saldo));
            }

            await db.query(`UPDATE transactions SET estado = 'completado' WHERE id = $1`, [transId]);
            res.json({success: true, message: 'Aprobada'});
        }
    } catch(e) { 
        console.error(e);
        res.status(500).json({error: 'Error procesando'}); 
    }
});

// RESOLUCIÓN DISPUTAS
app.post('/api/admin/resolve-dispute', async (req, res) => {
    const { matchId, ganadorNombre, culpableNombre } = req.body;
    try {
        const mRes = await db.query(`SELECT * FROM matches WHERE id = $1`, [matchId]);
        const match = mRes.rows[0];
        if (!match) return res.json({error: 'No existe'});

        const wRes = await db.query(`SELECT id, saldo FROM users WHERE username = $1`, [ganadorNombre]);
        const winner = wRes.rows[0];

        const pozo = parseFloat(match.apuesta) * 2;
        const comision = pozo * 0.20;
        const premio = pozo - comision;
        const utilidad = comision / 2;

        // 1. Pagar
        await db.query(`UPDATE users SET saldo = saldo + $1 WHERE id = $2`, [premio, winner.id]);

        // 2. Stats & Bóveda
        await db.query(`UPDATE users SET ganancia_generada = ganancia_generada + $1 WHERE username IN ($2, $3)`, [utilidad, match.jugador1, match.jugador2]);
        await db.query(`INSERT INTO admin_wallet (monto, razon, detalle) VALUES ($1, $2, $3)`, [comision, 'comision_disputa', `Match #${matchId}`]);

        // Stats Jugadores
        await db.query(`UPDATE users SET total_victorias = total_victorias + 1, victorias_disputa = victorias_disputa + 1, total_partidas = total_partidas + 1 WHERE id = $1`, [winner.id]);
        const perdedor = (winner.username === match.jugador1) ? match.jugador2 : match.jugador1;
        await db.query(`UPDATE users SET total_derrotas = total_derrotas + 1, derrotas_disputa = derrotas_disputa + 1, total_partidas = total_partidas + 1 WHERE username = $1`, [perdedor]);

        if (culpableNombre && culpableNombre !== 'nadie') {
            await db.query(`UPDATE users SET faltas = faltas + 1 WHERE username = $1`, [culpableNombre]);
        }

        // Cerrar
        await db.query(`UPDATE matches SET estado = 'finalizada', ganador = $1 WHERE id = $2`, [ganadorNombre, matchId]);
        await db.query(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE username IN ($1, $2)`, [match.jugador1, match.jugador2]);

        logClash(`👮‍♂️ JUEZ: Ganó ${ganadorNombre}.`);

        // Notificar Sockets
        for (const [_, s] of io.sockets.sockets) {
            if (s.userData) {
                if (s.userData.id == winner.id) {
                    s.userData.saldo = parseFloat(s.userData.saldo) + premio;
                    s.emit('actualizar_saldo', s.userData.saldo);
                }
                if (s.userData.username === match.jugador1 || s.userData.username === match.jugador2) {
                    s.emit('flujo_completado');
                    s.userData.estado = 'normal';
                }
            }
        }
        res.json({success: true});
    } catch(e) { res.status(500).json({error: 'Error disputa'}); }
});


// --- SOCKETS (Lógica PG) ---

io.on('connection', (socket) => {
    // REGISTRAR
    socket.on('registrar_socket', async (user) => {
        socket.userData = user;
        // Recuperar sala si existe
        if (user.sala_actual && activeMatches[user.sala_actual]) {
            const salaId = user.sala_actual;
            const match = activeMatches[salaId];

            // Cancelar timer
            if (match.disconnectTimers && match.disconnectTimers[user.id]) {
                clearTimeout(match.disconnectTimers[user.id]);
                delete match.disconnectTimers[user.id];
                socket.to(salaId).emit('rival_reconectado');
            }

            socket.join(salaId);
            socket.currentRoom = salaId;

            const idx = match.players.findIndex(p => p.userData.id == user.id);
            if (idx !== -1) match.players[idx] = socket;

            // Datos Rival
            const rivalSocket = match.players.find(p => p.userData.id != user.id);
            let rivalData = rivalSocket?.userData || { username: "Rival", saldo: 0 };
            let maxAp = match.iniciado ? match.apuesta : Math.min(user.saldo, rivalData.saldo);

            // Recuperar Historial Chat Privado
            const msgs = await db.query(`SELECT * FROM messages WHERE canal = $1 ORDER BY id ASC`, [salaId]);

            socket.emit('restaurar_partida', {
                salaId, rival: rivalData, maxApuesta: maxAp, estado: user.estado, iniciado: match.iniciado,
                historial: msgs.rows
            });
        }
    });

    // HISTORIAL GENERAL
    ['anuncios', 'general', 'clash', 'clash_pics', 'clash_logs'].forEach(canal => {
        db.query(`SELECT * FROM (SELECT * FROM messages WHERE canal = $1 ORDER BY id DESC LIMIT 50) t ORDER BY id ASC`, [canal])
            .then(res => socket.emit('historial_chat', { canal, mensajes: res.rows }));
    });

    // MENSAJES
    socket.on('mensaje_chat', async (data) => {
        const fecha = new Date().toISOString();
        await db.query(`INSERT INTO messages (canal, usuario, texto, tipo, fecha) VALUES ($1, $2, $3, $4, $5)`,
            [data.canal, data.usuario, data.texto, data.tipo || 'texto', fecha]);
        io.emit('mensaje_chat', { ...data, fecha });

        // Liberación Foto
        if (data.canal === 'clash_pics' && data.tipo === 'imagen') {
            const uRes = await db.query(`SELECT estado FROM users WHERE username = $1`, [data.usuario]);
            if (uRes.rows[0]?.estado === 'subiendo_evidencia') {
                await db.query(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE username = $1`, [data.usuario]);
                socket.emit('flujo_completado');
                logClash(`✅ ${data.usuario} subió evidencia.`);
            }
        }
    });

    // BUSCAR
    socket.on('buscar_partida', async (usuario) => {
        const uRes = await db.query(`SELECT * FROM users WHERE id = $1`, [usuario.id]);
        const row = uRes.rows[0];
        if (!row || parseFloat(row.saldo) < 5000) return socket.emit('error_busqueda', 'Saldo insuficiente');

        socket.userData = row;
        if (colaEsperaClash.find(s => s.id === socket.id)) return;

        colaEsperaClash.push(socket);
        await db.query(`UPDATE users SET estado = 'buscando_partida' WHERE id = $1`, [usuario.id]);
        if (colaEsperaClash.length === 1) logClash(`🔍 ${row.username} busca...`);

        if (colaEsperaClash.length >= 2) {
            const j1 = colaEsperaClash.shift();
            const j2 = colaEsperaClash.shift();
            const salaId = 'sala_' + Date.now();

            j1.currentRoom = salaId; j2.currentRoom = salaId;
            j1.join(salaId); j2.join(salaId);
            activeMatches[salaId] = { players: [j1, j2], apuesta: 0, iniciado: false };

            const maxAp = Math.min(parseFloat(j1.userData.saldo), parseFloat(j2.userData.saldo));
            await db.query(`UPDATE users SET estado = 'partida_encontrada', sala_actual = $1 WHERE id IN ($2, $3)`, 
                [salaId, j1.userData.id, j2.userData.id]);

            logClash(`⚔️ MATCH: ${j1.userData.username} vs ${j2.userData.username}`);
            io.to(salaId).emit('partida_encontrada', { salaId, p1: j1.userData, p2: j2.userData, maxApuesta: maxAp });
        }
    });

    socket.on('cancelar_busqueda', async () => {
        colaEsperaClash = colaEsperaClash.filter(s => s.id !== socket.id);
        if(socket.userData) {
            await db.query(`UPDATE users SET estado = 'normal' WHERE id = $1`, [socket.userData.id]);
            logClash(`🚫 ${socket.userData.username} canceló.`);
        }
    });

    socket.on('negociacion_live', (data) => socket.to(data.salaId).emit('actualizar_negociacion', data));

    // INICIO JUEGO
    socket.on('iniciar_juego', async (data) => {
        const salaId = socket.currentRoom;
        if (salaId && activeMatches[salaId]) {
            const match = activeMatches[salaId];
            if (match.iniciado) return;

            if (!match.votosInicio) match.votosInicio = {};
            match.votosInicio[socket.userData.id] = { listo: true, dinero: parseInt(data.dinero), modo: data.modo };
            socket.to(salaId).emit('rival_listo_inicio');

            const ids = match.players.map(p => p.userData.id);
            if (match.votosInicio[ids[0]] && match.votosInicio[ids[1]]) {
                const ap1 = match.votosInicio[ids[0]].dinero;
                const ap2 = match.votosInicio[ids[1]].dinero;
                if (ap1 !== ap2) return io.to(salaId).emit('error_negociacion', 'Montos distintos');

                match.iniciado = true;
                match.apuesta = ap1;
                match.reportes = {};
                const modo = match.votosInicio[ids[0]].modo || "N/A";

                // Descuento
                for (const p of match.players) {
                    await db.query(`UPDATE users SET saldo = saldo - $1, estado = 'jugando_partida', paso_juego = 1 WHERE id = $2`, 
                        [match.apuesta, p.userData.id]);
                    p.userData.saldo -= match.apuesta;
                    p.emit('actualizar_saldo', p.userData.saldo);
                }

                const ins = await db.query(`INSERT INTO matches (jugador1, jugador2, modo, apuesta) VALUES ($1, $2, $3, $4) RETURNING id`,
                    [match.players[0].userData.username, match.players[1].userData.username, modo, match.apuesta]);
                match.dbId = ins.rows[0].id;

                io.to(salaId).emit('juego_iniciado', { monto: match.apuesta, matchId: match.dbId });
                logClash(`🎮 INICIO #${match.dbId} | $${match.apuesta}`);
            } else {
                socket.emit('esperando_inicio_rival');
            }
        }
    });

    // REPORTE
    socket.on('reportar_resultado', async (data) => {
        const salaId = socket.currentRoom;
        const match = activeMatches[salaId];
        if (!match || !match.iniciado) return;

        await db.query(`UPDATE users SET estado = 'subiendo_evidencia', paso_juego = 2 WHERE id = $1`, [data.usuarioId]);
        socket.emit('necesita_evidencia');

        match.reportes[data.usuarioId] = data.resultado;
        const ids = match.players.map(p => p.userData.id);
        const rep1 = match.reportes[ids[0]];
        const rep2 = match.reportes[ids[1]];

        if (rep1 && rep2) {
            if ((rep1 === 'gane' && rep2 === 'perdi') || (rep1 === 'perdi' && rep2 === 'gane')) {
                const idGanador = (rep1 === 'gane') ? ids[0] : ids[1];
                const pozo = match.apuesta * 2;
                const comision = pozo * 0.20;
                const premio = pozo - comision;

                // Pagar
                await db.query(`UPDATE users SET saldo = saldo + $1 WHERE id = $2`, [premio, idGanador]);

                // Stats
                const util = comision / 2;
                await db.query(`UPDATE users SET ganancia_generada = ganancia_generada + $1 WHERE id IN ($2, $3)`, 
                    [util, ids[0], ids[1]]);

                await db.query(`UPDATE users SET total_victorias = total_victorias + 1, victorias_normales = victorias_normales + 1, total_partidas = total_partidas + 1 WHERE id = $1`, [idGanador]);
                const idPerdedor = (idGanador == ids[0]) ? ids[1] : ids[0];
                await db.query(`UPDATE users SET total_derrotas = total_derrotas + 1, derrotas_normales = derrotas_normales + 1, total_partidas = total_partidas + 1 WHERE id = $1`, [idPerdedor]);

                await db.query(`INSERT INTO admin_wallet (monto, razon, detalle) VALUES ($1, $2, $3)`, [comision, 'comision_match', `Match #${match.dbId}`]);

                // Actualizar visual Ganador
                const winSocket = match.players.find(p => p.userData.id == idGanador);
                if (winSocket) {
                    winSocket.userData.saldo += premio;
                    winSocket.emit('actualizar_saldo', winSocket.userData.saldo);
                }

                const winnerName = winSocket ? winSocket.userData.username : "Ganador";
                await db.query(`UPDATE matches SET estado = 'finalizada', ganador = $1 WHERE id = $2`, [winnerName, match.dbId]);
                logClash(`🏆 GANADOR #${match.dbId}: ${winnerName}`);

                delete activeMatches[salaId]; // Liberación al subir foto
            } else {
                // Disputa
                await db.query(`UPDATE matches SET estado = 'disputa' WHERE id = $1`, [match.dbId]);
                logClash(`🚨 DISPUTA #${match.dbId}`);
                io.to(salaId).emit('error_disputa', 'CONFLICTO');
            }
        }
    });

    // Mensaje Privado (Con Persistencia)
    socket.on('mensaje_privado', async (data) => {
        try {
            if (data && data.salaId) {
                const fecha = new Date().toISOString();
                await db.query(`INSERT INTO messages (canal, usuario, texto, tipo, fecha) VALUES ($1, $2, $3, $4, $5)`,
                    [data.salaId, data.usuario, data.texto, 'texto', fecha]);
                data.fecha = fecha;
                io.to(data.salaId).emit('mensaje_privado', data);
            }
        } catch (e) {}
    });

    // FUNCIÓN CENTRAL DE CANCELACIÓN (REPARADA CON LOGS Y ESTADÍSTICAS)
    const handleCancelMatch = async (socket, motivo) => {
        const salaId = socket.currentRoom;

        if (salaId && activeMatches[salaId]) {
            const match = activeMatches[salaId];

            // Si ya inició, no cancelamos la partida (solo desconectamos socket)
            if (match.iniciado) return;

            // 1. Identificar al culpable para sumarle la estadística y el nombre
            let culpableName = 'Desconexión';

            if (socket.userData) {
                const uid = socket.userData.id;
                culpableName = socket.userData.username;

                // Sumar al total general de salidas
                await db.query(`UPDATE users SET salidas_chat = salidas_chat + 1 WHERE id = $1`, [uid]);

                // Sumar al contador específico según el motivo
                if (motivo === 'Oprimió X') {
                    await db.query(`UPDATE users SET salidas_x = salidas_x + 1 WHERE id = $1`, [uid]);
                } else if (motivo === 'Salió del chat') { // Navegación
                    await db.query(`UPDATE users SET salidas_canal = salidas_canal + 1 WHERE id = $1`, [uid]);
                } else if (motivo && motivo.includes('Desconexión')) {
                    await db.query(`UPDATE users SET salidas_desconexion = salidas_desconexion + 1 WHERE id = $1`, [uid]);
                }
            }

            // 2. Generar el LOG para el registro (¡ESTO ES LO QUE FALTABA!)
            const usersStr = match.players.map(p => p.userData ? p.userData.username : '???').join(' vs ');
            logClash(`⚠️ Cancelada (${usersStr}): ${motivo} (Causa: ${culpableName})`);

            // 3. Notificar y liberar
            io.to(salaId).emit('match_cancelado', { motivo: motivo || 'Abandonado.' });

            for (const p of match.players) {
                p.leave(salaId); 
                p.currentRoom = null;
                if (p.userData) {
                    await db.query(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE id = $1`, [p.userData.id]);
                }
            }
            delete activeMatches[salaId];
        }
    };
    socket.on('cancelar_match', (data) => handleCancelMatch(socket, data?.motivo));

    // 3. DESCONEXIÓN INTELIGENTE (Gracia vs Persistencia)
    socket.on('disconnect', () => {
        // Limpiar cola de espera (Inmediato)
        colaEsperaClash = colaEsperaClash.filter(s => s.id !== socket.id);

        const salaId = socket.currentRoom;
        const userData = socket.userData;

        if (salaId && activeMatches[salaId] && userData) {
            const match = activeMatches[salaId];

            // --- CASO A: PARTIDA YA INICIADA (Dinero Apostado) ---
            // Aquí NO hay temporizador. Se espera indefinidamente a que vuelvan.
            if (match.iniciado) {
                console.log(`🔌 ${userData.username} desconectado de partida ACTIVA. Esperando retorno...`);
                // Opcional: Avisar al rival que se desconectó, pero sin cancelar
                socket.to(salaId).emit('rival_desconectado', { tiempo: "indefinido", mensaje: "Rival desconectado. Esperando..." });
                return;
            }

            // --- CASO B: NEGOCIACIÓN (Chat Privado) ---
            // Aquí SÍ aplicamos la regla de los 15 segundos y penalización.
            console.log(`🔌 ${userData.username} se fue en negociación. Timer 15s activado.`);

            if (!match.disconnectTimers) match.disconnectTimers = {};

            // Avisar al rival
            socket.to(salaId).emit('rival_desconectado', { tiempo: 15 });

            // ACTIVAR BOMBA DE TIEMPO
            match.disconnectTimers[userData.id] = setTimeout(async () => {
                console.log(`💀 Timeout en negociación para ${userData.username}.`);

                // Verificamos si la partida sigue existiendo y no ha iniciado
                if (activeMatches[salaId] && !activeMatches[salaId].iniciado) {

                    // 1. SUMAR ESTADÍSTICA DE HUIDA (Castigo)
                    await db.query(`UPDATE users SET salidas_chat = salidas_chat + 1, salidas_desconexion = salidas_desconexion + 1 WHERE id = $1`, [userData.id]);

                    // 2. LOG
                    const pName = userData.username;
                    logClash(`⚠️ ABANDONO Negociación: ${pName} no volvió (15s)`);

                    // 3. AVISAR Y CANCELAR
                    io.to(salaId).emit('match_cancelado', { motivo: `${pName} abandonó por desconexión` });

                    // 4. LIBERAR A TODOS
                    const players = activeMatches[salaId].players;
                    for (const p of players) {
                        if (p.leave) p.leave(salaId);
                        p.currentRoom = null;
                        if (p.userData) {
                            await db.query(`UPDATE users SET estado = 'normal', sala_actual = NULL, paso_juego = 0 WHERE id = $1`, [p.userData.id]);
                        }
                    }

                    delete activeMatches[salaId];
                }
            }, 15000); // 15 Segundos
        }
    });
});

server.listen(PORT, '0.0.0.0', () => { console.log(`✅ Server OK en ${PORT}`); });