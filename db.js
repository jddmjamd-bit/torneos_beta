const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'torneos.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('❌ Error BD', err.message);
    else console.log('✅ BD Conectada (Sistema Pagos)');
});

db.serialize(() => {
    // USUARIOS
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        saldo REAL DEFAULT 0,
        tipo_suscripcion TEXT DEFAULT 'free',
        estado TEXT DEFAULT 'normal',
        sala_actual TEXT DEFAULT NULL,
        paso_juego INTEGER DEFAULT 0
    )`);

    // MENSAJES
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canal TEXT DEFAULT 'general',
        usuario TEXT,
        texto TEXT,
        tipo TEXT DEFAULT 'texto',
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // PARTIDAS
    db.run(`CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jugador1 TEXT,
        jugador2 TEXT,
        modo TEXT,
        apuesta INTEGER,
        ganador TEXT DEFAULT NULL,
        estado TEXT DEFAULT 'en_curso',
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // --- NUEVA: TRANSACCIONES (DEPÓSITOS/RETIROS) ---
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        usuario_nombre TEXT,
        tipo TEXT, -- 'deposito', 'retiro'
        metodo TEXT, -- 'manual_nequi', 'auto_wompi'
        monto REAL,
        referencia TEXT,
        estado TEXT DEFAULT 'pendiente', -- 'pendiente', 'completado', 'rechazado'
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // --- NUEVA: BÓVEDA DEL ADMIN (GANANCIAS) ---
    db.run(`CREATE TABLE IF NOT EXISTS admin_wallet (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monto REAL,
        razon TEXT, -- 'comision_match', 'excedente_recarga'
        detalle TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migraciones
    const actualizaciones = [
        "ALTER TABLE users ADD COLUMN estado TEXT DEFAULT 'normal'",
        "ALTER TABLE users ADD COLUMN sala_actual TEXT DEFAULT NULL",
        "ALTER TABLE users ADD COLUMN paso_juego INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN tipo_suscripcion TEXT DEFAULT 'free'",
        "ALTER TABLE users ADD COLUMN ganancia_generada REAL DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN canal TEXT DEFAULT 'general'",
        "ALTER TABLE messages ADD COLUMN tipo TEXT DEFAULT 'texto'",
        "ALTER TABLE users ADD COLUMN faltas INTEGER DEFAULT 0", // <--- NUEVO: Contador de Culpabilidad
        "ALTER TABLE users ADD COLUMN total_victorias INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN victorias_normales INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN victorias_disputa INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN total_derrotas INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN derrotas_normales INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN derrotas_disputa INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN total_partidas INTEGER DEFAULT 0",

            "ALTER TABLE users ADD COLUMN salidas_chat INTEGER DEFAULT 0",      // Total general de salidas
            "ALTER TABLE users ADD COLUMN salidas_desconexion INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN salidas_x INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN salidas_canal INTEGER DEFAULT 0"
    ];

    actualizaciones.forEach(sql => {
        db.run(sql, (err) => {});
    });

    console.log("👍 Tablas verificadas.");
});

module.exports = db;