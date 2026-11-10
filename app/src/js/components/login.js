// ===== 登录弹层：三种方式 =====
// 1) 扫码登录（主推，TV 端接口，二维码画在应用里）
// 2) 网页登录（弹 B 站官方登录窗口，扫码/密码都行，登录后自动捞 Cookie）
// 3) 粘贴 Cookie（兜底）

import { bili } from '../api.js';
import { store } from '../store.js';
import { el } from '../utils.js';
import { toast } from './toast.js';
import { openModal, closeModal } from './modal.js';

let pollTimer = null;
let webLoginRunning = false;

/**
 * @param {{ onSuccess?: Function, title?: string, defaultTab?: 'qr'|'web'|'cookie' }} opts
 */
export function openLoginModal(opts = {}) {
  const { onSuccess, title = '登录 B 站', defaultTab = 'qr' } = opts;

  let tab = defaultTab;
  let authCode = null;

  // ---------- 容器 ----------
  const body = el('div', { class: 'login-body' });
  const tabsBar = el('div', { class: 'seg-tabs', style: { marginBottom: '16px' } });

  const TABS = [
    { key: 'qr', label: '扫码登录' },
    { key: 'web', label: '网页登录' },
    { key: 'cookie', label: 'Cookie' },
  ];

  function renderTabs() {
    tabsBar.innerHTML = '';
    TABS.forEach((t) => {
      tabsBar.appendChild(
        el('button', {
          class: 'seg-tab' + (tab === t.key ? ' active' : ''),
          text: t.label,
          onclick: () => {
            if (tab === t.key) return;
            tab = t.key;
            renderTabs();
            renderBody();
          },
        }),
      );
    });
  }

  function renderBody() {
    stopPoll();
    body.innerHTML = '';
    if (tab === 'qr') renderQr();
    else if (tab === 'web') renderWeb();
    else renderCookie();
  }

  // ---------- 扫码登录 ----------
  function renderQr() {
    const box = el('div', { class: 'qr-login' });
    const imgBox = el('div', { class: 'qr-img-box' });
    const qrImg = el('img', { class: 'qr-img', alt: '登录二维码' });
    const mask = el('div', { class: 'qr-mask' });
    const statusText = el('div', { class: 'qr-status', text: '正在获取二维码…' });
    imgBox.append(qrImg, mask);
    box.append(imgBox, statusText);

    body.appendChild(box);
    body.appendChild(
      el('div', { class: 'cookie-help', style: { marginTop: '14px' } }, [
        el('div', { text: '打开手机哔哩哔哩 App → 我的 → 扫一扫' }),
        el('div', { text: '扫码后在手机上点「确认登录」，这边会自动完成' }),
      ]),
    );

    const refresh = el('button', {
      class: 'btn ghost',
      text: '刷新二维码',
      style: { marginTop: '12px', width: '100%' },
      onclick: () => loadQr(),
    });
    body.appendChild(refresh);

    let expired = false;

    async function loadQr() {
      expired = false;
      mask.style.display = 'none';
      statusText.textContent = '正在获取二维码…';
      statusText.className = 'qr-status';
      qrImg.style.opacity = '0.3';
      try {
        const res = await bili.qrLoginCreate();
        if (!res.ok) {
          statusText.textContent = '获取二维码失败：' + (res.error || '');
          statusText.className = 'qr-status error';
          return;
        }
        authCode = res.data.authCode;
        qrImg.src = res.data.qrDataUrl;
        qrImg.style.opacity = '1';
        statusText.textContent = '等待扫码…';
        startPoll();
      } catch (e) {
        statusText.textContent = '获取二维码异常：' + e.message;
        statusText.className = 'qr-status error';
      }
    }

    function startPoll() {
      let ticks = 0;
      pollTimer = setInterval(async () => {
        ticks++;
        // 二维码 180 秒有效
        if (ticks > 90) {
          stopPoll();
          expired = true;
          mask.style.display = 'flex';
          mask.textContent = '二维码已过期，点击刷新';
          mask.onclick = () => { mask.style.display = 'none'; loadQr(); };
          return;
        }
        if (!authCode) return;
        try {
          const res = await bili.qrLoginPoll(authCode);
          if (!res.ok) return;
          const d = res.data;
          if (d.status === 'scanned') {
            statusText.textContent = '已扫码，请在手机上点「确认登录」';
            statusText.className = 'qr-status scanned';
          } else if (d.status === 'expired') {
            stopPoll();
            expired = true;
            mask.style.display = 'flex';
            mask.textContent = '二维码已过期，点击刷新';
            mask.onclick = () => { mask.style.display = 'none'; loadQr(); };
          } else if (d.status === 'success') {
            stopPoll();
            statusText.textContent = '登录成功！';
            statusText.className = 'qr-status success';
            const u = d.user || {};
            store.set({ user: u });
            toast.success(`欢迎回来，${u.uname || ''}`);
            setTimeout(() => {
              closeModal();
              onSuccess && onSuccess(u);
            }, 600);
          }
        } catch {
          // 忽略单次轮询失败
        }
      }, 2000);
    }

    loadQr();
  }

  // ---------- 网页登录 ----------
  function renderWeb() {
    const btn = el('button', {
      class: 'btn primary',
      text: '打开 B 站登录窗口',
      style: { width: '100%' },
      onclick: async () => {
        if (webLoginRunning) return;
        webLoginRunning = true;
        btn.disabled = true;
        btn.textContent = '等待登录…（在弹出窗口里扫码或输密码）';
        try {
          const res = await bili.webLogin();
          if (!res.ok) {
            toast.error(res.error || '登录失败');
            return;
          }
          if (res.data.cancelled) {
            if (res.data.reason !== '用户关闭了登录窗口') toast.info(res.data.reason || '已取消');
            return;
          }
          store.set({ user: res.data });
          toast.success(`欢迎回来，${res.data.uname || ''}`);
          closeModal();
          onSuccess && onSuccess(res.data);
        } finally {
          webLoginRunning = false;
          btn.disabled = false;
          btn.textContent = '打开 B 站登录窗口';
        }
      },
    });

    body.appendChild(btn);
    body.appendChild(
      el('div', { class: 'cookie-help', style: { marginTop: '14px' } }, [
        el('div', { text: '会弹出一个独立的 B 站官方登录页（和浏览器里一样）。' }),
        el('div', { text: '支持扫码、账号密码、短信、微信/微博/QQ。登录成功后自动读取 Cookie。' }),
      ]),
    );
  }

  // ---------- Cookie ----------
  function renderCookie() {
    const ta = el('textarea', {
      class: 'textarea',
      rows: 4,
      placeholder: '把浏览器 document.cookie 的整串粘贴到这里（含 SESSDATA=...）',
    });

    const btn = el('button', {
      class: 'btn',
      text: '用 Cookie 登录',
      style: { marginTop: '12px', width: '100%' },
      onclick: async () => {
        const raw = (ta.value || '').trim();
        if (!raw) {
          toast.error('请先粘贴 Cookie');
          return;
        }
        btn.disabled = true;
        btn.textContent = '验证中…';
        const res = await bili.login(raw);
        btn.disabled = false;
        btn.textContent = '用 Cookie 登录';
        if (!res.ok) {
          toast.error(res.error || '登录失败');
          return;
        }
        if (!res.data.isLogin) {
          toast.error('Cookie 无效或已过期');
          return;
        }
        store.set({ user: res.data });
        closeModal();
        toast.success(`欢迎回来，${res.data.uname || ''}`);
        onSuccess && onSuccess(res.data);
      },
    });

    body.append(ta, btn);
    body.appendChild(
      el('div', { class: 'cookie-help', style: { marginTop: '14px' } }, [
        el('div', { text: '浏览器打开 bilibili.com 登录 → F12 → Console → 输入 document.cookie → 复制整串' }),
      ]),
    );
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  renderTabs();
  renderBody();

  openModal({
    title,
    body: el('div', {}, [tabsBar, body]),
    footer: [],
    onClose: stopPoll,
  });
}
