const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCodeLib = require('qrcode');
const db = require('./db');

/* ===== Telegram notifications =====
 * Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID trong env (systemd unit).
 * Nếu thiếu env → no-op (không crash, không gửi).
 */
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const TG_ENABLED = !!(TG_TOKEN && TG_CHAT);
let lastQrSentAt = 0;
const QR_THROTTLE_MS = 25 * 1000; // tối thiểu 25s giữa 2 PNG QR
let wasDisconnected = false;       // để chỉ gửi "reconnected" khi vừa từ disconnected sang ready

async function tgSendText(text) {
    if (!TG_ENABLED) return;
    try {
        const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
        });
        if (!r.ok) console.warn(`tg sendMessage ${r.status}`, await r.text().catch(() => ''));
    } catch (e) {
        console.warn('tgSendText fail:', e.message);
    }
}

async function tgSendPhoto(buffer, caption) {
    if (!TG_ENABLED) return;
    try {
        const form = new FormData();
        form.append('chat_id', String(TG_CHAT));
        form.append('caption', caption);
        form.append('parse_mode', 'Markdown');
        form.append('photo', new Blob([buffer], { type: 'image/png' }), 'qr.png');
        const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
            method: 'POST', body: form,
        });
        if (!r.ok) console.warn(`tg sendPhoto ${r.status}`, await r.text().catch(() => ''));
    } catch (e) {
        console.warn('tgSendPhoto fail:', e.message);
    }
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;
const REMINDER_INTERVAL_MS = 30 * 1000; // quét lịch nhắc mỗi 30 giây
let clientReady = false;

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

function formatDueForDisplay(dueAtIso, hasTime) {
    const d = new Date(dueAtIso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    if (hasTime) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mi} ${dd}/${mm}/${yy}`;
    }
    return `${dd}/${mm}/${yy}`;
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

client.on('qr', async (qr) => {
    console.log('\n--- QUÉT MÃ QR NÀY BẰNG ỨNG DỤNG WHATSAPP TRÊN ĐIỆN THOẠI CỦA BẠN ---');
    qrcode.generate(qr, { small: true });

    // Gửi QR qua Telegram (throttle 25s/lần để không spam khi WA refresh)
    const now = Date.now();
    if (now - lastQrSentAt < QR_THROTTLE_MS) return;
    lastQrSentAt = now;
    try {
        const buf = await QRCodeLib.toBuffer(qr, { type: 'png', scale: 10, margin: 4 });
        await tgSendPhoto(buf, '🔐 *WhatsApp cần quét QR mới*\nQuét trong ~30s, ảnh sẽ refresh sau đó.');
    } catch (e) {
        console.warn('QR→Telegram fail:', e.message);
    }
});

client.on('ready', () => {
    console.log('✅ WhatsApp Bot đã sẵn sàng!');
    clientReady = true;
    if (wasDisconnected) {
        wasDisconnected = false;
        tgSendText('✅ *Bot reconnected* — WhatsApp client trở lại bình thường.');
    }
});

// Khi puppeteer frame bị detach hoặc whatsapp ngắt kết nối → re-initialize
client.on('disconnected', async (reason) => {
    console.warn(`⚠️ WhatsApp client disconnected: ${reason}. Đang khởi tạo lại sau 5s...`);
    clientReady = false;
    wasDisconnected = true;
    tgSendText(`⚠️ *Bot disconnected*: \`${reason}\`\nĐang re-init sau 5s...`);
    try { await client.destroy(); } catch (_) {}
    setTimeout(() => {
        console.log('🔄 Re-initializing WhatsApp client...');
        client.initialize().catch(e => console.error('Re-init failed:', e.message));
    }, 5000);
});

