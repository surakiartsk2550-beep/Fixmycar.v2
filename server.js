require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const twilio = require('twilio');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const devOtpRequested = process.env.DEV_OTP_ENABLED === 'true';
const devOtpEnabled = devOtpRequested && !isProduction;
const devOtpCredentials = devOtpEnabled
    ? process.env.DEV_OTP_CREDENTIALS !== undefined
        ? parseDevelopmentOtpCredentials(process.env.DEV_OTP_CREDENTIALS)
        : parseDevelopmentOtpCredentials(`${process.env.DEV_OTP_PHONE || ''}:${process.env.DEV_OTP_CODE || ''}`)
    : new Map();
const pendingDevOtps = new Map();

if (devOtpRequested && isProduction) {
    console.warn('WARNING: Development OTP is disabled because NODE_ENV is production.');
}

if (devOtpEnabled && devOtpCredentials.size === 0) {
    throw new Error('Development OTP requires at least one valid DEV_OTP_CREDENTIALS entry.');
}

// FIXMYCAR Twilio Verify Service from your Twilio Console.
// Service SID is not a secret, but keeping it in .env is still recommended.
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID || 'VA57c9f5054a71d68689b00d3c253ab1f6';

if (!devOtpEnabled && (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)) {
    console.warn('WARNING: Twilio environment variables are not configured. OTP will not work until .env is filled in.');
}

