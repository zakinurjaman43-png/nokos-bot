require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const crypto = require('crypto');
const midtransClient = require('midtrans-client');

// ==================================================
// KONFIGURASI
// ==================================================

const SMSCODE_BASE_URL = 'https://api.smscode.gg/v1';

const MARKUP_MINIMAL = 2000;
const PEMBULATAN_HARGA = 500;

const MIN_DEPOSIT = 15000;

const DEPOSIT_OPTIONS = [
    15000,
    25000,
    50000,
    100000,
    250000,
    500000
];

const DATABASE_FILE = './users.json';

// ==================================================
// VALIDASI ENV
// ==================================================

if (!process.env.BOT_TOKEN) {
    console.log('❌ BOT_TOKEN tidak ditemukan di .env');
    process.exit(1);
}

if (!process.env.SMSCODE_API_TOKEN) {
    console.log('❌ SMSCODE_API_TOKEN tidak ditemukan di .env');
    process.exit(1);
}

if (!process.env.MIDTRANS_SERVER_KEY) {
    console.log('❌ MIDTRANS_SERVER_KEY tidak ditemukan di .env');
    process.exit(1);
}

// ==================================================
// TELEGRAM BOT
// ==================================================

const bot = new TelegramBot(
    process.env.BOT_TOKEN,
    {
        polling: true
    }
);

console.log('========================================');
console.log('NOKOS STORE BOT');
console.log('BOT SEDANG JALAN...');
console.log('========================================');

// ==================================================
// MIDTRANS
// ==================================================

const midtransCore = new midtransClient.CoreApi({
    isProduction: true,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY || ''
});

const MIDTRANS_BASE_URL = 'https://api.midtrans.com';

// ==================================================
// LOCK PEMBELIAN
// ==================================================

const processingPurchases = new Set();

const processingDeposits = new Set();

// ==================================================
// DATABASE
// ==================================================

function loadUsers() {

    try {

        if (!fs.existsSync(DATABASE_FILE)) {

            fs.writeFileSync(
                DATABASE_FILE,
                JSON.stringify({}, null, 2)
            );

        }

        const raw = fs.readFileSync(
            DATABASE_FILE,
            'utf8'
        );

        const users = JSON.parse(raw);

        return users && typeof users === 'object'
            ? users
            : {};

    } catch (error) {

        console.log(
            'DATABASE LOAD ERROR:',
            error.message
        );

        return {};
    }
}

function saveUsers(users) {

    fs.writeFileSync(
        DATABASE_FILE,
        JSON.stringify(users, null, 2)
    );
}

// ==================================================
// FORMAT TELEGRAM USER
// ==================================================

function getTelegramName(msg) {

    const firstName =
        msg?.from?.first_name || '';

    const lastName =
        msg?.from?.last_name || '';

    const fullName =
        `${firstName} ${lastName}`.trim();

    return fullName || 'Pengguna Telegram';
}

function getTelegramUsername(msg) {

    if (msg?.from?.username) {

        return `@${msg.from.username}`;

    }

    return '-';
}

// ==================================================
// USER
// ==================================================

function getUser(chatId) {

    const users = loadUsers();

    const id = String(chatId);

    if (!users[id]) {

        users[id] = {

            id: chatId,

            name: 'Pengguna Telegram',

            username: '-',

            balance: 0,

            orders: [],

            history: [],

            deposits: []

        };

        saveUsers(users);

    }

    // Backup kalau user lama belum punya field
    if (!Array.isArray(users[id].orders)) {
        users[id].orders = [];
    }

    if (!Array.isArray(users[id].history)) {
        users[id].history = [];
    }

    if (!Array.isArray(users[id].deposits)) {
        users[id].deposits = [];
    }

    if (typeof users[id].balance !== 'number') {
        users[id].balance =
            Number(users[id].balance || 0);
    }

    return users[id];
}

function updateTelegramUser(msg) {

    const users = loadUsers();

    const chatId =
        String(msg.chat.id);

    if (!users[chatId]) {

        users[chatId] = {

            id: msg.chat.id,

            name: getTelegramName(msg),

            username: getTelegramUsername(msg),

            balance: 0,

            orders: [],

            history: [],

            deposits: []

        };

    } else {

        users[chatId].name =
            getTelegramName(msg);

        users[chatId].username =
            getTelegramUsername(msg);

    }

    saveUsers(users);

    return users[chatId];
}

// ==================================================
// RUPIAH
// ==================================================

function rupiah(angka) {

    return Number(angka || 0)
        .toLocaleString('id-ID');
}

// ==================================================
// HARGA JUAL
// ==================================================

function hitungHargaJual(hargaSupplier) {

    const harga =
        Number(hargaSupplier || 0) +
        MARKUP_MINIMAL;

    return Math.ceil(
        harga / PEMBULATAN_HARGA
    ) * PEMBULATAN_HARGA;
}

// ==================================================
// API SMSCODE
// ==================================================

async function apiRequest(
    url,
    options = {}
) {

    try {

        const response =
            await fetch(
                url,
                {
                    ...options,

                    headers: {

                        Authorization:
                            `Bearer ${process.env.SMSCODE_API_TOKEN}`,

                        'Content-Type':
                            'application/json',

                        ...(options.headers || {})

                    }
                }
            );

        const text =
            await response.text();

        let json;

        try {

            json = JSON.parse(text);

        } catch {

            json = {
                success: false,
                message: text
            };

        }

        return {

            ...json,

            _httpStatus:
                response.status,

            _ok:
                response.ok

        };

    } catch (error) {

        console.log(
            'SMSCODE API ERROR:',
            error.message
        );

        return null;
    }
}

// ==================================================
// AMBIL SALDO SUPPLIER
// ==================================================

async function ambilSaldoSupplier() {

    const result =
        await apiRequest(
            `${SMSCODE_BASE_URL}/balance`
        );

    if (
        !result ||
        !result.success
    ) {

        return null;
    }

    return Number(
        result.data?.balance || 0
    );
}

// ==================================================
// AMBIL LAYANAN
// ==================================================

