# Hướng Dẫn Deploy lên VPS Ubuntu

Hướng dẫn chi tiết cài đặt và vận hành **todowhatsapp** trên VPS Ubuntu thật (single host: Node backend + WhatsApp bot + nginx serve frontend tĩnh + HTTPS).

---

## 0. Tóm tắt kiến trúc deploy

```
        Internet (HTTPS :443)
              │
              ▼
        ┌─────────┐
        │  nginx  │  ──► /          → serve static (todo-app/index.html, css, js)
        │         │  ──► /api/*     → proxy_pass http://127.0.0.1:3000
        └─────────┘
              │
              ▼
        ┌─────────────┐    Database file
        │ Node server │ ◄──► backend/data.db (SQLite WAL)
        │ (systemd)   │ ◄──► backend/.wwebjs_auth/ (WhatsApp session)
        └─────────────┘
              │
              ▼
        WhatsApp Web (Puppeteer headless Chromium)
```

Backend chỉ lắng nghe `127.0.0.1:3000` — không expose port 3000 ra ngoài. Tất cả request từ trình duyệt đi qua nginx :443 → cùng origin nên không cần CORS.

---

## 1. Yêu cầu

| Mục | Khuyến nghị |
|---|---|
| OS | Ubuntu **22.04 LTS** hoặc **24.04 LTS** |
| RAM | tối thiểu **1 GB** (Chromium nuốt nhiều), tốt hơn **2 GB** |
| Disk | tối thiểu **5 GB** trống |
| CPU | 1 vCPU đủ; 2 vCPU mượt hơn khi sync WhatsApp |
| Domain | tùy chọn (nếu muốn HTTPS), ví dụ `todo.example.com` |
| Quyền | user có **sudo** |

---

## 2. Chuẩn bị server

### 2.1 SSH vào server và cập nhật hệ thống

```bash
ssh root@YOUR_SERVER_IP
apt update && apt upgrade -y
apt install -y curl git build-essential ufw
```

### 2.2 Tạo user thường (đừng chạy bot bằng root)

```bash
adduser todo
usermod -aG sudo todo
# Copy SSH key cho user mới (tùy chọn)
rsync --archive --chown=todo:todo ~/.ssh /home/todo
```

Logout, SSH lại với user `todo`:
```bash
ssh todo@YOUR_SERVER_IP
```

### 2.3 Set timezone (quan trọng — parser deadline dùng local TZ)

```bash
sudo timedatectl set-timezone Asia/Ho_Chi_Minh    # hoặc America/Lima, v.v.
timedatectl
```

### 2.4 Firewall ufw

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # mở 80 + 443
sudo ufw enable
sudo ufw status
```

> **Đừng** mở port 3000 ra ngoài. Backend chỉ giao tiếp qua nginx.

---

## 3. Cài Node.js 20.x

Dùng NodeSource (mới hơn apt mặc định):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # v20.x.x
npm --version
```

---

## 4. Cài dependencies hệ thống cho Puppeteer/Chromium

`whatsapp-web.js` chạy Chromium headless qua Puppeteer. Trên Ubuntu mặc định thiếu nhiều thư viện đồ họa — Chromium sẽ crash với lỗi kiểu "error while loading shared libraries".

```bash
sudo apt install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
  libcairo2 libasound2t64 libatspi2.0-0 libgtk-3-0 fonts-liberation \
  fonts-noto-color-emoji fonts-noto-cjk
```

> Nếu dùng Ubuntu 22.04, thay `libasound2t64` → `libasound2`.

---

## 5. Cài nginx + certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

Verify: `curl http://localhost` thấy trang welcome nginx.

---

## 6. Clone repo + cài npm deps

```bash
cd /home/todo
git clone https://github.com/chilv1/todowhatsapp.git
cd todowhatsapp/backend
npm install
```

`npm install` sẽ:
- Build `better-sqlite3` (native module — cần `build-essential` đã cài ở 2.1)
- Tải Chromium cho Puppeteer (~170 MB) — **mất vài phút**

Nếu `better-sqlite3` build fail, kiểm tra `python3` đã có chưa: `sudo apt install -y python3`.

---

## 7. Cấu hình frontend gọi API qua nginx (cùng origin)

Mặc định `js/store.js` set `API_BASE = 'http://localhost:3000'` — chỉ chạy được ở máy dev.

Sửa để gọi tương đối (cùng origin với nginx):

```bash
cd /home/todo/todowhatsapp
sed -i "s|API_BASE: 'http://localhost:3000'|API_BASE: ''|" js/store.js

# Verify
grep "API_BASE:" js/store.js
# Expect: API_BASE: '',
```

Tăng cache-buster để client mới nhận file đã sửa:

