# Premium Todo App — Hướng Dẫn Sử Dụng

## Tổng Quan

Ứng dụng quản lý công việc cá nhân với giao diện hiện đại, đồng bộ task từ WhatsApp Group, hỗ trợ deadline + tự động nhắc khi đến hạn.

**Kiến trúc:**
- **Backend** (Node.js + Express + better-sqlite3 + WhatsApp Web JS) — nguồn dữ liệu duy nhất, REST API trên cổng 3000
- **Frontend** (HTML/CSS/JS thuần) — thin client gọi REST, chỉ giữ theme + filter trong localStorage

---

## Cấu Trúc Thư Mục

```
todo-app/
├── index.html              # Entry point
├── css/
│   ├── index.css           # Biến CSS, theme, layout
│   ├── components.css      # Buttons, cards, modals, toast, assignee-chip
│   └── animations.css
├── js/
│   ├── utils.js            # formatDate, debounce, escapeHtml…
│   ├── store.js            # API client (async)
│   ├── ui.js               # DOM rendering
│   ├── dragdrop.js         # Drag & drop → App.onReorder
│   └── app.js              # Main controller (async)
└── backend/
    ├── server.js           # WhatsApp bridge + REST API + reminder loop
    ├── db.js               # SQLite layer (better-sqlite3, WAL, prepared stmts)
    ├── migrations/
    │   └── 001_init.sql    # Schema: tasks, task_assignees, seen_messages
    ├── data.db             # SQLite database (gitignored)
    └── package.json
```

---

## Cài Đặt & Chạy Local

### 1. Backend

```bash
cd todo-app/backend
npm install
node server.js
```

Lần đầu sẽ in QR code → mở **WhatsApp** trên điện thoại → **Settings** → **Linked Devices** → **Link a Device** → quét.

Backend chạy ở `http://localhost:3000`. Database tự khởi tạo `backend/data.db`.

### 2. Frontend

Phải serve qua HTTP (không dùng `file://`) vì gọi `fetch` cross-origin tới backend:

```bash
cd todo-app
python3 -m http.server 8080
```

Mở `http://localhost:8080`.

### Dừng tất cả

```bash
pkill -9 -f "node server.js"
pkill -9 -f "http.server 8080"
pkill -9 -f "wwebjs_auth/session"
```

---

