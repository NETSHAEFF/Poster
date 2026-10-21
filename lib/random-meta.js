const titleBanks = {
    short: [
        'малая проказница',
        'cute yng girl',
        'девочка пай',
        'Пожалуйста хватит...',
        'Mal0letka Anal',
        'Новый клип',
        'Check best in desc',
        'BEST SEXY T33N',
    ],
    medium: [
        'малая проказница',
        'cute yng girl',
        'девочка пай',
        'Пожалуйста хватит...',
        'Mal0letka Anal',
        'Новый клип',
        'Check best in desc',
        'BEST SEXY T33N',
    ],
    long: [
        'малая проказница',
        'cute yng girl',
        'девочка пай',
        'Пожалуйста хватит...',
        'Mal0letka Anal',
        'Новый клип',
        'Check best in desc',
        'BEST SEXY T33N',
    ],
};

const captionTemplates = {
    withLink: [
        'Full verified clip here:\n{link}',
        'More verified content in profile:\n{link}',
        'Watch the full version:\n{link}',
        'Полная версия здесь:\n{link}',
        'Еще материалы в профиле:\n{link}',
        'Veja o conteudo completo:\n{link}',
        'Main link below:\n{link}',
    ],
    withoutLink: [
        'More verified content in profile',
        'Watch the full version in profile',
        'Полная версия в профиле',
        'Veja mais no perfil',
    ],
};

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function getDurationBucket(durationSec) {
    if (!Number.isFinite(durationSec) || durationSec <= 0) return 'short';
    if (durationSec <= 60) return 'short';
    if (durationSec <= 600) return 'medium';
    return 'long';
}

function getRandomTitle(options = {}) {
    const bucket = getDurationBucket(options.durationSec);
    return pick(titleBanks[bucket] || titleBanks.short);
}

function getRandomCaption(tgLink, options = {}) {
    if (!tgLink || !String(tgLink).trim()) {
        return pick(captionTemplates.withoutLink);
    }

    const caption = pick(captionTemplates.withLink);
    return caption.replace('{link}', tgLink);
}

/**
 * Парсер синтаксиса Spintax: {вариант1|вариант2|вариант3}
 * Поддерживает вложенные конструкции
 */
function parseSpintax(text) {
    if (!text || typeof text !== 'string') return text || '';
    let result = text;
    const spintaxRegex = /\{([^{}]+)\}/g;
    let iterations = 0;
    while (spintaxRegex.test(result) && iterations < 10) {
        result = result.replace(spintaxRegex, (match, choices) => {
            const options = choices.split('|');
            return options[Math.floor(Math.random() * options.length)].trim();
        });
        iterations++;
    }
    return result;
}

/**
 * Словарь гомоглифов (символов с абсолютно идентичным начертанием в кириллице и латинице)
 */
const HOMOGLYPHS = {
    // Кириллица -> Латиница
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
    // Латиница -> Кириллица
    'a': 'а', 'e': 'е', 'o': 'о', 'p': 'р', 'c': 'с', 'y': 'у', 'x': 'х',
    'A': 'А', 'B': 'В', 'E': 'Е', 'K': 'К', 'M': 'М', 'H': 'Н', 'O': 'О', 'P': 'Р', 'C': 'С', 'T': 'Т', 'X': 'Х',
};

/**
 * Заменяет 1-2 символа на их гомоглифы (визуально для человека текст идентичен на 100%,
 * но байтовые хэши MD5/SHA и точные спам-фильтры платформы считают строки разными).
 * Не удаляется фильтрами очистки невидимых символов.
 */
function homoglyphJitter(text, maxReplacements = 2) {
    if (!text || typeof text !== 'string') return text || '';
    const chars = text.split('');
    const replaceableIndices = [];
    for (let i = 0; i < chars.length; i++) {
        if (HOMOGLYPHS[chars[i]]) {
            replaceableIndices.push(i);
        }
    }
    if (replaceableIndices.length === 0) return text;

    const count = Math.min(replaceableIndices.length, Math.floor(Math.random() * maxReplacements) + 1);
    for (let i = replaceableIndices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [replaceableIndices[i], replaceableIndices[j]] = [replaceableIndices[j], replaceableIndices[i]];
    }
    for (let k = 0; k < count; k++) {
        const idx = replaceableIndices[k];
        chars[idx] = HOMOGLYPHS[chars[idx]];
    }
    return chars.join('');
}

const TITLE_DECORATORS = [
    '', ' 🔥', ' ⚡', ' 👀', ' 🎬', ' ✨', ' 💥', ' ⬇️', ' 👇', ' 👈', ' [HD]', ' (full)', ' (new)', ''
];

/**
 * Создает естественную вариацию заголовка для защиты от спам-фильтров NameVids
 */
function makeVariedTitle(baseTitle, maxLen = 48) {
    let title = parseSpintax(baseTitle || '').trim();
    if (!title) return '';

    // Если заголовок короткий и не содержит спец-символов на конце, добавляем декоратор
    if (title.length < maxLen - 8) {
        const deco = TITLE_DECORATORS[Math.floor(Math.random() * TITLE_DECORATORS.length)];
        title = (title + deco).trim();
    }

    // Применяем гомоглифы
    title = homoglyphJitter(title, 2);

    // Добавляем невидимый Zero-Width space в случайную позицию
    const zwsp = '\u200B';
    const pos = Math.floor(Math.random() * (title.length + 1));
    title = title.slice(0, pos) + zwsp + title.slice(pos);

    if (title.length > maxLen) {
        title = title.slice(0, maxLen).trim();
    }

    return title;
}

/**
 * Создает естественную вариацию описания
 */
function makeVariedCaption(baseCaption) {
    let caption = parseSpintax(baseCaption || '').trim();
    if (!caption) return '';

    // Применяем гомоглифы к описанию
    caption = homoglyphJitter(caption, 2);

    const zwsp = '\u200B';
    const pos = Math.floor(Math.random() * (caption.length + 1));
    caption = caption.slice(0, pos) + zwsp + caption.slice(pos);

    return caption;
}

module.exports = {
    getRandomTitle,
    getRandomCaption,
    parseSpintax,
    homoglyphJitter,
    makeVariedTitle,
    makeVariedCaption
};
