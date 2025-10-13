// osint.js
const fetch = require('node-fetch');
require('dotenv').config();
const { hunterCheck } = require('./hunter');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;
const NUMVERIFY_API_KEY = process.env.NUMVERIFY_API_KEY;
const HUNTER_API_KEY = process.env.HUNTER_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

/**
 * Fungsi utama yang akan dipanggil dari index.js
 * @param {string} query input user (nama, email, atau nomor)
 * @returns {Promise<string>} hasil siap dikirim ke WhatsApp
 */
// async function runOsint(query) {
//     query = query.trim();

//     // === CEK JENIS INPUT ===
//     if (/^\+?\d{9,15}$/.test(query)) return await osintPhone(query);
//     if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query)) return await osintEmail(query);

//     // cek jika user ketik domain
//     if (query.includes('.') && !query.includes(' ')) {
//         return await osintDomainHunter(query);
//     }

//     // fallback: dianggap nama → pakai Google Search
//     return await osintName(query);
// }

/**
 * Cek nama atau email pakai SerpAPI dulu,
 * kalau gagal atau limit, fallback ke Google Custom Search.
 */
async function serpOrGoogleSearch(query, limit = 100) {
    let results = [];

    // 🔹 Coba SerpAPI dulu
    try {
        const serpURL = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}`;
        const serpRes = await fetch(serpURL);
        const serpData = await serpRes.json();

        if (serpData.organic_results && serpData.organic_results.length > 0) {
            results = serpData.organic_results.slice(0, limit).map(r => ({
                title: r.title,
                link: r.link
            }));
            return { source: 'SerpAPI', results };
        }
    } catch (err) {
        console.warn('⚠️ SerpAPI gagal atau limit habis:', err.message);
    }

    // 🔹 Fallback ke Google Custom Search
    try {
        const googleURL = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}`;
        const googleRes = await fetch(googleURL);
        const googleData = await googleRes.json();

        if (googleData.items && googleData.items.length > 0) {
            results = googleData.items.slice(0, limit).map(r => ({
                title: r.title,
                link: r.link
            }));
            return { source: 'Google Custom Search', results };
        }
    } catch (err) {
        console.error('❌ Google fallback error:', err);
    }

    return { source: null, results: [] };
}

/** 🌐 OSINT Nama */
async function osintName(name) {
    const { source, results } = await serpOrGoogleSearch(name);
    if (results.length === 0) {
        return `🔍 Tidak ditemukan hasil publik untuk *${name}*.`;
    }

    const list = results.map((r, i) => `${i + 1}. *${r.title}*\n${r.link}`).join('\n\n');
    return `🌐 *Hasil OSINT Nama:* _${name}_ (via ${source})\n\n${list}`;
}

/** 📱 OSINT Nomor via NumVerify */
async function osintPhone(number) {
    const url = `http://apilayer.net/api/validate?access_key=${NUMVERIFY_API_KEY}&number=${encodeURIComponent(number)}&format=1`;
    try {
        const res = await fetch(url);
        const data = await res.json();

        if (!data.valid) {
            return `🚫 Nomor *${number}* tidak valid atau tidak ditemukan.`;
        }

        return (
            `📱 *Hasil OSINT Nomor HP:*\n\n` +
            `• Valid: ${data.valid ? 'Ya' : 'Tidak'}\n` +
            `• Number: ${data.number || '-'}\n` +
            `• Local Format: ${data.local_format || '-'}\n` +
            `• International Format: ${data.international_format || '-'}\n` +
            `• Country: ${data.country_name || '-'} (${data.country_code || '-'})\n` +
            `• Location: ${data.location || '-'}\n` +
            `• Carrier: ${data.carrier || '-'}\n` +
            `• Line Type: ${data.line_type || '-'}`
        );
    } catch (err) {
        console.error('OSINT phone error:', err);
        return '❌ Gagal memeriksa nomor.';
    }
}

// 📧 Email (Hunter.io Email Verifier + tambahan)
//
async function osintEmail(email) {
    const endpoints = [
        {
            name: "Discover",
            url: `https://api.hunter.io/v2/discover?email=${encodeURIComponent(
                email
            )}&api_key=${HUNTER_API_KEY}`,
        },
        {
            name: "Email Verifier",
            url: `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(
                email
            )}&api_key=${HUNTER_API_KEY}`,
        },
        {
            name: "People Finder",
            url: `https://api.hunter.io/v2/people/find?email=${encodeURIComponent(
                email
            )}&api_key=${HUNTER_API_KEY}`,
        },
        {
            name: "Combined",
            url: `https://api.hunter.io/v2/combined/find?email=${encodeURIComponent(
                email
            )}&api_key=${HUNTER_API_KEY}`,
        },
    ];

    let output = `📧 *Hasil OSINT Email (Hunter.io)* untuk: _${email}_\n\n`;

    for (const ep of endpoints) {
        try {
            const res = await fetch(ep.url);
            const text = await res.text();

            // Jika respon berupa HTML error, skip
            if (text.startsWith("<!DOCTYPE html>") || text.includes("<html")) {
                console.warn(`⚠️ Hunter endpoint ${ep.name} return HTML page`);
                continue;
            }

            const data = JSON.parse(text);
            if (data.data) {
                output += `🧩 *${ep.name}:*\n`;
                for (const [k, v] of Object.entries(data.data)) {
                    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
                        output += `• ${k}: ${v}\n`;
                    }
                }
                output += "\n";
            }
        } catch (err) {
            console.error(`Hunter ${ep.name} error:`, err);
        }
    }

    // 🔎 Cari hasil publik via SerpAPI atau Google
    const { source, results } = await serpOrGoogleSearch(email);
    if (results.length > 0) {
        output += `🌐 *Ditemukan (${source}):*\n`;
        output += results.map((r, i) => `${i + 1}. ${r.title}\n${r.link}`).join('\n\n');
    } else {
        output += `🌐 Tidak ditemukan hasil publik (${source || 'pencarian umum'}).\n`;
    }

    return output;
}

module.exports = {
    runOsint: async (query) => {
        query = query.trim();
        if (/^\+?\d{9,15}$/.test(query)) return await osintPhone(query);
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query)) return await osintEmail(query);
        return await osintName(query);
    }
};