const twilioClient = process.env.TWILIO_ACCOUNT_SID
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const db = new Database(path.join(__dirname, 'fixmycar.db'));
const reviewUploadsDirectory = path.join(__dirname, 'public', 'uploads');
const maxReviewImageBytes = 2 * 1024 * 1024;
fs.mkdirSync(reviewUploadsDirectory, { recursive: true });
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mechanics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    legacy_id TEXT UNIQUE,
    name_en TEXT NOT NULL,
    name_th TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    line_id TEXT NOT NULL DEFAULT '',
    facebook TEXT NOT NULL DEFAULT '',
    shop_location TEXT NOT NULL DEFAULT '',
    lat REAL,
    lng REAL,
    image TEXT NOT NULL DEFAULT '',
    has_shop INTEGER NOT NULL DEFAULT 0,
    rating REAL NOT NULL DEFAULT 0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    categories TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS mechanic_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS banners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image TEXT NOT NULL,
    alt_text TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS banner_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review TEXT NOT NULL,
    profile_image TEXT NOT NULL DEFAULT '',
    photo TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS review_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    before_image TEXT NOT NULL,
    after_image TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`);

const reviewColumns = new Set(db.prepare('PRAGMA table_info(reviews)').all().map((column) => column.name));
if (!reviewColumns.has('profile_image')) {
    db.exec("ALTER TABLE reviews ADD COLUMN profile_image TEXT NOT NULL DEFAULT ''");
}
if (!reviewColumns.has('category')) {
    db.exec("ALTER TABLE reviews ADD COLUMN category TEXT NOT NULL DEFAULT ''");
}
if (!reviewColumns.has('user_id')) {
    db.exec('ALTER TABLE reviews ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}

function decodeHtml(value) {
    return value
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

function readLegacyWorkSamples() {
    return [
        {
            title: 'ล้างห้องเครื่อง',
            beforeImage: 'imgwork/Engine-before.jpg',
            afterImage: 'imgwork/Engine-after.jpg'
        },
        {
            title: 'เจียรจานเบรค',
            beforeImage: 'imgwork/Brake-disc-before.jpg',
            afterImage: 'imgwork/Brake-disc-after.jpg'
        },
        {
            title: 'เปลี่ยนเเบตเตอรี่',
            beforeImage: 'imgwork/battery-before.jpg',
            afterImage: 'imgwork/battery-after.jpg'
        },
        {
            title: 'ล้างแอร์',
            beforeImage: 'imgwork/Air-conditioner-before.jpg',
            afterImage: 'imgwork/Air-conditioner-after.jpg'
        }
    ].map((workSample, position) => ({ ...workSample, position }));
}

const seedLegacyWorkSamples = db.transaction(() => {
    const migration = db.prepare('SELECT value FROM work_meta WHERE key = ?').get('legacy_seeded');
    if (migration) return;

    const count = db.prepare('SELECT COUNT(*) AS count FROM work_samples').get().count;
    if (count === 0) {
        const legacyWorkSamples = readLegacyWorkSamples();
        if (!legacyWorkSamples.length) {
            throw new Error('No legacy work samples were found in public/work.html.');
        }

        const insertWorkSample = db.prepare(`
            INSERT INTO work_samples (title, before_image, after_image, position)
            VALUES (@title, @beforeImage, @afterImage, @position)
        `);
        for (const workSample of legacyWorkSamples) insertWorkSample.run(workSample);
    }

    db.prepare('INSERT INTO work_meta (key, value) VALUES (?, ?)').run('legacy_seeded', 'true');
});
seedLegacyWorkSamples();

function readLegacyMechanics() {
    const serviceHtml = fs.readFileSync(path.join(__dirname, 'public', 'service.html'), 'utf8');
    const openingTag = /<div\b[^>]*class="mechanic"[^>]*>/g;
    const divTags = /<\/?div\b[^>]*>/g;
    const mechanics = [];
    let match;

    while ((match = openingTag.exec(serviceHtml))) {
        let depth = 1;
        divTags.lastIndex = openingTag.lastIndex;
        let divMatch;
        while ((divMatch = divTags.exec(serviceHtml))) {
            depth += divMatch[0].startsWith('</') ? -1 : 1;
            if (depth === 0) {
                const cardHtml = serviceHtml.slice(match.index, divTags.lastIndex);
                const name = cardHtml.match(/<h3 class="mechanic-name" id="([^"]+)">([\s\S]*?)<\/h3>/);
                if (name) {
                    const info = Array.from(cardHtml.matchAll(/<p class="mechanic-info">([\s\S]*?)<\/p>/g))
                        .map((item) => decodeHtml(item[1]));
                    const valueFor = (label) => {
                        const row = info.find((item) => item.startsWith(label));
                        return row ? row.slice(row.indexOf(':') + 1).trim() : '';
                    };
                    const image = cardHtml.match(/<img src="([^"]+)"/);
                    const coordinates = match[0].match(/data-lat="([^"]+)"\s+data-lng="([^"]+)"/);
                    const rating = cardHtml.match(/<span class="rating-text">([\d.]+)\s+\((\d+)\)<\/span>/);

                    mechanics.push({
                        legacyId: name[1],
                        nameEn: decodeHtml(name[2]),
                        nameTh: decodeHtml((cardHtml.match(/<span class="mechanic-name-th">([\s\S]*?)<\/span>/) || [])[1] || ''),
                        phone: valueFor('เบอร์โทร'),
                        lineId: valueFor('Line'),
                        facebook: valueFor('Facebook'),
                        shopLocation: valueFor('ตำแหน่งร้าน'),
                        lat: coordinates ? Number(coordinates[1]) : null,
                        lng: coordinates ? Number(coordinates[2]) : null,
                        image: image ? image[1] : '',
                        hasShop: /class="shop-badge" data-shop="shop"/.test(cardHtml) ? 1 : 0,
                        rating: rating ? Number(rating[1]) : 0,
                        ratingCount: rating ? Number(rating[2]) : 0
                    });
                }
                break;
            }
        }
        openingTag.lastIndex = divTags.lastIndex;
    }

    return mechanics;
}

const migrateLegacyMechanics = db.transaction(() => {
    const migration = db.prepare('SELECT value FROM mechanic_meta WHERE key = ?').get('legacy_seeded');
    if (migration) return;

    if (db.prepare('SELECT COUNT(*) AS count FROM mechanics').get().count === 0) {
        const legacyMechanics = readLegacyMechanics();
        if (!legacyMechanics.length) {
            throw new Error('No legacy mechanics were found in public/service.html.');
        }

        const insertMechanic = db.prepare(`
            INSERT INTO mechanics (
                legacy_id, name_en, name_th, phone, line_id, facebook, shop_location,
                lat, lng, image, has_shop, rating, rating_count
            ) VALUES (
                @legacyId, @nameEn, @nameTh, @phone, @lineId, @facebook, @shopLocation,
                @lat, @lng, @image, @hasShop, @rating, @ratingCount
            )
        `);
        for (const mechanic of legacyMechanics) insertMechanic.run(mechanic);
    }

    db.prepare('INSERT INTO mechanic_meta (key, value) VALUES (?, ?)').run('legacy_seeded', 'true');
});
migrateLegacyMechanics();

const seedLegacyBanners = db.transaction(() => {
    const migration = db.prepare('SELECT value FROM banner_meta WHERE key = ?').get('legacy_seeded');
    if (migration) return;

    const legacyBanners = [
        { image: 'img/banner-1.jpg', altText: 'FIXMYCAR banner 1' },
        { image: 'img/banner-2.png', altText: 'FIXMYCAR banner 2' },
        { image: 'img/banner-3.jpg', altText: 'FIXMYCAR banner 3' }
    ];
    const insertBanner = db.prepare('INSERT INTO banners (image, alt_text) VALUES (@image, @altText)');
    if (db.prepare('SELECT COUNT(*) AS count FROM banners').get().count === 0) {
        for (const banner of legacyBanners) insertBanner.run(banner);
    }

    db.prepare('INSERT INTO banner_meta (key, value) VALUES (?, ?)').run('legacy_seeded', 'true');
});
seedLegacyBanners();

const seedLegacyReviews = db.transaction(() => {
    const migration = db.prepare('SELECT value FROM review_meta WHERE key = ?').get('legacy_seeded');
    if (migration) return;

    const legacyReviews = [
        {
            name: 'คุณเจน',
            rating: 5,
            review: 'รถเสียอยู่กลางทาง ช่างมาช่วยเร็วมาก บริการดีและอธิบายละเอียด',
            photo: 'imgwork/Engine-after.jpg'
        },
        {
            name: 'ใบบัว',
            rating: 5,
            review: 'ใช้งานสะดวก มาไว ทำงานเรียบร้อย ราคาแจ้งก่อนซ่อม',
            photo: 'imgwork/Brake-disc-after.jpg'
        },
        {
            name: 'สมศักดิ์',
            rating: 4,
            review: 'ประทับใจการบริการมากครับ ช่างอธิบายสาเหตุและแนวทางแก้ไขชัดเจน',
            photo: ''
        },
        {
            name: 'สมศรี',
            rating: 4,
            review: 'ตรวจเช็กละเอียด แจ้งทุกขั้นตอนก่อนดำเนินการ ทำให้มั่นใจในการใช้บริการ',
            photo: ''
        }
    ];
    const insertReview = db.prepare(`
        INSERT INTO reviews (name, rating, review, photo)
        VALUES (@name, @rating, @review, @photo)
    `);

    if (db.prepare('SELECT COUNT(*) AS count FROM reviews').get().count === 0) {
        for (const review of legacyReviews) insertReview.run(review);
    }

    db.prepare('INSERT INTO review_meta (key, value) VALUES (?, ?)').run('legacy_seeded', 'true');
});
seedLegacyReviews();

const reviewJsonParser = express.json({ limit: '6mb' });
app.use('/api/reviews', (req, res, next) => {
    reviewJsonParser(req, res, (error) => {
        if (!error) return next();
        if (error.type === 'entity.too.large') {
            return res.status(413).json({ message: 'ขนาดรูปภาพรวมต้องไม่เกิน 4 MB' });
        }
        if (error.type === 'entity.parse.failed') {
            return res.status(400).json({ message: 'ข้อมูลรีวิวไม่ถูกต้อง' });
        }
        return next(error);
    });
});
app.use(express.json());
app.use(cookieParser());

const requestOtpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'ขอ OTP บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' }
});

const verifyOtpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'ลอง OTP มากเกินไป กรุณารอสักครู่แล้วลองใหม่' }
});

function normalizePhone(phone) {
    const value = String(phone || '').replace(/\D/g, '');
    if (/^0\d{9}$/.test(value)) return '+66' + value.slice(1);
    if (/^66\d{9}$/.test(value)) return '+' + value;
    if (/^1\d{10}$/.test(value)) return '+' + value;
    if (/^\d{10}$/.test(value)) return '+1' + value;
    return null;
}

function parseDevelopmentOtpCredentials(value) {
    const credentials = new Map();

    for (const entry of value.split(',')) {
        const separator = entry.lastIndexOf(':');
        const phone = normalizePhone(entry.slice(0, separator).trim());
        const code = entry.slice(separator + 1).trim();

        if (separator < 0 || !phone || !/^\d{6}$/.test(code) || credentials.has(phone)) {
            throw new Error('Development OTP credentials must contain unique valid phone:6-digit-code entries.');
        }

        credentials.set(phone, code);
    }

    return credentials;
}

function getAdminPhones(value) {
    const phones = new Set();

    for (const phone of value.split(',')) {
        const normalizedPhone = normalizePhone(phone.trim());
        if (normalizedPhone) {
            phones.add(normalizedPhone);
        } else if (phone.trim()) {
            console.warn('Ignoring an invalid phone number in ADMIN_PHONES.');
        }
    }

    return phones;
}

const adminPhones = getAdminPhones(process.env.ADMIN_PHONES || '');

function isAdmin(user) {
    return adminPhones.has(user.phone);
}

function requireAdmin(req, res) {
    const user = getCurrentUser(req);
    if (!user) {
        res.status(401).json({ authenticated: false });
        return false;
    }
    if (!isAdmin(user)) {
        res.status(403).json({ message: 'ไม่มีสิทธิ์เข้าถึง Dashboard' });
        return false;
    }
    return true;
}

function serializeMechanic(mechanic) {
    return {
        id: mechanic.id,
        legacyId: mechanic.legacy_id,
        nameEn: mechanic.name_en,
        nameTh: mechanic.name_th,
        phone: mechanic.phone,
        lineId: mechanic.line_id,
        facebook: mechanic.facebook,
        shopLocation: mechanic.shop_location,
        lat: mechanic.lat,
        lng: mechanic.lng,
        image: mechanic.image,
        hasShop: Boolean(mechanic.has_shop),
        rating: mechanic.rating,
        ratingCount: mechanic.rating_count,
        categories: JSON.parse(mechanic.categories)
    };
}

function serializeBanner(banner) {
    return {
        id: banner.id,
        image: banner.image,
        altText: banner.alt_text
    };
}

function serializeReview(review, viewerId = null) {
    return {
        id: review.id,
        name: review.name,
        rating: review.rating,
        review: review.review,
        profileImage: review.profile_image,
        photo: review.photo,
        category: review.category,
        createdAt: review.created_at,
        isOwner: viewerId !== null && review.user_id === viewerId
    };
}

function serializeWorkSample(workSample) {
    return {
        id: workSample.id,
        title: workSample.title,
        beforeImage: workSample.before_image,
        afterImage: workSample.after_image
    };
}

function validateWorkSample(body) {
    const title = String(body.title || '').trim();
    if (!title || title.length > 100) {
        return { error: 'กรุณากรอกชื่องานไม่เกิน 100 ตัวอักษร' };
    }

    const before = validateBanner({ image: body.beforeImage });
    if (before.error) return { error: `รูปก่อนซ่อม: ${before.error}` };
    const after = validateBanner({ image: body.afterImage });
    if (after.error) return { error: `รูปหลังซ่อม: ${after.error}` };

    return {
        values: {
            title,
            beforeImage: before.values.image,
            afterImage: after.values.image
        }
    };
}

function decodeReviewImage(dataUrl, label) {
    if (dataUrl === undefined || dataUrl === null || dataUrl === '') return null;
    if (typeof dataUrl !== 'string') {
        throw new Error(`${label}ต้องเป็นไฟล์รูปภาพ`);
    }

    const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length > Math.ceil(maxReviewImageBytes / 3) * 4) {
        throw new Error(`${label}ต้องเป็นไฟล์ JPG, PNG หรือ WebP ขนาดไม่เกิน 2 MB`);
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > maxReviewImageBytes ||
        buffer.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
        throw new Error(`${label}ต้องเป็นไฟล์ JPG, PNG หรือ WebP ขนาดไม่เกิน 2 MB`);
    }

    let extension;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        extension = 'jpg';
    } else if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        extension = 'png';
    } else if (
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
        extension = 'webp';
    }

    const expectedExtension = match[1] === 'jpeg' ? 'jpg' : match[1];
    if (!extension || extension !== expectedExtension) {
        throw new Error(`${label}มีชนิดไฟล์ไม่ถูกต้อง`);
    }

    return { buffer, extension };
}

function validateReview(body) {
    const name = String(body.name || '').trim();
    const review = String(body.review || '').trim();
    const category = String(body.category || '').trim();
    const allowedCategories = new Set(['', 'repair', 'tirerepair', 'carwash', 'oilchange', 'battery', 'carcheck']);
    const ratingInput = body.rating === undefined || body.rating === null
        ? ''
        : String(body.rating).trim();
    const rating = Number(ratingInput);

    if (!name || name.length > 35) {
        return { error: 'กรุณากรอกชื่อไม่เกิน 35 ตัวอักษร' };
    }
    if (!ratingInput || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        return { error: 'คะแนนดาวต้องเป็นจำนวนเต็มระหว่าง 1 ถึง 5' };
    }
    if (!review || review.length > 200) {
        return { error: 'กรุณากรอกความคิดเห็นไม่เกิน 200 ตัวอักษร' };
    }
    if (!allowedCategories.has(category)) {
        return { error: 'หมวดหมู่บริการไม่ถูกต้อง' };
    }

    return { values: { name, rating, review, category } };
}

function validateAdminReview(body) {
    const result = validateReview(body);
    if (result.error) return result;

    const profileImage = String(body.profileImage || '').trim();
    const photo = String(body.photo || '').trim();
    for (const [label, image] of [['รูปโปรไฟล์', profileImage], ['รูปประกอบรีวิว', photo]]) {
        if (!image) continue;
        const validation = validateBanner({ image });
        if (validation.error) {
            return { error: `${label}: ${validation.error}` };
        }
    }

    return {
        values: {
            ...result.values,
            profileImage,
            photo
        }
    };
}

function validateBanner(body) {
    const image = String(body.image || '').trim();
    const altText = String(body.altText || '').trim();
    const isHttpsUrl = (() => {
        try {
            return new URL(image).protocol === 'https:';
        } catch {
            return false;
        }
    })();
    const isInternalPath = /^(?:\/)?(?:img|imgwork|uploads)\/[A-Za-z0-9._/-]+$/.test(image) &&
        !image.split('/').includes('..');

    if (!image || image.length > 500 || (!isHttpsUrl && !isInternalPath)) {
        return { error: 'รูปภาพต้องเป็น URL HTTPS หรือพาธภายในเว็บไซต์ เช่น img/banner.jpg' };
    }
    if (altText.length > 200) {
        return { error: 'คำอธิบายรูปภาพต้องมีความยาวไม่เกิน 200 ตัวอักษร' };
    }

    return { values: { image, altText } };
}

function validateMechanic(body) {
    const textFields = {
        nameEn: 120,
        nameTh: 120,
        phone: 40,
        lineId: 120,
        facebook: 160,
        shopLocation: 200
    };
    const values = {};
    for (const [field, maxLength] of Object.entries(textFields)) {
        const value = String(body[field] || '').trim();
        if (field === 'nameEn' && !value) return { error: 'กรุณากรอกชื่อช่าง' };
        if (value.length > maxLength) return { error: 'ข้อมูลช่างยาวเกินกำหนด' };
        values[field] = value;
    }

    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return { error: 'กรุณากรอกพิกัดละติจูดและลองจิจูดให้ถูกต้อง' };
    }

    const ratingInput = body.rating === undefined || body.rating === null ? '' : String(body.rating).trim();
    const ratingCountInput = body.ratingCount === undefined || body.ratingCount === null
        ? ''
        : String(body.ratingCount).trim();
    const rating = Number(ratingInput);
    const ratingCount = Number(ratingCountInput);
    if (!ratingInput || !Number.isInteger(rating) || rating < 0 || rating > 5) {
        return { error: 'คะแนนดาวต้องเป็นจำนวนเต็มระหว่าง 0 ถึง 5' };
    }
    if (!ratingCountInput || !Number.isSafeInteger(ratingCount) || ratingCount < 0 || ratingCount > 2147483647) {
        return { error: 'จำนวนรีวิวต้องเป็นจำนวนเต็มตั้งแต่ 0 ถึง 2147483647' };
    }

    const image = String(body.image || '').trim();
    const safeImage = image.startsWith('https://') ||
        image.startsWith('imgmechanic/') ||
        (image.startsWith('/') && !image.startsWith('//'));
    if (image && !safeImage) {
        return { error: 'URL รูปภาพต้องเป็น HTTPS หรือพาธภายในเว็บไซต์' };
    }

    const allowedCategories = new Set(['repair', 'tirerepair', 'carwash', 'oilchange', 'battery', 'carcheck']);
    const categories = Array.isArray(body.categories)
        ? [...new Set(body.categories.filter((category) => allowedCategories.has(category)))]
        : [];

    return {
        values: {
            ...values,
            lat,
            lng,
            image,
            rating,
            ratingCount,
            hasShop: body.hasShop === true ? 1 : 0,
            categories: JSON.stringify(categories)
        }
    };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(userId, res) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000);

    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, userId, expiresAt);

    res.cookie('fixmycar_session', rawToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/'
    });
}

function getCurrentUser(req) {
    const token = req.cookies.fixmycar_session;
    if (!token) return null;

    const row = db.prepare(`
        SELECT users.id, users.phone, users.created_at, users.last_login, sessions.expires_at
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(hashToken(token), Date.now());

    return row || null;
}

