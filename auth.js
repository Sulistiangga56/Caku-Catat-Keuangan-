const fs = require('fs');
const path = require('path');
const USERS_FILE = path.resolve('./users.json');

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getUser(jid) {
  const users = loadUsers();
  return users.find(u => u.jid === jid);
}

function generateToken(days = 3) {
  const token = Math.random().toString(36).substring(2, 10).toUpperCase();
  const users = loadUsers();
  users.push({
    token,
    active: false,
    createdAt: new Date().toISOString(),
    expiresInDays: days
  });
  saveUsers(users);
  return token;
}

function verifyToken(jid, token) {
  const users = loadUsers();
  const user = users.find(u => u.token === token);
  if (!user) return { success: false, msg: 'Token tidak valid.' };

  // hanya bisa digunakan sekali
  if (user.active) return { success: false, msg: 'Token sudah digunakan.' };

  // aktifkan token
  user.active = true;
  user.jid = jid;
  user.activatedAt = new Date().toISOString();
  saveUsers(users);
  return { success: true, msg: 'Token berhasil diaktifkan!' };
}

function isAuthorized(jid) {
  const users = loadUsers();
  const user = users.find(u => u.jid === jid && u.active);
  if (!user) return false;

  // cek expired
  const activated = new Date(user.activatedAt);
  const now = new Date();
  const diffDays = Math.floor((now - activated) / (1000 * 60 * 60 * 24));

  if (diffDays >= user.expiresInDays) {
    user.active = false;
    saveUsers(users);
    return false;
  }

  return true;
}

function listUsers() {
  const users = loadUsers();
  return users.map(u => {
    let status = '❌ Tidak aktif';
    if (u.active) {
      const activated = new Date(u.activatedAt);
      const now = new Date();
      const diffDays = Math.floor((now - activated) / (1000 * 60 * 60 * 24));
      const sisa = u.expiresInDays - diffDays;
      status = sisa > 0 ? `✅ Aktif (${sisa} hari tersisa)` : '⚠️ Kadaluarsa';
    }
    return {
      token: u.token,
      jid: u.jid || '-',
      status,
      expiresInDays: u.expiresInDays
    };
  });
}

function deactivateUser(jid) {
  const users = loadUsers();
  const user = users.find(u => u.jid === jid);
  if (!user) return false;
  user.active = false;
  saveUsers(users);
  return true;
}

module.exports = {
  loadUsers,
  saveUsers,
  getUser,
  generateToken,
  verifyToken,
  isAuthorized,
  listUsers,
  deactivateUser
};