async function ambilLayanan() {

    const result =
        await apiRequest(
            `${SMSCODE_BASE_URL}/catalog/services`
        );

    if (
        !result ||
        !result.success
    ) {

        console.log(
            'GAGAL LAYANAN:',
            result
        );

        return [];
    }

    return (result.data || [])
        .filter(
            service =>
                service.active !== false
        );
}

// ==================================================
// AMBIL NEGARA
// ==================================================

async function ambilNegara() {

    const result =
        await apiRequest(
            `${SMSCODE_BASE_URL}/catalog/countries`
        );

    if (
        !result ||
        !result.success
    ) {

        console.log(
            'GAGAL NEGARA:',
            result
        );

        return [];
    }

    return (result.data || [])
        .filter(
            country =>
                country.active !== false
        );
}

// ==================================================
// AMBIL PRODUK
// ==================================================

async function ambilProduk(
    countryId,
    serviceId
) {

    const url =
        `${SMSCODE_BASE_URL}/catalog/products` +
        `?country_id=${encodeURIComponent(countryId)}` +
        `&platform_id=${encodeURIComponent(serviceId)}` +
        `&limit=20` +
        `&page=1`;

    const result =
        await apiRequest(url);

    if (
        !result ||
        !result.success
    ) {

        console.log(
            'GAGAL PRODUK:',
            result
        );

        return [];
    }

    return (result.data || [])
        .filter(
            product =>
                product.active !== false
        );
}

// ==================================================
// AMBIL PRODUK SPESIFIK
// ==================================================

async function ambilProdukById(
    countryId,
    serviceId,
    productId
) {

    const products =
        await ambilProduk(
            countryId,
            serviceId
        );

    return products.find(
        product =>
            String(product.id) ===
            String(productId)
    );
}

// ==================================================
// CREATE ORDER SMSCODE
// ==================================================

async function buatOrderSupplier(
    productId
) {

    const idempotencyKey =
        crypto.randomUUID();

    const result =
        await apiRequest(
            `${SMSCODE_BASE_URL}/orders/create`,
            {
                method: 'POST',

                headers: {

                    'Idempotency-Key':
                        idempotencyKey

                },

                body: JSON.stringify({

                    product_id:
                        Number(productId),

                    quantity: 1

                })

            }
        );

    return result;
}

// ==================================================
// GET ORDER SMSCODE
// ==================================================

async function ambilOrderSupplier(
    orderId
) {

    return await apiRequest(
        `${SMSCODE_BASE_URL}/orders/${orderId}`
    );
}

// ==================================================
// CANCEL ORDER
// ==================================================

async function cancelOrderSupplier(
    orderId
) {

    return await apiRequest(
        `${SMSCODE_BASE_URL}/orders/cancel`,
        {
            method: 'POST',

            body: JSON.stringify({
                id: orderId
            })
        }
    );
}

// ==================================================
// RESEND OTP
// ==================================================

async function resendOrderSupplier(
    orderId
) {

    return await apiRequest(
        `${SMSCODE_BASE_URL}/orders/resend`,
        {
            method: 'POST',

            body: JSON.stringify({
                id: orderId
            })
        }
    );
}

// ==================================================
// FINISH ORDER
// ==================================================

async function finishOrderSupplier(
    orderId
) {

    return await apiRequest(
        `${SMSCODE_BASE_URL}/orders/finish`,
        {
            method: 'POST',

            body: JSON.stringify({
                id: orderId
            })
        }
    );
}

// ==================================================
// MENU UTAMA
// ==================================================

function tampilkanMenu(chatId) {

    bot.sendMessage(

        chatId,

        '🤖 *NOKOS STORE*\n\n' +
        'Silakan pilih menu:',

        {

            parse_mode:
                'Markdown',

            reply_markup: {

                keyboard: [

                    [
                        '🛒 Beli Nomor',
                        '💰 Saldo'
                    ],

                    [
                        '📦 Pesanan Saya',
                        '💳 Deposit'
                    ],

                    [
                        '📋 Riwayat',
                        '👤 Akun'
                    ]

                ],

                resize_keyboard:
                    true

            }

        }

    );
}

// ==================================================
// START
// ==================================================

bot.onText(
    /\/start/,
    (msg) => {

        updateTelegramUser(msg);

        tampilkanMenu(
            msg.chat.id
        );

    }
);

// ==================================================
// MENU MESSAGE
// ==================================================

