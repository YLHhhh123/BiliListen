// ===== toast.js：轻提示 =====

let container = null;
function ensureContainer() {
  if (container) return container;
  container = document.getElementById('toast-root');
  return container;
}

export function toast(message, type = 'info', duration = 2200) {
  const root = ensureContainer();
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease, transform .25s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 260);
  }, duration);
}

toast.success = (m) => toast(m, 'success');
toast.error = (m) => toast(m, 'error', 3000);
toast.info = (m) => toast(m, 'info');
