const { Pool } = require('pg');

// URL de conexión (La tomará de las variables de entorno de Render)
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error("❌ ERROR: No hay DATABASE_URL configurada.");
}

// Configuración del Pool para Neon
const db = new Pool({
    connectionString: connectionString,
    ssl: {
        rejectUnauthorized: false, // Neon usa certificados autofirmados a veces, esto evita errores
    },
    max: 20, // Límite de conexiones simultáneas (el plan gratis de Neon soporta bastantes)
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Inicializador de Tablas (Se ejecuta al arrancar para crear la estructura si está vacía)
const initDB = async () => {
    try {
        console.log("🔄 Conectando a Neon Tech...");
        const res = await db.query('SELECT NOW()');
        console.log("✅ ¡Conexión exitosa a Neon!", res.rows[0]);

        // --- CREACIÓN DE TABLAS ---

        // 1. Usuarios
        await db.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
            player_tag TEXT,
            saldo NUMERIC DEFAULT 0,
            tipo_suscripcion TEXT DEFAULT 'free',
            estado TEXT DEFAULT 'normal',
            sala_actual TEXT DEFAULT NULL,
            paso_juego INTEGER DEFAULT 0,
            ganancia_generada NUMERIC DEFAULT 0,
            faltas INTEGER DEFAULT 0,
            total_victorias INTEGER DEFAULT 0,
            victorias_normales INTEGER DEFAULT 0,
            victorias_disputa INTEGER DEFAULT 0,
            total_derrotas INTEGER DEFAULT 0,
            derrotas_normales INTEGER DEFAULT 0,
            derrotas_disputa INTEGER DEFAULT 0,
            total_partidas INTEGER DEFAULT 0,
            salidas_chat INTEGER DEFAULT 0,
            salidas_desconexion INTEGER DEFAULT 0,
            salidas_x INTEGER DEFAULT 0,
            salidas_canal INTEGER DEFAULT 0
        )`);
        // Migración: Agregar columna player_tag si no existe
        await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS player_tag TEXT`);

        // 2. Mensajes
        await db.query(`CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            canal TEXT DEFAULT 'general',
            usuario TEXT,
            texto TEXT,
            tipo TEXT DEFAULT 'texto',
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // 3. Partidas
        await db.query(`CREATE TABLE IF NOT EXISTS matches (
            id SERIAL PRIMARY KEY,
            jugador1 TEXT,
            jugador2 TEXT,
            modo TEXT,
            apuesta NUMERIC,
            ganador TEXT DEFAULT NULL,
            estado TEXT DEFAULT 'en_curso',
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // 4. Transacciones
        await db.query(`CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            usuario_id INTEGER,
            usuario_nombre TEXT,
            tipo TEXT,
            metodo TEXT,
            monto NUMERIC,
            referencia TEXT,
            estado TEXT DEFAULT 'pendiente',
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // 5. Bóveda Admin
        await db.query(`CREATE TABLE IF NOT EXISTS admin_wallet (
            id SERIAL PRIMARY KEY,
            monto NUMERIC,
            razon TEXT,
            detalle TEXT,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await db.query(`CREATE TABLE IF NOT EXISTS user_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            fcm_token TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id, fcm_token)
        )`);

        console.log("👍 Tablas verificadas en Neon.");

    } catch (err) {
        console.error("❌ Error inicializando Neon:", err.message);
    }
};


initDB();

module.exports = db;