bot.on(
    'message',
    async (msg) => {

        try {

            const chatId =
                msg.chat.id;

            const text =
                msg.text;

            if (!text) {
                return;
            }

            updateTelegramUser(msg);

            // ==========================================
            // BELI NOMOR
            // ==========================================

            if (
                text === '🛒 Beli Nomor'
            ) {

                await bot.sendMessage(
                    chatId,
                    '⏳ Mengambil daftar layanan...'
                );

                const services =
                    await ambilLayanan();

                if (
                    services.length === 0
                ) {

                    await bot.sendMessage(
                        chatId,
                        '❌ Gagal mengambil daftar layanan.'
                    );

                    return;
                }

                kirimLayanan(
                    chatId,
                    services,
                    0
                );

                return;
            }

            // ==========================================
            // SALDO
            // ==========================================

            if (
                text === '💰 Saldo'
            ) {

                const user =
                    getUser(chatId);

                await bot.sendMessage(

                    chatId,

                    '💰 *SALDO LU*\n\n' +
                    `💵 Rp${rupiah(user.balance)}\n\n` +
                    'Gunakan menu 💳 Deposit untuk menambah saldo.',

                    {
                        parse_mode:
                            'Markdown'
                    }

                );

                return;
            }

            // ==========================================
            // PESANAN SAYA
            // ==========================================

            if (
                text === '📦 Pesanan Saya'
            ) {

                const user =
                    getUser(chatId);

                if (
                    user.orders.length === 0
                ) {

                    await bot.sendMessage(
                        chatId,
                        '📦 Lu belum punya pesanan.'
                    );

                    return;
                }

                let pesan =
                    '📦 *PESANAN SAYA*\n\n';

                user.orders
                    .slice(-10)
                    .reverse()
                    .forEach(
                        (order, index) => {

                            pesan +=
                                `${index + 1}. ` +
                                `${order.status || 'PENDING'}\n` +
                                `🆔 ${order.id}\n` +
                                `📱 ${order.phone_number || '-'}\n` +
                                `💰 Rp${rupiah(order.price)}\n\n`;

                        }
                    );

                await bot.sendMessage(
                    chatId,
                    pesan,
                    {
                        parse_mode:
                            'Markdown'
                    }
                );

                return;
            }

            // ==========================================
            // DEPOSIT
            // ==========================================

            if (
                text === '💳 Deposit'
            ) {

                kirimPilihanDeposit(
                    chatId
                );

                return;
            }

            // ==========================================
            // RIWAYAT
            // ==========================================

            if (
                text === '📋 Riwayat'
            ) {

                const user =
                    getUser(chatId);

                if (
                    user.history.length === 0
                ) {

                    await bot.sendMessage(
                        chatId,
                        '📋 Belum ada riwayat transaksi.'
                    );

                    return;
                }

                let pesan =
                    '📋 *RIWAYAT*\n\n';

                user.history
                    .slice(-10)
                    .reverse()
                    .forEach(
                        (item, index) => {

                            pesan +=
                                `${index + 1}. ${item.type}\n` +
                                `💰 Rp${rupiah(item.amount)}\n` +
                                `🕐 ${item.date || '-'}\n\n`;

                        }
                    );

                await bot.sendMessage(
                    chatId,
                    pesan,
                    {
                        parse_mode:
                            'Markdown'
                    }
                );

                return;
            }

            // ==========================================
            // AKUN
            // ==========================================

            if (
                text === '👤 Akun'
            ) {

                const user =
                    getUser(chatId);

                await bot.sendMessage(

                    chatId,

                    '👤 *AKUN LU*\n\n' +
                    `👤 Nama: ${user.name || '-'}\n` +
                    `🔗 Username: ${user.username || '-'}\n` +
                    `🆔 Telegram ID: ${chatId}\n` +
                    `💰 Saldo: Rp${rupiah(user.balance)}`,

                    {
                        parse_mode:
                            'Markdown'
                    }

                );

                return;
            }

        } catch (error) {

            console.log(
                'MESSAGE ERROR:',
                error.message
            );

        }

    }
);

// ==================================================
// DEPOSIT MENU
// ==================================================

function kirimPilihanDeposit(chatId) {

    const keyboard = [];

    DEPOSIT_OPTIONS.forEach(
        nominal => {

            keyboard.push([

                {
                    text:
                        `💳 Rp${rupiah(nominal)}`,

                    callback_data:
                        `deposit_${nominal}`
                }

            ]);

        }
    );

    bot.sendMessage(

        chatId,

        '💳 *DEPOSIT SALDO*\n\n' +
        `Minimum deposit: *Rp${rupiah(MIN_DEPOSIT)}*\n\n` +
        'Pilih nominal deposit:',

        {

            parse_mode:
                'Markdown',

            reply_markup: {

                inline_keyboard:
                    keyboard

            }

        }

    );
}

// ==================================================
// TAMPILKAN LAYANAN
// ==================================================

function kirimLayanan(
    chatId,
    services,
    page
) {

    const pageSize = 10;

    const totalPages =
        Math.ceil(
            services.length /
            pageSize
        );

    const start =
        page * pageSize;

    const daftar =
        services.slice(
            start,
            start + pageSize
        );

    const keyboard = [];

    for (
        let i = 0;
        i < daftar.length;
        i += 2
    ) {

        const row = [];

        const service1 =
            daftar[i];

        row.push({

            text:
                `📱 ${service1.name}`,

            callback_data:
                `service_${service1.id}`

        });

        if (
            daftar[i + 1]
        ) {

            const service2 =
                daftar[i + 1];

            row.push({

                text:
                    `📱 ${service2.name}`,

                callback_data:
                    `service_${service2.id}`

            });

        }

        keyboard.push(row);
    }

    const nav = [];

    if (page > 0) {

        nav.push({

            text:
                '⬅️ Sebelumnya',

            callback_data:
                `services_page_${page - 1}`

        });

    }

    if (
        page <
        totalPages - 1
    ) {

        nav.push({

            text:
                '➡️ Berikutnya',

            callback_data:
                `services_page_${page + 1}`

        });

    }

    if (
        nav.length > 0
    ) {

        keyboard.push(nav);

    }

    bot.sendMessage(

        chatId,

        `📱 *PILIH LAYANAN*\n\n` +
        `Halaman ${page + 1} / ${totalPages}`,

        {

            parse_mode:
                'Markdown',

            reply_markup: {

                inline_keyboard:
                    keyboard

            }

        }

    );
}

// ==================================================
// TAMPILKAN NEGARA
// ==================================================

function kirimNegara(
    chatId,
    countries,
    serviceId,
    page
) {

    const pageSize = 10;

    const totalPages =
        Math.ceil(
            countries.length /
            pageSize
        );

    const start =
        page * pageSize;

    const daftar =
        countries.slice(
            start,
            start + pageSize
        );

    const keyboard = [];

    for (
        let i = 0;
        i < daftar.length;
        i += 2
    ) {

        const row = [];

        const country1 =
            daftar[i];

        row.push({

            text:
                `${country1.emoji || '🌍'} ${country1.name}`,

            callback_data:
                `country_${serviceId}_${country1.id}`

        });

        if (
            daftar[i + 1]
        ) {

            const country2 =
                daftar[i + 1];

            row.push({

                text:
                    `${country2.emoji || '🌍'} ${country2.name}`,

                callback_data:
                    `country_${serviceId}_${country2.id}`

            });

        }

        keyboard.push(row);

    }

    const nav = [];

    if (page > 0) {

        nav.push({

            text:
                '⬅️ Sebelumnya',

            callback_data:
                `countries_${serviceId}_${page - 1}`

        });

    }

    if (
        page <
        totalPages - 1
    ) {

        nav.push({

            text:
                '➡️ Berikutnya',

            callback_data:
                `countries_${serviceId}_${page + 1}`

        });

    }

    if (
        nav.length > 0
    ) {

        keyboard.push(nav);

    }

    bot.sendMessage(

        chatId,

        `🌍 *PILIH NEGARA*\n\n` +
        `Halaman ${page + 1} / ${totalPages}`,

        {

            parse_mode:
                'Markdown',

            reply_markup: {

                inline_keyboard:
                    keyboard

            }

        }

    );
}

