// ===== 登录弹层：三种方式，全都不需要手机 =====
// 1) 扫码登录（有手机时最快；TV 端接口，二维码画在应用里）
// 2) 窗口登录（应用内独立分区窗口，可用「密码登录」，不需要扫码）
// 3) 粘贴 Cookie（已在电脑浏览器登录过 B 站时最省事，从 DevTools 复制 SESSDATA）

import { bili } from '../api.js';
import { store } from '../store.js';
import { el } from '../utils.js';
import { toast } from './toast.js';
import { openModal, closeModal } from './modal.js';

let pollTimer = null;
let browserLoginRunning = false;
let unbindCapture = null;

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
    { key: 'web', label: '窗口登录' },
    { key: 'cookie', label: '粘贴 Cookie' },
  ];

  function switchTab(key) {
    if (tab === key) return;
    tab = key;
    renderTabs();
    renderBody();
  }

  function renderTabs() {
    tabsBar.innerHTML = '';
    TABS.forEach((t) => {
      tabsBar.appendChild(
        el('button', {
          class: 'seg-tab' + (tab === t.key ? ' active' : ''),
          text: t.label,
          onclick: () => switchTab(t.key),
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

    // 没有手机的人不该被二维码堵在这里
    body.appendChild(
      el('div', { class: 'cookie-help alt', style: { marginTop: '8px' } }, [
        el('div', { text: '没有手机，或者手机不在身边？' }),
        el('div', {}, [
          el('span', { text: '切到' }),
          el('a', {
            class: 'link',
            text: ' 窗口登录 ',
            style: { cursor: 'pointer', color: 'var(--brand)' },
            onclick: () => switchTab('web'),
          }),
          el('span', { text: '用密码登录，或者' }),
          el('a', {
            class: 'link',
            text: ' 粘贴 Cookie ',
            style: { cursor: 'pointer', color: 'var(--brand)' },
            onclick: () => switchTab('cookie'),
          }),
          el('span', { text: '直接搬用电脑上已登录的状态 —— 这两条都不需要手机。' }),
        ]),
      ]),
    );

    const refresh = el('button', {
      class: 'btn ghost',
      text: '刷新二维码',
      style: { marginTop: '12px', width: '100%' },
      onclick: () => loadQr(),
    });
    body.appendChild(refresh);

    async function loadQr() {
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
          mask.style.display = 'flex';
          mask.textContent = '二维码已过期，点击刷新';
          mask.onclick = () => {
            mask.style.display = 'none';
            loadQr();
          };
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
            mask.style.display = 'flex';
            mask.textContent = '二维码已过期，点击刷新';
            mask.onclick = () => {
              mask.style.display = 'none';
              loadQr();
            };
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

  // ---------- 窗口登录（应用内独立分区，可用密码登录） ----------
  function renderWeb() {
    const btn = el('button', {
      class: 'btn primary',
      text: '打开登录窗口',
      style: { width: '100%' },
    });
    const status = el('div', {
      class: 'qr-status',
      style: { marginTop: '12px', lineHeight: '1.9', textAlign: 'left', whiteSpace: 'pre-line' },
      text: '',
    });

    btn.onclick = async () => {
      if (browserLoginRunning) return;
      browserLoginRunning = true;
      btn.disabled = true;
      btn.textContent = '正在打开…';
      try {
        const res = await bili.browserLogin();
        if (!res.ok) {
          toast.error(res.error || '启动失败');
          return;
        }
        btn.textContent = '等待登录完成…';
        status.textContent =
          '① 在弹出的窗口顶部选「密码登录」页签\n' +
          '② 填账号（邮箱 / 用户名 / 手机号都行）+ 密码 + 旁边图片里的验证码\n' +
          '③ 登录成功后窗口自动关闭，这边立刻同步到账号';
        bindCapture();
      } finally {
        browserLoginRunning = false;
        btn.disabled = false;
      }
    };

    body.append(btn, status);
    body.appendChild(
      el('div', { class: 'cookie-help', style: { marginTop: '14px' } }, [
        el('div', { text: '这个窗口是一个独立的浏览器分区，B 站的滑块、密码管理器、第三方登录都能正常用。' }),
        el('div', { text: '登录凭据只留在本机这个分区里，主进程读出后经官方接口校验才落盘，不经任何第三方。' }),
      ]),
    );
  }

  /** 订阅主进程「登录成功」推送（幂等） */
  function bindCapture() {
    if (unbindCapture) return;
    unbindCapture = bili.onLoginCaptured((u) => {
      if (unbindCapture) {
        unbindCapture();
        unbindCapture = null;
      }
      closeModal();
      onSuccess && onSuccess(u);
    });
  }

  // ---------- 粘贴 Cookie ----------
  function renderCookie() {
    const ta = el('textarea', {
      class: 'textarea',
      rows: 5,
      spellcheck: false,
      placeholder:
        '粘贴下面任意一种都可以：\n' +
        '· SESSDATA 的值（Application → Cookies 里 SESSDATA 那一行的 Value）\n' +
        '· 整行 Cookie（Network → Request Headers 里的 Cookie 整行）',
    });

    const errLine = el('div', {
      class: 'qr-status error hint-line',
      style: { display: 'none', textAlign: 'left', whiteSpace: 'pre-line', marginTop: '10px' },
    });

    const pasteBtn = el('button', { class: 'btn ghost', text: '从剪贴板粘贴', style: { flex: '1' } });
    const loginBtn = el('button', { class: 'btn primary', text: '登录', style: { flex: '2' } });
    const actions = el('div', { class: 'cookie-actions' }, [pasteBtn, loginBtn]);

    function showErr(msg) {
      errLine.textContent = msg;
      errLine.style.display = 'block';
    }
    function clearErr() {
      errLine.style.display = 'none';
      errLine.textContent = '';
    }

    pasteBtn.onclick = async () => {
      clearErr();
      const res = await bili.readClipboard();
      if (!res.ok) return showErr('读取剪贴板失败：' + (res.error || ''));
      const text = (res.data && res.data.text) || '';
      if (!text.trim()) return showErr('剪贴板是空的。先在浏览器里复制 SESSDATA，再回来点这里。');
      ta.value = text;
      ta.focus();
    };

    loginBtn.onclick = async () => {
      const raw = (ta.value || '').trim();
      if (!raw) return showErr('先粘贴 SESSDATA 或 Cookie');
      clearErr();
      loginBtn.disabled = true;
      loginBtn.textContent = '验证中…';
      try {
        const res = await bili.login(raw);
        if (!res.ok) return showErr(res.error || '登录失败');
        const u = res.data || {};
        store.set({ user: u });
        closeModal();
        toast.success(`欢迎回来，${u.uname || ''}`);
        onSuccess && onSuccess(u);
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = '登录';
      }
    };

    body.append(ta, actions, errLine);

    // ---- 说明书（默认收起，免得弹层一打开就被文字淹没） ----
    const steps = el('div', { class: 'cookie-steps', style: { display: 'none' } }, [
      el('div', { class: 'cookie-steps-title', text: '怎么拿到 SESSDATA' }),
      el('div', {
        class: 'cookie-steps-note',
        text: 'SESSDATA 是 HttpOnly —— 在控制台敲 document.cookie 是永远拿不到的，必须从开发者面板里复制。',
      }),
      el('ol', {}, [
        el('li', {}, [
          el('span', { text: '在浏览器打开 bilibili.com，确认右上角已经是你自己的头像（未登录状态要先登录）' }),
        ]),
        el('li', {}, [
          el('span', { text: '按 F12 打开开发者工具，切到顶部「' }),
          el('b', { text: 'Application（应用）' }),
          el('span', { text: '」' }),
        ]),
        el('li', {}, [
          el('span', { text: '左侧 Storage → Cookies → 点开 ' }),
          el('b', { text: 'https://www.bilibili.com' }),
        ]),
        el('li', {}, [
          el('span', { text: '在列表里找到 ' }),
          el('b', { text: 'SESSDATA' }),
          el('span', { text: ' 这一行 → 双击 Value → Ctrl+C' }),
        ]),
        el('li', {}, [el('span', { text: '回到这里点「从剪贴板粘贴」，再点「登录」' })]),
      ]),
      el('div', {
        class: 'cookie-steps-alt',
        text: '另一种取法（拿到的是整行，也能直接粘）：F12 → Network → 刷新页面 → 点任意一个请求 → Request Headers → 复制 Cookie 整行。',
      }),
      el('button', {
        class: 'btn ghost',
        text: '在浏览器打开 bilibili.com',
        style: { width: '100%', marginTop: '10px' },
        onclick: () => bili.openExternal('https://www.bilibili.com'),
      }),
    ]);

    const toggle = el('button', {
      class: 'btn ghost',
      text: '怎么拿到 SESSDATA？',
      style: { width: '100%', marginTop: '10px' },
      onclick: () => {
        const opened = steps.style.display !== 'none';
        steps.style.display = opened ? 'none' : 'block';
        toggle.textContent = opened ? '怎么拿到 SESSDATA？' : '收起说明';
      },
    });

    body.append(toggle, steps);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (unbindCapture) {
      unbindCapture();
      unbindCapture = null;
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
