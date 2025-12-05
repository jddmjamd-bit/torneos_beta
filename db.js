const { Pool } = require('pg');

// TU URL DE SUPABASE AQUÍ (O mejor, usa process.env.DATABASE_URL en producción)
// Por ahora pégala aquí para probar, luego la movemos a variables de entorno.
const connectionString = process.env.DATABASE_URL || "postgresql://postgres:Juan030822...@db.wvcjkmuqlnscwrivpdmb.supabase.co:5432/postgres";

const db = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false } // Necesario para conexiones externas seguras
});

// Función para inicializar tablas (Sintaxis PostgreSQL)
const initDB = async () => {
    try {
        // USUARIOS (Usamos SERIAL para autoincrement)
        await db.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
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

        // MENSAJES
        await db.query(`CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            canal TEXT DEFAULT 'general',
            usuario TEXT,
            texto TEXT,
            tipo TEXT DEFAULT 'texto',
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // PARTIDAS
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

        // TRANSACCIONES
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

        // MIGRACIONES (Bóveda Admin)
        await db.query(`CREATE TABLE IF NOT EXISTS admin_wallet (
            id SERIAL PRIMARY KEY,
            monto NUMERIC,
            razon TEXT,
            detalle TEXT,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        console.log("👍 Base de datos PostgreSQL conectada y verificada.");
    } catch (err) {
        console.error("❌ Error inicializando DB:", err);
    }
};

initDB();

module.exports = db;