// ==================================================
// TAMPILKAN PRODUK
// ==================================================

function potongTeks(teks, maksimal = 80) {
    const text = String(teks || '-');
    if (text.length <= maksimal) return text;
    return text.slice(0, maksimal - 3) + '...';
}

function kirimProduk(
    chatId,
    products,
    countryId,
    serviceId,
    page = 0
) {

    // Maksimal 5 produk per halaman supaya pesan Telegram
    // tidak pernah terlalu panjang.
    const pageSize = 5;

    const totalPages = Math.max(
        1,
        Math.ceil(products.length / pageSize)
    );

    const start = page * pageSize;

    const daftar = products.slice(
        start,
        start + pageSize
    );

    let pesan =
        '📦 *PRODUK TERSEDIA*\n\n' +
        `Halaman ${page + 1} / ${totalPages}\n\n`;

    const keyboard = [];

    daftar.forEach((product, index) => {

        const hargaSupplier = Number(product.price || 0);
        const hargaJual = hitungHargaJual(hargaSupplier);
        const stok = Number(product.available || 0);

        const nama = potongTeks(
            product.name || `Produk ${product.id}`,
            70
        );

        const operator = potongTeks(
            product.operator_name || '-',
            50
        );

        pesan +=
            `*${start + index + 1}. ${nama}*\n` +
            `🏢 Operator: ${operator}\n` +
            `📦 Stok: ${stok}\n` +
            `💰 Harga: Rp${rupiah(hargaJual)}\n\n`;

        keyboard.push([
            {
                text: `🛒 BELI - Rp${rupiah(hargaJual)}`,
                callback_data:
                    `product_${countryId}_${serviceId}_${product.id}_${hargaJual}`
            }
        ]);
    });

    const nav = [];

    if (page > 0) {
        nav.push({
            text: '⬅️ Sebelumnya',
            callback_data:
                `products_${countryId}_${serviceId}_${page - 1}`
        });
    }

    if (page < totalPages - 1) {
        nav.push({
            text: '➡️ Berikutnya',
            callback_data:
                `products_${countryId}_${serviceId}_${page + 1}`
        });
    }

    if (nav.length > 0) {
        keyboard.push(nav);
    }

    bot.sendMessage(
        chatId,
        pesan.slice(0, 3900),
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        }
    ).catch(error => {
        console.log(
            'KIRIM PRODUK ERROR:',
            error.message
        );

        bot.sendMessage(
            chatId,
            '❌ Produk terlalu banyak untuk ditampilkan. Coba tekan Beli Nomor lagi.'
        ).catch(() => {});
    });
}

// ==================================================
// CALLBACK
// ==================================================

