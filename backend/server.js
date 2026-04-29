const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;
const MAX_BUFFER = 50; // ring buffer — multiple polling clients can each see the same tasks
const REMINDER_INTERVAL_MS = 30 * 1000; // quét lịch nhắc mỗi 30 giây
const SCHEDULE_FILE = path.join(__dirname, 'scheduled.json');
const SEEN_FILE = path.join(__dirname, 'seen.json');
const SEEN_CAP = 1000; // chỉ giữ N messageId gần nhất, tránh phình file
let pendingTasks = [];
let clientReady = false;

// Tập messageId đã xử lý — chống replay khi whatsapp-web.js đồng bộ lại lúc khởi động
let seenMessageIds = new Set();
try {
    if (fs.existsSync(SEEN_FILE)) {
        const arr = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
        if (Array.isArray(arr)) seenMessageIds = new Set(arr);
        console.log(`👁️  Đã nạp ${seenMessageIds.size} messageId đã xử lý.`);
    }
} catch (e) {
    console.warn('Không đọc được seen.json:', e.message);
}

function saveSeen() {
    try {
        let arr = Array.from(seenMessageIds);
        if (arr.length > SEEN_CAP) {
            arr = arr.slice(arr.length - SEEN_CAP);
            seenMessageIds = new Set(arr);
        }
        fs.writeFileSync(SEEN_FILE, JSON.stringify(arr));
    } catch (e) {
        console.warn('Không lưu được seen.json:', e.message);
    }
}

// Lịch nhắc — persistent qua restart: { [messageId]: { chatId, messageId, content, assignees, dueAt, hasTime, reminded, completed, createdAt } }
let scheduled = {};
try {
    if (fs.existsSync(SCHEDULE_FILE)) {
        scheduled = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')) || {};
        const total = Object.keys(scheduled).length;
        const pending = Object.values(scheduled).filter(t => !t.completed && !t.reminded).length;
        console.log(`📅 Đã nạp ${total} lịch nhắc (${pending} đang chờ).`);
    }
} catch (e) {
    console.warn('Không đọc được scheduled.json:', e.message);
    scheduled = {};
}

function saveSchedule() {
    try {
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduled, null, 2));
    } catch (e) {
        console.warn('Không lưu được scheduled.json:', e.message);
    }
}

/**
 * Parse deadline trong nội dung task. Cú pháp: token bắt đầu bằng "!" ở cuối câu.
 * Hỗ trợ:
 *   !YYYY-MM-DD HH:mm     ! 2026-05-01 17:00
 *   !YYYY-MM-DD           !2026-05-01           (mặc định 23:59)
 *   !DD/MM/YYYY HH:mm     !01/05/2026 17:00
 *   !DD/MM/YYYY           !01/05/2026           (mặc định 23:59)
 *   !DD/MM HH:mm          !01/05 17:00          (năm hiện tại)
 *   !DD/MM                !01/05                (năm hiện tại, 23:59)
 *   !HH:mm                !17:00                (hôm nay; nếu đã qua → ngày mai)
 * Trả về { dueAt, hasTime, cleanedContent } hoặc null nếu không match.
 */
function parseDeadline(content) {
    const m = content.match(/(^|\s)!([^\s!][^!]*?)\s*$/);
    if (!m) return null;
    const candidate = m[2].trim();
    const parsed = parseDateCandidate(candidate);
    if (!parsed) return null;
    const before = content.slice(0, m.index + m[1].length).trimEnd();
    return { dueAt: parsed.date.toISOString(), hasTime: parsed.hasTime, cleanedContent: before };
}

