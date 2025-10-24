// index.js
require("dotenv").config();
const { runOsint } = require('./osint');

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('baileys');
const {
  pool, addTransaction, editTransaction, deleteTransaction, getSummary, getTransactions,
  getCategorySummary, setTarget, setReminder, getSettings, getAllUsersWithReminder, setVaultPin, verifyVaultPin, saveVaultVideo,
  listVaultVideos, getVaultVideo
} = require('./db');

const {
  verifyToken,
  isAuthorized,
  generateToken,
  listUsers,
  deactivateUser
} = require('./auth');
const ADMIN_JID = process.env.ADMIN_JID;
const moment = require('moment');
const qrcode = require('qrcode-terminal');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});
const { startDailyMotivation, getMotivation } = require('./dailyMotivation');

// const vaultState = {};
const VAULT_DIR = path.join(__dirname, 'vault_videos');
const VAULT_DRIVE_FOLDER_LINK = process.env.VAULT_DRIVE_FOLDER_LINK;
const VAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 menit
if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR);
global.vaultState = global.vaultState || {};
const vaultState = global.vaultState;
const ADMIN_BOT = process.env.ADMIN_BOT;

const OUT_DIR = path.resolve(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

(async () => {
  const res = await openai.chat.completions.create({
    model: "openai/gpt-oss-20b",
    messages: [{ role: "user", content: "Halo dari Caku bot!" }],
  });
  console.log(res.choices[0].message);
})();


// Helpers
function formatCurrency(n) {
  return `Rp${Number(n).toLocaleString('id-ID')}`;
}

function parseAmountAndMeta(rawText) {
  const text = rawText.trim();

  // Nominal (+ / -)
  const amountMatch = text.match(/([+-]?\d+)/);
  const amount = amountMatch ? parseInt(amountMatch[1]) : NaN;

  // Kategori (misal [Kebutuhan Pokok])
  const categoryMatch = text.match(/\[(.*?)\]/);
  const category = categoryMatch ? categoryMatch[1].trim() : null;

  // 🔍 Cek apakah ada tanggal: "tanggal 20-10-2025" atau "tanggal 20/10/2025"
  const dateMatch = text.match(/tanggal\s+(\d{1,2}[-/]\d{1,2}[-/]\d{4})/i);
  const date = dateMatch
    ? moment(dateMatch[1], ['DD-MM-YYYY', 'DD/MM/YYYY']).format('YYYY-MM-DD HH:mm:ss')
    : moment().format('YYYY-MM-DD HH:mm:ss'); // default: hari ini

  // Deskripsi → hapus bagian amount, kategori, dan tanggal biar bersih
  const description = text
    .replace(amountMatch ? amountMatch[0] : '', '')
    .replace(categoryMatch ? categoryMatch[0] : '', '')
    .replace(dateMatch ? dateMatch[0] : '', '')
    .replace(/\s+/g, ' ')
    .trim();

  return { amount, description, category, date };
}

// Export XLSX
async function generateXlsx(userId, rows, meta = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Laporan');
  ws.addRow(['Laporan Keuangan']);
  ws.addRow([`User: ${userId}`, `Generated: ${moment().format('YYYY-MM-DD HH:mm')}`]);
  ws.addRow([]);
  ws.addRow(['ID', 'Tanggal', 'Amount', 'Description', 'Category']);
  rows.forEach(r => {
    ws.addRow([r.id, moment(r.created_at).format('YYYY-MM-DD HH:mm'), r.amount, r.description, r.category]);
  });
  const filename = path.join(OUT_DIR, `laporan_${userId}_${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(filename);
  return filename;
}

// Export PDF (simple)
async function generatePdf(userId, rows, meta = {}) {
  const filename = path.join(OUT_DIR, `laporan_${userId}_${Date.now()}.pdf`);
  const doc = new PDFDocument({ margin: 30 });
  doc.pipe(fs.createWriteStream(filename));
  doc.fontSize(16).text('Laporan Keuangan', { align: 'center' });
  doc.moveDown();
  doc.fontSize(10).text(`User: ${userId}`, { align: 'left' });
  doc.text(`Generated: ${moment().format('YYYY-MM-DD HH:mm')}`);
  doc.moveDown();
  rows.forEach(r => {
    doc.text(`#${r.id} ${moment(r.created_at).format('YYYY-MM-DD HH:mm')} | ${r.amount >= 0 ? '+' : ''}${r.amount} | ${r.description} | ${r.category || '-'}`);
  });
  doc.end();
  // wait until file exists
  await new Promise(res => setTimeout(res, 500));
  return filename;
}