client.on('auth_failure', (msg) => {
    console.error(`❌ WhatsApp auth failure: ${msg}. Cần quét QR lại — xóa .wwebjs_auth/.`);
    clientReady = false;
    tgSendText(`❌ *Auth failure*: \`${msg}\`\nVPS: \`rm -rf ~/todowhatsapp/backend/.wwebjs_auth && systemctl restart todoapp\``);
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
        if (db.isSeen(mid)) {
            return;
        }
        db.markSeen(mid);

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

        const createdAt = new Date().toISOString();
        let inserted = false;
        try {
            db.insertWhatsappTask({
                id: mid,
                text: `[${chat.name}] ${contact.pushname}: ${displayContent}`,
                messageId: mid,
                chatId: chat.id._serialized,
                groupName: chat.name,
                pusherName: contact.pushname || null,
                content: displayContent,
                dueAt,
                hasTime,
                assignees,
                createdAt,
            });
            inserted = true;
        } catch (e) {
            console.error('Lưu task vào DB lỗi:', e.message);
        }

        const tagStr = assignees.length ? ` (giao cho: ${assignees.map(a => a.name).join(', ')})` : '';
        const dueStr = dueAt ? ` [hạn: ${new Date(dueAt).toLocaleString('vi-VN')}]` : '';
        console.log(`📥 Nhận task mới từ nhóm ${chat.name}: ${taskContent}${tagStr}${dueStr}`);
        console.log(`   chatId=${chat.id._serialized} messageId=${mid}`);

        // Confirm trong nhóm WhatsApp: ai được giao, nội dung, deadline
        if (inserted) {
            try {
                const tagPrefix = assignees.length ? assignees.map(a => `@${a.number}`).join(' ') : '';
                const dueDisplay = dueAt ? formatDueForDisplay(dueAt, hasTime) : null;
                const headline = tagPrefix ? `✅ Đã giao task cho ${tagPrefix}` : `✅ Đã ghi nhận task`;
                const lines = [headline];
                if (displayContent) lines.push(`📝 ${displayContent}`);
                if (dueDisplay) lines.push(`⏰ Hạn: ${dueDisplay}`);
                const replyText = lines.join('\n');
                const sendOpts = assignees.length ? { mentions: assignees.map(a => a.id) } : undefined;
                await msg.reply(replyText, undefined, sendOpts);
            } catch (e) {
                console.warn('Confirm reply failed:', e.message);
            }
        }
    }
});

client.initialize();

/* ===== Helpers ===== */

// Map row của DB → shape API; dueDate/dueTime extract theo timezone của server
function toApiShape(r) {
    const out = {
        id: r.id,
        source: r.source,
        text: r.text,
        priority: r.priority,
        category: r.category,
        completed: r.completed,
        dueAt: r.dueAt,
        hasTime: r.hasTime,
        dueDate: null,
        dueTime: null,
        chatId: r.chatId,
        messageId: r.messageId,
        groupName: r.groupName,
        assignees: r.assignees,
        order: r.displayOrder,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
    };
    if (r.dueAt) {
        const d = new Date(r.dueAt);
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const da = String(d.getDate()).padStart(2, '0');
        out.dueDate = `${y}-${mo}-${da}`;
        if (r.hasTime) {
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            out.dueTime = `${hh}:${mm}`;
        }
    }
    return out;
}

// Convert dueDate (YYYY-MM-DD) + optional dueTime (HH:mm) → ISO theo local TZ.
// Trả { dueAt, hasTime } hoặc { dueAt: null, hasTime: false } nếu không có dueDate.
function buildDueAt(dueDate, dueTime) {
    if (!dueDate) return { dueAt: null, hasTime: false };
    const dm = String(dueDate).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!dm) return { dueAt: null, hasTime: false };
    let h = 23, mi = 59, hasTime = false;
    if (dueTime) {
        const tm = String(dueTime).match(/^(\d{1,2}):(\d{2})$/);
        if (tm) { h = +tm[1]; mi = +tm[2]; hasTime = true; }
    }
    const d = new Date(+dm[1], +dm[2] - 1, +dm[3], h, mi, 0, 0);
    return { dueAt: d.toISOString(), hasTime };
}

function genUuid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
}

/* ===== /api/todos — REST CRUD ===== */

app.get('/api/todos', (req, res) => {
    const todos = db.listAllTasks().map(toApiShape);
    res.json({ todos });
});

app.get('/api/todos/:id', (req, res) => {
    const t = db.getTaskById(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(toApiShape(t));
});

app.post('/api/todos', (req, res) => {
    const { text, priority, category, dueDate, dueTime, id } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'text required' });
    }
    const { dueAt, hasTime } = buildDueAt(dueDate, dueTime);
    try {
        const created = db.insertManualTask({
            id: id || genUuid(),
            text: text.trim(),
            priority,
            category,
            dueAt,
            hasTime,
        });
        res.status(201).json(toApiShape(created));
    } catch (e) {
        console.error('create manual task failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.patch('/api/todos/:id', (req, res) => {
    const id = req.params.id;
    const existing = db.getTaskById(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const body = req.body || {};
    const patch = {};
    if ('text' in body && typeof body.text === 'string' && body.text.trim()) patch.text = body.text.trim();
    if ('priority' in body) patch.priority = body.priority;
    if ('category' in body) patch.category = body.category;
    if ('completed' in body) {
        patch.completed = !!body.completed;
        patch.completedAt = body.completed ? new Date().toISOString() : null;
    }
    if ('order' in body) patch.displayOrder = Number(body.order);
    // dueDate / dueTime: chỉ xử lý nếu client gửi 1 trong 2 (cho phép xóa: dueDate: null)
    if ('dueDate' in body || 'dueTime' in body) {
        if (body.dueDate === null) {
            patch.dueAt = null;
            patch.hasTime = false;
        } else {
            const dueDate = body.dueDate || (existing.dueAt ? toApiShape(existing).dueDate : null);
            const dueTime = body.dueTime || null;
            const { dueAt, hasTime } = buildDueAt(dueDate, dueTime);
            patch.dueAt = dueAt;
            patch.hasTime = hasTime;
        }
    }
    const updated = db.updateTask(id, patch);
    res.json(toApiShape(updated));
});

app.delete('/api/todos/:id', (req, res) => {
    const ok = db.deleteTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
});

app.post('/api/todos/clear-completed', (req, res) => {
    const removed = db.clearCompletedManual();
    res.json({ removed });
});

app.post('/api/todos/reorder', (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.some(x => typeof x !== 'string')) {
        return res.status(400).json({ error: 'ids[] (string) required' });
    }
    db.reorderTasks(ids);
    res.json({ ok: true });
});

