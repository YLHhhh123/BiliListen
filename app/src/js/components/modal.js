// ===== modal.js：通用弹层 =====

import { el } from '../utils.js';

let current = null;

/**
 * 打开 modal
 * opts: { title, body: HTMLElement | string, footer: HTMLElement | array, onClose }
 */
export function openModal(opts) {
  closeModal();
  const mask = el('div', { class: 'modal-mask' });
  const modal = el('div', { class: 'modal' });

  const header = el('div', { class: 'modal-header' }, [
    el('h3', {}, opts.title || ''),
    el('div', {
      class: 'modal-close',
      onclick: closeModal,
      innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.3 5.71L12 12.01l-6.3-6.3-1.42 1.42L10.59 13.4l-6.3 6.3 1.42 1.42 6.3-6.3 6.3 6.3 1.41-1.42-6.3-6.29 6.3-6.3z"/></svg>',
    }),
  ]);
  const body = el('div', { class: 'modal-body' });
  if (typeof opts.body === 'string') body.textContent = opts.body;
  else if (opts.body) body.appendChild(opts.body);

  const footer = el('div', { class: 'modal-footer' });
  if (opts.footer) {
    const kids = Array.isArray(opts.footer) ? opts.footer : [opts.footer];
    kids.forEach((k) => footer.appendChild(k));
  }

  modal.append(header, body, footer);
  mask.appendChild(modal);
  document.getElementById('modal-root').appendChild(mask);
  current = { mask, onClose: opts.onClose };

  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeModal();
  });
}

export function closeModal() {
  if (!current) return;
  current.mask.remove();
  if (current.onClose) { try { current.onClose(); } catch {} }
  current = null;
}
