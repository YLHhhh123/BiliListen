'use strict';
/**
 * 自签名代码签名证书生成脚本
 *
 * 为什么自签：商业 OV/EV 证书要花钱（OV 约 1000-3000 元/年）；自签名免费，
 * 能给安装包和 exe 挂上真实的签名者信息（不再「unsigned」），并让导入过
 * 本证书的机器完全信任。局限要说清楚：陌生机器上的 SmartScreen
 * 「未知发布者」提示靠的是 CA 信誉链，自签消除不了 —— 想全绿只能买商业证书。
 *
 * 生成一次，长期复用：
 *   - PFX 固定在 certs\codesign.pfx（私钥，.gitignore 已排除，绝不进仓库）
 *   - 密码存 certs\codesign.pass.txt
 *   - 打包脚本检测到 PFX 就自动签名，没有就跳过（不影响未配置的环境）
 *   - 加 RFC3161 时间戳：证书过期后，已签好的文件依然验证有效
 *
 * 用法：node scripts\make-cert.js [发布者名称]
 *   发布者名称默认 "BiliListen"，会出现在 UAC/签名详情的「颁发给」里。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const certsDir = path.join(__dirname, '..', '..', 'certs');
const pfxPath = path.join(certsDir, 'codesign.pfx');
const passPath = path.join(certsDir, 'codesign.pass.txt');

const subject = process.argv[2] || 'BiliListen';
// 10 年有效期；自签证书本来就没有 CA 信誉积累，年限只是个参数
const notAfter = new Date();
notAfter.setFullYear(notAfter.getFullYear() + 10);
const pass = generatePass();

function generatePass() {
  // 24 位随机密码，纯字母数字（signtool 命令行传参不需要转义）
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = require('crypto').randomBytes(24);
  for (const b of buf) s += chars[b % chars.length];
  return s;
}

fs.mkdirSync(certsDir, { recursive: true });

if (fs.existsSync(pfxPath)) {
  console.log('[cert] 已存在 ' + pfxPath);
  console.log('[cert] 复用现有证书即可，如需重新生成请先手动删除。');
  process.exit(0);
}

console.log(`[cert] 生成自签名代码签名证书：CN=${subject}，有效期 10 年…`);

// New-SelfSignedCertificate 直接把私钥导出权限打开（-KeyExportPolicy Exportable），
// 一步生成 + 一步导出 PFX，不落中间 cer 文件。
// Type CodeSigningCert 模板生成的 EKU 是 Code Signing，signtool 认这个。
// 多行数组用 "; " 拼接成单行 —— PowerShell 换行才是语句分隔符，空格不是。
const ps = [
  '$ErrorActionPreference = "Stop";',
  // Cert:\CurrentUser\My 不需要管理员权限，普通用户就能建
  '$cert = New-SelfSignedCertificate -Subject "CN=' + subject + '"' +
    ' -Type CodeSigningCert' +
    ' -KeyAlgorithm RSA -KeyLength 3072' +
    ' -HashAlgorithm SHA256' +
    ' -NotAfter (Get-Date "' + notAfter.toISOString() + '")' +
    ' -KeyUsage DigitalSignature' +
    ' -KeyExportPolicy Exportable' +
    ' -CertStoreLocation "Cert:\\CurrentUser\\My";',
  "$pwdSecure = ConvertTo-SecureString -String '" + pass + "' -Force -AsPlainText;",
  'Export-PfxCertificate -Cert $cert -FilePath "' + pfxPath.replace(/'/g, "''") + '"',
    ' -Password $pwdSecure | Out-Null;',
  'Write-Output $cert.Thumbprint',
].join(' ');

let thumbprint;
try {
  // 优先 pwsh（PowerShell 7+）：部分机器的 Windows PowerShell 5.1 的 Cert:
  // PSDrive 会被污染的 PSModulePath 弄丢（"Cannot find drive Cert"），pwsh 没这毛病
  const shell = hasPwsh() ? 'pwsh' : 'powershell';
  thumbprint = execFileSync(shell, ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
} catch (e) {
  console.error('[cert] 生成失败：' + (e.stderr || e.message));
  process.exit(1);
}

function hasPwsh() {
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch { return false; }
}

fs.writeFileSync(passPath, pass, 'utf8');
console.log('[cert] 完成。');
console.log('[cert]   证书：' + pfxPath);
console.log('[cert]   指纹：' + thumbprint);
console.log('[cert]   密码：' + passPath + '（已写入，勿提交仓库）');
console.log('[cert] 之后 node scripts\\build.js 会自动用它签名。');
console.log('');
console.log('[cert] 想让本机（或朋友的机器）显示「发布者已验证」，把证书装进受信任区：');
console.log('[cert]   双击安装包 → 详细信息 → 查看证书 → 安装证书 → 「将所有的证书都放入下列存储」');
console.log('[cert]   → 浏览选「受信任的人员」→ 完成。之后本机 UAC 不再显示未知发布者。');
