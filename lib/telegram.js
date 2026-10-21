const axios = require('axios');
const logger = require('./logger');

async function sendTelegramAlert(message) {
    const token = process.env.TG_BOT_TOKEN;
    const chatId = process.env.TG_CHAT_ID;
    if (!token || !chatId) return;

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text: message
        });
    } catch (e) {
        logger.error(`Ошибка отправки в TG: ${e.message}`);
    }
}

module.exports = { sendTelegramAlert };
