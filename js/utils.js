/* ============ UTILS MODULE ============ */
const Utils = (() => {
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    if (d.getTime() === today.getTime()) return 'Today';
    if (d.getTime() === tomorrow.getTime()) return 'Tomorrow';
    if (d.getTime() === yesterday.getTime()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function isOverdue(dateStr, timeStr) {
    if (!dateStr) return false;
    // Nếu có giờ → chính xác đến phút; không thì lấy 23:59 (cuối ngày)
    const t = timeStr && /^\d{1,2}:\d{2}$/.test(timeStr) ? timeStr + ':00' : '23:59:59';
    const d = new Date(dateStr + 'T' + t);
    return d < new Date();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function debounce(fn, ms = 200) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function getTodayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  return {
    generateId, getTodayStr, formatDate, isOverdue, escapeHtml, debounce,
    uuid: generateId, today: getTodayStr,
  };
})();
