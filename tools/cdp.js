// 极简 CDP 客户端：连上应用页面，执行表达式 / 收集控制台报错
// 用法：node tools/cdp.js "<js 表达式>"  [--logs]
const http = require('http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function connect(port = 9472) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有 page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = (e) => j(new Error('ws error')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else {
      listeners.forEach((fn) => fn(msg));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, send, on: (fn) => listeners.push(fn), page };
}

async function evaluate(cdp, expression, { awaitPromise = true } = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const t = r.exceptionDetails;
    throw new Error((t.exception && (t.exception.description || t.exception.value)) || t.text);
  }
  return r.result.value;
}

module.exports = { connect, evaluate, getJson };

if (require.main === module) {
  (async () => {
    const expr = process.argv[2];
    const cdp = await connect();
    const logs = [];
    cdp.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled') {
        logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        logs.push('[exception] ' + (d.exception?.description || d.text));
      }
      if (m.method === 'Log.entryAdded') {
        logs.push(`[${m.params.entry.level}] ${m.params.entry.text}`);
      }
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    try {
      const v = await evaluate(cdp, expr);
      console.log(JSON.stringify(v, null, 2));
    } catch (e) {
      console.log('EVAL-ERR:', e.message);
    }
    await new Promise((r) => setTimeout(r, 400));
    if (logs.length) console.log('--- 控制台 ---\n' + logs.join('\n'));
    cdp.ws.close();
    process.exit(0);
  })();
}
