const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    user: 'root',           
    host: 'localhost',
    database: 'caku',
    password: '',           
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function addTransaction(amount, description) {
    const [result] = await pool.execute(
        "INSERT INTO transactions (amount, description) VALUES (?, ?)",
        [amount, description]
    );
    return result.insertId;
}

async function getSummary(month = null) {
    let query = "SELECT * FROM transactions";
    let params = [];

    if (month) {
        // format bulan pakai MM-YYYY
        query += " WHERE DATE_FORMAT(created_at, '%m-%Y') = ?";
        params.push(month);
    }

    query += " ORDER BY created_at DESC LIMIT 20";

    const [rows] = await pool.execute(query, params);

    let saldo = 0;
    rows.forEach(r => saldo += r.amount);

    return { saldo, rows };
}

module.exports = { addTransaction, getSummary };
