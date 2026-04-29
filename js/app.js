/* ============================================
   App — Main Controller (Phase 3: API-backed)
   ============================================ */

const App = {
  state: { todos: [], filter: 'all', searchQuery: '' },
  theme: 'dark',
  editing: false,           // pause polling khi đang inline edit
  refreshIntervalMs: 5000,

  async init() {
    const prefs = Store.loadPrefs();
    this.state.filter = prefs.filter || 'all';
    this.state.searchQuery = '';
    this.theme = Store.loadTheme();

    UI.init();
    UI.setTheme(this.theme);
    DragDrop.init();
    this.bindEvents();

    UI.els.dueDate.min = Utils.today();
    UI.els.taskInput.focus();

    // Migration một lần: localStorage → backend
    try {
      const n = await Store.migrateLegacyIfAny();
      if (n > 0) UI.toast(`Đã chuyển ${n} task từ trình duyệt lên server.`);
    } catch (_) { /* ignore */ }

    // Lần đầu render từ server
    await this.refresh();

    // Polling đồng bộ task (bao gồm task mới từ WhatsApp)
    setInterval(() => {
      if (!this.editing) this.refresh().catch(() => {});
    }, this.refreshIntervalMs);

    console.log('✅ Todo App initialized (API mode)');
  },

  async refresh() {
    try {
      const todos = await Store.fetchAll();
      this.state.todos = todos;
      this.render();
    } catch (e) {
      console.warn('refresh failed:', e.message);
    }
  },

  /* ===== Bind All Events ===== */
  bindEvents() {
    UI.els.btnAdd.addEventListener('click', () => this.addTask());
    UI.els.taskInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.addTask();
    });

    UI.els.taskList.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      switch (action) {
        case 'toggle': this.toggleTask(id); break;
        case 'delete': this.deleteTask(id, btn.closest('.task-item')); break;
        case 'edit':   this.editTask(id, btn.closest('.task-item')); break;
      }
    });

    UI.els.filterTabs.addEventListener('click', e => {
      const tab = e.target.closest('.filter-tab');
      if (!tab) return;
      this.state.filter = tab.dataset.filter;
      Store.savePrefs({ filter: this.state.filter });
      this.render();
    });

    UI.els.searchInput.addEventListener('input', Utils.debounce(e => {
      this.state.searchQuery = e.target.value;
      this.render();
    }, 200));

    UI.els.btnClear.addEventListener('click', () => this.clearCompleted());
    UI.els.btnTheme.addEventListener('click', () => this.toggleTheme());

    UI.els.btnStats.addEventListener('click', () => {
      UI.openStats(Store.getStats(this.state.todos));
    });
    UI.els.btnCloseStats.addEventListener('click', () => UI.closeStats());
    UI.els.modalStats.addEventListener('click', e => {
      if (e.target === UI.els.modalStats) UI.closeStats();
    });

    UI.els.btnExport.addEventListener('click', () => {
      if (this.state.todos.length === 0) { UI.toast('No tasks to export'); return; }
      Store.exportJSON(this.state.todos);
      UI.toast('Tasks exported successfully!');
    });

    UI.els.btnImport.addEventListener('click', () => UI.els.importFile.click());
    UI.els.importFile.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async ev => {
        const count = await Store.importJSON(ev.target.result);
        if (count > 0) {
          await this.refresh();
          UI.toast(`Imported ${count} new task${count > 1 ? 's' : ''}`);
        } else if (count === 0) {
          UI.toast('No new tasks to import');
        } else {
          UI.toast('Invalid file format');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    document.addEventListener('keydown', e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      switch (e.key) {
        case 'n': case 'N': e.preventDefault(); UI.els.taskInput.focus(); break;
        case '/': e.preventDefault(); UI.els.searchInput.focus(); break;
        case '1': this.state.filter = 'all'; Store.savePrefs({ filter: 'all' }); this.render(); break;
        case '2': this.state.filter = 'active'; Store.savePrefs({ filter: 'active' }); this.render(); break;
        case '3': this.state.filter = 'completed'; Store.savePrefs({ filter: 'completed' }); this.render(); break;
        case 't': case 'T': this.toggleTheme(); break;
        case '?': UI.toast('N: New task  /: Search  1-3: Filter  T: Theme'); break;
        case 'Escape': UI.closeStats(); break;
      }
    });
  },

  /* ===== Actions ===== */

  async addTask() {
    const text = UI.els.taskInput.value.trim();
    if (!text) { UI.shakeInput(); return; }
    try {
      const created = await Store.create({
        text,
        priority: UI.els.prioritySelect.value,
        category: UI.els.categorySelect.value,
        dueDate: UI.els.dueDate.value || null,
      });
      // Optimistic prepend để khỏi flicker chờ refresh
      this.state.todos = [created, ...this.state.todos];
      UI.resetForm();
      this.render();
      UI.toast('Task added ✨');
    } catch (e) {
      UI.toast('Lỗi: ' + e.message);
    }
  },

  async toggleTask(id) {
    const todo = this.state.todos.find(t => t.id === id);
    if (!todo) return;
    const target = !todo.completed;

    try {
      let updated;
      if (target && todo.source === 'whatsapp' && todo.chatId && todo.messageId) {
        await Store.complete(id);
        UI.toast('Đã thông báo nhóm WhatsApp ✅');
        updated = await this._getById(id);
      } else {
        updated = await Store.update(id, { completed: target });
      }
      // Cập nhật cache + animate
      this.state.todos = this.state.todos.map(t => t.id === id ? updated : t);
      const el = UI.els.taskList.querySelector(`[data-id="${id}"]`);
      if (el && updated.completed) {
        el.classList.add('just-completed');
        setTimeout(() => el.classList.remove('just-completed'), 500);
      }
      this.render();
    } catch (e) {
      UI.toast('Lỗi: ' + e.message);
    }
  },

  async _getById(id) {
    // Lấy lại 1 task sau action (avoid full refresh)
    try { return await Store._request(`/api/todos/${encodeURIComponent(id)}`); }
    catch (_) { return null; }
  },

  deleteTask(id, taskItem) {
    if (!taskItem) {
      Store.remove(id).then(() => this.refresh()).catch(e => UI.toast('Lỗi: ' + e.message));
      return;
    }
    taskItem.classList.add('removing');
    taskItem.addEventListener('animationend', async () => {
      try {
        await Store.remove(id);
        this.state.todos = this.state.todos.filter(t => t.id !== id);
        this.render();
        UI.toast('Task deleted');
      } catch (e) {
        UI.toast('Lỗi: ' + e.message);
        await this.refresh();
      }
    }, { once: true });
  },

  editTask(id, taskItem) {
    const todo = this.state.todos.find(t => t.id === id);
    if (!todo || !taskItem) return;
    this.editing = true;
    UI.startEdit(taskItem, todo, async (newText) => {
      try {
        const updated = await Store.update(id, { text: newText });
        this.state.todos = this.state.todos.map(t => t.id === id ? updated : t);
      } catch (e) {
        UI.toast('Lỗi: ' + e.message);
      } finally {
        this.editing = false;
        this.render();
      }
    }, () => {
      this.editing = false;
      this.render();
    });
  },

  async clearCompleted() {
    const count = this.state.todos.filter(t => t.completed).length;
    if (count === 0) { UI.toast('No completed tasks to clear'); return; }
    try {
      const r = await Store.clearCompleted();
      const removed = (r && r.removed) || count;
      this.state.todos = this.state.todos.filter(t => !t.completed);
      this.render();
      UI.toast(`Cleared ${removed} completed task${removed > 1 ? 's' : ''}`);
    } catch (e) {
      UI.toast('Lỗi: ' + e.message);
    }
  },

  async onReorder(fromId, toId) {
    const ids = this.state.todos.map(t => t.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, fromId);
    // Optimistic local reorder
    const map = new Map(this.state.todos.map(t => [t.id, t]));
    this.state.todos = ids.map(id => map.get(id)).filter(Boolean);
    this.render();
    try {
      await Store.reorder(ids);
    } catch (e) {
      UI.toast('Reorder failed: ' + e.message);
      await this.refresh();
    }
  },

  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    Store.saveTheme(this.theme);
    UI.setTheme(this.theme);
    UI.toast(`${this.theme === 'dark' ? '🌙' : '☀️'} ${this.theme.charAt(0).toUpperCase() + this.theme.slice(1)} mode`);
  },

  render() {
    const filtered = Store.getFilteredTodos(this.state.todos, {
      filter: this.state.filter,
      searchQuery: this.state.searchQuery,
    });
    UI.renderTasks(filtered);
    UI.updateCount(Store.activeCount(this.state.todos));
    UI.setActiveFilter(this.state.filter);
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