```bash
sed -i 's/?v=[0-9]\+/?v=prod1/g' index.html
```

---

## 8. First run — quét QR WhatsApp

QR code in ra **terminal SSH**, bạn quét trực tiếp trên đó:

```bash
cd /home/todo/todowhatsapp/backend
node server.js
```

Đợi ~10–30 giây, terminal hiện QR ASCII art:
```
--- QUÉT MÃ QR NÀY BẰNG ỨNG DỤNG WHATSAPP TRÊN ĐIỆN THOẠI CỦA BẠN ---
█████████████████
█▀▄▀█...
```

Trên điện thoại: **WhatsApp** → **Settings** → **Linked Devices** → **Link a Device** → quét QR trên màn hình SSH.

Khi thấy:
```
✅ WhatsApp Bot đã sẵn sàng!
```

→ Nhấn **Ctrl+C** để dừng. Session đã lưu vào `backend/.wwebjs_auth/`. Lần sau systemd start không cần quét lại.

> Nếu QR không hiện rõ trong terminal, phóng to font terminal hoặc giảm zoom màn hình điện thoại.

---

## 9. Tạo systemd service (chạy nền + auto-restart)

```bash
sudo tee /etc/systemd/system/todoapp.service > /dev/null <<'EOF'
[Unit]
Description=TodoApp WhatsApp Bot + REST API
After=network.target

[Service]
Type=simple
User=todo
WorkingDirectory=/home/todo/todowhatsapp/backend
ExecStart=/usr/bin/node /home/todo/todowhatsapp/backend/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=append:/var/log/todoapp.log
StandardError=append:/var/log/todoapp.log

# Hạn chế tài nguyên (tùy chọn)
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

sudo touch /var/log/todoapp.log
sudo chown todo:todo /var/log/todoapp.log

sudo systemctl daemon-reload
sudo systemctl enable --now todoapp
sudo systemctl status todoapp        # phải thấy "active (running)"
```

Tail log:
```bash
sudo tail -f /var/log/todoapp.log
# Hoặc qua journald:
journalctl -u todoapp -f
```

---

## 10. Cấu hình nginx

Tạo server block cho domain (thay `todo.example.com` bằng domain của bạn):

```bash
sudo tee /etc/nginx/sites-available/todoapp > /dev/null <<'EOF'
server {
    listen 80;
    server_name todo.example.com;

    # Static frontend
    root /home/todo/todowhatsapp;
    index index.html;

    # CSS/JS — long cache, cache-bust qua ?v=N
    location ~* \.(css|js|png|jpg|svg|woff2)$ {
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
    }

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Bảo vệ thư mục nhạy cảm
    location ~ ^/(backend|\.wwebjs|\.git) {
        deny all;
        return 404;
    }

    client_max_body_size 5m;
}
EOF

sudo ln -sf /etc/nginx/sites-available/todoapp /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t                     # check syntax
sudo systemctl reload nginx
```

Test HTTP:
```bash
curl -I http://todo.example.com
curl -s http://todo.example.com/api/todos | head -5
```

Mở trình duyệt: `http://todo.example.com` → thấy app.

---

## 11. HTTPS với Let's Encrypt

Chỉ chạy được khi domain đã trỏ A record về IP server.

```bash
sudo certbot --nginx -d todo.example.com
# Trả lời:
#   - Email
#   - Đồng ý ToS
#   - Có muốn redirect HTTP → HTTPS không? → 2 (Yes)
```

certbot tự sửa nginx config thêm SSL. Test:
```bash
curl -I https://todo.example.com
```

Test auto-renew (cron đã được certbot tạo sẵn):
```bash
sudo certbot renew --dry-run
```

---

## 12. Backup data

3 file/thư mục quan trọng (đã gitignore):

| Path | Vai trò | Mất là gì |
|---|---|---|
| `backend/data.db` (+ `data.db-wal`, `data.db-shm`) | Toàn bộ task, assignees, history | Mất hết task |
| `backend/.wwebjs_auth/` | WhatsApp session token | Phải quét QR lại |
| `backend/.wwebjs_cache/` | Cache thuần — không cần backup | (bỏ) |

### Script backup hằng ngày

```bash
sudo mkdir -p /var/backups/todoapp
sudo chown todo:todo /var/backups/todoapp

cat > /home/todo/backup-todoapp.sh <<'EOF'
#!/bin/bash
set -e
DEST=/var/backups/todoapp
TS=$(date +%Y%m%d-%H%M%S)
cd /home/todo/todowhatsapp/backend
# Dump SQLite an toàn (không cần dừng server, WAL OK)
sqlite3 data.db ".backup '$DEST/data-$TS.db'"
# Tar session WhatsApp
tar czf $DEST/wwebjs-$TS.tgz .wwebjs_auth
# Giữ 14 bản, xóa cũ hơn
find $DEST -type f -mtime +14 -delete
EOF
chmod +x /home/todo/backup-todoapp.sh
sudo apt install -y sqlite3      # nếu chưa có

# Cron 02:30 mỗi đêm
crontab -e
# Thêm dòng:
# 30 2 * * * /home/todo/backup-todoapp.sh >> /var/log/todoapp-backup.log 2>&1
```