/**
 * Mark complete + (nếu là task whatsapp) reply tag vào nhóm.
 * Body không cần — server tự lấy chatId/assignees từ DB.
 *
 * Nếu reply WhatsApp fail (disconnect, frame detach, …): task vẫn được
 * mark completed trong DB, response 200 với notified=false + reason.
 * Frontend KHÔNG nên hiển thị lỗi đỏ — chỉ inform softly.
 */
app.post('/api/todos/:id/complete', async (req, res) => {
    const id = req.params.id;
    const t = db.getTaskById(id);
    if (!t) return res.status(404).json({ error: 'not found' });

    // Cập nhật completed trong DB ngay (idempotent)
    const now = new Date().toISOString();
    db.updateTask(id, { completed: true, completedAt: now });

    // Nếu không phải whatsapp hoặc đã thông báo rồi → trả luôn
    if (t.source !== 'whatsapp' || !t.chatId || !t.messageId || t.notifiedCompleteAt) {
        return res.json({ ok: true, notified: false });
    }

    if (!clientReady) {
        return res.json({ ok: true, notified: false, reason: 'whatsapp client offline' });
    }

    try {
        const tagList = (t.assignees || []).filter(a => a && a.id && a.number);
        const tagPrefix = tagList.map(a => `@${a.number}`).join(' ');
        const baseReply = `✅ Task đã hoàn thành${t.text ? `: ${t.text}` : ''}`;
        const replyText = tagPrefix ? `${tagPrefix} ${baseReply}` : baseReply;
        const sendOpts = tagList.length ? { mentions: tagList.map(a => a.id) } : undefined;

        const original = await client.getMessageById(t.messageId).catch(() => null);
        if (original) {
            await original.reply(replyText, undefined, sendOpts);
        } else {
            await client.sendMessage(t.chatId, replyText, sendOpts);
        }
        db.markNotifiedComplete(id);
        console.log(`📤 Complete-reply về ${t.chatId}${tagList.length ? ` (tag ${tagList.length} người)` : ''}`);
        res.json({ ok: true, notified: true });
    } catch (e) {
        // Lỗi puppeteer/frame/network — task đã done trong DB. Không trả 500.
        // notified_complete_at chưa set → có thể retry sau qua endpoint riêng.
        console.warn(`⚠️ Complete-reply failed (task vẫn done): ${e.message}`);
        res.json({ ok: true, notified: false, reason: e.message });
    }
});


// Job định kỳ: quét DB, gửi nhắc khi đến hạn
async function checkReminders() {
    if (!clientReady) return;
    const due = db.listDuePending(new Date().toISOString());
    for (const t of due) {
        try {
            const tagList = Array.isArray(t.assignees) ? t.assignees.filter(a => a && a.id && a.number) : [];
            const tagPrefix = tagList.map(a => `@${a.number}`).join(' ');
            const head = tagPrefix ? `⏰ ${tagPrefix} —` : '⏰';
            const replyText = `${head} đã đến hạn task: ${t.content || ''}`.trim();
            const sendOpts = tagList.length ? { mentions: tagList.map(a => a.id) } : undefined;

            let original = null;
            try { original = await client.getMessageById(t.messageId); } catch (_) {}
            if (original) {
                await original.reply(replyText, undefined, sendOpts);
            } else {
                await client.sendMessage(t.chatId, replyText, sendOpts);
            }
            db.markReminded(t.id);
            console.log(`⏰ Đã nhắc task ${t.messageId} (nhóm ${t.groupName || t.chatId})`);
        } catch (e) {
            console.error(`Nhắc thất bại cho ${t.messageId}:`, e.message);
        }
    }
}

setInterval(checkReminders, REMINDER_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
    console.log(`Đang khởi tạo WhatsApp Client, vui lòng đợi...`);
    if (TG_ENABLED) {
        tgSendText(`🟢 *TodoApp service started* — booting WhatsApp client...`);
        pollTelegram();
    } else {
        console.log('ℹ️  Telegram notify disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).');
    }
});

