// index.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const {
  addTransaction, editTransaction, deleteTransaction, getSummary, getTransactions,
  getCategorySummary, setTarget, setReminder, getSettings, getAllUsersWithReminder
} = require('./db');

const moment = require('moment');
const qrcode = require('qrcode-terminal');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');

const OUT_DIR = path.resolve(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

// Helpers
function formatCurrency(n) {
  return `Rp${Number(n).toLocaleString('id-ID')}`;
}

function parseAmountAndMeta(text) {
  // Parse: +100000 Description [category]
  // category optional within square brackets at end
  // Return: { amount, description, category }
  const catMatch = text.match(/\[(.+?)\]\s*$/);
  let category = null;
  if (catMatch) {
    category = catMatch[1].trim();
    text = text.slice(0, catMatch.index).trim();
  }

  const parts = text.trim().split(/\s+/);
  const amountStr = parts[0];
  const amount = parseInt(amountStr.replace(/[^\d-+]/g, ''), 10);
  const description = parts.slice(1).join(' ') || '-';
  return { amount, description, category };
}

// Export XLSX
async function generateXlsx(userId, rows, meta = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Laporan');
  ws.addRow(['Laporan Keuangan']);
  ws.addRow([`User: ${userId}`, `Generated: ${moment().format('YYYY-MM-DD HH:mm')}`]);
  ws.addRow([]);
  ws.addRow(['ID','Tanggal','Amount','Description','Category']);
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

// COMMANDS
const commands = {
  help: async (sock, from) => {
    const helpText = [
      '📌 *Perintah Bot Keuangan*',
      '- `+100000 Gaji [salary]` : tambah pemasukan',
      '- `-50000 Makan [food]` : tambah pengeluaran (category optional in [] )',
      '- `laporan` : laporan singkat',
      '- `laporan bulan MM-YYYY` : laporan per bulan',
      '- `laporan kategori <category>` : laporan per kategori',
      '- `laporan export MM-YYYY` : export xlsx & pdf',
      '- `grafik MM-YYYY` : pie chart kategori',
      '- `saldo` : cek saldo saat ini',
      '- `target 10000000` : set target tabungan',
      '- `reminder HH:mm` : set daily reminder (local time)',
      '- `hapus <id>` : hapus transaksi',
      '- `edit <id> <amount> <desc> [category]` : edit transaksi',
      '- `help` : show this help'
    ].join('\n');
    await sock.sendMessage(from, { text: helpText });
  },

  tambah: async (sock, from, rawText) => {
    // rawText is full original text
    const { amount, description, category } = parseAmountAndMeta(rawText);
    if (!Number.isFinite(amount)) return await sock.sendMessage(from, { text: 'Format amount tidak valid.' });
    const id = await addTransaction(from, amount, description, category);
    await sock.sendMessage(from, { text: `✅ Tercatat (ID ${id}): ${formatCurrency(amount)} - ${description} ${category ? '['+category+']' : ''}` });
  },

  laporan: async (sock, from, args) => {
    // args may be: [], ['bulan','MM-YYYY'], ['export','MM-YYYY'], ['kategori','food']
    if (args[0] === 'bulan' && args[1]) {
      const month = args[1];
      const { saldo, rows } = await getSummary(from, month);
      let rep = `📊 Laporan Bulan ${month}\nSaldo: ${formatCurrency(saldo)}\n\n`;
      rows.forEach(r => {
        rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${r.category || '-'} | ${moment(r.created_at).format('DD/MM HH:mm')}\n`;
      });
      await sock.sendMessage(from, { text: rep });
      return;
    }

    if (args[0] === 'export') {
      const month = args[1] || null;
      const rows = await getTransactions(from, { limit: 1000, month });
      const xlsx = await generateXlsx(from, rows);
      const pdf = await generatePdf(from, rows);

      await sock.sendMessage(from, { text: 'Menyiapkan file export...' });

      // send files
      await sock.sendMessage(from, { document: fs.readFileSync(xlsx), fileName: path.basename(xlsx), mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      await sock.sendMessage(from, { document: fs.readFileSync(pdf), fileName: path.basename(pdf), mimetype: 'application/pdf' });
      return;
    }

    if (args[0] === 'kategori' && args[1]) {
      const category = args.slice(1).join(' ');
      const rows = await getTransactions(from, { limit: 200, category });
      let rep = `📊 Laporan Kategori: ${category}\n\n`;
      rows.forEach(r => {
        rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${moment(r.created_at).format('DD/MM HH:mm')}\n`;
      });
      await sock.sendMessage(from, { text: rep });
      return;
    }

    // default laporan recent
    const { saldo, rows } = await getSummary(from, null);
    let rep = `📊 Laporan Terbaru\nSaldo: ${formatCurrency(saldo)}\n\n`;
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

  target: async (sock, from, args) => {
    const target = parseInt(args[0]);
    if (!Number.isFinite(target)) return await sock.sendMessage(from, { text: 'Format: target 10000000' });
    await setTarget(from, target);
    await sock.sendMessage(from, { text: `🎯 Target diset: ${formatCurrency(target)}` });
  },

  reminder: async (sock, from, args) => {
    const time = args[0];
    if (!time || !/^\d{2}:\d{2}$/.test(time)) return await sock.sendMessage(from, { text: 'Format: reminder HH:mm (24h)' });
    await setReminder(from, time);
    await sock.sendMessage(from, { text: `⏰ Reminder harian diset pada ${time}` });
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

// MAIN message handler
async function handleMessage(sock, msg) {
  try {
    if (!msg.message || !msg.key.remoteJid) return;
    if (msg.key.fromMe) return; // ignore bot's own messages

    const from = msg.key.remoteJid;
    // get plain text (support extended)
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
    if (!text) return;

    const raw = text.trim();
    const parts = raw.split(/\s+/);
    const first = parts[0].toLowerCase();

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
      // allow 'laporan' without explicit 'laporan' keyword if user writes 'report' or 'help'
      if (cmd === 'report') await commands.laporan(sock, from, args);
      else await commands.help(sock, from);
    }
  } catch (err) {
    console.error('handleMessage error', err);
  }
}

// START BOT
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({
    auth: state,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    markOnlineOnConnect: true
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
          const text = `⏰ Reminder catat keuangan\nSaldo bulan ini: ${formatCurrency(summary.saldo)}\nKetik 'laporan bulan ${moment().format('MM-YYYY')}' untuk detail.`;
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