function parseDateCandidate(s) {
    let m;
    // YYYY-MM-DD HH:mm
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (m) return { date: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0), hasTime: true };
    // YYYY-MM-DD
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return { date: new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 0, 0), hasTime: false };
    // DD/MM/YYYY HH:mm
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (m) return { date: new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], 0, 0), hasTime: true };
    // DD/MM/YYYY
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return { date: new Date(+m[3], +m[2] - 1, +m[1], 23, 59, 0, 0), hasTime: false };
    // DD/MM HH:mm
    m = s.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (m) {
        const now = new Date();
        return { date: new Date(now.getFullYear(), +m[2] - 1, +m[1], +m[3], +m[4], 0, 0), hasTime: true };
    }
    // DD/MM
    m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (m) {
        const now = new Date();
        return { date: new Date(now.getFullYear(), +m[2] - 1, +m[1], 23, 59, 0, 0), hasTime: false };
    }
    // HH:mm — hôm nay (hoặc ngày mai nếu đã trôi qua)
    m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
        const now = new Date();
        const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], 0, 0);
        if (dt.getTime() <= now.getTime()) dt.setDate(dt.getDate() + 1);
        return { date: dt, hasTime: true };
    }
    return null;
}

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('\n--- QUÉT MÃ QR NÀY BẰNG ỨNG DỤNG WHATSAPP TRÊN ĐIỆN THOẠI CỦA BẠN ---');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp Bot đã sẵn sàng!');
    clientReady = true;
});

client.on('message_create', async (msg) => {
    // Chỉ xử lý tin nhắn trong group hoặc tin nhắn có tag đặc biệt
    const chat = await msg.getChat();
    
    // Bạn có thể lọc: if (chat.isGroup) { ... }
    // Ở đây mình lưu tất cả tin nhắn bắt đầu bằng "#todo " hoặc "#task "
    // Nếu bạn muốn lưu TOÀN BỘ tin nhắn trong nhóm thì bỏ điều kiện if (text.startsWith) đi.
    const text = msg.body.trim();
    
    // Điều kiện: Trong Group VÀ bắt đầu bằng "#todo" (để tránh spam)
    if (chat.isGroup && text.toLowerCase().startsWith('#todo ')) {
        const mid = msg.id._serialized;
        // Chống replay: bỏ qua nếu đã xử lý messageId này
        if (seenMessageIds.has(mid)) {
            return;
        }
        seenMessageIds.add(mid);
        saveSeen();

        const rawContent = text.substring(6).trim();
        const contact = await msg.getContact();

        // Bóc deadline trước (token "!..." cuối câu) — phần còn lại mới là nội dung task
        const parsedDeadline = parseDeadline(rawContent);
        const taskContent = parsedDeadline ? parsedDeadline.cleanedContent : rawContent;
        const dueAt = parsedDeadline ? parsedDeadline.dueAt : null;
        const hasTime = parsedDeadline ? parsedDeadline.hasTime : false;

        // Trích xuất người được tag (@) trong tin nhắn → assignees
        const mentionedIds = msg.mentionedIds || [];
        const assignees = [];
        for (const rawId of mentionedIds) {
            // mentionedIds có thể là string hoặc { _serialized }
            const id = typeof rawId === 'string' ? rawId : (rawId && rawId._serialized) || String(rawId);
            const number = id.split('@')[0];
            try {
                const c = await client.getContactById(id);
                const name = c.pushname || c.name || c.verifiedName || c.shortName || number;
                assignees.push({ id, number, name });
            } catch (_) {
                assignees.push({ id, number, name: number });
            }
        }

        // Hiển thị: thay @<số> bằng @<tên> cho dễ đọc trên UI
        let displayContent = taskContent;
        for (const a of assignees) {
            displayContent = displayContent.split(`@${a.number}`).join(`@${a.name}`);
        }

        const newTask = {
            id: msg.id._serialized,
            text: `[${chat.name}] ${contact.pushname}: ${displayContent}`,
            chatId: chat.id._serialized,
            messageId: msg.id._serialized,
            assignees,
            dueAt,
            hasTime,
            createdAt: new Date().toISOString(),
            source: 'whatsapp'
        };

        pendingTasks.push(newTask);
        if (pendingTasks.length > MAX_BUFFER) pendingTasks.shift();

        // Đăng ký lịch nhắc nếu có deadline
        if (dueAt) {
            scheduled[msg.id._serialized] = {
                chatId: chat.id._serialized,
                messageId: msg.id._serialized,
                groupName: chat.name,
                content: displayContent,
                assignees,
                dueAt,
                hasTime,
                reminded: false,
                completed: false,
                createdAt: new Date().toISOString(),
            };
            saveSchedule();
        }

        const tagStr = assignees.length ? ` (giao cho: ${assignees.map(a => a.name).join(', ')})` : '';
        const dueStr = dueAt ? ` [hạn: ${new Date(dueAt).toLocaleString('vi-VN')}]` : '';
        console.log(`📥 Nhận task mới từ nhóm ${chat.name}: ${taskContent}${tagStr}${dueStr}`);
        console.log(`   chatId=${newTask.chatId} messageId=${newTask.messageId}`);
    }
});