bot.on(
    'callback_query',
    async (query) => {

        const chatId =
            query.message.chat.id;

        const data =
            query.data || '';

        try {

            await bot.answerCallbackQuery(
                query.id
            );

        } catch {}

        // ==========================================
        // PAGINATION LAYANAN
        // ==========================================

        if (
            data.startsWith(
                'services_page_'
            )
        ) {

            const page =
                parseInt(
                    data.replace(
                        'services_page_',
                        ''
                    )
                );

            const services =
                await ambilLayanan();

            if (
                services.length === 0
            ) {

                await bot.sendMessage(
                    chatId,
                    '❌ Gagal mengambil layanan.'
                );

                return;
            }

            kirimLayanan(
                chatId,
                services,
                page
            );

            return;
        }

        // ==========================================
        // PILIH LAYANAN
        // ==========================================

        if (
            data.startsWith(
                'service_'
            )
        ) {

            const serviceId =
                data.replace(
                    'service_',
                    ''
                );

            await bot.sendMessage(
                chatId,
                '⏳ Mengambil daftar negara...'
            );

            const countries =
                await ambilNegara();

            if (
                countries.length === 0
            ) {

                await bot.sendMessage(
                    chatId,
                    '❌ Gagal mengambil daftar negara.'
                );

                return;
            }

            kirimNegara(
                chatId,
                countries,
                serviceId,
                0
            );

            return;
        }

        // ==========================================
        // PAGINATION NEGARA
        // ==========================================

        if (
            data.startsWith(
                'countries_'
            )
        ) {

            const bagian =
                data.split('_');

            const serviceId =
                bagian[1];

            const page =
                parseInt(
                    bagian[2]
                );

            const countries =
                await ambilNegara();

            if (
                countries.length === 0
            ) {

                await bot.sendMessage(
                    chatId,
                    '❌ Gagal mengambil negara.'
                );

                return;
            }

            kirimNegara(
                chatId,
                countries,
                serviceId,
                page
            );

            return;
        }

        // ==========================================
        // PAGINATION PRODUK
        // ==========================================

        if (
            data.startsWith(
                'products_'
            )
        ) {

            const bagian =
                data.split('_');

            const countryId =
                bagian[1];

            const serviceId =
                bagian[2];

            const page =
                parseInt(
                    bagian[3]
                );

            const products =
                await ambilProduk(
                    countryId,
                    serviceId
                );

            if (
                products.length === 0
            ) {

                await bot.sendMessage(
                    chatId,
                    '❌ Produk untuk layanan dan negara ini sedang kosong.'
                );

                return;
            }

            kirimProduk(
                chatId,
                products,
                countryId,
                serviceId,
                page
            );

            return;
        }

        // ==========================================
        // PILIH NEGARA
        // ==========================================

        if (
            data.startsWith(
                'country_'
            )
        ) {

            const bagian =
                data.split('_');

            const serviceId =
                bagian[1];

            const countryId =
                bagian[2];

            await bot.sendMessage(
                chatId,
                '⏳ Mengambil produk, stok, dan harga...'
            );

            const products =
                await ambilProduk(
                    countryId,
                    serviceId
                );

            if (
                products.length === 0
            ) {

                await bot.sendMessage(
                    chatId,
                    '❌ Produk untuk layanan dan negara ini sedang kosong.'
                );

                return;
            }

            kirimProduk(
                chatId,
                products,
                countryId,
                serviceId
            );

            return;
        }

        // ==========================================
        // BELI PRODUK
        // ==========================================

        if (
            data.startsWith(
                'product_'
            )
        ) {

            const bagian =
                data.split('_');

            const countryId =
                bagian[1];

            const serviceId =
                bagian[2];

            const productId =
                bagian[3];

            const displayedPrice =
                Number(
                    bagian[4] || 0
                );

            const lockKey =
                `${chatId}_${productId}`;

            if (
                processingPurchases.has(
                    lockKey
                )
            ) {

                await bot.sendMessage(
                    chatId,
                    '⏳ Pembelian sedang diproses. Jangan tekan berkali-kali.'
                );

                return;
            }

            processingPurchases.add(
                lockKey
            );

            try {

                const user =
                    getUser(chatId);

                // ------------------------------------------
                // AMBIL PRODUK TERBARU
                // ------------------------------------------

                const product =
                    await ambilProdukById(
                        countryId,
                        serviceId,
                        productId
                    );

                if (!product) {

                    await bot.sendMessage(
                        chatId,
                        '❌ Produk sudah tidak tersedia.'
                    );

                    return;
                }

                const hargaSupplier =
                    Number(
                        product.price || 0
                    );

                const hargaJual =
                    hitungHargaJual(
                        hargaSupplier
                    );

                const stok =
                    Number(
                        product.available || 0
                    );

                if (stok <= 0) {

                    await bot.sendMessage(
                        chatId,
                        '❌ Stok produk sudah habis.'
                    );

                    return;
                }

                // ------------------------------------------
                // CEGAH HARGA BERUBAH
                // ------------------------------------------

                if (
                    hargaJual !==
                    displayedPrice
                ) {

                    await bot.sendMessage(

                        chatId,

                        '⚠️ *Harga berubah*\n\n' +
                        `Harga sebelumnya: Rp${rupiah(displayedPrice)}\n` +
                        `Harga terbaru: Rp${rupiah(hargaJual)}\n\n` +
                        'Silakan kembali ke daftar produk dan pilih lagi.',

                        {
                            parse_mode:
                                'Markdown'
                        }

                    );

                    return;
                }

                // ------------------------------------------
                // CEK SALDO CUSTOMER
                // ------------------------------------------

                if (
                    Number(user.balance) <
                    hargaJual
                ) {

                    await bot.sendMessage(

                        chatId,

                        '❌ *Saldo tidak cukup*\n\n' +
                        `Saldo lu: Rp${rupiah(user.balance)}\n` +
                        `Harga: Rp${rupiah(hargaJual)}\n\n` +
                        'Silakan lakukan deposit.',

                        {
                            parse_mode:
                                'Markdown'
                        }

                    );

                    return;
                }

                // ------------------------------------------
                // CEK SALDO SUPPLIER
                // ------------------------------------------

                const supplierBalance =
                    await ambilSaldoSupplier();

                if (
                    supplierBalance === null
                ) {

                    await bot.sendMessage(
                        chatId,
                        '❌ Gagal mengecek saldo supplier. Coba lagi.'
                    );

                    return;
                }

                if (
                    supplierBalance <
                    hargaSupplier
                ) {

                    await bot.sendMessage(

                        chatId,

                        '❌ *Saldo supplier tidak cukup.*\n\n' +
                        `Saldo supplier: Rp${rupiah(supplierBalance)}\n` +
                        `Harga supplier: Rp${rupiah(hargaSupplier)}\n\n` +
                        'Order belum dibuat.',

                        {
                            parse_mode:
                                'Markdown'
                        }

                    );

                    return;
                }

                await bot.sendMessage(
                    chatId,
                    '⏳ Membuat order nomor...'
                );

                // ------------------------------------------
                // ORDER KE SMSCODE
                // ------------------------------------------

                const orderResult =
                    await buatOrderSupplier(
                        productId
                    );

                if (
                    !orderResult ||
                    !orderResult.success
                ) {

                    console.log(
                        'SMSCODE CREATE ORDER ERROR:',
                        orderResult
                    );

                    await bot.sendMessage(

                        chatId,

                        '❌ *Gagal membuat order nomor.*\n\n' +
                        `${orderResult?.message || 'Supplier menolak order.'}`,

                        {
                            parse_mode:
                                'Markdown'
                        }

                    );

                    return;
                }

                // ------------------------------------------
                // AMBIL DATA ORDER
                // ------------------------------------------

                const supplierOrder =
                    orderResult?.data?.orders?.[0] ||
                    orderResult?.data;

                if (!supplierOrder) {

                    console.log(
                        'ORDER RESPONSE TIDAK VALID:',
                        orderResult
                    );

                    await bot.sendMessage(
                        chatId,
                        '⚠️ Order supplier berhasil tetapi data order tidak terbaca. Hubungi admin.'
                    );

                    return;
                }

                const supplierOrderId =
                    supplierOrder.id;

                // ------------------------------------------
                // UPDATE DATABASE
                // ------------------------------------------

                const users =
                    loadUsers();

                const currentUser =
                    users[String(chatId)];

                if (!currentUser) {

                    console.log(
                        'CRITICAL: USER HILANG SETELAH ORDER',
                        supplierOrder
                    );

                    await bot.sendMessage(
                        chatId,
                        '⚠️ Order berhasil dibuat tetapi data akun bermasalah. Hubungi admin.'
                    );

                    return;
                }

                if (
                    Number(currentUser.balance) <
                    hargaJual
                ) {

                    console.log(
                        'CRITICAL: SALDO USER BERUBAH SETELAH ORDER',
                        supplierOrder
                    );

                    await bot.sendMessage(
                        chatId,
                        '⚠️ Order berhasil dibuat tetapi saldo akun berubah. Hubungi admin.'
                    );

                    return;
                }

                // Potong saldo customer
                currentUser.balance =
                    Number(currentUser.balance) -
                    hargaJual;

                const localOrder = {

                    id:
                        supplierOrderId,

                    supplier_order_id:
                        supplierOrderId,

                    product_id:
                        productId,

                    country_id:
                        countryId,

                    service_id:
                        serviceId,

                    phone_number:
                        supplierOrder.phone_number || null,

                    otp_code:
                        supplierOrder.otp_code || null,

                    status:
                        supplierOrder.status || 'ACTIVE',

                    supplier_price:
                        hargaSupplier,

                    price:
                        hargaJual,

                    created_at:
                        new Date().toISOString()

                };

                currentUser.orders =
                    currentUser.orders || [];

                currentUser.orders.push(
                    localOrder
                );

                currentUser.history =
                    currentUser.history || [];

                currentUser.history.push({

                    type:
                        'Pembelian nomor',

                    amount:
                        hargaJual,

                    order_id:
                        supplierOrderId,

                    date:
                        new Date().toLocaleString(
                            'id-ID'
                        )

                });

                saveUsers(users);

                // ------------------------------------------
                // TAMPILKAN NOMOR
                // ------------------------------------------

                await bot.sendMessage(

                    chatId,

                    '✅ *NOMOR BERHASIL DIBELI*\n\n' +
                    `📱 Nomor: *${supplierOrder.phone_number || '-'}*\n` +
                    `🆔 Order ID: ${supplierOrderId}\n` +
                    `📊 Status: ${supplierOrder.status || 'ACTIVE'}\n` +
                    `💰 Harga: Rp${rupiah(hargaJual)}\n\n` +
                    'Gunakan tombol di bawah untuk mengecek OTP.',

                    {

                        parse_mode:
                            'Markdown',

                        reply_markup: {

                            inline_keyboard: [

                                [
                                    {
                                        text:
                                            '🔄 Cek OTP',

                                        callback_data:
                                            `otp_${supplierOrderId}`
                                    }
                                ],

                                [
                                    {
                                        text:
                                            '🔁 Resend OTP',

                                        callback_data:
                                            `resend_${supplierOrderId}`
                                    }
                                ],

                                [
                                    {
                                        text:
                                            '✅ Finish',

                                        callback_data:
                                            `finish_${supplierOrderId}`
                                    }
                                ],

                                [
                                    {
                                        text:
                                            '❌ Cancel',

                                        callback_data:
                                            `cancel_${supplierOrderId}`
                                    }
                                ]

                            ]

                        }

                    }

                );

            } catch (error) {

                console.log(
                    'PURCHASE ERROR:',
                    error.message
                );

                await bot.sendMessage(
                    chatId,
                    '❌ Terjadi error saat proses pembelian. Cek CMD.'
                );

            } finally {

                processingPurchases.delete(
                    lockKey
                );

            }

            return;
        }

        // ==========================================
        // CEK OTP
        // ==========================================

        if (
            data.startsWith(
                'otp_'
            )
        ) {

            const orderId =
                data.replace(
                    'otp_',
                    ''
                );

            await bot.sendMessage(
                chatId,
                '⏳ Mengecek order...'
            );

            const result =
                await ambilOrderSupplier(
                    orderId
                );

            if (
                !result ||
                !result.success
            ) {

                await bot.sendMessage(
                    chatId,
                    '❌ Gagal mengambil status order.'
                );

                return;
            }

            const order =
                result.data;

            // Update local order
            updateLocalOrder(
                chatId,
                order
            );

            if (
                order.otp_code
            ) {

                await bot.sendMessage(

                    chatId,

                    '📩 *OTP DITERIMA*\n\n' +
                    `📱 Nomor: ${order.phone_number || '-'}\n` +
                    `🔐 OTP: *${order.otp_code}*\n` +
                    `📊 Status: ${order.status || '-'}`,

                    {
                        parse_mode:
                            'Markdown'
                    }

                );

            } else {

                await bot.sendMessage(

                    chatId,

                    '⏳ *OTP belum masuk*\n\n' +
                    `Status: ${order.status || '-'}\n` +
                    'Coba cek lagi beberapa saat.',

                    {
                        parse_mode:
                            'Markdown'
                    }

                );

            }

            return;
        }

        // ==========================================
        // RESEND OTP
        // ==========================================

        if (
            data.startsWith(
                'resend_'
            )
        ) {

            const orderId =
                data.replace(
                    'resend_',
                    ''
                );

            const result =
                await resendOrderSupplier(
                    orderId
                );

            if (
                !result ||
                !result.success
            ) {

                await bot.sendMessage(

                    chatId,

                    '❌ Gagal resend OTP.\n\n' +
                    'Supplier menolak permintaan resend.'

                );

                return;
            }

            await bot.sendMessage(
                chatId,
                '✅ Permintaan resend OTP berhasil dikirim.'
            );

            return;
        }

        // ==========================================
        // FINISH
        // ==========================================

        if (
            data.startsWith(
                'finish_'
            )
        ) {

            const orderId =
                data.replace(
                    'finish_',
                    ''
                );

            const result =
                await finishOrderSupplier(
                    orderId
                );

            if (
                !result ||
                !result.success
            ) {

                await bot.sendMessage(

                    chatId,

                    '❌ Gagal menyelesaikan order.\n\n' +
                    'Supplier menolak proses finish.'

                );

                return;
            }

            updateLocalOrder(
                chatId,
                result.data
            );

            await bot.sendMessage(
                chatId,
                '✅ Order berhasil di-finish.'
            );

            return;
        }

        // ==========================================
        // CANCEL
        // ==========================================

        if (
            data.startsWith(
                'cancel_'
            )
        ) {

            const orderId =
                data.replace(
                    'cancel_',
                    ''
                );

            const result =
                await cancelOrderSupplier(
                    orderId
                );

            if (
                !result ||
                !result.success
            ) {

                await bot.sendMessage(

                    chatId,

                    '❌ Gagal cancel order.\n\n' +
                    'Order belum bisa dibatalkan saat ini.'

                );

                return;
            }

            const refundAmount =
                Number(
                    result.data?.refund_amount ||
                    result.data?.amount ||
                    0
                );

            // Refund hanya sebesar refund supplier.
            // Margin tidak ikut diberikan kembali.
            if (
                refundAmount > 0
            ) {

                const users =
                    loadUsers();

                const user =
                    users[String(chatId)];

                if (user) {

                    user.balance =
                        Number(user.balance || 0) +
                        refundAmount;

                    user.history =
                        user.history || [];

                    user.history.push({

                        type:
                            'Refund cancel order',

                        amount:
                            refundAmount,

                        order_id:
                            orderId,

                        date:
                            new Date().toLocaleString(
                                'id-ID'
                            )

                    });

                    saveUsers(users);

                }

            }

            updateLocalOrder(
                chatId,
                result.data
            );

            await bot.sendMessage(

                chatId,

                '❌ *Order dibatalkan*\n\n' +
                `💰 Refund supplier: Rp${rupiah(refundAmount)}\n\n` +
                'Refund mengikuti nominal yang dikembalikan supplier.',

                {
                    parse_mode:
                        'Markdown'
                }

            );

            return;
        }

        // ==========================================
        // DEPOSIT
        // ==========================================

        if (
            data.startsWith(
                'deposit_'
            )
        ) {

            const nominal =
                Number(
                    data.replace(
                        'deposit_',
                        ''
                    )
                );

            if (
                !DEPOSIT_OPTIONS.includes(
                    nominal
                )
            ) {

                await bot.sendMessage(
                    chatId,
                    '❌ Nominal deposit tidak valid.'
                );

                return;
            }

            if (
                nominal <
                MIN_DEPOSIT
            ) {

                await bot.sendMessage(

                    chatId,

                    `❌ Minimum deposit Rp${rupiah(MIN_DEPOSIT)}.`

                );

                return;
            }

            const depositLock =
                `${chatId}_${nominal}`;

            if (
                processingDeposits.has(
                    depositLock
                )
            ) {

                await bot.sendMessage(
                    chatId,
                    '⏳ Deposit sedang dibuat.'
                );

                return;
            }

            processingDeposits.add(
                depositLock
            );

            try {

                await buatPembayaranMidtrans(
                    chatId,
                    nominal
                );

            } catch (error) {

                console.log(
                    'MIDTRANS CREATE ERROR:',
                    error.message
                );

                await bot.sendMessage(

                    chatId,

                    '❌ *Gagal membuat QRIS*\n\n' +
                    'Pembayaran sedang tidak tersedia. Coba lagi nanti.',

                    {
                        parse_mode:
                            'Markdown'
                    }

                );

            } finally {

                processingDeposits.delete(
                    depositLock
                );

            }

            return;
        }

    }
);

