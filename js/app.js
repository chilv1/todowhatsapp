/* ============================================
   App — Premium Todo App (Main Controller)
   ============================================ */

const App = {
  state: null,
  theme: 'dark',

  /* ===== Initialize ===== */
  init() {
    // Load state
    this.state = Store.load();
    this.theme = Store.loadTheme();

    // Init UI
    UI.init();
    UI.setTheme(this.theme);

    // Init drag & drop
    DragDrop.init();

    // Bind events
    this.bindEvents();

    // Initial render
    this.render();

    // Set minimum date to today for due date input
    UI.els.dueDate.min = Utils.today();

    // Focus input
    UI.els.taskInput.focus();

    // Sync WhatsApp Tasks
    this.syncWhatsAppTasks();

    console.log('✅ Todo App initialized');
  },

  /* ===== Bind All Events ===== */
  bindEvents() {
    // Add task
    UI.els.btnAdd.addEventListener('click', () => this.addTask());
    UI.els.taskInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.addTask();
    });

    // Task list actions (event delegation)
    UI.els.taskList.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      const id = btn.dataset.id;

      switch (action) {
        case 'toggle':
          this.toggleTask(id);
          break;
        case 'delete':
          this.deleteTask(id, btn.closest('.task-item'));
          break;
        case 'edit':
          this.editTask(id, btn.closest('.task-item'));
          break;
      }
    });

    // Filter tabs
    UI.els.filterTabs.addEventListener('click', e => {
      const tab = e.target.closest('.filter-tab');
      if (!tab) return;
      this.state.filter = tab.dataset.filter;
      Store.save(this.state);
      this.render();
    });

    // Search
    UI.els.searchInput.addEventListener('input', Utils.debounce(e => {
      this.state.searchQuery = e.target.value;
      this.render();
    }, 200));

    // Clear completed
    UI.els.btnClear.addEventListener('click', () => {
      const count = this.state.todos.filter(t => t.completed).length;
      if (count === 0) {
        UI.toast('No completed tasks to clear');
        return;
      }
      Store.clearCompleted(this.state);
      this.render();
      UI.toast(`Cleared ${count} completed task${count > 1 ? 's' : ''}`);
    });

    // Theme toggle
    UI.els.btnTheme.addEventListener('click', () => this.toggleTheme());

    // Stats
    UI.els.btnStats.addEventListener('click', () => {
      const stats = Store.getStats(this.state);
      UI.openStats(stats);
    });
    UI.els.btnCloseStats.addEventListener('click', () => UI.closeStats());
    UI.els.modalStats.addEventListener('click', e => {
      if (e.target === UI.els.modalStats) UI.closeStats();
    });

    // Export
    UI.els.btnExport.addEventListener('click', () => {
      if (this.state.todos.length === 0) {
        UI.toast('No tasks to export');
        return;
      }
      Store.exportJSON(this.state);
      UI.toast('Tasks exported successfully!');
    });

    // Import
    UI.els.btnImport.addEventListener('click', () => UI.els.importFile.click());
    UI.els.importFile.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = ev => {
        const count = Store.importJSON(this.state, ev.target.result);
        if (count > 0) {
          this.render();
          UI.toast(`Imported ${count} new task${count > 1 ? 's' : ''}`);
        } else if (count === 0) {
          UI.toast('No new tasks to import');
        } else {
          UI.toast('Invalid file format');
        }
      };
      reader.readAsText(file);
      e.target.value = ''; // Reset file input
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      // Don't capture when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
      }

      switch (e.key) {
        case 'n':
        case 'N':
          e.preventDefault();
          UI.els.taskInput.focus();
          break;
        case '/':
          e.preventDefault();
          UI.els.searchInput.focus();
          break;
        case '1':
          this.state.filter = 'all';
          Store.save(this.state);
          this.render();
          break;
        case '2':
          this.state.filter = 'active';
          Store.save(this.state);
          this.render();
          break;
        case '3':
          this.state.filter = 'completed';
          Store.save(this.state);
          this.render();
          break;
        case 't':
        case 'T':
          this.toggleTheme();
          break;
        case '?':
          UI.toast('N: New task  /: Search  1-3: Filter  T: Theme');
          break;
        case 'Escape':
          UI.closeStats();
          break;
      }
    });
  },

  /* ===== Sync WhatsApp Tasks ===== */
  syncWhatsAppTasks() {
    setInterval(async () => {
      try {
        const response = await fetch('http://localhost:3000/api/tasks');
        if (!response.ok) return;
        const data = await response.json();
        
        if (data.tasks && data.tasks.length > 0) {
          // Dedupe: bỏ qua task đã có (theo messageId) HOẶC user từng xóa
          const existing = new Set(this.state.todos.map(t => t.messageId).filter(Boolean));
          const dismissed = new Set(this.state.dismissedMessageIds || []);
          const fresh = data.tasks.filter(t => t.messageId && !existing.has(t.messageId) && !dismissed.has(t.messageId));
          console.log(`[whatsapp-sync] backend=${data.tasks.length}, existing=${existing.size}, dismissed=${dismissed.size}, fresh=${fresh.length}`);
          if (fresh.length === 0) return;
          fresh.forEach(task => {
            // Nếu tin nhắn có deadline → dùng nó; còn không, mặc định dueDate = hôm nay
            let dueDate = Utils.today();
            let dueTime = null;
            if (task.dueAt) {
              const d = new Date(task.dueAt);
              dueDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
              if (task.hasTime) {
                dueTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
              }
            }
            Store.addTodo(this.state, {
              text: task.text,
              category: 'work',
              priority: 'medium',
              dueDate,
              dueTime,
              source: task.source,
              chatId: task.chatId,
              messageId: task.messageId,
              assignees: task.assignees,
            });
          });
          this.render();
          if (window.UI && UI.toast) {
            UI.toast(`Đã thêm ${fresh.length} công việc từ WhatsApp! 📱`);
          }
        }
      } catch (e) {
        // Backend might be offline, silently ignore
      }
    }, 5000); // Poll every 5 seconds
  },

  /* ===== Add Task ===== */
  addTask() {
    const text = UI.els.taskInput.value.trim();

    if (!text) {
      UI.shakeInput();
      return;
    }

    const todo = Store.addTodo(this.state, {
      text,
      priority: UI.els.prioritySelect.value,
      dueDate: UI.els.dueDate.value || null,
      category: UI.els.categorySelect.value,
    });

    UI.resetForm();
    this.render();
    UI.toast('Task added ✨');
  },

  /* ===== Toggle Task ===== */
  toggleTask(id) {
    const todo = Store.toggleTodo(this.state, id);
    if (!todo) return;

    // Add celebration class
    const taskItem = UI.els.taskList.querySelector(`[data-id="${id}"]`);
    if (taskItem && todo.completed) {
      taskItem.classList.add('just-completed');
      setTimeout(() => taskItem.classList.remove('just-completed'), 500);
    }

    // Notify originating WhatsApp group on first completion
    if (todo.completed && todo.source === 'whatsapp' && todo.chatId && todo.messageId && !todo.notifiedAt) {
      fetch('http://localhost:3000/api/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: todo.chatId,
          messageId: todo.messageId,
          text: todo.text,
          assignees: todo.assignees || [],
        }),
      }).then(r => {
        if (r.ok) {
          todo.notifiedAt = new Date().toISOString();
          Store.save(this.state);
          UI.toast('Đã thông báo nhóm WhatsApp ✅');
        }
      }).catch(() => { /* backend offline — silently skip */ });
    }

    this.render();
  },

  /* ===== Delete Task ===== */
  deleteTask(id, taskItem) {
    if (!taskItem) return;

    // Animate out first
    taskItem.classList.add('removing');
    taskItem.addEventListener('animationend', () => {
      Store.deleteTodo(this.state, id);
      this.render();
      UI.toast('Task deleted');
    });
  },

  /* ===== Edit Task ===== */
  editTask(id, taskItem) {
    const todo = this.state.todos.find(t => t.id === id);
    if (!todo || !taskItem) return;
    UI.startEdit(taskItem, todo);
  },

  /* ===== Toggle Theme ===== */
  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    Store.saveTheme(this.theme);
    UI.setTheme(this.theme);
    UI.toast(`${this.theme === 'dark' ? '🌙' : '☀️'} ${this.theme.charAt(0).toUpperCase() + this.theme.slice(1)} mode`);
  },

  /* ===== Render Everything ===== */
  render() {
    const filtered = Store.getFilteredTodos(this.state);
    UI.renderTasks(filtered);
    UI.updateCount(Store.activeCount(this.state));
    UI.setActiveFilter(this.state.filter);
  },
};

/* ===== Start the App ===== */
document.addEventListener('DOMContentLoaded', () => App.init());