## REST API (Backend)

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/api/todos` | Liệt kê tất cả task (manual + whatsapp) |
| `GET` | `/api/todos/:id` | Lấy 1 task |
| `POST` | `/api/todos` | Tạo task thủ công. Body: `{ text, priority?, category?, dueDate?, dueTime? }` |
| `PATCH` | `/api/todos/:id` | Cập nhật. Field hợp lệ: `text, priority, category, completed, dueDate, dueTime, order` |
| `DELETE` | `/api/todos/:id` | Xóa task. Với task whatsapp, `seen_messages` giữ messageId nên bot không add lại |
| `POST` | `/api/todos/:id/complete` | Mark complete + (nếu là whatsapp) reply tag vào nhóm |
| `POST` | `/api/todos/clear-completed` | Xóa hàng loạt task **manual** đã hoàn thành |
| `POST` | `/api/todos/reorder` | Body: `{ ids: [...] }` — set display_order theo thứ tự mảng |

Format ngày trong API:
- Request: `dueDate: "YYYY-MM-DD"`, `dueTime: "HH:mm"` (optional). Set `dueDate: null` để xóa hạn.
- Response: cả `dueAt` (ISO UTC) lẫn `dueDate`/`dueTime` (đã chuyển về local TZ của server).

---

## Đồng Bộ WhatsApp

### Cú pháp tin nhắn trong Group

```
#todo @ai_đó nội dung công việc !DEADLINE
```

| Token deadline | Ý nghĩa |
|---|---|
| `!2026-05-01 17:00` | Ngày + giờ cụ thể |
| `!2026-05-01` | Ngày, mặc định 23:59 |
| `!01/05/2026 09:30` | DD/MM/YYYY HH:mm |
| `!30/04` | Năm hiện tại, 23:59 |
| `!17:00` | Hôm nay 17:00 (đã qua → ngày mai) |

Ví dụ:
```
#todo @bạnA Làm slide thuyết trình !2026-05-02 17:00
#todo @bạnA @bạnB Họp team !09:00
```

### Cách hoạt động

1. **Ingest**: bot nghe `message_create` trong Group, dedupe qua `seen_messages` (chống replay khi whatsapp-web.js đồng bộ lại)
2. **Lưu DB**: `tasks` row + `task_assignees` (mention được resolve sang `{id, number, name}`)
3. **Frontend hiện**: chip `@Tên` xanh WhatsApp, badge ngày + giờ
4. **Auto-nhắc**: job 30s scan `due_at <= now AND completed=0 AND reminded=0` → reply trong nhóm với @tag thật, mark `reminded=1`
5. **Hoàn thành**: tick trên web → `POST /api/todos/:id/complete` → bot reply ✅ + tag, set `completed=1`

---

## Quản Lý Task Trên Web

| Hành động | Cách thực hiện |
|---|---|
| Tạo task | Gõ vào "What needs to be done?" → Enter |
| Hoàn thành | Click ô tròn |
| Sửa | Click bút chì → Enter |
| Xóa | Click thùng rác |
| Sắp xếp | Kéo thả |
| Tìm | Gõ vào ô search |
| Lọc | Tab All / Active / Completed |
| Xóa task done | Footer "Clear done" (chỉ task manual) |
| Stats | Icon biểu đồ ở header |
| Export/Import | Footer (JSON, chỉ migrate task manual) |

### Phím tắt

| Phím | Hành động |
|---|---|
| `N` | Focus task input |
| `/` | Focus search |
| `1`–`3` | Filter All/Active/Completed |
| `T` | Toggle theme |
| `Esc` | Đóng modal |

---

## Database Schema

```
tasks (
  id PK, source ('manual'|'whatsapp'), text, priority, category,
  due_at ISO, has_time,
  completed, completed_at,
  message_id UNIQUE, chat_id, group_name, pusher_name, content,
  reminded, reminded_at, notified_complete_at,
  display_order, created_at, updated_at
)
task_assignees (task_id FK, wa_id, number, name)
seen_messages (message_id PK, seen_at)
```

Index quan trọng: `idx_tasks_due_pending` (partial: `WHERE completed=0 AND reminded=0 AND due_at IS NOT NULL`) — để job nhắc scan chỉ vài row.

### Inspect database

```bash
sqlite3 backend/data.db "SELECT message_id, completed, reminded, due_at, group_name FROM tasks ORDER BY created_at DESC"
```

---

## Troubleshooting

| Triệu chứng | Cách xử lý |
|---|---|
| Task không lên web | Backend chạy chưa? `curl http://localhost:3000/api/todos` |
| Bot không gửi nhắc | Xem log `tail -f /tmp/server.log` (hoặc terminal chạy node) — phải thấy `⏰ Đã nhắc...` |
| WhatsApp 401 / mất kết nối | Xóa `backend/.wwebjs_auth/` rồi chạy lại để quét QR mới |
| Task cũ tự xuất hiện lại | `seen_messages` đã chặn — nếu vẫn lặp, thử `sqlite3 backend/data.db "INSERT OR IGNORE INTO seen_messages VALUES ('<messageId>', datetime('now'))"` |
| Trình duyệt cache JS cũ | Hard-refresh `Cmd+Shift+R`; hoặc bump `?v=N` trong `index.html` |

---

## Tech Stack

**Frontend:** HTML5, CSS3 (vars + glass-morphism), Vanilla ES6+, Inter font
**Backend:** Node.js, Express 5, better-sqlite3 (WAL mode), whatsapp-web.js (Puppeteer), qrcode-terminal, CORS