app.post('/api/auth/request-otp', requestOtpLimiter, async (req, res) => {
    try {
        const phone = normalizePhone(req.body.phone);

        if (!phone) {
            return res.status(400).json({ message: 'เบอร์โทรศัพท์ไม่ถูกต้อง' });
        }

        if (devOtpEnabled) {
            if (!devOtpCredentials.has(phone)) {
                return res.status(400).json({ message: 'โหมดทดสอบรองรับเฉพาะเบอร์ที่กำหนดไว้' });
            }

            pendingDevOtps.set(phone, { expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0 });
            return res.json({ ok: true, status: 'pending', verificationId: phone, mode: 'development' });
        }

        if (!twilioClient) {
            return res.status(500).json({ message: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า SMS OTP' });
        }

        const verification = await twilioClient.verify.v2
            .services(TWILIO_VERIFY_SERVICE_SID)
            .verifications
            .create({ to: phone, channel: 'sms' });

        return res.json({
            ok: true,
            status: verification.status,
            verificationId: phone
        });
    } catch (error) {
        console.error('request OTP error:', error.message);
        return res.status(500).json({ message: 'ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่' });
    }
});

app.post('/api/auth/verify-otp', verifyOtpLimiter, async (req, res) => {
    try {
        const phone = normalizePhone(req.body.verificationId);
        const code = String(req.body.otp || '').replace(/\D/g, '');

        if (!phone || !/^\d{6}$/.test(code)) {
            return res.status(400).json({ message: 'ข้อมูล OTP ไม่ถูกต้อง' });
        }

        if (devOtpEnabled) {
            const pendingOtp = pendingDevOtps.get(phone);
            const expectedCode = devOtpCredentials.get(phone);

            if (!expectedCode || !pendingOtp || pendingOtp.expiresAt <= Date.now() || pendingOtp.attempts >= 5) {
                pendingDevOtps.delete(phone);
                return res.status(401).json({ message: 'OTP ไม่ถูกต้องหรือหมดอายุ' });
            }

            if (code !== expectedCode) {
                pendingOtp.attempts++;
                return res.status(401).json({ message: 'OTP ไม่ถูกต้องหรือหมดอายุ' });
            }

            pendingDevOtps.delete(phone);
        } else if (!twilioClient) {
            return res.status(500).json({ message: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า SMS OTP' });
        } else {
            const check = await twilioClient.verify.v2
                .services(TWILIO_VERIFY_SERVICE_SID)
                .verificationChecks
                .create({ to: phone, code });

            if (check.status !== 'approved') {
                return res.status(401).json({ message: 'OTP ไม่ถูกต้องหรือหมดอายุ' });
            }
        }

        let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);

        if (!user) {
            const result = db.prepare('INSERT INTO users (phone, last_login) VALUES (?, CURRENT_TIMESTAMP)').run(phone);
            user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
        } else {
            db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
        }

        createSession(user.id, res);

        return res.json({
            ok: true,
            redirect: '/home.html',
            user: {
                id: user.id,
                phone: user.phone
            }
        });
    } catch (error) {
        console.error('verify OTP error:', error.message);
        return res.status(500).json({ message: 'ตรวจสอบ OTP ไม่สำเร็จ กรุณาลองใหม่' });
    }
});

app.get('/api/auth/me', (req, res) => {
    const user = getCurrentUser(req);

    if (!user) {
        return res.status(401).json({ authenticated: false });
    }

    return res.json({
        authenticated: true,
        user: {
            id: user.id,
            phone: user.phone,
            isAdmin: isAdmin(user),
            createdAt: user.created_at,
            lastLogin: user.last_login
        }
    });
});

app.get('/api/admin/dashboard', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const registeredUsers = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    const mechanicCount = db.prepare('SELECT COUNT(*) AS count FROM mechanics').get().count;
    const totalReviews = db.prepare('SELECT COUNT(*) AS count FROM reviews').get().count;
    const reviewCategoryLabels = {
        repair: 'ช่างซ่อม',
        tirerepair: 'ช่างปะยาง',
        carwash: 'ล้างภายใน/ภายนอก',
        oilchange: 'ถ่ายน้ำมันเครื่อง',
        battery: 'เปลี่ยนแบต',
        carcheck: 'เช็คสภาพรถ',
        unspecified: 'ไม่ระบุ'
    };
    const reviewCategoryCounts = new Map(
        db.prepare(`
            SELECT COALESCE(NULLIF(category, ''), 'unspecified') AS category, COUNT(*) AS count
            FROM reviews
            GROUP BY COALESCE(NULLIF(category, ''), 'unspecified')
        `).all().map((row) => [row.category, row.count])
    );
    const reviewCategories = Object.entries(reviewCategoryLabels).map(([category, label]) => ({
        category,
        label,
        count: reviewCategoryCounts.get(category) || 0
    }));

    return res.json({ registeredUsers, mechanicCount, totalReviews, reviewCategories });
});

app.get('/api/banners', (req, res) => {
    const banners = db.prepare('SELECT * FROM banners ORDER BY id').all();
    return res.json({ banners: banners.map(serializeBanner) });
});

app.get('/api/reviews', (req, res) => {
    const user = getCurrentUser(req);
    const reviews = db.prepare('SELECT * FROM reviews ORDER BY id DESC').all();
    return res.json({ reviews: reviews.map((review) => serializeReview(review, user?.id ?? null)) });
});

app.get('/api/works', (req, res) => {
    const workSamples = db.prepare('SELECT * FROM work_samples ORDER BY position, id').all();
    return res.json({ works: workSamples.map(serializeWorkSample) });
});

app.post('/api/reviews', (req, res) => {
    const user = getCurrentUser(req);
    if (!user) {
        return res.status(401).json({ message: 'กรุณาเข้าสู่ระบบก่อนเขียนรีวิว' });
    }

    const result = validateReview(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    let profileImage;
    let photo;
    try {
        profileImage = decodeReviewImage(req.body.profileImage, 'รูปโปรไฟล์');
        photo = decodeReviewImage(req.body.photo, 'รูปประกอบรีวิว');
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }

    const savedFiles = [];
    try {
        const saveImage = (image) => {
            if (!image) return '';
            const filename = `${crypto.randomUUID()}.${image.extension}`;
            fs.writeFileSync(path.join(reviewUploadsDirectory, filename), image.buffer, { flag: 'wx' });
            const imagePath = `/uploads/${filename}`;
            savedFiles.push(imagePath);
            return imagePath;
        };
        const profileImagePath = saveImage(profileImage);
        const photoPath = saveImage(photo);
        const inserted = db.prepare(`
            INSERT INTO reviews (name, rating, review, profile_image, photo, category, user_id)
            VALUES (@name, @rating, @review, @profileImage, @photo, @category, @userId)
        `).run({
            ...result.values,
            profileImage: profileImagePath,
            photo: photoPath,
            userId: user.id
        });
        const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(inserted.lastInsertRowid);
        return res.status(201).json({ review: serializeReview(review, user.id) });
    } catch (error) {
        for (const imagePath of savedFiles) {
            try {
                fs.unlinkSync(path.join(reviewUploadsDirectory, path.basename(imagePath)));
            } catch (cleanupError) {
                console.error('Remove unreferenced review image error:', cleanupError.message);
            }
        }
        console.error('Create review error:', error.message);
        return res.status(500).json({ message: 'ส่งรีวิวไม่สำเร็จ กรุณาลองใหม่' });
    }
});

app.put('/api/reviews/:id', (req, res) => {
    const user = getCurrentUser(req);
    if (!user) {
        return res.status(401).json({ message: 'กรุณาเข้าสู่ระบบก่อนแก้ไขรีวิว' });
    }

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ message: 'รหัสรีวิวไม่ถูกต้อง' });
    }

    const existingReview = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
    if (!existingReview || existingReview.user_id !== user.id) {
        return res.status(404).json({ message: 'ไม่พบรีวิวที่ต้องการแก้ไข' });
    }

    const result = validateReview(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    let profileImage;
    let photo;
    try {
        profileImage = decodeReviewImage(req.body.profileImage, 'รูปโปรไฟล์');
        photo = decodeReviewImage(req.body.photo, 'รูปประกอบรีวิว');
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }

    const savedFiles = [];
    try {
        const saveImage = (image) => {
            if (!image) return null;
            const filename = `${crypto.randomUUID()}.${image.extension}`;
            fs.writeFileSync(path.join(reviewUploadsDirectory, filename), image.buffer, { flag: 'wx' });
            const imagePath = `/uploads/${filename}`;
            savedFiles.push(imagePath);
            return imagePath;
        };
        const profileImagePath = saveImage(profileImage);
        const photoPath = saveImage(photo);
        db.prepare(`
            UPDATE reviews
            SET name = @name, rating = @rating, review = @review, category = @category,
                profile_image = COALESCE(@profileImage, profile_image),
                photo = COALESCE(@photo, photo)
            WHERE id = @id AND user_id = @userId
        `).run({
            ...result.values,
            profileImage: profileImagePath,
            photo: photoPath,
            id,
            userId: user.id
        });

        const updatedReview = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
        return res.json({ review: serializeReview(updatedReview, user.id) });
    } catch (error) {
        for (const imagePath of savedFiles) {
            try {
                fs.unlinkSync(path.join(reviewUploadsDirectory, path.basename(imagePath)));
            } catch (cleanupError) {
                console.error('Remove unreferenced review image error:', cleanupError.message);
            }
        }
        console.error('Update review error:', error.message);
        return res.status(500).json({ message: 'แก้ไขรีวิวไม่สำเร็จ กรุณาลองใหม่' });
    }
});

app.delete('/api/reviews/:id', (req, res) => {
    const user = getCurrentUser(req);
    if (!user) {
        return res.status(401).json({ message: 'กรุณาเข้าสู่ระบบก่อนลบรีวิว' });
    }

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ message: 'รหัสรีวิวไม่ถูกต้อง' });
    }

    const result = db.prepare('DELETE FROM reviews WHERE id = ? AND user_id = ?').run(id, user.id);
    if (!result.changes) {
        return res.status(404).json({ message: 'ไม่พบรีวิวที่ต้องการลบ' });
    }
    return res.json({ ok: true });
});

