// GitHub API push: blobs -> tree -> commit -> ref（绕过 flaky git 通道）
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = fs.readFileSync('C:/Users/35453/Downloads/ghp.txt', 'utf8').trim();
const REPO = 'wxzjss/orb-duel';
const ROOT = 'C:/Users/35453/WorkBuddy/2026-10-14-19-05-29';

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${REPO}/${apiPath}`, method,
      headers: {
        'Authorization': `token ${TOKEN}`,
        'User-Agent': 'orb-duel-push',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 300) return reject(new Error(`${res.statusCode} ${buf.slice(0, 300)}`));
        resolve(buf ? JSON.parse(buf) : {});
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // 1. 取远端当前 head（作为 parent）
  const branch = await api('GET', 'branches/main');
  const parentSha = branch.commit.sha;
  const baseTree = branch.commit.commit.tree.sha;
  console.log('parent:', parentSha);

  // 2. 文件清单从 _filelist.txt 读取（避免 child_process）
  const files = fs.readFileSync(path.join(ROOT, 'tests', '_filelist.txt'), 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean);
  console.log('files:', files.length);

  // 3. 逐个建 blob（带并发与重试）
  const tree = [];
  for (const f of files) {
    const abs = path.join(ROOT, f);
    const content = fs.readFileSync(abs);
    let sha = null, tries = 0;
    while (!sha) {
      try {
        const r = await api('POST', 'git/blobs', { content: content.toString('base64'), encoding: 'base64' });
        sha = r.sha;
      } catch (e) { tries++; if (tries > 4) throw new Error(`blob fail ${f}: ${e.message}`); await new Promise(r => setTimeout(r, 1500)); }
    }
    tree.push({ path: f.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha });
    process.stdout.write(`blob ${f} ok\n`);
  }

  // 4. 建树
  const treeRes = await api('POST', 'git/trees', { base_tree: baseTree, tree });
  console.log('tree:', treeRes.sha);

  // 5. 提交
  const commit = await api('POST', 'git/commits', {
    message: 'v3.0: OrbAI 控制台接口 + 手机适配 + TITLE 触屏修复 + 残影特效 + 无限关卡链',
    tree: treeRes.sha, parents: [parentSha],
  });
  console.log('commit:', commit.sha);

  // 6. 更新 main（预期 fast-forward；非 fast-forward 则重跑整个脚本基于新 head）
  await api('PATCH', 'git/refs/heads/main', { sha: commit.sha, force: false });
  console.log('PUSHED via API');
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
