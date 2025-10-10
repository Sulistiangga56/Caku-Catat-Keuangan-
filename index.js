// index.js
require("dotenv").config();

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
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

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
      '- `reminder list` : lihat reminder kamu',
      '- `reminder off` : matikan reminder',
      '- `hapus <id>` : hapus transaksi',
      '- `edit <id> <amount> <desc> [category]` : edit transaksi',
      '- `kategori` : lihat daftar kategori',
      '- `cari <kata>` : cari transaksi',
      '- `pengeluaran [bulan MM-YYYY]` : total pengeluaran (negatif) bulan ini/param',
      '- `pemasukan [bulan MM-YYYY]` : total pemasukan (positif)',
      '- `hari ini` / `minggu ini` : transaksi hari/ minggu ini',
      '- `tahunan YYYY` : ringkasan per bulan tahun tersebut',
      '- `ranking kategori [MM-YYYY]` : urut kategori berdasar pengeluaran',
      '- `stat` : statistik singkat',
      '- `backup` : kirim file .xlsx backup (terbatas)',
      '- `reset` : hapus semua transaksi (butuh konfirmasi)',
      '- `saran` : saran penghematan sederhana',
      '- `progress` : progres target tabungan',
      '- `split` : bagi transaksi patungan (lihat dokumentasi)',
      '- `help` : show this help'
    ].join('\n');
    await sock.sendMessage(from, { text: helpText });
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

    console.log('[DEBUG split input]', rawText);

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

    await addTransaction(from, -total, `${description} (Patungan)`, 'Patungan');
  },

  tambah: async (sock, from, rawText) => {
    const { amount, description, category } = parseAmountAndMeta(rawText);
    if (!Number.isFinite(amount)) return await sock.sendMessage(from, { text: 'Format amount tidak valid.' });
    const id = await addTransaction(from, amount, description, category);
    await sock.sendMessage(from, { text: `✅ Tercatat (ID ${id}): ${formatCurrency(amount)} - ${description} ${category ? '[' + category + ']' : ''}` });
  },

  laporan: async (sock, from, args) => {
    // maintain previous behaviors
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

    if ((args[0] === 'kategori' || args[0] === 'Kategori') && args[1]) {
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

  // day/week quick
  'hari': async (sock, from, args) => {
    // support message "hari ini"
    if (args[0] === 'ini' || args[0] === undefined) {
      const start = moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const end = moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
      const rows = await getTransactions(from, { limit: 1000, since: start, until: end });
      if (!rows.length) return sock.sendMessage(from, { text: 'Tidak ada transaksi hari ini.' });
      let rep = `📅 Transaksi Hari Ini:\n\n`;
      rows.forEach(r => {
        rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${r.category || '-'} | ${moment(r.created_at).format('HH:mm')}\n`;
      });
      return sock.sendMessage(from, { text: rep });
    }
    await sock.sendMessage(from, { text: 'Gunakan: "hari ini"' });
  },

  'minggu': async (sock, from, args) => {
    if (args[0] === 'ini' || args[0] === undefined) {
      const start = moment().startOf('week').format('YYYY-MM-DD HH:mm:ss');
      const end = moment().endOf('week').format('YYYY-MM-DD HH:mm:ss');
      const rows = await getTransactions(from, { limit: 1000, since: start, until: end });
      if (!rows.length) return sock.sendMessage(from, { text: 'Tidak ada transaksi minggu ini.' });
      let rep = `📅 Transaksi Minggu Ini:\n\n`;
      rows.forEach(r => {
        rep += `#${r.id} ${r.amount >= 0 ? '➕' : '➖'} ${formatCurrency(Math.abs(r.amount))} | ${r.description} | ${r.category || '-'} | ${moment(r.created_at).format('dd DD/MM HH:mm')}\n`;
      });
      return sock.sendMessage(from, { text: rep });
    }
    await sock.sendMessage(from, { text: 'Gunakan: "minggu ini"' });
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

    // if (sub === 'pesan') {
    //   const text = args.slice(1).join(' ');
    //   if (!text) return sock.sendMessage(from, { text: 'Format: reminder pesan <teks>' });
    //   // store pesan di settings: we don't have setReminder msg function; use setTarget as quick hack? better: extend db later.
    //   // For now, we store it in settings.reminder_time as "HH:mm|MESSAGE" conservatively
    //   const settings = await getSettings(from);
    //   const time = settings?.reminder_time || null;
    //   await setReminder(from, time ? time : '00:00'); // ensure row exists
    //   // hack: store message in settings table is not implemented; ideally add setReminderMessage in db.js
    //   await sock.sendMessage(from, { text: 'Pesan reminder disimpan (note: pesan disimpan sementara). Fitur lengkap akan ditambah di DB.' });
    //   return;
    // }

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
      // aliases
      if (cmd === 'report') await commands.laporan(sock, from, args);
      else if (cmd === 'hari' && args[0] === 'ini') await commands.hari(sock, from, args);
      else if (cmd === 'minggu' && args[0] === 'ini') await commands.minggu(sock, from, args);
      else if (cmd === 'bayar') await commands.split(sock, from, raw);
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
