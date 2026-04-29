/* ============================================
   UI — Premium Todo App (DOM Rendering)
   ============================================ */

const UI = {
  /* ===== Cache DOM elements ===== */
  els: {},

  init() {
    this.els = {
      taskList: document.getElementById('task-list'),
      taskInput: document.getElementById('task-input'),
      btnAdd: document.getElementById('btn-add'),
      prioritySelect: document.getElementById('priority-select'),
      dueDate: document.getElementById('due-date'),
      categorySelect: document.getElementById('category-select'),
      searchInput: document.getElementById('search-input'),
      filterTabs: document.getElementById('filter-tabs'),
      taskCount: document.getElementById('task-count'),
      btnClear: document.getElementById('btn-clear'),
      btnExport: document.getElementById('btn-export'),
      btnImport: document.getElementById('btn-import'),
      importFile: document.getElementById('import-file'),
      btnTheme: document.getElementById('btn-theme'),
      btnStats: document.getElementById('btn-stats'),
      modalStats: document.getElementById('modal-stats'),
      btnCloseStats: document.getElementById('btn-close-stats'),
      emptyState: document.getElementById('empty-state'),
      toastContainer: document.getElementById('toast-container'),
      // Stats
      statTotal: document.getElementById('stat-total'),
      statCompleted: document.getElementById('stat-completed'),
      statActive: document.getElementById('stat-active'),
      statOverdue: document.getElementById('stat-overdue'),
      progressFill: document.getElementById('progress-fill'),
      progressText: document.getElementById('progress-text'),
      breakdownBars: document.getElementById('breakdown-bars'),
    };
  },

  /* ===== Render Task List ===== */
  renderTasks(todos) {
    const list = this.els.taskList;

    // If empty
    if (todos.length === 0) {
      list.innerHTML = '';
      this.els.emptyState.style.display = 'flex';
      return;
    }

    this.els.emptyState.style.display = 'none';
    list.innerHTML = todos.map(todo => this.taskHTML(todo)).join('');
  },

  /* ===== Single Task HTML ===== */
  taskHTML(todo) {
    const completed = todo.completed ? 'completed' : '';
    let dateStr = todo.dueDate ? Utils.formatDate(todo.dueDate) : '';
    if (dateStr && todo.dueTime) dateStr += ` ${todo.dueTime}`;
    const overdue = !todo.completed && Utils.isOverdue(todo.dueDate) ? 'overdue' : '';

    return `
      <li class="task-item ${completed}" 
          data-id="${todo.id}" 
          data-priority="${todo.priority}"
          draggable="true"
          role="listitem">
        <button class="task-checkbox" 
                aria-label="${todo.completed ? 'Mark incomplete' : 'Mark complete'}"
                data-action="toggle" data-id="${todo.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </button>
        <div class="task-content">
          <span class="task-text">${Utils.escapeHtml(todo.text)}</span>
          <div class="task-meta">
            <span class="task-badge badge-category cat-${todo.category}">${todo.category}</span>
            ${dateStr ? `<span class="task-badge badge-date ${overdue}">${dateStr}</span>` : ''}
            <span class="priority-dot p-${todo.priority}" title="${todo.priority} priority"></span>
            ${todo.assignees && todo.assignees.length ? todo.assignees.map(a => `<span class="assignee-chip" title="WhatsApp: ${Utils.escapeHtml(a.number || '')}">@${Utils.escapeHtml(a.name || a.number || '?')}</span>`).join('') : ''}
          </div>
        </div>
        <div class="task-actions">
          <button class="btn-task-action btn-task-edit" 
                  title="Edit" aria-label="Edit task"
                  data-action="edit" data-id="${todo.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="btn-task-action btn-task-delete" 
                  title="Delete" aria-label="Delete task"
                  data-action="delete" data-id="${todo.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </li>
    `;
  },

  /* ===== Update Footer Count ===== */
  updateCount(activeCount) {
    const s = activeCount === 1 ? '' : 's';
    this.els.taskCount.textContent = `${activeCount} item${s} left`;
  },

  /* ===== Update Filter Tab UI ===== */
  setActiveFilter(filter) {
    this.els.filterTabs.querySelectorAll('.filter-tab').forEach(tab => {
      const isActive = tab.dataset.filter === filter;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive);
    });
  },

  /* ===== Show Toast ===== */
  toast(message, duration = 5000) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    this.els.toastContainer.appendChild(el);

    let removed = false;
    const remove = () => { if (removed) return; removed = true; el.remove(); };

    setTimeout(() => {
      el.classList.add('removing');
      el.addEventListener('animationend', remove, { once: true });
      // fallback nếu animationend không fire (animation bị huỷ, tab nền…)
      setTimeout(remove, 500);
    }, duration);
  },

  /* ===== Inline Edit =====
     onCommit(newText) — async; gọi khi user xác nhận text mới
     onCancel() — gọi khi user hủy hoặc text không đổi (để App tắt cờ editing)
  */
  startEdit(taskItem, todo, onCommit, onCancel) {
    const textEl = taskItem.querySelector('.task-text');
    const original = todo.text;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-edit-input';
    input.value = original;

    textEl.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finishEdit = async () => {
      if (finished) return;
      finished = true;
      const newText = input.value.trim();
      if (newText && newText !== original) {
        try { await onCommit(newText); }
        catch (_) { if (typeof onCancel === 'function') onCancel(); }
      } else {
        if (typeof onCancel === 'function') onCancel();
      }
    };

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = original; input.blur(); }
    });
  },

  /* ===== Statistics Modal ===== */
  openStats(stats) {
    this.els.statTotal.textContent = stats.total;
    this.els.statCompleted.textContent = stats.completed;
    this.els.statActive.textContent = stats.active;
    this.els.statOverdue.textContent = stats.overdue;

    // Progress ring
    const circumference = 2 * Math.PI * 52; // r=52
    const offset = circumference - (stats.completionRate / 100) * circumference;
    this.els.progressFill.style.strokeDashoffset = offset;
    this.els.progressText.textContent = `${stats.completionRate}%`;

    // Breakdown bars
    const maxPriority = Math.max(stats.byPriority.high, stats.byPriority.medium, stats.byPriority.low, 1);
    this.els.breakdownBars.innerHTML = ['high', 'medium', 'low'].map(p => `
      <div class="breakdown-row">
        <span class="breakdown-label">${p}</span>
        <div class="breakdown-bar">
          <div class="breakdown-bar-fill fill-${p}" style="width: ${(stats.byPriority[p] / maxPriority) * 100}%"></div>
        </div>
        <span class="breakdown-count">${stats.byPriority[p]}</span>
      </div>
    `).join('');

    this.els.modalStats.classList.add('open');
    this.els.modalStats.setAttribute('aria-hidden', 'false');
  },

  closeStats() {
    this.els.modalStats.classList.remove('open');
    this.els.modalStats.setAttribute('aria-hidden', 'true');
  },

  /* ===== Theme ===== */
  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  },

  /* ===== Input shake animation ===== */
  shakeInput() {
    this.els.taskInput.classList.add('shake');
    setTimeout(() => this.els.taskInput.classList.remove('shake'), 500);
  },

  /* ===== Reset input form ===== */
  resetForm() {
    this.els.taskInput.value = '';
    this.els.prioritySelect.value = 'medium';
    this.els.dueDate.value = '';
    this.els.categorySelect.value = 'personal';
    this.els.taskInput.focus();
  },
};