// ==================================================
// UPDATE ORDER LOKAL
// ==================================================

function updateLocalOrder(
    chatId,
    order
) {

    if (!order) {
        return;
    }

    const users =
        loadUsers();

    const user =
        users[String(chatId)];

    if (!user) {
        return;
    }

    user.orders =
        user.orders || [];

    const index =
        user.orders.findIndex(
            item =>
                String(item.id) ===
                String(order.id)
        );

    if (index >= 0) {

        user.orders[index] = {

            ...user.orders[index],

            status:
                order.status ??
                user.orders[index].status,

            phone_number:
                order.phone_number ??
                user.orders[index].phone_number,

            otp_code:
                order.otp_code ??
                user.orders[index].otp_code,

            otp_received_at:
                order.otp_received_at ??
                user.orders[index].otp_received_at,

            expires_at:
                order.expires_at ??
                user.orders[index].expires_at

        };

        saveUsers(users);
    }
}

// ==================================================
// MIDTRANS CREATE QRIS
// ==================================================

async function buatPembayaranMidtrans(
    chatId,
    nominal
) {

    const orderId =
        `DEP-${chatId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    const parameter = {

        payment_type:
            'qris',

        transaction_details: {

            order_id:
                orderId,

            gross_amount:
                nominal

        },

        item_details: [

            {

                id:
                    `deposit-${nominal}`,

                price:
                    nominal,

                quantity:
                    1,

                name:
                    `Deposit Saldo Nokos Store`

            }

        ],

        qris: {

            acquirer:
                'gopay'

        },

        custom_expiry: {

            order_time:
                new Date().toISOString(),

            expiry_duration:
                15,

            unit:
                'minute'

        }

    };

    const response =
        await midtransCore.charge(
            parameter
        );

    console.log(
        'MIDTRANS CREATE:',
        response
    );

    if (
        !response ||
        !response.actions
    ) {

        throw new Error(
            'QRIS tidak tersedia dari Midtrans.'
        );
    }

    const qrAction =
        response.actions.find(
            action =>
                action.name ===
                'generate-qr-code-v2'
        ) ||
        response.actions.find(
            action =>
                action.name ===
                'generate-qr-code'
        );

    if (
        !qrAction ||
        !qrAction.url
    ) {

        throw new Error(
            'Link QRIS tidak ditemukan. Channel pembayaran mungkin belum aktif.'
        );
    }

    // Simpan transaksi deposit
    const users =
        loadUsers();

    const user =
        users[String(chatId)];

    if (!user) {
        throw new Error(
            'User tidak ditemukan.'
        );
    }

    user.deposits =
        user.deposits || [];

    user.deposits.push({

        order_id:
            orderId,

        amount:
            nominal,

        status:
            'pending',

        created_at:
            new Date().toISOString()

    });

    saveUsers(users);

    // ==============================================
    // KIRIM QR IMAGE
    // ==============================================

    const qrBuffer =
        await ambilQRImage(
            qrAction.url
        );

    await bot.sendPhoto(

        chatId,

        qrBuffer,

        {

            caption:

                '💳 *PEMBAYARAN DEPOSIT*\n\n' +
                `💰 Nominal: *Rp${rupiah(nominal)}*\n` +
                `🆔 Order: \`${orderId}\`\n\n` +
                'Scan QRIS untuk membayar.\n' +
                'Setelah pembayaran berhasil, saldo akan diproses otomatis.',

            parse_mode:
                'Markdown'

        }

    );

    // Mulai cek status
    pollMidtransPayment(
        chatId,
        orderId,
        nominal
    );

}

