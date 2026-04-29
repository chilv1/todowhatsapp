/* ============================================
   Store — API client (Phase 3)
   ============================================ */

const Store = {
  API_BASE: 'http://localhost:3000',
  PREFS_KEY: 'todo-app-prefs',
  THEME_KEY: 'todo-app-theme',
  LEGACY_KEY: 'todo-app-data',

  /* ===== UI prefs (sync, local) ===== */

  loadPrefs() {
    try {
      const raw = localStorage.getItem(this.PREFS_KEY);
      if (raw) return { filter: 'all', searchQuery: '', ...JSON.parse(raw) };
    } catch (_) { /* ignore */ }
    return { filter: 'all', searchQuery: '' };
  },

  savePrefs(prefs) {
    try {
      localStorage.setItem(this.PREFS_KEY, JSON.stringify({
        filter: prefs.filter || 'all',
      }));
    } catch (_) { /* ignore */ }
  },

  loadTheme() {
    try { return localStorage.getItem(this.THEME_KEY) || 'dark'; }
    catch (_) { return 'dark'; }
  },

  saveTheme(theme) {
    try { localStorage.setItem(this.THEME_KEY, theme); } catch (_) { /* ignore */ }
  },

  /* ===== Server-backed CRUD ===== */

  async _request(path, options = {}) {
    const r = await fetch(this.API_BASE + path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => r.statusText);
      throw new Error(`${r.status} ${msg}`);
    }
    if (r.status === 204) return null;
    return r.json();
  },

  async fetchAll() {
    const data = await this._request('/api/todos');
    return data.todos || [];
  },

  async create({ text, priority, category, dueDate, dueTime }) {
    return this._request('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ text, priority, category, dueDate: dueDate || null, dueTime: dueTime || null }),
    });
  },

  async update(id, patch) {
    return this._request(`/api/todos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async toggle(id, completed) {
    return this.update(id, { completed });
  },

  async remove(id) {
    return this._request(`/api/todos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async complete(id) {
    return this._request(`/api/todos/${encodeURIComponent(id)}/complete`, { method: 'POST' });
  },

  async clearCompleted() {
    return this._request('/api/todos/clear-completed', { method: 'POST' });
  },

  async reorder(ids) {
    return this._request('/api/todos/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  },

  /* ===== One-shot legacy migration ===== */

  async migrateLegacyIfAny() {
    const raw = localStorage.getItem(this.LEGACY_KEY);
    if (!raw) return 0;
    try {
      const data = JSON.parse(raw);
      // Bỏ task whatsapp (đã có trong DB qua bot). Chỉ migrate task tự thêm.
      const todos = (data.todos || []).filter(t => !t.messageId);
      let migrated = 0;
      for (const t of todos) {
        try {
          await this.create({
            text: t.text,
            priority: t.priority,
            category: t.category,
            dueDate: t.dueDate || null,
            dueTime: t.dueTime || null,
          });
          migrated++;
        } catch (e) {
          console.warn('Migrate task lỗi:', e.message);
        }
      }
      // Sao lưu rồi xóa key cũ
      localStorage.setItem(this.LEGACY_KEY + '_migrated_at', new Date().toISOString());
      localStorage.removeItem(this.LEGACY_KEY);
      return migrated;
    } catch (e) {
      console.error('Migration parse failed:', e);
      return 0;
    }
  },

  /* ===== Pure helpers (operate on client cache) ===== */

  getFilteredTodos(todos, { filter, searchQuery }) {
    let list = [...(todos || [])];
    if (filter === 'active') list = list.filter(t => !t.completed);
    else if (filter === 'completed') list = list.filter(t => t.completed);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(t =>
        (t.text || '').toLowerCase().includes(q) ||
        (t.category || '').toLowerCase().includes(q)
      );
    }
    return list;
  },

  activeCount(todos) {
    return (todos || []).filter(t => !t.completed).length;
  },

  getStats(todos) {
    const all = todos || [];
    const total = all.length;
    const completed = all.filter(t => t.completed).length;
    const active = total - completed;
    const overdue = all.filter(t => !t.completed && Utils.isOverdue(t.dueDate)).length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    const byPriority = { high: 0, medium: 0, low: 0 };
    for (const t of all) {
      if (byPriority[t.priority] !== undefined) byPriority[t.priority]++;
    }
    return { total, completed, active, overdue, completionRate, byPriority };
  },

  /* ===== Export / Import ===== */

  exportJSON(todos) {
    const data = { exportedAt: new Date().toISOString(), todos: todos || [] };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `todo-backup-${Utils.today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  async importJSON(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      if (!data.todos || !Array.isArray(data.todos)) return 0;
      let imported = 0;
      for (const t of data.todos) {
        if (t.messageId) continue; // bỏ task whatsapp — đã có trong DB
        try {
          await this.create({
            text: t.text,
            priority: t.priority,
            category: t.category,
            dueDate: t.dueDate || null,
            dueTime: t.dueTime || null,
          });
          imported++;
        } catch (_) { /* skip lỗi từng item */ }
      }
      return imported;
    } catch (e) {
      console.error('Import failed:', e);
      return -1;
    }
  },
};