app.get('/api/admin/banners', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const banners = db.prepare('SELECT * FROM banners ORDER BY id').all();
    return res.json({ banners: banners.map(serializeBanner) });
});

app.get('/api/admin/works', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const workSamples = db.prepare('SELECT * FROM work_samples ORDER BY position, id').all();
    return res.json({ works: workSamples.map(serializeWorkSample) });
});

app.get('/api/admin/reviews', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const reviews = db.prepare('SELECT * FROM reviews ORDER BY id DESC').all();
    return res.json({ reviews: reviews.map(serializeReview) });
});

app.post('/api/admin/reviews', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const result = validateAdminReview(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    try {
        const inserted = db.prepare(`
            INSERT INTO reviews (name, rating, review, category, profile_image, photo)
            VALUES (@name, @rating, @review, @category, @profileImage, @photo)
        `).run(result.values);
        const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(inserted.lastInsertRowid);
        return res.status(201).json({ review: serializeReview(review) });
    } catch (error) {
        console.error('Admin create review error:', error.message);
        return res.status(500).json({ message: 'เพิ่มรีวิวไม่สำเร็จ' });
    }
});

app.put('/api/admin/reviews/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ message: 'รหัสรีวิวไม่ถูกต้อง' });
    }

    const result = validateAdminReview(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    try {
        const updated = db.prepare(`
            UPDATE reviews
            SET name = @name, rating = @rating, review = @review, category = @category,
                profile_image = @profileImage, photo = @photo
            WHERE id = @id
        `).run({ ...result.values, id });
        if (!updated.changes) {
            return res.status(404).json({ message: 'ไม่พบรีวิวที่ต้องการแก้ไข' });
        }
        const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
        return res.json({ review: serializeReview(review) });
    } catch (error) {
        console.error('Admin update review error:', error.message);
        return res.status(500).json({ message: 'แก้ไขรีวิวไม่สำเร็จ' });
    }
});

