// GitHub API 增量推送：只上传 _changelist.txt 中列出的文件（base_tree 复用远端）
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
  const branch = await api('GET', 'branches/main');
  const parentSha = branch.commit.sha;
  const baseTree = branch.commit.commit.tree.sha;
  console.log('parent:', parentSha, 'msg:', branch.commit.commit.message.slice(0, 40));

  const list = fs.readFileSync(path.join(ROOT, 'tests', '_changelist.txt'), 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean);
  console.log('changed files:', list.length);

  const tree = [];
  for (const f of list) {
    const content = fs.readFileSync(path.join(ROOT, f));
    let sha = null, tries = 0;
    while (!sha) {
      try {
        const r = await api('POST', 'git/blobs', { content: content.toString('base64'), encoding: 'base64' });
        sha = r.sha;
      } catch (e) { tries++; if (tries > 5) throw new Error(`blob fail ${f}: ${e.message}`); await new Promise(r => setTimeout(r, 2000)); }
    }
    tree.push({ path: f.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha });
    console.log('blob ok:', f);
  }

  const treeRes = await api('POST', 'git/trees', { base_tree: baseTree, tree });
  const commit = await api('POST', 'git/commits', {
    message: 'v4.0 刀与锤：挥刀三段+重锤秒杀+命中矩阵+防御dormant+协议v2+FX加量变亮（362/362）',
    tree: treeRes.sha, parents: [parentSha],
  });
  await api('PATCH', 'git/refs/heads/main', { sha: commit.sha, force: false });
  console.log('PUSHED:', commit.sha);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
