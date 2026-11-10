#!/usr/bin/env node
'use strict';
/**
 * 脱离控制台分离启动打包版 BiliListen（清 ELECTRON_RUN_AS_NODE）。
 * 用法：node scripts/launch-detached.js [debugPort]
 * 不带端口 = 正常启动（给用户日常用）
 */
const { spawn } = require('child_process');

const exe = 'E:\\rea\\bili-listen\\dist\\BiliListen-win32-x64\\BiliListen.exe';
const port = process.argv[2];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = port ? [`--remote-debugging-port=${port}`] : [];
const child = spawn(exe, args, { env, detached: true, stdio: 'ignore' });
child.unref();
console.log(`[launch] pid=${child.pid} port=${port || '(无调试端口)'}`);