client.initialize();

// API endpoint để Frontend lấy task — KHÔNG drain, frontend tự dedupe theo messageId
app.get('/api/tasks', (req, res) => {
    res.json({ tasks: pendingTasks });
});

// API endpoint để Frontend báo task đã hoàn thành — bot reply vào nhóm WhatsApp
app.post('/api/complete', async (req, res) => {
    const { chatId, messageId, text, assignees } = req.body || {};
    if (!chatId || !messageId) {
        return res.status(400).json({ error: 'missing chatId or messageId' });
    }
    try {
        const original = await client.getMessageById(messageId);
        const tagList = Array.isArray(assignees) ? assignees.filter(a => a && a.id && a.number) : [];
        const tagPrefix = tagList.map(a => `@${a.number}`).join(' ');
        const baseReply = `✅ Task đã hoàn thành${text ? `: ${text}` : ''}`;
        const replyText = tagPrefix ? `${tagPrefix} ${baseReply}` : baseReply;
        const sendOpts = tagList.length ? { mentions: tagList.map(a => a.id) } : undefined;

        if (original) {
            await original.reply(replyText, undefined, sendOpts);
        } else {
            await client.sendMessage(chatId, replyText, sendOpts);
        }
        // Hủy lịch nhắc cho task đã hoàn thành
        if (scheduled[messageId]) {
            scheduled[messageId].completed = true;
            scheduled[messageId].completedAt = new Date().toISOString();
            saveSchedule();
        }
        console.log(`📤 Đã gửi xác nhận hoàn thành về ${chatId}${tagList.length ? ` (tag ${tagList.length} người)` : ''}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('Reply failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Job định kỳ: quét scheduled, gửi nhắc khi đến hạn
async function checkReminders() {
    if (!clientReady) return;
    const now = Date.now();
    for (const [mid, t] of Object.entries(scheduled)) {
        if (!t || t.completed || t.reminded) continue;
        if (!t.dueAt || new Date(t.dueAt).getTime() > now) continue;
        try {
            const tagList = Array.isArray(t.assignees) ? t.assignees.filter(a => a && a.id && a.number) : [];
            const tagPrefix = tagList.map(a => `@${a.number}`).join(' ');
            const head = tagPrefix ? `⏰ ${tagPrefix} —` : '⏰';
            const replyText = `${head} đã đến hạn task: ${t.content || ''}`.trim();
            const sendOpts = tagList.length ? { mentions: tagList.map(a => a.id) } : undefined;

            let original = null;
            try { original = await client.getMessageById(mid); } catch (_) {}
            if (original) {
                await original.reply(replyText, undefined, sendOpts);
            } else {
                await client.sendMessage(t.chatId, replyText, sendOpts);
            }
            t.reminded = true;
            t.remindedAt = new Date().toISOString();
            saveSchedule();
            console.log(`⏰ Đã nhắc task ${mid} (nhóm ${t.groupName || t.chatId})`);
        } catch (e) {
            console.error(`Nhắc thất bại cho ${mid}:`, e.message);
        }
    }
}

setInterval(checkReminders, REMINDER_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
    console.log(`Đang khởi tạo WhatsApp Client, vui lòng đợi...`);
});
