const axios = require('axios');

async function generateAccountName() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (apiKey) {
        try {
            const prompt = `Generate a creative channel name for a video sharing platform.
Rules:
- 2 to 3 words combined into CamelCase
- end with a random 3 or 4 digit number
- keep it brandable, neutral, and short
- output ONLY the name`;

            const resp = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { maxOutputTokens: 40, temperature: 1.0 }
                },
                { timeout: 15000 }
            );

            const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (text && text.length > 0 && text.length < 60) {
                return text.replace(/["'\n\r]/g, '').trim();
            }
        } catch (e) {
            console.error('[ai-name] Gemini API error:', e.message);
        }
    }

    return generateFallbackName();
}

async function generateVideoTitle() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (apiKey) {
        const hooks = [
            'watch below',
            'full version below',
            'more in profile',
            'link in bio',
        ];
        const themes = [
            'short teaser',
            'fresh preview',
            'full clip below',
            'verified content',
            'consensual 18+ clip',
        ];
        const hook = hooks[Math.floor(Math.random() * hooks.length)];
        const theme = themes[Math.floor(Math.random() * themes.length)];

        const prompt = `Write one short title for a legal 18+ consensual teaser video.
Incorporate the idea "${theme}" and the CTA "${hook}".
Rules:
- 2 to 5 words
- no references to minors, coercion, hidden recording, incest, or deepfakes
- keep it clean, teaser-like, and clickable
- output ONLY the title`;

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const resp = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
                    {
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { maxOutputTokens: 40, temperature: 1.0 },
                        safetySettings: [
                            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                        ]
                    },
                    { timeout: 15000 }
                );

                const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (text && text.length >= 4 && text.length < 60) {
                    return text.replace(/["'\n\r]/g, '').trim();
                }
                if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
            } catch (e) {
                console.error('[ai-name] Gemini API video title error:', e.message);
            }
        }
    }

    return generateFallbackTitle();
}

function generateFallbackName() {
    const adj = ['Fresh', 'Wild', 'Secret', 'Night', 'Bold', 'Nova', 'Prime', 'Velvet', 'Pulse', 'Vivid'];
    const noun = ['Clips', 'Vibes', 'Stars', 'Zone', 'Hub', 'World', 'Box', 'Stream', 'Vault', 'Gate'];
    const num = Math.floor(Math.random() * 9000) + 1000;
    const a = adj[Math.floor(Math.random() * adj.length)];
    const n = noun[Math.floor(Math.random() * noun.length)];
    return `${a}${n}${num}`;
}

function generateFallbackTitle() {
    const templates = [
        'Short teaser below',
        'Full clip in bio',
        'Fresh preview here',
        'Watch the full set',
        'New teaser below',
        'More in profile',
        'Полная версия ниже',
        'Смотри ниже',
        'Новый тизер',
        'Короткий клип',
    ];
    return templates[Math.floor(Math.random() * templates.length)];
}

module.exports = { generateAccountName, generateVideoTitle };