> Bonus: dùng `rclone`/`rsync`/`restic` đẩy `/var/backups/todoapp` lên S3/Backblaze để có off-site backup.

---

## 13. Vận hành thường ngày

### Xem trạng thái + log

```bash
sudo systemctl status todoapp
journalctl -u todoapp -n 100 --no-pager      # 100 dòng log gần nhất
journalctl -u todoapp -f                      # tail -f
sudo tail -f /var/log/nginx/access.log
```

### Restart sau khi sửa code

```bash
cd /home/todo/todowhatsapp
git pull
cd backend && npm install        # nếu package.json đổi
sudo systemctl restart todoapp
```

### Inspect database

```bash
sqlite3 /home/todo/todowhatsapp/backend/data.db \
  "SELECT message_id, completed, reminded, due_at, group_name FROM tasks ORDER BY created_at DESC LIMIT 20"
```

### Reset WhatsApp session (logout)

```bash
sudo systemctl stop todoapp
rm -rf /home/todo/todowhatsapp/backend/.wwebjs_auth
sudo systemctl start todoapp
# Tail log để bắt QR
journalctl -u todoapp -f
# Quét QR rồi Ctrl+C khỏi journalctl khi xong
```

---

## 14. Troubleshooting

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `node: command not found` | Chưa cài Node 20 (bước 3) | Lặp lại bước 3 |
| `Error while loading shared libraries: libnss3.so` | Thiếu deps Chromium | Lặp lại bước 4 |
| `better-sqlite3` build fail | Thiếu `python3` / `build-essential` / `node-gyp` | `sudo apt install -y python3 build-essential` |
| systemd `status=203/EXEC` | Sai path `node` hoặc `WorkingDirectory` | `which node` → sửa `ExecStart` đúng path |
| QR không bao giờ hiện | Mất kết nối tới WhatsApp servers, hoặc IP bị block | Đổi VPS region; hoặc dùng VPN proxy cho Puppeteer |
| nginx 502 Bad Gateway | Backend không chạy hoặc không bind 127.0.0.1:3000 | `systemctl status todoapp`; `ss -tlnp | grep 3000` |
| Frontend trắng / fetch fail | `Store.API_BASE` chưa đổi sang `''` (bước 7) | Sửa lại `js/store.js`; hard-refresh |
| Browser cache CSS/JS cũ | Chưa bump `?v=...` (bước 7) | Bump số version trong `index.html` |
| Bot không gửi nhắc đúng giờ | Sai timezone server | `timedatectl` → `set-timezone` (bước 2.3); restart todoapp |
| Database lock errors | WAL chưa enabled, hoặc backup script đang FILE COPY | Backup phải dùng `sqlite3 .backup` (đã viết ở bước 12) |
| Disk đầy vì log Chromium | journald rotate chậm | `sudo journalctl --vacuum-size=100M` |

---

## 15. Hardening tùy chọn

- **Fail2ban** cho SSH: `sudo apt install fail2ban`
- **SSH disable password**: trong `/etc/ssh/sshd_config` set `PasswordAuthentication no`
- **HTTP basic auth** trước khi vào app (vì hiện chưa có login):
  ```bash
  sudo apt install -y apache2-utils
  sudo htpasswd -c /etc/nginx/.htpasswd todo
  # Thêm vào server block nginx:
  #   auth_basic "TodoApp";
  #   auth_basic_user_file /etc/nginx/.htpasswd;
  ```
- **Rate-limit /api**: thêm `limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;` ở `/etc/nginx/nginx.conf` rồi `limit_req zone=api burst=20;` trong block `/api/`.

---

## Checklist deploy nhanh

```
[ ] SSH với user non-root + ufw
[ ] timedatectl set-timezone đúng
[ ] Cài Node 20 + deps Chromium
[ ] Cài nginx + certbot
[ ] git clone + npm install
[ ] Sửa store.js: API_BASE = ''
[ ] Quét QR (chạy node server.js trong SSH)
[ ] systemd unit + enable + start
[ ] nginx server block + reload
[ ] certbot --nginx (HTTPS)
[ ] Cron backup
[ ] Kiểm: https://domain → tạo task, gửi #todo trong nhóm WhatsApp
```
