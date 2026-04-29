const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'data.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function runMigrations() {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        applied_at  TEXT NOT NULL
    )`);
    const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0;
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
        const v = parseInt(f.split('_')[0], 10);
        if (!Number.isFinite(v) || v <= current) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
        const apply = db.transaction(() => {
            db.exec(sql);
            db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(v, new Date().toISOString());
        });
        apply();
        console.log(`✓ migration ${f} applied (v${v})`);
    }
}

runMigrations();

/* ===== Prepared statements ===== */

const stmts = {
    insertTask: db.prepare(`
        INSERT INTO tasks (
            id, source, text, priority, category,
            due_at, has_time, completed,
            message_id, chat_id, group_name, pusher_name, content,
            reminded, display_order, created_at, updated_at
        ) VALUES (
            @id, @source, @text, @priority, @category,
            @due_at, @has_time, 0,
            @message_id, @chat_id, @group_name, @pusher_name, @content,
            0, @display_order, @created_at, @updated_at
        )
    `),
    insertAssignee: db.prepare(`
        INSERT OR REPLACE INTO task_assignees (task_id, wa_id, number, name)
        VALUES (?, ?, ?, ?)
    `),
    getTaskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    getTaskByMessageId: db.prepare('SELECT * FROM tasks WHERE message_id = ?'),
    getAssignees: db.prepare('SELECT wa_id AS id, number, name FROM task_assignees WHERE task_id = ?'),
    listAll: db.prepare('SELECT * FROM tasks ORDER BY completed ASC, display_order ASC, created_at DESC'),
    listDuePending: db.prepare(`
        SELECT * FROM tasks
        WHERE source = 'whatsapp'
          AND due_at IS NOT NULL
          AND completed = 0
          AND reminded = 0
          AND due_at <= ?
    `),
    markReminded: db.prepare(`
        UPDATE tasks SET reminded = 1, reminded_at = ?, updated_at = ? WHERE id = ?
    `),
    markCompletedById: db.prepare(`
        UPDATE tasks SET completed = 1, completed_at = ?, updated_at = ? WHERE id = ?
    `),
    setNotifiedComplete: db.prepare(`
        UPDATE tasks SET notified_complete_at = ?, updated_at = ? WHERE id = ?
    `),
    markCompleted: db.prepare(`
        UPDATE tasks SET completed = 1, completed_at = ?, notified_complete_at = ?, updated_at = ?
        WHERE message_id = ?
    `),
    deleteTaskById: db.prepare('DELETE FROM tasks WHERE id = ?'),
    deleteCompleted: db.prepare("DELETE FROM tasks WHERE completed = 1 AND source = 'manual'"),
    maxOrder: db.prepare('SELECT COALESCE(MAX(display_order), -1) AS max FROM tasks'),
    markSeen: db.prepare(`INSERT OR IGNORE INTO seen_messages (message_id, seen_at) VALUES (?, ?)`),
    isSeen: db.prepare('SELECT 1 FROM seen_messages WHERE message_id = ? LIMIT 1'),
};

/* ===== High-level helpers ===== */

function isSeen(messageId) {
    return !!stmts.isSeen.get(messageId);
}

function markSeen(messageId) {
    stmts.markSeen.run(messageId, new Date().toISOString());
}

function rowToTask(row) {
    if (!row) return null;
    const assignees = stmts.getAssignees.all(row.id);
    return {
        id: row.id,
        source: row.source,
        text: row.text,
        priority: row.priority,
        category: row.category,
        dueAt: row.due_at,
        hasTime: !!row.has_time,
        completed: !!row.completed,
        completedAt: row.completed_at,
        messageId: row.message_id,
        chatId: row.chat_id,
        groupName: row.group_name,
        pusherName: row.pusher_name,
        content: row.content,
        reminded: !!row.reminded,
        remindedAt: row.reminded_at,
        notifiedCompleteAt: row.notified_complete_at,
        displayOrder: row.display_order,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        assignees,
    };
}

const insertWhatsappTaskTxn = db.transaction((task) => {
    stmts.insertTask.run({
        id: task.id,
        source: 'whatsapp',
        text: task.text,
        priority: task.priority || 'medium',
        category: task.category || 'work',
        due_at: task.dueAt || null,
        has_time: task.hasTime ? 1 : 0,
        message_id: task.messageId,
        chat_id: task.chatId,
        group_name: task.groupName || null,
        pusher_name: task.pusherName || null,
        content: task.content || null,
        display_order: task.displayOrder || 0,
        created_at: task.createdAt,
        updated_at: task.createdAt,
    });
    for (const a of (task.assignees || [])) {
        stmts.insertAssignee.run(task.id, a.id, a.number, a.name);
    }
});

function insertWhatsappTask(task) {
    insertWhatsappTaskTxn(task);
}

function listAllTasks() {
    return stmts.listAll.all().map(rowToTask);
}

function listDuePending(nowIso) {
    return stmts.listDuePending.all(nowIso).map(rowToTask);
}

function markReminded(taskId) {
    const now = new Date().toISOString();
    stmts.markReminded.run(now, now, taskId);
}

function markCompletedByMessageId(messageId) {
    const now = new Date().toISOString();
    const r = stmts.markCompleted.run(now, now, now, messageId);
    return r.changes > 0;
}

function getTaskByMessageId(messageId) {
    return rowToTask(stmts.getTaskByMessageId.get(messageId));
}

function getTaskById(id) {
    return rowToTask(stmts.getTaskById.get(id));
}

/**
 * Tạo task thủ công (source='manual'). Trả về task vừa tạo.
 * dueAt: ISO string hoặc null. has_time: bool.
 */
function insertManualTask({ id, text, priority, category, dueAt, hasTime, displayOrder }) {
    const now = new Date().toISOString();
    const order = Number.isFinite(displayOrder) ? displayOrder : (stmts.maxOrder.get().max + 1);
    stmts.insertTask.run({
        id,
        source: 'manual',
        text,
        priority: priority || 'medium',
        category: category || 'personal',
        due_at: dueAt || null,
        has_time: hasTime ? 1 : 0,
        message_id: null,
        chat_id: null,
        group_name: null,
        pusher_name: null,
        content: null,
        display_order: order,
        created_at: now,
        updated_at: now,
    });
    return getTaskById(id);
}

/**
 * Cập nhật task (whitelist field). Trả về task sau update hoặc null nếu không tồn tại.
 */
function updateTask(id, patch) {
    const map = {
        text: 'text',
        priority: 'priority',
        category: 'category',
        dueAt: 'due_at',
        hasTime: 'has_time',
        completed: 'completed',
        completedAt: 'completed_at',
        displayOrder: 'display_order',
    };
    const sets = [];
    const values = [];
    for (const [apiKey, dbCol] of Object.entries(map)) {
        if (apiKey in patch) {
            let v = patch[apiKey];
            if (apiKey === 'hasTime' || apiKey === 'completed') v = v ? 1 : 0;
            sets.push(`${dbCol} = ?`);
            values.push(v);
        }
    }
    if (!sets.length) return getTaskById(id);
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    const sql = `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`;
    const r = db.prepare(sql).run(...values);
    if (r.changes === 0) return null;
    return getTaskById(id);
}

function deleteTask(id) {
    return stmts.deleteTaskById.run(id).changes > 0;
}

/**
 * Xóa task manual đã hoàn thành. Task whatsapp giữ lại để có lịch sử.
 * Trả về số dòng xóa.
 */
function clearCompletedManual() {
    return stmts.deleteCompleted.run().changes;
}

const reorderTxn = db.transaction((ids) => {
    const stmt = db.prepare('UPDATE tasks SET display_order = ?, updated_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    ids.forEach((id, idx) => stmt.run(idx, now, id));
});

function reorderTasks(ids) {
    reorderTxn(ids);
}

function markNotifiedComplete(taskId) {
    const now = new Date().toISOString();
    stmts.setNotifiedComplete.run(now, now, taskId);
}

/* ===== Backfill from legacy JSON ===== */

function backfillFromLegacy() {
    const seenFile = path.join(__dirname, 'seen.json');
    const schedFile = path.join(__dirname, 'scheduled.json');

    if (fs.existsSync(seenFile)) {
        try {
            const arr = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
            if (Array.isArray(arr)) {
                const now = new Date().toISOString();
                const insert = db.transaction((ids) => {
                    for (const id of ids) stmts.markSeen.run(id, now);
                });
                insert(arr);
                console.log(`↪️  Backfill: ${arr.length} seen messageId từ seen.json`);
            }
            fs.renameSync(seenFile, seenFile + '.imported');
        } catch (e) {
            console.warn('Backfill seen.json lỗi:', e.message);
        }
    }

    if (fs.existsSync(schedFile)) {
        try {
            const obj = JSON.parse(fs.readFileSync(schedFile, 'utf8')) || {};
            let imported = 0;
            for (const [mid, t] of Object.entries(obj)) {
                if (!t || !t.chatId) continue;
                const existing = stmts.getTaskByMessageId.get(mid);
                if (existing) continue;
                insertWhatsappTaskTxn({
                    id: mid,
                    text: `[${t.groupName || ''}] ${t.content || ''}`.trim(),
                    messageId: mid,
                    chatId: t.chatId,
                    groupName: t.groupName || null,
                    content: t.content || null,
                    dueAt: t.dueAt || null,
                    hasTime: !!t.hasTime,
                    assignees: Array.isArray(t.assignees) ? t.assignees : [],
                    createdAt: t.createdAt || new Date().toISOString(),
                });
                if (t.reminded) {
                    stmts.markReminded.run(t.remindedAt || new Date().toISOString(), new Date().toISOString(), mid);
                }
                if (t.completed) {
                    const now = new Date().toISOString();
                    stmts.markCompleted.run(t.completedAt || now, t.completedAt || now, now, mid);
                }
                stmts.markSeen.run(mid, t.createdAt || new Date().toISOString());
                imported++;
            }
            console.log(`↪️  Backfill: ${imported} task từ scheduled.json`);
            fs.renameSync(schedFile, schedFile + '.imported');
        } catch (e) {
            console.warn('Backfill scheduled.json lỗi:', e.message);
        }
    }
}

backfillFromLegacy();

module.exports = {
    db,
    isSeen,
    markSeen,
    insertWhatsappTask,
    insertManualTask,
    listAllTasks,
    listDuePending,
    markReminded,
    markCompletedByMessageId,
    markNotifiedComplete,
    getTaskByMessageId,
    getTaskById,
    updateTask,
    deleteTask,
    clearCompletedManual,
    reorderTasks,
};
