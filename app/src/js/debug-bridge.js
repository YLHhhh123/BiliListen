// ===== debug-bridge.js：给自动化测试用的调试句柄 =====
// 生产环境无副作用：只是把内部模块挂到 window，方便 CDP 断言。
// 只在 --dev 或 --remote-debugging-port 存在时挂载。

import { store } from './store.js';
import { getAudio } from './player.js';

/** 自动化测试一律静音：URL 带 ?mute=1 或 --mute-audio 参数时强制 volume=0 */
function shouldMute() {
  return /[?&]mute=1/.test(location.search) || navigator.userAgent.includes('BiliListenTest');
}

export function installDebugBridge() {
  const a = getAudio();
  const forceMute = shouldMute();
  if (forceMute) {
    a.muted = true;
    a.volume = 0;
  }
  window.__bili = {
    store,
    muted: forceMute,
    get audio() {
      return a;
    },
    /** 拿播放器当前真实状态（audio 元素不在 DOM 里，测试直接查 querySelector 会拿不到） */
    state() {
      const s = store.get();
      return {
        playing: s.playing,
        isPlaying: s.isPlaying,
        queue: s.queue,
        currentIndex: s.currentIndex,
        volume: a.volume,
        muted: a.muted,
        rate: a.playbackRate,
        paused: a.paused,
        src: a.src,
        duration: a.duration,
        currentTime: a.currentTime,
        lyrics: s.lyrics?.length || 0,
        theme: s.theme,
      };
    },
  };
}