/* =================================================================
 * Telegram command bot — long-polling, whitelist by chat_id
 * ================================================================= */

let lastUpdateId = 0;
const APP_DIR = '/home/todo/todowhatsapp';
const LOG_FILE = '/var/log/todoapp.log';

function execShell(cmd, timeoutMs = 10000) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
        });
    });
}

function fmtUptime(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    if (h) return `${h}h ${m}m ${sec}s`;
    if (m) return `${m}m ${sec}s`;
    return `${sec}s`;
}

async function ackTelegramUpdates() {
    if (lastUpdateId <= 0) return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&limit=1&timeout=0`);
    } catch (_) { /* ignore */ }
}

async function tgCmdHelp() {
    await tgSendText(`*Available commands*
/status — bot info
/restart — restart service (systemd auto-revives)
/logs — last 20 log lines
/qr — force re-auth (destroys WhatsApp session). Type \`/qr confirm\` to proceed.
/help — this message`);
}

async function tgCmdStatus() {
    const all = db.listAllTasks();
    const active = all.filter(t => !t.completed).length;
    const due = db.listDuePending(new Date().toISOString()).length;
    await tgSendText(`*Status*
Uptime: ${fmtUptime(process.uptime())}
WhatsApp: ${clientReady ? '✅ ready' : '⚠️ not ready'}
Tasks: ${all.length} total, ${active} active
Due to remind: ${due}`);
}

async function tgCmdLogs() {
    const r = await execShell(`tail -20 ${LOG_FILE}`);
    if (!r.ok) {
        await tgSendText(`❌ logs failed: \`${(r.err && r.err.message) || r.stderr}\``);
        return;
    }
    let out = r.stdout.trim() || '(empty)';
    if (out.length > 3500) out = '...' + out.slice(-3500);
    await tgSendText('```\n' + out + '\n```');
}

async function tgCmdRestart() {
    await tgSendText('🔄 Restarting service...');
    await ackTelegramUpdates();
    // Async exec — process này sẽ bị kill trong vài giây, systemd revive
    exec('sudo /usr/bin/systemctl restart todoapp', () => { /* may not run */ });
}

async function tgCmdQR(confirmed) {
    if (!confirmed) {
        await tgSendText(`⚠️ Lệnh này sẽ *xóa session WhatsApp* và buộc quét QR mới.
Confirm bằng cách gõ: \`/qr confirm\``);
        return;
    }
    await tgSendText('🗑 Wiping `.wwebjs_auth/` và restart — chờ ảnh QR mới trong ~15s...');
    await ackTelegramUpdates();
    exec(`rm -rf ${APP_DIR}/backend/.wwebjs_auth && sudo /usr/bin/systemctl restart todoapp`, () => {});
}

async function handleTgUpdate(update) {
    lastUpdateId = update.update_id;
    const msg = update.message;
    if (!msg || !msg.text || !msg.chat) return;
    if (String(msg.chat.id) !== String(TG_CHAT)) {
        console.warn(`tg: ignored cmd from chat ${msg.chat.id} text="${msg.text.slice(0, 30)}"`);
        return;
    }
    const text = msg.text.trim();
    try {
        switch (true) {
            case text === '/help' || text === '/start': return await tgCmdHelp();
            case text === '/status': return await tgCmdStatus();
            case text === '/logs': return await tgCmdLogs();
            case text === '/restart': return await tgCmdRestart();
            case text === '/qr': return await tgCmdQR(false);
            case text === '/qr confirm': return await tgCmdQR(true);
            default:
                if (text.startsWith('/')) {
                    await tgSendText(`Unknown command \`${text.split(' ')[0]}\`. Try /help`);
                }
        }
    } catch (e) {
        console.error('tg cmd error:', e.message);
        await tgSendText(`❌ Error: \`${e.message}\``);
    }
}

async function pollTelegram() {
    console.log('📲 Telegram command polling started');
    while (true) {
        try {
            const url = `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=25&allowed_updates=["message"]`;
            const r = await fetch(url, { signal: AbortSignal.timeout(35000) });
            if (!r.ok) { await new Promise(s => setTimeout(s, 5000)); continue; }
            const data = await r.json();
            if (data.ok && Array.isArray(data.result)) {
                for (const update of data.result) {
                    await handleTgUpdate(update);
                }
            }
        } catch (e) {
            const msg = String(e && e.message || e);
            if (!msg.includes('aborted') && !msg.includes('Abort')) {
                console.warn('tg poll error:', msg);
            }
            await new Promise(s => setTimeout(s, 5000));
        }
    }
}
