const axios = require("axios");
const cron = require("node-cron");
const moment = require("moment");
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

async function getMotivation(mode = "serius") {
  try {
    const promptSets = {
      serius: [
        "Berikan satu quotes motivasi yang inspiratif dalam bahasa Indonesia.",
        "Berikan satu ayat Al-Qur'an beserta terjemahan dan artinya yang dapat memotivasi hari.",
        "Berikan satu kalimat afirmasi positif untuk memulai hari dalam bahasa Indonesia.",
        "Berikan satu kata-kata bijak untuk membangkitkan semangat hari dalam bahasa Indonesia.",
        "Berikan satu pesan motivasi singkat untuk hari dalam bahasa Indonesia."
      ],
      lucu: [
        "Berikan satu quotes motivasi yang lucu dan menghibur dalam bahasa Indonesia.",
        "Berikan satu kalimat afirmasi positif yang lucu untuk memulai hari dalam bahasa Indonesia.",
        "Berikan satu kata-kata bijak yang kocak untuk membangkitkan semangat dalam bahasa Indonesia.",
        "Berikan satu pesan motivasi singkat yang lucu dalam bahasa Indonesia."
      ],
      dark: [
        "Berikan satu quotes motivasi dengan nuansa dark humor dalam bahasa Indonesia.",
        "Berikan satu kalimat afirmasi positif dengan sentuhan dark humor untuk memulai hari dalam bahasa Indonesia.",
        "Berikan satu kata-kata bijak dengan gaya dark humor untuk membangkitkan semangat dalam bahasa Indonesia.",
        "Berikan satu pesan motivasi singkat dengan dark humor dalam bahasa Indonesia."
      ]
    };

    // Ambil semua prompt untuk mode yg dipilih
    const prompts = promptSets[mode] || promptSets.serius;

    // Pilih 1 prompt secara acak
    const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];

    console.log(`[bot] 🎯 Prompt terpilih untuk ${mode}: ${randomPrompt}`);

    // Kirim prompt random itu aja ke model
    const res = await openai.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: randomPrompt }],
    });

    const reply = res.choices?.[0]?.message?.content?.trim();
    return reply || "✨ Semangat hari ini! Jangan lupa bersyukur 🙏";
  } catch (err) {
    console.error("[bot] getMotivation error:", err.message);
    return "⚠️ Gagal mengambil motivasi hari ini.";
  }
}


function startDailyMotivation(sock, adminJid) {
  console.log("[bot] Daily motivation scheduler aktif ✅");

  // Pagi 05:30
  cron.schedule("30 5 * * *", async () => {
    const quote = await getMotivation("serius");
    await sock.sendMessage(adminJid, {
      text: `Selamat pagi! 🌞 ${quote}`,
    });
  });

  // Malam 22:00
  cron.schedule("0 22 * * *", async () => {
    const quote = await getMotivation("serius");
    await sock.sendMessage(adminJid, {
      text: `Selamat malam! 🌙 ${quote}`,
    });
  });
}

module.exports = { getMotivation, startDailyMotivation };