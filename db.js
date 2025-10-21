// db.js
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',      // sesuaikan
  password: '',      // sesuaikan
  database: 'caku',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// TRANSACTIONS
async function addTransaction(user_id, amount, description, category, created_at = null) {
  const dateValue = created_at || moment().format('YYYY-MM-DD HH:mm:ss');

  const [result] = await pool.query(
    'INSERT INTO transactions (user_id, amount, description, category, created_at) VALUES (?, ?, ?, ?, ?)',
    [user_id, amount, description, category, dateValue]
  );

  return result.insertId;
}

async function editTransaction(id, userId, amount, description, category = null) {
  const [res] = await pool.execute(
    `UPDATE transactions SET amount = ?, description = ?, category = ? WHERE id = ? AND user_id = ?`,
    [amount, description, category, id, userId]
  );
  return res.affectedRows;
}

async function deleteTransaction(id, userId) {
  const [res] = await pool.execute(
    `DELETE FROM transactions WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  return res.affectedRows;
}

// Get last N or filtered transactions
// --- bagian atas file: tetap sama (pool dll) ---

// Get last N or filtered transactions (fixed)
async function getTransactions(userId, opts = {}) {
  let { limit = 50, month = null, category = null, since = null, until = null } = opts;

  // pastikan limit integer dan wajar
  limit = Number.parseInt(limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 1000) limit = 1000; // safety cap

  const whereParts = [];
  const params = [];

  // tambahkan kondisi hanya jika ada
  if (userId) {
    whereParts.push('user_id = ?');
    params.push(userId);
  }
  if (month) {
    whereParts.push("DATE_FORMAT(created_at, '%m-%Y') = ?");
    params.push(month);
  }
  if (category) {
    whereParts.push('category = ?');
    params.push(category);
  }
  if (since) {
    whereParts.push('created_at >= ?');
    params.push(since);
  }
  if (until) {
    whereParts.push('created_at <= ?');
    params.push(until);
  }

  let query = 'SELECT * FROM transactions';
  if (whereParts.length) {
    query += ' WHERE ' + whereParts.join(' AND ');
  }

  // inject limit sebagai angka (safe karena sudah parseInt)
  query += ` ORDER BY created_at DESC LIMIT ${limit}`;

  // debug logging singkat (bisa dihapus nanti)
  // console.log('getTransactions SQL:', query, 'params:', params);

  const [rows] = await pool.execute(query, params);
  return rows;
}

async function getSummary(userId, month = null) {
  const whereParts = [];
  const params = [];

  if (userId) {
    whereParts.push('user_id = ?');
    params.push(userId);
  }
  if (month) {
    whereParts.push("DATE_FORMAT(created_at, '%m-%Y') = ?");
    params.push(month);
  }

  let whereSql = '';
  if (whereParts.length) whereSql = ' WHERE ' + whereParts.join(' AND ');

  const saldoQuery = `SELECT COALESCE(SUM(amount),0) as saldo FROM transactions${whereSql}`;
  const [r] = await pool.execute(saldoQuery, params);
  const saldo = r[0].saldo || 0;

  // gunakan fungsi getTransactions yang sudah aman
  const rows = await getTransactions(userId, { limit: 100, month });

  return { saldo, rows };
}

async function getCategorySummary(userId, month = null) {
  const params = [];
  let query = `SELECT category, SUM(amount) as total, SUM(CASE WHEN amount<0 THEN amount ELSE 0 END) as total_negative FROM transactions`;

  const whereParts = [];
  if (userId) {
    whereParts.push('user_id = ?');
    params.push(userId);
  }
  if (month) {
    whereParts.push("DATE_FORMAT(created_at, '%m-%Y') = ?");
    params.push(month);
  }
  if (whereParts.length) {
    query += ' WHERE ' + whereParts.join(' AND ');
  }

  query += ` GROUP BY category ORDER BY ABS(SUM(amount)) DESC`;

  const [rows] = await pool.execute(query, params);
  return rows;
}

async function getCategories(userId, month = null) {
  const params = [userId];
  let query = `
    SELECT category, SUM(amount) as total
    FROM transactions
    WHERE user_id = ?
  `;

  if (month) {
    query += ` AND DATE_FORMAT(created_at, '%m-%Y') = ?`;
    params.push(month);
  }

  query += ` GROUP BY category ORDER BY ABS(SUM(amount)) DESC`;

  const [rows] = await pool.execute(query, params);
  return rows;
}

// SETTINGS
async function setTarget(userId, target) {
  // upsert
  const [res] = await pool.execute(
    `INSERT INTO settings (user_id, target) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE target = ?`,
    [userId, target, target]
  );
  return res;
}

// async function setReminder(userId, timeStr) {
//   const [res] = await pool.execute(
//     `INSERT INTO settings (user_id, reminder_time) VALUES (?, ?)
//      ON DUPLICATE KEY UPDATE reminder_time = ?`,
//     [userId, timeStr, timeStr]
//   );
//   return res;
// }

// setReminder(userId, time, msg)
async function setReminder(userId, time, msg = null) {
  const conn = await pool.getConnection();
  try {
    const sql = `
      INSERT INTO settings (user_id, reminder_time, reminder_msg)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE reminder_time = VALUES(reminder_time), reminder_msg = VALUES(reminder_msg)
    `;
    await conn.execute(sql, [userId, time, msg || '⏰ Reminder catat keuangan hari ini!']);
  } finally {
    conn.release();
  }
}

async function getAllUsersWithReminder() {
  const [rows] = await pool.execute(`
    SELECT user_id, reminder_time, reminder_msg FROM settings
    WHERE reminder_time IS NOT NULL
  `);
  return rows;
}

async function getSettings(userId) {
  const [rows] = await pool.execute(`SELECT * FROM settings WHERE user_id = ?`, [userId]);
  return rows[0] || null;
}

// AES encryption helper
const AES_KEY = process.env.AES_KEY || 'MY_SUPER_SECRET_KEY_32CHARS!!';
function encrypt(text, key) {
  if (!text || !key) throw new Error('encrypt(): text dan key harus terisi');
  const iv = crypto.randomBytes(16);
  const hashKey = crypto.createHash('sha256').update(String(key)).digest();
  const cipher = crypto.createCipheriv('aes-256-cbc', hashKey, iv);
  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted, key) {
  if (!encrypted || !key) throw new Error('decrypt(): encrypted dan key harus terisi');
  const [ivHex, encryptedText] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const hashKey = crypto.createHash('sha256').update(String(key)).digest();
  const decipher = crypto.createDecipheriv('aes-256-cbc', hashKey, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ================= VAULT FUNCTIONS =================

async function setVaultPin(userId, pin) {
  if (!pin || !userId) throw new Error('PIN atau userId tidak boleh kosong');
  const pinHash = encrypt(pin, String(userId)); // gunakan userId sebagai key
  await pool.execute(
    `INSERT INTO vault_users (user_id, pin_hash)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE pin_hash = VALUES(pin_hash)`,
    [userId, pinHash]
  );
}

async function verifyVaultPin(userId, pin) {
  const [rows] = await pool.execute(`SELECT pin_hash FROM vault_users WHERE user_id = ?`, [userId]);
  if (rows.length === 0) return false;
  try {
    const decrypted = decrypt(rows[0].pin_hash, String(userId)); // gunakan userId sebagai key
    return decrypted === pin;
  } catch {
    return false;
  }
}

async function saveVaultVideo(userId, title, filePath) {
  await pool.execute(
    `INSERT INTO vault_videos (user_id, title, file_path) VALUES (?, ?, ?)`,
    [userId, title, filePath]
  );
}

async function listVaultVideos(userId) {
  const [rows] = await pool.execute(
    `SELECT id, title, file_path, created_at FROM vault_videos WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function getVaultVideo(userId, title) {
  const [rows] = await pool.execute(
    `SELECT * FROM vault_videos WHERE user_id = ? AND title = ? LIMIT 1`,
    [userId, title]
  );
  return rows[0] || null;
}

module.exports = {
  addTransaction,
  editTransaction,
  deleteTransaction,
  getTransactions,
  getSummary,
  getCategorySummary,
  getCategories,
  setTarget,
  setReminder,
  getSettings,
  getAllUsersWithReminder,
  setVaultPin,
  verifyVaultPin,
  saveVaultVideo,
  listVaultVideos,
  getVaultVideo,
  pool
};