// ==================================================
// AMBIL QR IMAGE
// ==================================================

async function ambilQRImage(
    url
) {

    const auth =
        Buffer
            .from(
                `${process.env.MIDTRANS_SERVER_KEY}:`
            )
            .toString('base64');

    const response =
        await fetch(

            url,

            {

                headers: {

                    Authorization:
                        `Basic ${auth}`

                }

            }

        );

    if (!response.ok) {

        throw new Error(
            `Gagal mengambil QRIS (${response.status})`
        );

    }

    const arrayBuffer =
        await response.arrayBuffer();

    return Buffer.from(
        arrayBuffer
    );
}

// ==================================================
// STATUS MIDTRANS
// ==================================================

async function cekStatusMidtrans(
    orderId
) {

    const auth =
        Buffer
            .from(
                `${process.env.MIDTRANS_SERVER_KEY}:`
            )
            .toString('base64');

    const response =
        await fetch(

            `${MIDTRANS_BASE_URL}/v2/${encodeURIComponent(orderId)}/status`,

            {

                headers: {

                    Authorization:
                        `Basic ${auth}`,

                    Accept:
                        'application/json'

                }

            }

        );

    const text =
        await response.text();

    let json;

    try {

        json =
            JSON.parse(text);

    } catch {

        json = {
            message:
                text
        };

    }

    return {

        ...json,

        _httpStatus:
            response.status,

        _ok:
            response.ok

    };
}

