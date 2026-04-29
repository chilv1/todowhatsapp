/* ============================================
   Drag & Drop — Premium Todo App
   ============================================ */

const DragDrop = {
  draggedId: null,

  init() {
    const list = UI.els.taskList;

    list.addEventListener('dragstart', e => {
      const item = e.target.closest('.task-item');
      if (!item) return;

      this.draggedId = item.dataset.id;
      item.classList.add('dragging');

      // Set drag image
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.draggedId);

      // Slight delay to show the visual change
      requestAnimationFrame(() => {
        item.style.opacity = '0.4';
      });
    });

    list.addEventListener('dragend', e => {
      const item = e.target.closest('.task-item');
      if (!item) return;

      item.classList.remove('dragging');
      item.style.opacity = '';
      this.draggedId = null;

      // Remove all drag-over states
      list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    list.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const item = e.target.closest('.task-item');
      if (!item || item.dataset.id === this.draggedId) return;

      // Remove drag-over from others
      list.querySelectorAll('.drag-over').forEach(el => {
        if (el !== item) el.classList.remove('drag-over');
      });

      item.classList.add('drag-over');
    });

    list.addEventListener('dragleave', e => {
      const item = e.target.closest('.task-item');
      if (item) item.classList.remove('drag-over');
    });

    list.addEventListener('drop', e => {
      e.preventDefault();
      const targetItem = e.target.closest('.task-item');
      if (!targetItem || !this.draggedId) return;

      targetItem.classList.remove('drag-over');

      const targetId = targetItem.dataset.id;
      if (this.draggedId !== targetId) {
        App.onReorder(this.draggedId, targetId);
        UI.toast('Task reordered');
      }
    });
  },
};