app.delete('/api/admin/reviews/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ message: 'รหัสรีวิวไม่ถูกต้อง' });
    }

    const result = db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
    if (!result.changes) {
        return res.status(404).json({ message: 'ไม่พบรีวิวที่ต้องการลบ' });
    }
    return res.json({ ok: true });
});

app.post('/api/admin/works', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const result = validateWorkSample(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    try {
        const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM work_samples').get().position;
        const inserted = db.prepare(`
            INSERT INTO work_samples (title, before_image, after_image, position)
            VALUES (@title, @beforeImage, @afterImage, @position)
        `).run({ ...result.values, position });
        const workSample = db.prepare('SELECT * FROM work_samples WHERE id = ?').get(inserted.lastInsertRowid);
        return res.status(201).json({ work: serializeWorkSample(workSample) });
    } catch (error) {
        console.error('Create work sample error:', error.message);
        return res.status(500).json({ message: 'เพิ่มผลงานไม่สำเร็จ' });
    }
});

app.put('/api/admin/works/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ message: 'รหัสผลงานไม่ถูกต้อง' });
    }

    const result = validateWorkSample(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    try {
        const updated = db.prepare(`
            UPDATE work_samples
            SET title = @title, before_image = @beforeImage, after_image = @afterImage
            WHERE id = @id
        `).run({ ...result.values, id });
        if (!updated.changes) {
            return res.status(404).json({ message: 'ไม่พบผลงานที่ต้องการแก้ไข' });
        }
        const workSample = db.prepare('SELECT * FROM work_samples WHERE id = ?').get(id);
        return res.json({ work: serializeWorkSample(workSample) });
    } catch (error) {
        console.error('Update work sample error:', error.message);
        return res.status(500).json({ message: 'แก้ไขผลงานไม่สำเร็จ' });
    }
});