// ==================================================
// POLLING PEMBAYARAN
// ==================================================

async function pollMidtransPayment(
    chatId,
    orderId,
    nominal
) {

    let attempts = 0;

    const maxAttempts = 90;

    const timer =
        setInterval(
            async () => {

                attempts++;

                try {

                    const status =
                        await cekStatusMidtrans(
                            orderId
                        );

                    console.log(
                        `MIDTRANS STATUS ${orderId}:`,
                        status.transaction_status
                    );

                    const transactionStatus =
                        status.transaction_status;

                    // ======================================
                    // SETTLEMENT
                    // ======================================

                    if (
                        transactionStatus ===
                        'settlement'
                    ) {

                        clearInterval(timer);

                        prosesDepositBerhasil(
                            chatId,
                            orderId,
                            nominal
                        );

                        return;
                    }

                    // ======================================
                    // EXPIRE / DENY / CANCEL
                    // ======================================

                    if (
                        [
                            'expire',
                            'deny',
                            'cancel'
                        ].includes(
                            transactionStatus
                        )
                    ) {

                        clearInterval(timer);

                        await bot.sendMessage(

                            chatId,

                            '❌ *Pembayaran tidak berhasil*\n\n' +
                            `Status: ${transactionStatus}\n` +
                            `Order: ${orderId}`,

                            {
                                parse_mode:
                                    'Markdown'
                            }

                        );

                        updateDepositStatus(
                            chatId,
                            orderId,
                            transactionStatus
                        );

                        return;
                    }

                    // ======================================
                    // TIMEOUT
                    // ======================================

                    if (
                        attempts >=
                        maxAttempts
                    ) {

                        clearInterval(timer);

                        await bot.sendMessage(

                            chatId,

                            '⏱️ Waktu pengecekan pembayaran selesai.\n\n' +
                            `Order: ${orderId}\n` +
                            'Kalau pembayaran sudah dilakukan, cek status dari admin/payment gateway.',

                            {
                                parse_mode:
                                    'Markdown'
                            }

                        );

                    }

                } catch (error) {

                    console.log(
                        'MIDTRANS POLLING ERROR:',
                        error.message
                    );

                    if (
                        attempts >=
                        maxAttempts
                    ) {

                        clearInterval(timer);

                    }

                }

            },

            10000
        );
}

// ==================================================
// DEPOSIT BERHASIL
// ==================================================

function prosesDepositBerhasil(
    chatId,
    orderId,
    nominal
) {

    const users =
        loadUsers();

    const user =
        users[String(chatId)];

    if (!user) {

        console.log(
            'CRITICAL: USER TIDAK DITEMUKAN SAAT SETTLEMENT',
            chatId,
            orderId
        );

        return;
    }

    user.balance =
        Number(user.balance || 0) +
        Number(nominal);

    user.deposits =
        user.deposits || [];

    const deposit =
        user.deposits.find(
            item =>
                item.order_id ===
                orderId
        );

    if (deposit) {

        if (
            deposit.status ===
            'settlement'
        ) {

            return;
        }

        deposit.status =
            'settlement';

        deposit.paid_at =
            new Date().toISOString();

    }

    user.history =
        user.history || [];

    user.history.push({

        type:
            'Deposit berhasil',

        amount:
            nominal,

        order_id:
            orderId,

        date:
            new Date().toLocaleString(
                'id-ID'
            )

    });

    saveUsers(users);

    bot.sendMessage(

        chatId,

        '✅ *DEPOSIT BERHASIL*\n\n' +
        `💰 Saldo masuk: Rp${rupiah(nominal)}\n` +
        `💵 Saldo sekarang: Rp${rupiah(user.balance)}\n\n` +
        'Sekarang lu sudah bisa membeli nomor.',

        {
            parse_mode:
                'Markdown'
        }

    );

}

// ==================================================
// UPDATE STATUS DEPOSIT
// ==================================================

function updateDepositStatus(
    chatId,
    orderId,
    status
) {

    const users =
        loadUsers();

    const user =
        users[String(chatId)];

    if (!user) {
        return;
    }

    user.deposits =
        user.deposits || [];

    const deposit =
        user.deposits.find(
            item =>
                item.order_id ===
                orderId
        );

    if (deposit) {

        deposit.status =
            status;

        deposit.updated_at =
            new Date().toISOString();

    }

    saveUsers(users);
}

// ==================================================
// TELEGRAM ERROR HANDLER
// ==================================================

bot.on(
    'polling_error',
    (error) => {

        console.log(
            'TELEGRAM POLLING ERROR:',
            error.code || '',
            error.message || error
        );

    }
);

// ==================================================
// ERROR PROCESS
// ==================================================

process.on(
    'uncaughtException',
    (error) => {

        console.log(
            'UNCAUGHT EXCEPTION:',
            error.message
        );

    }
);

process.on(
    'unhandledRejection',
    (error) => {

        console.log(
            'UNHANDLED REJECTION:',
            error?.message || error
        );

    }
);
