let baseDir = require('path').join(__dirname, '..');
if (process.pkg) baseDir = require('path').dirname(process.execPath);
require('dotenv').config({ path: require('path').join(baseDir, '.env'), quiet: true });

const config = {
    port: parseInt(process.env.PORT) || 335,
    panelPassword: process.env.PANEL_PASSWORD || '',
    defaultDelay: 5,
    maxRetries: 3,
    requestTimeout: 120000,
    sleepBetweenSteps: 3000,
    sleepBetweenFiles: 10000,
    maxFileSize: 500 * 1024 * 1024,
    allowedExtensions: ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.jpg', '.jpeg', '.png', '.gif', '.webp'],
    videoExtensions: ['.mp4', '.avi', '.mov', '.mkv', '.webm'],
    apiDomain: 'https://add4.oakroot.top',
    siteDomain: 'https://namevids.me',
    historyMaxItems: 100,
    
    // --- Настройки водяного знака (Watermark) ---
    watermark: {
        enabled: process.env.WATERMARK_ENABLED === 'true' || false,
        text: process.env.WATERMARK_TEXT || '@ТвойКанал',
        fontSize: parseInt(process.env.WATERMARK_FONT_SIZE) || 36,
        color: process.env.WATERMARK_COLOR || 'white',
        bordercolor: process.env.WATERMARK_BORDER_COLOR || 'black',
        borderwidth: parseInt(process.env.WATERMARK_BORDER_WIDTH) || 2,
        position: process.env.WATERMARK_POSITION || 'bottom-right' // 'center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'
    },
};

module.exports = config;