app.delete('/api/admin/works/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ message: 'รหัสผลงานไม่ถูกต้อง' });
    }

    const result = db.prepare('DELETE FROM work_samples WHERE id = ?').run(id);
    if (!result.changes) {
        return res.status(404).json({ message: 'ไม่พบผลงานที่ต้องการลบ' });
    }
    return res.json({ ok: true });
});

app.post('/api/admin/banners', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const result = validateBanner(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    try {
        const inserted = db.prepare(
            'INSERT INTO banners (image, alt_text) VALUES (@image, @altText)'
        ).run(result.values);
        const banner = db.prepare('SELECT * FROM banners WHERE id = ?').get(inserted.lastInsertRowid);
        return res.status(201).json({ banner: serializeBanner(banner) });
    } catch (error) {
        console.error('Create banner error:', error.message);
        return res.status(500).json({ message: 'เพิ่ม Banner ไม่สำเร็จ' });
    }
});

app.put('/api/admin/banners/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ message: 'รหัส Banner ไม่ถูกต้อง' });
    }

    const result = validateBanner(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    try {
        const updated = db.prepare(
            'UPDATE banners SET image = @image, alt_text = @altText WHERE id = @id'
        ).run({ ...result.values, id });
        if (!updated.changes) {
            return res.status(404).json({ message: 'ไม่พบ Banner ที่ต้องการแก้ไข' });
        }
        const banner = db.prepare('SELECT * FROM banners WHERE id = ?').get(id);
        return res.json({ banner: serializeBanner(banner) });
    } catch (error) {
        console.error('Update banner error:', error.message);
        return res.status(500).json({ message: 'แก้ไข Banner ไม่สำเร็จ' });
    }
});