// Generate chart using QuickChart (no API key necessary for simple charts)
function quickChartUrl(labels, dataValues, title = 'Pengeluaran per Kategori') {
  const chartConfig = {
    type: 'pie',
    data: {
      labels,
      datasets: [{ data: dataValues }]
    },
    options: {
      title: { display: true, text: title }
    }
  };
  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?c=${encoded}&format=png&width=800&height=400`;
}

// small utils
function uniqArray(arr) {
  return Array.from(new Set(arr));
}

function sum(arr) {
  return arr.reduce((a, b) => a + (Number(b) || 0), 0);
}

// COMMANDS
const commands = {
  help: async (sock, from) => {
    const helpText = [
      '📌 *Panduan Singkat — CAKU Bot*',
      '',
      '🗂️ Menu Utama',
      '• Ketik `menu` atau `help` untuk melihat menu utama',
      '',
      '📝 Pencatatan Cepat',
      '• `+100000 Gaji [salary]` → catat pemasukan',
      '• `+100000 Gaji tanggal 10-10-2025 [salary]` → catat pemasukan untuk tanggal tertentu',
      '• `-50000 Makan [food]` → catat pengeluaran',
      '• `-50000 Makan tanggal 10-10-2025 [food]` → catat pengeluaran untuk tanggal tertentu',
      '• `edit <id> <amount> <desc> [category]` → ubah transaksi',
      '• `hapus <id>` → hapus transaksi',
      '',
      '📊 Laporan & Export',
      '• `laporan` → ringkasan terbaru',
      '• `laporan bulan MM-YYYY` → laporan per bulan',
      '• `laporan kategori <nama>` → laporan per kategori',
      '• `laporan tanggal DD-MM-YYYY` atau `DD-MM-YYYY - DD-MM-YYYY` → laporan per tanggal / rentang',
      '• `laporan export [MM-YYYY]` → ekspor XLSX & PDF',
      '• `grafik MM-YYYY` → grafik pie kategori',
      '',
      '🎯 Target & Reminder',
      '• `target 10000000` → set target tabungan',
      '• `progress` → lihat progres target',
      '• `reminder HH:mm` → set reminder harian',
      '• `reminder pesan <teks>` → ubah teks reminder',
      '• `reminder list` / `reminder off`',
      '',
      '🔒 Vault (simpan video pribadi)',
      '• `vault pin <pin>` → set PIN (minimal 4 angka)',
      '• `vault auth <pin>` → login ke Vault',
      '• `vault logout` → logout Vault',
      '• `upload video <judul> [drive|local]` → kirim video setelah perintah',
      '• `vault list` → lihat daftar video',
      '• `vault get <judul>` → ambil video',
      '',
      '🔎 Lainnya',
      '• `cari <kata>` → cari transaksi',
      '• `kategori` → daftar kategori',
      '• `pengeluaran [MM-YYYY]` / `pemasukan [MM-YYYY]`',
      '• `saran` → saran penghematan AI',
      '• `backup` → kirim file .xlsx backup',
      '• `reset` → hapus semua transaksi (butuh konfirmasi `reset iya`)',
      '• `motivasi <serius, lucu, dark>` → pesan motivasi',
      '',
      'ℹ️ Contoh cepat:',
      '• `+150000 Gaji bulan ini [salary]`',
      '• `laporan tanggal 10-10-2025 - 17-10-2025`',
      '• `upload video Liburan drive` lalu kirim videonya',
      '',
      'Butuh bantuan lebih lanjut? Ketik `menu` untuk kembali ke menu utama.'
    ].join('\n');

    await sock.sendMessage(from, { text: helpText });
  },

  'admin': async (sock, from, args) => {
    if (!args.length) {
      return sock.sendMessage(from, { text: 'Ketik: *Admin Pesan Anda*\nContoh: _Admin saya ingin menanyakan cara melihat laporan bulan ini_' });
    }

    const message = args.join(' ');
    const adminBot = process.env.ADMIN_BOT; // nomor pengirim admin (bot)
    const adminJid = process.env.ADMIN_JID; // nomor penerima notifikasi (admin utama)

    // Kirim balasan ke user
    await sock.sendMessage(from, {
      text: `🙏 *Terima kasih telah menghubungi Admin.*\nMohon tunggu beberapa saat, Admin akan segera membalas pesan Anda.`
    });

    // Kirim notifikasi ke admin utama
    await sock.sendMessage(adminJid, {
      text: `📩 *Notifikasi Pesan Baru dari Pengguna*\n\n👤 Dari: ${from}\n💬 Pesan: ${message}`
    });

    console.log(`📨 Pesan admin dari ${from}: ${message}`);
  },

  // quick keyword search (client side filtering)
  cari: async (sock, from, args) => {
    const keyword = args.join(' ').toLowerCase().trim();
    if (!keyword) return sock.sendMessage(from, { text: 'Format: cari <kata>' });

    // ambil banyak data (limit tinggi)
    const rows = await getTransactions(from, { limit: 1000 });
    const found = rows.filter(r => (r.description || '').toLowerCase().includes(keyword));
    if (!found.length) return sock.sendMessage(from, { text: 'Tidak ditemukan transaksi yang cocok.' });

    let rep = `🔍 Hasil pencarian: "${keyword}"\n\n`;
    found.slice(0, 50).forEach(r => {
      rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${r.category || '-'} | ${moment(r.created_at).format('DD/MM HH:mm')}\n`;
    });
    if (found.length > 50) rep += `\n...dan ${found.length - 50} hasil lainnya.`;
    await sock.sendMessage(from, { text: rep });
  },

  split: async (sock, from, rawText) => {
    // pastikan string
    if (Array.isArray(rawText)) rawText = rawText.join(' ');
    if (typeof rawText !== 'string') {
      rawText = rawText?.conversation || rawText?.text || String(rawText);
    }

    // console.log('[DEBUG split input]', rawText);

    const regex = /bayar\s+(\d+)\s+(.*?)\s*-\s*bareng\s+(@[\d\s,@]+)(?:\s+via\s+([\w\s]+))?/i;
    const match = rawText.match(regex);
    if (!match) {
      return sock.sendMessage(from, { text: '⚠️ Format salah.\n\n📘 Contoh benar:\nBayar 150000 makan - bareng @62812345, @62898765 via Dana' });
    }

    const total = parseInt(match[1]);
    const description = match[2].trim();
    const peopleText = match[3].trim();
    const method = (match[4] || 'Transfer').trim();

    const numbers = peopleText.split(/[, ]+/).map(n => n.replace('@', '').trim()).filter(Boolean);
    const everyone = [from, ...numbers];
    const perPerson = Math.round(total / everyone.length);

    for (const num of numbers) {
      const jid = num.includes('@s.whatsapp.net') ? num : `${num}@s.whatsapp.net`;
      const prettyMethod = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
      await sock.sendMessage(jid, {
        text: `💸 *Patungan Otomatis*\n@${from.split('@')[0]} telah membayar *Rp${perPerson.toLocaleString()}* untuk *${description}* melalui *${prettyMethod}*.\n\nSilakan konfirmasi bila sudah diterima.`,
        mentions: [from]
      });
    }

    await sock.sendMessage(from, {
      text: `✅ Transaksi dibagi rata ke ${numbers.length} orang.\nMasing-masing: Rp${perPerson.toLocaleString()} (${method}).`
    });

    await addTransaction(from, -perPerson, `${description} (Patungan)`, 'Patungan');
  },

  tambah: async (sock, from, rawText) => {
    const { amount, description, category, date } = parseAmountAndMeta(rawText);

    if (!Number.isFinite(amount)) {
      return await sock.sendMessage(from, { text: '⚠️ Format jumlah tidak valid. Contoh: +100000 Gaji [Pemasukan]' });
    }

    const id = await addTransaction(from, amount, description, category, date);

    await sock.sendMessage(from, {
      text: `✅ Tercatat (ID ${id}): ${formatCurrency(amount)} - ${description} ${category ? '[' + category + ']' : ''}\n📅 Tanggal: ${moment(date).format('DD MMMM YYYY')}`
    });
  },

  laporan: async (sock, from, args) => {
    // laporan per bulan
    if (args[0] === 'bulan' && args[1]) {
      const month = args[1];
      const { saldo, rows } = await getSummary(from, month);

      // hitung total masuk & keluar
      const totalMasuk = rows.filter(r => r.amount > 0).reduce((sum, r) => sum + r.amount, 0);
      const totalKeluar = rows.filter(r => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0);

      let rep = `📊 Laporan Bulan ${month}\n\n`;
      rep += `💰 Total Pemasukan : ${formatCurrency(totalMasuk)}\n`;
      rep += `💸 Total Pengeluaran : ${formatCurrency(totalKeluar)}\n`;
      rep += `🧾 Saldo Akhir : ${formatCurrency(totalMasuk - totalKeluar)}\n\n`;

      rows.forEach(r => {
        rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${r.category || '-'} | ${moment(r.created_at).format('DD/MM HH:mm')}\n`;
      });

      await sock.sendMessage(from, { text: rep });
      return;
    }

    // export
    if (args[0] === 'export') {
      const month = args[1] || null;
      const rows = await getTransactions(from, { limit: 1000, month });
      const xlsx = await generateXlsx(from, rows);
      const pdf = await generatePdf(from, rows);

      await sock.sendMessage(from, { text: 'Menyiapkan file export...' });

      await sock.sendMessage(from, {
        document: fs.readFileSync(xlsx),
        fileName: path.basename(xlsx),
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      await sock.sendMessage(from, {
        document: fs.readFileSync(pdf),
        fileName: path.basename(pdf),
        mimetype: 'application/pdf'
      });
      return;
    }

    // laporan per kategori
    if ((args[0] === 'kategori' || args[0] === 'Kategori') && args[1]) {
      const category = args.slice(1).join(' ');
      const rows = await getTransactions(from, { limit: 200, category });

      // hitung total masuk & keluar
      const totalMasuk = rows.filter(r => r.amount > 0).reduce((sum, r) => sum + r.amount, 0);
      const totalKeluar = rows.filter(r => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0);

      let rep = `📊 Laporan Kategori: ${category}\n\n`;
      rep += `💰 Total Pemasukan : ${formatCurrency(totalMasuk)}\n`;
      rep += `💸 Total Pengeluaran : ${formatCurrency(totalKeluar)}\n`;
      rep += `🧾 Selisih : ${formatCurrency(totalMasuk - totalKeluar)}\n\n`;

      rows.forEach(r => {
        rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${moment(r.created_at).format('DD/MM HH:mm')}\n`;
      });

      await sock.sendMessage(from, { text: rep });
      return;
    }

    // laporan default (recent)
    const { saldo, rows } = await getSummary(from, null);

    // hitung total masuk & keluar dari rows
    const totalMasuk = rows.filter(r => r.amount > 0).reduce((sum, r) => sum + r.amount, 0);
    const totalKeluar = rows.filter(r => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0);

    let rep = `📊 Laporan Terbaru\n\n`;
    rep += `💰 Total Pemasukan : ${formatCurrency(totalMasuk)}\n`;
    rep += `💸 Total Pengeluaran : ${formatCurrency(totalKeluar)}\n`;
    rep += `🧾 Saldo Akhir : ${formatCurrency(totalMasuk - totalKeluar)}\n\n`;

    rows.slice(0, 30).forEach(r => {
      rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${r.category || '-'} | ${moment(r.created_at).format('DD/MM HH:mm')}\n`;
    });

    await sock.sendMessage(from, { text: rep });
  },

  grafik: async (sock, from, args) => {
    const month = args[0] || null;
    const rows = await getCategorySummary(from, month);
    if (!rows.length) return await sock.sendMessage(from, { text: 'Tidak ada data untuk membuat grafik.' });

    const labels = rows.map(r => r.category || 'Uncategorized');
    const values = rows.map(r => Math.abs(Number(r.total)));
    const url = quickChartUrl(labels, values, `Pengeluaran ${month || ''}`);
    // download image
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    await sock.sendMessage(from, { image: resp.data, caption: `📊 Grafik ${month || ''}` });
  },

  saldo: async (sock, from) => {
    const { saldo } = await getSummary(from, null);
    await sock.sendMessage(from, { text: `💰 Saldo saat ini: ${formatCurrency(saldo)}` });
  },

  // kategori: list unique categories
  kategori: async (sock, from) => {
    const rows = await getTransactions(from, { limit: 1000 });
    const categories = Array.from(
      new Set(
        rows
          .map(r => (r.category || '').trim())
          .filter(c => c.length > 0)
      )
    );
    if (!categories.length) {
      await sock.sendMessage(from, { text: 'Belum ada kategori yang tercatat.' });
      return;
    }
    await sock.sendMessage(from, { text: `📊 Daftar Kategori Tercatat:\n\n${categories.map((c, i) => `${i + 1}. ${c}`).join('\n')}` });
  },

  // totals by sign
  pengeluaran: async (sock, from, args) => {
    const month = args[0] || null; // expect MM-YYYY
    const rows = await getTransactions(from, { limit: 1000, month });
    const neg = rows.filter(r => Number(r.amount) < 0).map(r => Number(r.amount));
    const totalNeg = Math.abs(sum(neg));
    await sock.sendMessage(from, { text: `📉 Total Pengeluaran ${month ? `bulan ${month}` : ''}: ${formatCurrency(totalNeg)}` });
  },

  pemasukan: async (sock, from, args) => {
    const month = args[0] || null;
    const rows = await getTransactions(from, { limit: 1000, month });
    const pos = rows.filter(r => Number(r.amount) > 0).map(r => Number(r.amount));
    const totalPos = sum(pos);
    await sock.sendMessage(from, { text: `📈 Total Pemasukan ${month ? `bulan ${month}` : ''}: ${formatCurrency(totalPos)}` });
  },

  // laporan per hari, minggu, dan tanggal custom
  'hari': async (sock, from, args) => {
    if (args[0] === 'ini' || args[0] === undefined) {
      const start = moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const end = moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
      const rows = await getTransactions(from, { limit: 1000, since: start, until: end });
      if (!rows.length) return sock.sendMessage(from, { text: 'Tidak ada transaksi hari ini.' });

      const totalMasuk = rows.filter(r => r.amount > 0).reduce((sum, r) => sum + r.amount, 0);
      const totalKeluar = rows.filter(r => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0);

      let rep = `📅 *Transaksi Hari Ini (${moment().format('DD MMM YYYY')})*\n\n`;
      rep += `💰 Total Pemasukan : ${formatCurrency(totalMasuk)}\n`;
      rep += `💸 Total Pengeluaran : ${formatCurrency(totalKeluar)}\n`;
      rep += `🧾 Saldo Hari Ini : ${formatCurrency(totalMasuk - totalKeluar)}\n\n`;

      rows.forEach(r => {
        rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${r.category || '-'} | ${moment(r.created_at).format('HH:mm')}\n`;
      });
      return sock.sendMessage(from, { text: rep });
    }

    await sock.sendMessage(from, { text: 'Gunakan format: *hari ini*' });
  },

  'minggu': async (sock, from, args) => {
    if (args[0] === 'ini' || args[0] === undefined) {
      const start = moment().startOf('week').format('YYYY-MM-DD HH:mm:ss');
      const end = moment().endOf('week').format('YYYY-MM-DD HH:mm:ss');
      const rows = await getTransactions(from, { limit: 1000, since: start, until: end });
      if (!rows.length) return sock.sendMessage(from, { text: 'Tidak ada transaksi minggu ini.' });

      const totalMasuk = rows.filter(r => r.amount > 0).reduce((sum, r) => sum + r.amount, 0);
      const totalKeluar = rows.filter(r => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0);

      let rep = `📅 *Transaksi Minggu Ini (${moment(start).format('DD MMM')} - ${moment(end).format('DD MMM YYYY')})*\n\n`;
      rep += `💰 Total Pemasukan : ${formatCurrency(totalMasuk)}\n`;
      rep += `💸 Total Pengeluaran : ${formatCurrency(totalKeluar)}\n`;
      rep += `🧾 Saldo Minggu Ini : ${formatCurrency(totalMasuk - totalKeluar)}\n\n`;

      rows.forEach(r => {
        rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${r.category || '-'} | ${moment(r.created_at).format('dd DD/MM HH:mm')}\n`;
      });
      return sock.sendMessage(from, { text: rep });
    }

    await sock.sendMessage(from, { text: 'Gunakan format: *minggu ini*' });
  },

  'laporan_tanggal': async (sock, from, args) => {
    if (args[0] === 'tanggal' && args[1]) {
      const rangeInput = args.slice(1).join(' ').trim();
      let startDate, endDate;

      // pisahkan berdasarkan tanda " - "
      const rangeParts = rangeInput.split('-').map(x => x.trim());

      // 🧩 Deteksi apakah input mengandung dua tanggal penuh
      if (rangeParts.length >= 6) {
        // Format: DD-MM-YYYY - DD-MM-YYYY
        const startStr = `${rangeParts[0]}-${rangeParts[1]}-${rangeParts[2]}`;
        const endStr = `${rangeParts[3]}-${rangeParts[4]}-${rangeParts[5]}`;
        startDate = moment(startStr, 'DD-MM-YYYY', true);
        endDate = moment(endStr, 'DD-MM-YYYY', true);

        if (!startDate.isValid() || !endDate.isValid()) {
          return sock.sendMessage(from, { text: '⚠️ Format tanggal tidak valid.\nGunakan: *laporan tanggal 10-10-2025 - 17-10-2025*' });
        }
      } else {
        // Format: DD-MM-YYYY saja
        startDate = moment(rangeInput, 'DD-MM-YYYY', true);
        if (!startDate.isValid()) {
          return sock.sendMessage(from, { text: '⚠️ Format tanggal tidak valid.\nGunakan: *laporan tanggal 10-10-2025*' });
        }
        endDate = moment(startDate);
      }

      const start = startDate.startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const end = endDate.endOf('day').format('YYYY-MM-DD HH:mm:ss');

      const rows = await getTransactions(from, { limit: 2000, since: start, until: end });
      if (!rows.length) {
        return sock.sendMessage(from, { text: `Tidak ada transaksi antara ${startDate.format('DD MMM YYYY')} dan ${endDate.format('DD MMM YYYY')}.` });
      }

      const totalMasuk = rows.filter(r => r.amount > 0).reduce((sum, r) => sum + r.amount, 0);
      const totalKeluar = rows.filter(r => r.amount < 0).reduce((sum, r) => sum + Math.abs(r.amount), 0);

      let rep = `📅 *Laporan Transaksi*\n🗓️ Periode: ${startDate.format('DD MMM YYYY')} - ${endDate.format('DD MMM YYYY')}\n\n`;
      rep += `💰 Total Pemasukan : ${formatCurrency(totalMasuk)}\n`;
      rep += `💸 Total Pengeluaran : ${formatCurrency(totalKeluar)}\n`;
      rep += `🧾 Saldo Akhir : ${formatCurrency(totalMasuk - totalKeluar)}\n\n`;

      rows.forEach(r => {
        rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${r.category || '-'} | ${moment(r.created_at).format('DD/MM HH:mm')}\n`;
      });

      return sock.sendMessage(from, { text: rep });
    }

    // fallback ke laporan utama
    await commands.help(sock, from);
    return;
  },

  tahunan: async (sock, from, args) => {
    const year = args[0] || moment().format('YYYY');
    // gather per month totals
    const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0') + '-' + year); // MM-YYYY
    let rep = `📅 Ringkasan Tahun ${year}\n\n`;
    for (const m of months) {
      const { rows } = await getSummary(from, m);
      const total = sum(rows.map(r => Number(r.amount)));
      rep += `${m}: ${formatCurrency(total)} (${rows.length} transaksi)\n`;
    }
    await sock.sendMessage(from, { text: rep });
  },

  'ranking': async (sock, from, args) => {
    // usage: ranking kategori MM-YYYY
    if (args[0] === 'kategori' && args[1]) {
      const month = args[1];
      const rows = await getCategorySummary(from, month);
      if (!rows.length) return sock.sendMessage(from, { text: 'Tidak ada data.' });
      // sort by total negative (spending) or abs total
      const ranked = rows.sort((a, b) => Math.abs(b.total) - Math.abs(a.total)).slice(0, 10);
      let rep = `🏆 Ranking Kategori ${month}:\n\n`;
      ranked.forEach((r, i) => {
        rep += `${i + 1}. ${r.category || 'Uncategorized'} — ${formatCurrency(Math.abs(Number(r.total)))}\n`;
      });
      return sock.sendMessage(from, { text: rep });
    }
    await sock.sendMessage(from, { text: 'Format: ranking kategori MM-YYYY' });
  },

  stat: async (sock, from) => {
    const rows = await getTransactions(from, { limit: 1000 });
    const totalTrans = rows.length;
    const categories = Array.from(new Set(rows.map(r => (r.category || '').trim()).filter(Boolean)));
    const totalPengeluaran = sum(rows.filter(r => Number(r.amount) < 0).map(r => Number(r.amount)));
    const totalPemasukan = sum(rows.filter(r => Number(r.amount) > 0).map(r => Number(r.amount)));
    const avgPerTrans = totalTrans ? ((totalPemasukan + totalPengeluaran) / totalTrans) : 0;
    const rep = [
      `📊 Statistik Singkat`,
      `Transaksi: ${totalTrans}`,
      `Kategori aktif: ${categories.length}`,
      `Total Pemasukan: ${formatCurrency(totalPemasukan)}`,
      `Total Pengeluaran: ${formatCurrency(Math.abs(totalPengeluaran))}`,
      `Rata-rata per transaksi: ${formatCurrency(Math.abs(avgPerTrans))}`
    ].join('\n');
    await sock.sendMessage(from, { text: rep });
  },

  // reminder controls
  reminder: async (sock, from, args) => {
    const sub = args[0];
    if (!sub) return sock.sendMessage(from, { text: 'Format: reminder HH:mm | reminder list | reminder off | reminder pesan <text>' });

    if (sub === 'list') {
      const settings = await getSettings(from);
      if (!settings || !settings.reminder_time) return sock.sendMessage(from, { text: 'Belum ada reminder diset.' });
      return sock.sendMessage(from, { text: `Reminder: ${settings.reminder_time}\nPesan: ${settings.reminder_msg || '-'}` });
    }

    if (sub === 'off') {
      await setReminder(from, null);
      return sock.sendMessage(from, { text: 'Reminder dimatikan.' });
    }

    // index.js (Bagian 'reminder pesan')
    if (sub === 'pesan') {
      const text = args.slice(1).join(' ');
      if (!text) return sock.sendMessage(from, { text: 'Format: reminder pesan <teks>' });

      const settings = await getSettings(from);
      const time = settings?.reminder_time || null;

      // Jika belum ada waktu, set waktu default tapi simpan pesannya
      const timeToSet = time || '00:00';

      // 💡 Perbaikan: Kirim pesan baru (text) ke fungsi setReminder
      await setReminder(from, timeToSet, text);

      return sock.sendMessage(from, {
        text: `✅ Pesan reminder berhasil diubah menjadi:\n*${text}*.\nReminder aktif pada: ${timeToSet}`
      });
    }

    // otherwise treat as time
    const time = sub;
    if (!/^\d{2}:\d{2}$/.test(time)) return sock.sendMessage(from, { text: 'Format: reminder HH:mm (24h)' });

    // 💡 Tambahan: Ambil settings untuk mempertahankan pesan yang sudah ada
    const settings = await getSettings(from);
    const existingMsg = settings?.reminder_msg || null;

    // Gunakan existingMsg, bukan null, agar tidak tertimpa pesan default
    await setReminder(from, time, existingMsg);
    await sock.sendMessage(from, { text: `⏰ Reminder harian diset pada ${time}${existingMsg ? `\nPesan: ${existingMsg}` : ''}` });
    // const time = sub;
    // if (!/^\d{2}:\d{2}$/.test(time)) return sock.sendMessage(from, { text: 'Format: reminder HH:mm (24h)' });
    // await setReminder(from, time);
    // await sock.sendMessage(from, { text: `⏰ Reminder harian diset pada ${time}` });
  },

  // backup XLSX quick
  backup: async (sock, from) => {
    const rows = await getTransactions(from, { limit: 5000 });
    if (!rows.length) return sock.sendMessage(from, { text: 'Belum ada transaksi untuk di-backup.' });
    const xlsx = await generateXlsx(from, rows);
    await sock.sendMessage(from, { document: fs.readFileSync(xlsx), fileName: path.basename(xlsx), mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  },

  // reset (destructive) - require confirm
  reset: async (sock, from, args) => {
    const confirm = args[0];
    if (confirm !== 'iya' && confirm !== 'yes') {
      return sock.sendMessage(from, { text: 'Konfirmasi reset: ketik `reset iya` untuk menghapus semua transaksi Anda. (PERMANENT)' });
    }
    // fetch all ids then delete
    const rows = await getTransactions(from, { limit: 5000 });
    for (const r of rows) {
      try { await deleteTransaction(r.id, from); } catch (e) { /* ignore per-row errors */ }
    }
    await sock.sendMessage(from, { text: '✅ Semua transaksi Anda telah dihapus.' });
  },

  saran: async (sock, from) => {
    try {
      const month = moment().format('MM-YYYY');
      const cats = await getCategorySummary(from, month);

      if (!cats.length) {
        await sock.sendMessage(from, { text: 'Belum ada data bulan ini untuk memberi saran.' });
        return;
      }

      // Urutkan kategori dari pengeluaran terbesar
      const sorted = cats.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      const summaryText = sorted.map(c =>
        `${c.category || 'Tanpa Kategori'}: ${formatCurrency(Math.abs(Number(c.total)))}`
      ).join('\n');

      // Buat prompt untuk ChatGPT
      const prompt = `
      Kamu adalah asisten keuangan pribadi yang ramah dan cerdas.
      Berikut ringkasan pengeluaran bulan ${month}:
      ${summaryText}

      Buatkan analisis singkat dan 2–3 saran praktis yang membantu user mengatur pengeluaran bulan depan.
      Gunakan gaya santai tapi tetap profesional, maksimal 5 kalimat.
      `;

      // Kirim ke ChatGPT
      const response = await openai.chat.completions.create({
        model: "openai/gpt-oss-20b", // ringan tapi cerdas
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
      });

      const advice = response.choices[0].message.content;
      await sock.sendMessage(from, { text: `💡 *Saran Keuangan AI (${month})*\n\n${advice}` });
    } catch (err) {
      console.error('Error di command saran:', err);
      await sock.sendMessage(from, { text: '⚠️ Gagal mendapatkan saran. Coba lagi nanti.' });
    }
  },

  progress: async (sock, from) => {
    const settings = await getSettings(from);
    if (!settings || !settings.target) return sock.sendMessage(from, { text: 'Belum ada target. Set target dengan: target 10000000' });
    const target = Number(settings.target);
    // current saved = total saldo
    const { saldo } = await getSummary(from, null);
    const percent = Math.min(100, Math.round((saldo / target) * 100));
    await sock.sendMessage(from, { text: `🎯 Target: ${formatCurrency(target)}\nTerkumpul: ${formatCurrency(saldo)} (${percent}%)` });
  },

  target: async (sock, from, args) => {
    const target = parseInt(args[0]);
    if (!Number.isFinite(target)) return await sock.sendMessage(from, { text: 'Format: target 10000000' });
    await setTarget(from, target);
    await sock.sendMessage(from, { text: `🎯 Target diset: ${formatCurrency(target)}` });
  },

  hapus: async (sock, from, args) => {
    const id = parseInt(args[0]);
    if (!id) return await sock.sendMessage(from, { text: 'Format: hapus <id>' });
    const affected = await deleteTransaction(id, from);
    if (affected) await sock.sendMessage(from, { text: `✅ Terhapus transaksi ID ${id}` });
    else await sock.sendMessage(from, { text: `❌ Gagal hapus. Pastikan ID benar dan milik Anda.` });
  },

  edit: async (sock, from, args, raw) => {
    // usage: edit 123 -50000 makan malam [food]
    const id = parseInt(args[0]);
    if (!id) return await sock.sendMessage(from, { text: 'Format: edit <id> <amount> <desc> [category]' });

    const rest = raw.split(/\s+/).slice(2).join(' ');
    const { amount, description, category } = parseAmountAndMeta(rest);
    if (!Number.isFinite(amount)) return await sock.sendMessage(from, { text: 'Amount invalid' });

    const affected = await editTransaction(id, from, amount, description, category);
    if (affected) await sock.sendMessage(from, { text: `✅ Terupdate ID ${id}` });
    else await sock.sendMessage(from, { text: `❌ Gagal update. Pastikan ID benar dan milik Anda.` });
  }
};

async function saveVaultVideoMessage(sock, msg, userId, title) {
  const media = msg.message.videoMessage;
  if (!media) throw new Error('Pesan bukan video');

  const stream = await downloadContentFromMessage(media, 'video');
  const buffer = [];
  for await (const chunk of stream) {
    buffer.push(chunk);
  }

  const fileName = `${Date.now()}_${title.replace(/\s+/g, '_')}.mp4`;
  const filePath = path.join(VAULT_DIR, fileName);
  fs.writeFileSync(filePath, Buffer.concat(buffer));

  await saveVaultVideo(userId, title, filePath);
  return filePath;
}


// MAIN message handler
async function handleMessage(sock, msg) {
  try {
    if (!msg || !msg.message) {
      // console.log('[DEBUG MSG TYPE] message kosong atau event sistem, dilewati.');
      return;
    }

    const msgType = Object.keys(msg.message)[0];
    // console.log('[DEBUG MSG TYPE]', msgType);

    if (!msg.key.remoteJid) return;
    const from = msg.key.remoteJid;
    const isVideo = !!msg.message?.videoMessage;
    if (msg.key.fromMe) return;

    // console.log('[bot] [VAULT DEBUG] vaultState check =>', vaultState[from]);

    // ======= HANDLE KETIKA VIDEO DIKIRIM =======
    if (msg.message.videoMessage && vaultState[from]?.uploadTitle) {
      // console.log(`[VAULT DEBUG] Detected videoMessage from ${from}, state:`, vaultState[from]);
      const title = vaultState[from].uploadTitle;
      const target = vaultState[from].uploadTarget;

      try {
        const media = msg.message.videoMessage;
        const stream = await downloadContentFromMessage(media, 'video');
        const buffer = [];
        for await (const chunk of stream) buffer.push(chunk);
        // console.log(`[VAULT DEBUG] Received video buffer, length=${Buffer.concat(buffer).length}`);

        if (target === 'drive') {
          // console.log('[VAULT DEBUG] Upload target: DRIVE');
          const driveModule = require('./drive');
          const uploadToDrive = driveModule.uploadToDrive || driveModule.default?.uploadToDrive;
          // Ambil folderId dari env VAULT_DRIVE_FOLDER_LINK (pastikan ini adalah folderId, bukan link)
          // Jika VAULT_DRIVE_FOLDER_LINK adalah link, ambil ID dari link
          let folderId = process.env.VAULT_DRIVE_FOLDER_LINK;
          // Jika folderId berupa link, ekstrak ID dari link Google Drive
          if (folderId && folderId.includes('folders/')) {
            const match = folderId.match(/\/folders\/([a-zA-Z0-9_-]+)/);
            if (match) folderId = match[1];
          }
          const gfile = await uploadToDrive(Buffer.concat(buffer), `${title}.mp4`, folderId);

          await sock.sendMessage(from, {
            text: `✅ Video berhasil diupload ke Google Drive.\n📂 Folder: ${process.env.VAULT_DRIVE_FOLDER_LINK}\n🔗 Link file: ${gfile.webViewLink}`
          });
        } else {
          // console.log('[VAULT DEBUG] Upload target: LOCAL');
          const fileName = `${Date.now()}_${title.replace(/\s+/g, '_')}.mp4`;
          const filePath = path.join(VAULT_DIR, fileName);
          fs.writeFileSync(filePath, Buffer.concat(buffer));
          await saveVaultVideo(from, title, filePath);
          await sock.sendMessage(from, { text: '✅ Video berhasil disimpan di Vault lokal.' });
        }

        delete vaultState[from].uploadTitle;
        delete vaultState[from].uploadTarget;
      } catch (err) {
        console.error('Error save video:', err);
        await sock.sendMessage(from, { text: '❌ Gagal menyimpan video.' });
      }
      return;
    }

    // ----- robust text extraction (include buttons / template replies) -----
    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.buttonsResponseMessage?.selectedDisplayText ||
      msg.message?.buttonsResponseMessage?.selectedButtonId ||
      msg.message?.templateButtonReplyMessage?.selectedDisplayText ||
      msg.message?.templateButtonReplyMessage?.selectedId ||
      '';

    // debug: show incoming message types (hapus/comment kalau sudah ok)
    // console.log('[DEBUG message keys]', Object.keys(msg.message), 'text=', text);

    if (!text) return;

    const raw = String(text).trim();
    const parts = raw.split(/\s+/);
    const first = (parts[0] || '').toLowerCase();

    // === GLOBAL KEYWORDS (tampil menu / navigasi) ===
    const rawLower = raw.toLowerCase();

    // Always allow menu to show (whether authorized or not)
    if (rawLower === 'menu' || rawLower === 'help menu') {
      // Tampilkan menu utama dengan lebih ringkas
      await sock.sendMessage(from, {
        text: [
          '👋 *Selamat Datang di WhatsApp Bot!* 🤖',
          '',
          '📋 *Fitur Utama:*',
          '━━━━━━━━━━━━━━━━━━━',
          '1️⃣ *CAKU* — Catat & Kelola Keuangan',
          '2️⃣ *CIG* — Cek Siapa Tidak Follow Balik IG',
          '3️⃣ *OSINT* — Lacak Info Publik',
          '4️⃣ *VAULT* — Simpan & Unduh Video',
          '━━━━━━━━━━━━━━━━━━━',
          '',
          '💬 *Bantuan?*',
          'Ketik: *Admin Pertanyaan/Keluhan Anda*',
          'Contoh: _Admin saya lupa cara export laporan_',
          '',
          'Ketik: caku | cig | osint | vault',
          'Atau: help',
          '',
          'Terima kasih telah menggunakan layanan kami! 🌟'
        ].join('\n')
      });
      return;
    }

    // allow user to go back to menu anytime
    if (rawLower === 'ulang' || rawLower === 'menu utama') {
      await sock.sendMessage(from, {
        text: [
          '👋 *Selamat Datang di WhatsApp Bot!* 🤖',
          '',
          '📋 *Fitur Utama:*',
          '━━━━━━━━━━━━━━━━━━━',
          '1️⃣ *CAKU* — Catat & Kelola Keuangan',
          '2️⃣ *CIG* — Cek Siapa Tidak Follow Balik IG',
          '3️⃣ *OSINT* — Lacak Info Publik',
          '4️⃣ *VAULT* — Simpan & Unduh Video',
          '━━━━━━━━━━━━━━━━━━━',
          '',
          '💬 *Bantuan?*',
          'Ketik: *Admin Pertanyaan/Keluhan Anda*',
          'Contoh: _Admin saya lupa cara export laporan_',
          '',
          'Ketik: caku | cig | osint | vault',
          'Atau: help',
          '',
          'Terima kasih telah menggunakan layanan kami! 🌟'
        ].join('\n')
      });
      return;
    }

    // === SHORTCUTS TO FEATURE ENTRY POINTS ===

    // CAKU
    if (rawLower === 'caku') {
      if (isAuthorized(from)) {
        await sock.sendMessage(from, {
          text: '💰 Kamu sudah aktif. Ketik perintah CAKU seperti `+100000 Gaji` atau `laporan`.\nUntuk bantuan ketik `help`.'
        });
      } else {
        await sock.sendMessage(from, { text: '🔑 Silakan masukkan token kamu untuk mengaktifkan akses CAKU.' });
      }
      return;
    }

    // CIG
    if (rawLower === 'cig' || rawLower === 'checkig') {
      await sock.sendMessage(from, {
        text: '🔗 Cek siapa yang tidak follow balik kamu di sini:\nhttps://checkig-bylionx.streamlit.app/',
        linkPreview: false
      });
      return;
    }

    // OSINT
    if (rawLower === 'osint') {
      await sock.sendMessage(from, {
        text: '🕵️‍♂️ *Fitur OSINT aktif!*\n\nKetik dengan format:\n`osint <nomor|email|nama>`\n\nContoh:\n`osint 628123456789`\n`osint someone@email.com`\n`osint John Doe`'
      });
      return;
    }

    // VAULT
    if (rawLower === 'vault') {
      await sock.sendMessage(from, {
        text: `🔒 *Fitur Personal Vault aktif!*\n
              Kamu bisa menyimpan video pribadi dengan aman (terenkripsi & butuh PIN).\n
              📌 *Perintah dasar:*
              • Set PIN baru → \`vault pin <pin>\`
              • Login → \`vault auth <pin>\`
              • Upload video → \`upload video <judul>\` lalu kirim videonya
              • Lihat daftar → \`vault list\`
              • Ambil video → \`vault get <judul>\`
              • Logout → \`vault logout\``
      });
      return;
    }

    // === VAULT COMMANDS ===
    if (rawLower.startsWith('vault pin ')) {
      const pin = raw.split(' ')[2];
      if (!pin || pin.length < 4) {
        await sock.sendMessage(from, { text: 'PIN minimal 4 angka.' });
        return;
      }

      // cek apakah user sudah punya PIN
      const [rows] = await pool.execute(`SELECT * FROM vault_users WHERE user_id = ?`, [from]);
      if (rows.length > 0) {
        await sock.sendMessage(from, { text: '❌ PIN sudah diset sebelumnya. Harap hubungi admin jika ingin diubah.' });
        return;
      }

      // set PIN pertama kali
      await setVaultPin(from, pin);
      await sock.sendMessage(from, { text: '✅ PIN Vault berhasil diset!' });
      return;
    }


    if (rawLower.startsWith('vault auth ')) {
      const pin = raw.split(' ')[2];
      if (!pin) return await sock.sendMessage(from, { text: 'Masukkan PIN kamu: vault auth <pin>' });
      const valid = await verifyVaultPin(from, pin);
      if (!valid) return await sock.sendMessage(from, { text: '❌ PIN salah!' });
      vaultState[from] = { auth: true, lastActive: Date.now() };
      await sock.sendMessage(from, { text: '🔓 Akses Vault dibuka untuk sesi ini.' });
      return;
    }

    if (rawLower === 'vault logout') {
      if (!vaultState[from]?.auth) {
        await sock.sendMessage(from, { text: '🔐 Kamu belum login ke Vault.' });
        return;
      }
      delete vaultState[from];
      await sock.sendMessage(from, { text: '🚪 Kamu telah logout dari Vault.' });
      return;
    }


    // ======== VAULT STATE ========
    function updateVaultActivity(userId) {
      if (vaultState[userId]?.auth) {
        vaultState[userId].lastActive = Date.now();
      }
    }

    function isVaultActive(userId) {
      const state = vaultState[userId];
      if (!state || !state.auth) return false;
      if (Date.now() - state.lastActive > VAULT_TIMEOUT_MS) {
        delete vaultState[userId];
        return false;
      }
      return true;
    }

    // ======== VAULT UPLOAD HANDLER (DEBUGGED) ========

    if (rawLower.startsWith('upload video ')) {
      if (!isVaultActive(from)) {
        await sock.sendMessage(from, { text: '🔒 Sesi Vault kamu sudah habis atau belum login. Ketik `vault auth <pin>` untuk login kembali.' });
        return;
      }

      updateVaultActivity(from);

      // 🧠 Parsing command
      let parts = raw.trim().split(/\s+/).slice(2); // hapus 'upload video'
      let lastWord = parts[parts.length - 1]?.toLowerCase()?.trim();
      let target = 'local';

      if (['drive', 'local'].includes(lastWord)) {
        target = lastWord;
        parts.pop();
      }

      const title = parts.join(' ').trim();
      // console.log(`[VAULT DEBUG] Command parsed => title="${title}", target="${target}", parts=`, parts);

      if (!title) return await sock.sendMessage(from, { text: 'Masukkan judul yang valid.' });

      vaultState[from] = { uploadTitle: title, uploadTarget: target };
      // console.log(`[VAULT DEBUG] vaultState[${from}] =`, vaultState[from]);

      await sock.sendMessage(from, {
        text: `🎬 Kirim video untuk disimpan dengan judul: "${title}" ke ${target === 'drive' ? 'Google Drive' : 'database lokal'}`
      });
      return;
    }

    if (rawLower === 'vault list') {
      if (!isVaultActive(from)) {
        await sock.sendMessage(from, { text: '🔒 Sesi Vault kamu sudah habis atau belum login. Ketik `vault auth <pin>` untuk login kembali.' });
        return;
      }
      updateVaultActivity(from);
      const { listDriveFiles } = require('./drive');
      const folderId = '1b8lyrO-tfAgdyQdcGFHIqNEFUhDUYwc-';

      const localList = await listVaultVideos(from);
      let driveList = [];
      try {
        driveList = await listDriveFiles(folderId);
      } catch (e) {
        // console.error('[VAULT DEBUG] Gagal ambil list Drive:', e.message);
      }

      if (!localList.length && !driveList.length)
        return await sock.sendMessage(from, { text: '📂 Belum ada video tersimpan di Vault (lokal atau Drive).' });

      let msg = '🎥 *Daftar Video:*\n';
      if (localList.length) {
        msg += '\n📁 *Lokal:*\n' + localList.map((v, i) => `${i + 1}. ${v.title}`).join('\n');
      }
      if (driveList.length) {
        msg += '\n☁️ *Google Drive:*\n' + driveList.map((v, i) => `${i + 1}. ${v.name}`).join('\n');
      }
      await sock.sendMessage(from, { text: msg });
      return;
    }

    if (rawLower.startsWith('vault get ')) {
      if (!isVaultActive(from)) {
        await sock.sendMessage(from, { text: '🔒 Sesi Vault kamu sudah habis atau belum login. Ketik `vault auth <pin>` untuk login kembali.' });
        return;
      }
      updateVaultActivity(from);
      const title = raw.slice(10).trim();
      const { listDriveFiles, getDriveFile } = require('./drive');
      const folderId = '1b8lyrO-tfAgdyQdcGFHIqNEFUhDUYwc-';

      // Cek di lokal dulu
      let video = await getVaultVideo(from, title);

      if (video) {
        await sock.sendMessage(from, { video: { url: video.file_path }, caption: `🎬 ${title} (lokal)` });
        return;
      }

      // Kalau gak ada di lokal, coba cek di Drive
      try {
        const driveFiles = await listDriveFiles(folderId);
        const match = driveFiles.find(f => f.name.toLowerCase().includes(title.toLowerCase()));
        if (!match) return await sock.sendMessage(from, { text: '❌ Video tidak ditemukan di lokal maupun Drive.' });

        await sock.sendMessage(from, {
          video: { url: match.webContentLink },
          caption: `🎬 ${match.name} (Drive)`
        });
      } catch (err) {
        console.error('Error get from Drive:', err);
        await sock.sendMessage(from, { text: '❌ Gagal mengambil video dari Drive.' });
      }
      return;
    }

    // === Command OSINT langsung ===
    if (rawLower.startsWith('osint ')) {
      const target = raw.slice(6).trim();
      if (!target) {
        await sock.sendMessage(from, { text: '🕵️‍♂️ Format salah.\nContoh:\n• osint Angga Sulistiangga\n• osint +6281234567890' });
        return;
      }
      const result = await runOsint(target);
      await sock.sendMessage(from, { text: result });
      return;
    }

    // ====== MOTIVASI MANUAL ======
    if (rawLower.startsWith('motivasi')) {
      // console.log('[bot] [DEBUG] Trigger motivasi:', rawLower);
      let mode = 'serius';
      if (rawLower.includes('lucu')) mode = 'lucu';
      else if (rawLower.includes('dark')) mode = 'dark';
      const quote = await getMotivation(mode);
      await sock.sendMessage(from, { text: quote });
      return;
    }

    // === Token-only input ===
    // Hanya proses kalau pesan benar-benar dimulai dengan 'token ' atau 'TOKEN '
    if (/^token\s+[A-Z0-9]{4,}$/.test(raw.toUpperCase())) {
      const token = raw.split(/\s+/)[1]?.toUpperCase();
      if (!token) {
        await sock.sendMessage(from, { text: '⚠️ Format salah. Gunakan: `token <kode>`' });
        return;
      }

      const result = verifyToken(from, token);
      if (result && result.msg) {
        await sock.sendMessage(from, { text: result.msg });
      } else {
        await sock.sendMessage(from, { text: result ? '✅ Token aktif!' : '❌ Token tidak valid.' });
      }
      return;
    }

    // === Aktivasi Token ===
    if (raw.toLowerCase().startsWith('token ')) {
      const token = raw.split(' ')[1];
      const result = verifyToken(from, token);
      await sock.sendMessage(from, { text: result.msg });
      return;
    }

    function normalizeJid(jid) {
      if (!jid) return '';
      return jid.split('@')[0]; // return nomor saja
    }

    const senderNum = normalizeJid(from);
    const adminNum = normalizeJid(ADMIN_JID);

    // debug log (tampilkan di console saat testing)
    // console.log('[DEBUG admin check] from=', from, 'senderNum=', senderNum, 'adminNum=', adminNum, 'raw=', raw);

    if (senderNum === adminNum) {
      // buatoken atau "buat token"
      if (rawLower.startsWith('buatoken') || rawLower.startsWith('buat token')) {
        const parts = raw.split(/\s+/);
        const hari = parseInt(parts[1], 10) || 3;
        try {
          const token = generateToken(hari);
          await sock.sendMessage(from, { text: `✅ Token baru: *${token}*\nBerlaku selama ${hari} hari.` });
        } catch (e) {
          console.error('Error generateToken', e);
          await sock.sendMessage(from, { text: '❌ Gagal membuat token (cek log).' });
        }
        return;
      }

      // listuser (case-insensitive)
      if (rawLower === 'listuser' || rawLower === 'list user') {
        try {
          const users = listUsers();
          if (!users || users.length === 0) {
            await sock.sendMessage(from, { text: 'Belum ada user terdaftar.' });
          } else {
            const list = users
              .map(u => `🔹 *${u.jid || '-'}*\nToken: ${u.token}\n${u.status}\nMasa: ${u.expiresInDays} hari`)
              .join('\n\n');
            await sock.sendMessage(from, { text: list });
          }
        } catch (e) {
          console.error('Error listUsers', e);
          await sock.sendMessage(from, { text: '❌ Gagal mengambil daftar user (cek log).' });
        }
        return;
      }

      // kick <jid>  or kick <number>
      if (rawLower.startsWith('kick ')) {
        const parts = raw.split(/\s+/);
        let jidKick = parts[1] || '';
        // jika admin kirim hanya nomor, tambahkan domain
        if (!jidKick.includes('@')) {
          jidKick = `${jidKick}@s.whatsapp.net`;
        }
        const success = deactivateUser(jidKick);
        await sock.sendMessage(from, {
          text: success
            ? `🚫 User ${jidKick} telah dinonaktifkan.`
            : `❌ Tidak ditemukan user ${jidKick}.`
        });
        return;
      }
    }

    // === Cek Otorisasi ===
    if (!isAuthorized(from)) {
      await sock.sendMessage(from, {
        text: '🚫 Akses kamu tidak aktif atau sudah kadaluarsa.\nKirim token dengan format:\n`token <kode>`\nContoh:\n`token 3X79A1U2`'
      });
      return;
    }

    // Automatic: if message begins with + or - treat as tambah
    if (/^[+-]\d+/.test(first)) {
      await commands.tambah(sock, from, raw);
      return;
    }

    // parse normal commands
    const cmd = first;
    const args = parts.slice(1);
    if (commands[cmd]) {
      // pass raw to edit handler if needed
      await commands[cmd](sock, from, args, raw);
    } else {
      // aliases
      if (cmd === 'report') await commands.laporan(sock, from, args);
      else if (cmd === 'hari' && args[0] === 'ini') await commands.hari(sock, from, args);
      else if (cmd === 'minggu' && args[0] === 'ini') await commands.minggu(sock, from, args);
      else if (cmd === 'bayar') await commands.split(sock, from, raw);
      else await sock.sendMessage(from, {
        text: [
          '👋 *Selamat Datang di WhatsApp Bot!* 🤖',
          '',
          '📋 *Fitur Utama:*',
          '━━━━━━━━━━━━━━━━━━━',
          '1️⃣ *CAKU* — Catat & Kelola Keuangan',
          '2️⃣ *CIG* — Cek Siapa Tidak Follow Balik IG',
          '3️⃣ *OSINT* — Lacak Info Publik',
          '4️⃣ *VAULT* — Simpan & Unduh Video',
          '━━━━━━━━━━━━━━━━━━━',
          '',
          '💬 *Bantuan?*',
          'Ketik: *Admin Pertanyaan/Keluhan Anda*',
          'Contoh: _Admin saya lupa cara export laporan_',
          '',
          'Ketik: caku | cig | osint | vault',
          'Atau: help',
          '',
          'Terima kasih telah menggunakan layanan kami! 🌟'
        ].join('\n')
      });
    }
  } catch (err) {
    console.error('handleMessage error', err);
  }
}

// START BOT
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false
  });


  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('Scan QR code untuk login!');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnecting?', shouldReconnect, lastDisconnect?.error);
      if (shouldReconnect) setTimeout(startBot, 5000);
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Bot terhubung!');

      startDailyMotivation(sock, ADMIN_JID);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      await handleMessage(sock, m);
    }
  });

  // Setup cron job to deliver reminders every minute check (we will match HH:mm)
  cron.schedule('* * * * *', async () => {
    try {
      const users = await getAllUsersWithReminder();
      const now = moment().format('HH:mm');
      for (const u of users) {
        if (u.reminder_time === now) {
          // send a reminder message and a short daily summary
          const summary = await getSummary(u.user_id, moment().format('MM-YYYY'));
          const text = `${u.reminder_msg || '⏰ Reminder catat keuangan hari ini!'}\n\nSaldo bulan ini: ${formatCurrency(summary.saldo)}\nKetik *laporan bulan ${moment().format('MM-YYYY')}* untuk detail.`;
          await sock.sendMessage(u.user_id, { text });
        }
      }
    } catch (e) {
      console.error('cron error', e);
    }
  });

  console.log('Bot siap.');
}
startBot();
