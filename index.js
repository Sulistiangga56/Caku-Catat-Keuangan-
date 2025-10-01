const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { addTransaction, getSummary } = require('./db');
const moment = require('moment');
const qrcode = require('qrcode-terminal');

// Command handler map
const commands = {
    laporan: async (sock, from, args) => {
        let month = null;
        if (args[0] === "bulan" && args[1]) month = args[1];
        let data = await getSummary(month);
        let report = `📊 Laporan Keuangan ${month || ''}\nSaldo: Rp${data.saldo}\n\n`;
        data.rows.forEach(t => {
            report += `${t.amount >= 0 ? '➕' : '➖'} Rp${Math.abs(t.amount)} | ${t.description} | ${moment(t.created_at).format('DD/MM HH:mm')}\n`;
        });
        await sock.sendMessage(from, { text: report });
    },
    default: async (sock, from) => {
        await sock.sendMessage(from, {
            text: "📌 Format:\n" +
                "+100000 Gaji\n" +
                "-50000 Makan\n" +
                "laporan\n" +
                "laporan bulan 09-2025"
        });
    }
};

async function handleMessage(sock, msg) {
    if (!msg.message || !msg.key.remoteJid) return;
    if (msg.key.fromMe) return;
    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    // Command parsing
    const [cmd, ...args] = text.trim().toLowerCase().split(" ");
    if (commands[cmd]) {
        await commands[cmd](sock, from, args);
    } else if (/^[+-]?\d+/.test(text)) {
        let [amountStr, ...descParts] = text.split(" ");
        let amount = parseInt(amountStr);
        let description = descParts.join(" ") || "-";
        await addTransaction(amount, description);
        await sock.sendMessage(from, { text: `✅ Tercatat: Rp${amount} - ${description}` });
    } else {
        await commands.default(sock, from);
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const sock = makeWASocket({
        auth: state,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        markOnlineOnConnect: true,
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
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) setTimeout(startBot, 5000);
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot terhubung!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        await handleMessage(sock, messages[0]);
    });
}

startBot();
