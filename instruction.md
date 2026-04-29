# Premium Todo App — Hướng Dẫn Sử Dụng

## Tổng Quan

Ứng dụng quản lý công việc cá nhân với giao diện hiện đại, hỗ trợ đồng bộ task từ WhatsApp Group.

**Kiến trúc:**
- **Frontend**: HTML/CSS/JavaScript thuần, chạy trực tiếp trong trình duyệt
- **Backend**: Node.js + Express + WhatsApp Web JS — bridge nhận tin nhắn từ WhatsApp Group đẩy vào todo list

---

## Cấu Trúc Thư Mục

```
todo-app/
├── index.html              # Entry point chính
├── css/
│   ├── index.css           # Biến CSS, theme, layout
│   ├── components.css      # Buttons, cards, modals, toast
│   └── animations.css      # Animations
├── js/
│   ├── utils.js            # Helpers (formatDate, debounce, escapeHtml...)
│   ├── store.js            # State + CRUD + localStorage
│   ├── ui.js               # DOM rendering
│   ├── dragdrop.js         # Drag & drop logic
│   └── app.js              # Main controller
└── backend/
    ├── server.js           # WhatsApp bridge + Express API
    ├── package.json
    └── node_modules/
```

---

## Cài Đặt

### 1. Frontend (không cần cài gì)

Mở trực tiếp file `index.html` bằng trình duyệt, hoặc chạy local server:

```bash
cd todo-app
python3 -m http.server 8080
# Truy cập: http://localhost:8080
```

### 2. Backend (tùy chọn — chỉ cần nếu muốn sync WhatsApp)

```bash
cd todo-app/backend
npm install
node server.js
```

Khi chạy lần đầu, terminal sẽ hiện QR code — dùng **WhatsApp** trên điện thoại quét để đăng nhập:
- Mở WhatsApp → **Settings** → **Linked Devices** → **Link a Device**
- Quét QR trên terminal

Sau khi đăng nhập, backend sẽ chạy ở `http://localhost:3000`.

---

## Hướng Dẫn Sử Dụng

### Tạo Task Mới

1. Nhập nội dung vào ô **"What needs to be done?"**
2. Chọn các tùy chọn (không bắt buộc):
   - **Priority**: 🟢 Low / 🟡 Medium / 🔴 High
   - **Due**: Ngày hết hạn
   - **Tag**: Personal / Work / Study / Health / Other
3. Bấm nút **+** hoặc nhấn **Enter**

### Quản Lý Task

| Hành động | Cách thực hiện |
|---|---|
| Đánh dấu hoàn thành | Click vào ô tròn bên trái task |
| Sửa task | Click nút bút chì → nhập text mới → Enter |
| Xóa task | Click nút thùng rác |
| Sắp xếp lại | Kéo và thả task |
| Tìm kiếm | Gõ vào ô search (tự động lọc) |
| Lọc | Click tab **All** / **Active** / **Completed** |
| Xóa tất cả task đã hoàn thành | Click **Clear done** ở footer |

### Statistics

Click nút biểu đồ ở header để xem:
- Tổng số task / Hoàn thành / Đang làm / Quá hạn
- Vòng tròn tiến độ hoàn thành (%)
- Phân bố theo Priority

### Export / Import

- **Export**: Click nút Export ở footer → tải file `todo-backup-YYYY-MM-DD.json`
- **Import**: Click nút Import → chọn file JSON đã backup
  - Task trùng ID sẽ bị bỏ qua (không ghi đè)

### Đổi Theme

Click biểu tượng mặt trăng/mặt trời ở header để chuyển dark/light mode.

---

## Phím Tắt

| Phím | Hành động |
|---|---|
| `N` | Focus vào ô tạo task mới |
| `/` | Focus vào ô tìm kiếm |
| `1` | Filter All |
| `2` | Filter Active |
| `3` | Filter Completed |
| `T` | Toggle theme |
| `?` | Hiện danh sách phím tắt |
| `Esc` | Đóng modal |

> **Lưu ý:** Phím tắt không hoạt động khi đang gõ trong input/textarea/select.

---

## Tính Năng WhatsApp Sync

### Cách dùng

1. Đảm bảo backend đang chạy (`node server.js`)
2. Trong **WhatsApp Group**, gửi tin nhắn theo format:

```
#todo Mua sữa cho mẹ
#todo Họp team lúc 3pm
```

3. Frontend tự động poll mỗi 5 giây và thêm task vào danh sách
4. Task sẽ có format: `[Tên nhóm] Tên người gửi: nội dung`

### Lưu ý

- Chỉ tin nhắn trong **Group** mới được xử lý (tránh spam từ chat 1-1)
- Phải bắt đầu bằng `#todo ` (có khoảng trắng phía sau)
- Task từ WhatsApp mặc định: `category=work`, `priority=medium`, `dueDate=hôm nay`
- Nếu backend offline, frontend không báo lỗi (silent fail)

---

## Lưu Trữ Dữ Liệu

App lưu state trong **localStorage** của trình duyệt:

| Key | Nội dung |
|---|---|
| `todo-app-data` | Danh sách task + filter hiện tại |
| `todo-app-theme` | `dark` hoặc `light` |

> **Cảnh báo:** Xóa cookies/cache trình duyệt sẽ mất hết task. Hãy **Export** định kỳ để backup.

---

## Cấu Trúc Một Task

```javascript
{
  id: "abc123...",              // Unique ID
  text: "Mua sữa",              // Nội dung
  completed: false,             // Trạng thái
  priority: "medium",           // low | medium | high
  dueDate: "2026-04-30",        // ISO date hoặc null
  category: "personal",         // personal | work | study | health | other
  createdAt: "2026-04-29T...",  // ISO timestamp
  order: 0                      // Vị trí trong list (cho drag & drop)
}
```

---

## Troubleshooting

### Task không hiển thị sau khi thêm

Mở DevTools → Console kiểm tra lỗi. Có thể do:
- localStorage bị disable (chế độ private/incognito)
- JS file load không đúng thứ tự

### Backend WhatsApp không kết nối được

- Đảm bảo đã quét QR code thành công
- Kiểm tra điện thoại có internet
- Xóa thư mục `.wwebjs_auth` trong backend rồi chạy lại để đăng nhập mới

### Task từ WhatsApp không xuất hiện

- Kiểm tra backend có đang chạy không (`http://localhost:3000/api/tasks`)
- Tin nhắn phải gửi trong **Group**, không phải chat 1-1
- Phải bắt đầu bằng `#todo ` (chữ thường, có khoảng trắng)

---

## Bug Đã Biết

⚠️ **Mismatch tên hàm trong [utils.js](js/utils.js):**

File `utils.js` export `generateId` và `getTodayStr`, nhưng các file khác lại gọi `Utils.uuid()` và `Utils.today()`. Cần fix bằng một trong hai cách:

**Cách 1** — Sửa `utils.js` để export đúng tên:
```javascript
return { uuid: generateId, today: getTodayStr, formatDate, isOverdue, escapeHtml, debounce };
```

**Cách 2** — Sửa các call site trong `store.js` và `app.js` thành `Utils.generateId()` và `Utils.getTodayStr()`.

---

## Tech Stack

**Frontend:**
- HTML5 (semantic, ARIA)
- CSS3 (CSS Variables, Grid, Flexbox, glass-morphism)
- Vanilla JavaScript (ES6+, không framework)
- Google Fonts: Inter

**Backend:**
- Node.js + Express 5
- whatsapp-web.js (Puppeteer)
- qrcode-terminal
- CORS
