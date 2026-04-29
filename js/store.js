/* ============================================
   Store — Premium Todo App (localStorage)
   ============================================ */

const Store = {
  STORAGE_KEY: 'todo-app-data',
  THEME_KEY: 'todo-app-theme',

  /**
   * Default app state
   */
  defaultState() {
    return {
      todos: [],
      filter: 'all',
      searchQuery: '',
    };
  },

  /**
   * Load state from localStorage
   */
  load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return { ...this.defaultState(), ...parsed };
      }
    } catch (e) {
      console.warn('Failed to load state:', e);
    }
    return this.defaultState();
  },

  /**
   * Save state to localStorage
   */
  save(state) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
        todos: state.todos,
        filter: state.filter,
      }));
    } catch (e) {
      console.warn('Failed to save state:', e);
    }
  },

  /**
   * Load theme preference
   */
  loadTheme() {
    try {
      return localStorage.getItem(this.THEME_KEY) || 'dark';
    } catch (e) {
      return 'dark';
    }
  },

  /**
   * Save theme preference
   */
  saveTheme(theme) {
    try {
      localStorage.setItem(this.THEME_KEY, theme);
    } catch (e) {
      console.warn('Failed to save theme:', e);
    }
  },

  /* ===== CRUD Operations ===== */

  /**
   * Add a new todo
   */
  addTodo(state, { text, priority, dueDate, dueTime, category, source, chatId, messageId, assignees }) {
    const todo = {
      id: Utils.uuid(),
      text: text.trim(),
      completed: false,
      priority: priority || 'medium',
      dueDate: dueDate || null,
      category: category || 'personal',
      createdAt: new Date().toISOString(),
      order: state.todos.length,
    };
    if (dueTime) todo.dueTime = dueTime;
    if (source) todo.source = source;
    if (chatId) todo.chatId = chatId;
    if (messageId) todo.messageId = messageId;
    if (Array.isArray(assignees) && assignees.length) todo.assignees = assignees;
    state.todos.unshift(todo);
    this.save(state);
    return todo;
  },

  /**
   * Toggle todo completion
   */
  toggleTodo(state, id) {
    const todo = state.todos.find(t => t.id === id);
    if (todo) {
      todo.completed = !todo.completed;
      this.save(state);
    }
    return todo;
  },

  /**
   * Update todo text
   */
  updateTodo(state, id, newText) {
    const todo = state.todos.find(t => t.id === id);
    if (todo && newText.trim()) {
      todo.text = newText.trim();
      this.save(state);
    }
    return todo;
  },

  /**
   * Delete a single todo
   */
  deleteTodo(state, id) {
    state.todos = state.todos.filter(t => t.id !== id);
    this.save(state);
  },

  /**
   * Clear all completed todos
   */
  clearCompleted(state) {
    state.todos = state.todos.filter(t => !t.completed);
    this.save(state);
  },

  /**
   * Reorder todos (drag & drop)
   */
  reorder(state, fromId, toId) {
    const fromIndex = state.todos.findIndex(t => t.id === fromId);
    const toIndex = state.todos.findIndex(t => t.id === toId);
    if (fromIndex === -1 || toIndex === -1) return;

    const [moved] = state.todos.splice(fromIndex, 1);
    state.todos.splice(toIndex, 0, moved);

    // Update order numbers
    state.todos.forEach((t, i) => t.order = i);
    this.save(state);
  },

  /* ===== Filtered Views ===== */

  /**
   * Get filtered and searched todos
   */
  getFilteredTodos(state) {
    let list = [...state.todos];

    // Filter by status
    if (state.filter === 'active') {
      list = list.filter(t => !t.completed);
    } else if (state.filter === 'completed') {
      list = list.filter(t => t.completed);
    }

    // Filter by search
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      list = list.filter(t =>
        t.text.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      );
    }

    return list;
  },

  /**
   * Count active (not completed) todos
   */
  activeCount(state) {
    return state.todos.filter(t => !t.completed).length;
  },

  /* ===== Export / Import ===== */

  /**
   * Export todos as JSON
   */
  exportJSON(state) {
    const data = {
      exportedAt: new Date().toISOString(),
      todos: state.todos,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `todo-backup-${Utils.today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  /**
   * Import todos from JSON
   */
  importJSON(state, jsonString) {
    try {
      const data = JSON.parse(jsonString);
      if (data.todos && Array.isArray(data.todos)) {
        // Merge: add imported tasks that don't already exist
        const existingIds = new Set(state.todos.map(t => t.id));
        const newTodos = data.todos.filter(t => !existingIds.has(t.id));
        state.todos = [...newTodos, ...state.todos];
        this.save(state);
        return newTodos.length;
      }
      return 0;
    } catch (e) {
      console.error('Import failed:', e);
      return -1;
    }
  },

  /* ===== Statistics ===== */

  /**
   * Get statistics
   */
  getStats(state) {
    const total = state.todos.length;
    const completed = state.todos.filter(t => t.completed).length;
    const active = total - completed;
    const overdue = state.todos.filter(t => !t.completed && Utils.isOverdue(t.dueDate)).length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    const byPriority = { high: 0, medium: 0, low: 0 };
    state.todos.forEach(t => {
      if (byPriority[t.priority] !== undefined) byPriority[t.priority]++;
    });

    return { total, completed, active, overdue, completionRate, byPriority };
  },
};