app.delete('/api/admin/banners/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ message: 'รหัส Banner ไม่ถูกต้อง' });
    }

    const result = db.prepare('DELETE FROM banners WHERE id = ?').run(id);
    if (!result.changes) {
        return res.status(404).json({ message: 'ไม่พบ Banner ที่ต้องการลบ' });
    }
    return res.json({ ok: true });
});

app.get('/api/mechanics', (req, res) => {
    const mechanics = db.prepare('SELECT * FROM mechanics ORDER BY id').all();
    return res.json({ mechanics: mechanics.map(serializeMechanic) });
});

app.get('/api/admin/mechanics', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const mechanics = db.prepare('SELECT * FROM mechanics ORDER BY id DESC').all();
    return res.json({ mechanics: mechanics.map(serializeMechanic) });
});

app.post('/api/admin/mechanics', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const result = validateMechanic(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    try {
        const insert = db.prepare(`
            INSERT INTO mechanics (
                name_en, name_th, phone, line_id, facebook, shop_location,
                lat, lng, image, has_shop, rating, rating_count, categories
            ) VALUES (
                @nameEn, @nameTh, @phone, @lineId, @facebook, @shopLocation,
                @lat, @lng, @image, @hasShop, @rating, @ratingCount, @categories
            )
        `);
        const inserted = insert.run(result.values);
        const mechanic = db.prepare('SELECT * FROM mechanics WHERE id = ?').get(inserted.lastInsertRowid);
        return res.status(201).json({ mechanic: serializeMechanic(mechanic) });
    } catch (error) {
        console.error('Create mechanic error:', error.message);
        return res.status(500).json({ message: 'เพิ่มข้อมูลช่างไม่สำเร็จ' });
    }
});

app.put('/api/admin/mechanics/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ message: 'รหัสช่างไม่ถูกต้อง' });
    }

    const result = validateMechanic(req.body || {});
    if (result.error) return res.status(400).json({ message: result.error });

    const update = db.prepare(`
        UPDATE mechanics SET
            name_en = @nameEn,
            name_th = @nameTh,
            phone = @phone,
            line_id = @lineId,
            facebook = @facebook,
            shop_location = @shopLocation,
            lat = @lat,
            lng = @lng,
            image = @image,
            has_shop = @hasShop,
            rating = @rating,
            rating_count = @ratingCount,
            categories = @categories
        WHERE id = @id
    `);
    try {
        const updated = update.run({ ...result.values, id });
        if (!updated.changes) {
            return res.status(404).json({ message: 'ไม่พบข้อมูลช่างที่ต้องการแก้ไข' });
        }
        const mechanic = db.prepare('SELECT * FROM mechanics WHERE id = ?').get(id);
        return res.json({ mechanic: serializeMechanic(mechanic) });
    } catch (error) {
        console.error('Update mechanic error:', error.message);
        return res.status(500).json({ message: 'แก้ไขข้อมูลช่างไม่สำเร็จ' });
    }
});

app.delete('/api/admin/mechanics/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ message: 'รหัสช่างไม่ถูกต้อง' });
    }

    const result = db.prepare('DELETE FROM mechanics WHERE id = ?').run(id);
    if (!result.changes) {
        return res.status(404).json({ message: 'ไม่พบข้อมูลช่างที่ต้องการลบ' });
    }
    return res.json({ ok: true });
});

app.get('/api/admin/dashboard-status', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    if (devOtpEnabled) {
        return res.json({ otp: { status: 'development' } });
    }

    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
        return res.json({ otp: { status: 'not_configured' } });
    }

    try {
        const credentials = Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64');
        const response = await fetch(
            `https://verify.twilio.com/v2/Services/${encodeURIComponent(TWILIO_VERIFY_SERVICE_SID)}`,
            {
                headers: { Authorization: `Basic ${credentials}` },
                signal: AbortSignal.timeout(8000)
            }
        );

        if (!response.ok) {
            console.error(`Twilio Verify health check failed with status ${response.status}.`);
            return res.json({ otp: { status: 'unavailable' } });
        }

        return res.json({ otp: { status: 'operational' } });
    } catch (error) {
        console.error('Twilio Verify health check error:', error.message);
        return res.json({ otp: { status: 'unavailable' } });
    }
});

app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies.fixmycar_session;

    if (token) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    }

    res.clearCookie('fixmycar_session', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
    res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '' });
});

app.get('/dashboard.html', (req, res) => {
    const user = getCurrentUser(req);

    if (!user) {
        return res.redirect('/login.html');
    }

    if (!isAdmin(user)) {
        return res.redirect('/home.html');
    }

    return res.sendFile('dashboard.html', { root: path.join(__dirname, 'public') });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, HOST, () => {
    console.log(`FIXMYCAR login server running at http://${HOST}:${PORT}/home.html ✅Successful`);
});
