/**
 * 拉取 Misskey 官方参照文件到 vendor/（官方源码不随本仓库分发）
 *
 * 用法：node tools/fetch-misskey-refs.mjs [ref]      # ref 默认 develop
 * 私有/fork 也可用环境变量 MISSKEY_REPO 指定仓库
 */
import fs from 'node:fs';

const REF = process.argv[2] ?? process.env.MISSKEY_REF ?? 'develop';
const REPO = process.env.MISSKEY_REPO ?? 'misskey-dev/misskey';
const OUT = new URL('../vendor/', import.meta.url);
const UA = 'misskey-theme-march7th-bloom';

const FILES = {
	'packages/frontend-shared/themes/_light.json5': '_light.json5',
	'packages/frontend-shared/themes/_dark.json5': '_dark.json5',
	'packages/frontend-shared/js/theme.ts': 'misskey-theme.ts',
};

/** raw 优先；被墙/失败时回落 GitHub API（公开仓库无需 token） */
async function fetchText(p) {
	try {
		const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${REF}/${p}`, { headers: { 'User-Agent': UA } });
		if (r.ok) return { text: await r.text(), via: 'raw' };
	} catch { /* 继续走 API */ }
	const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${p}?ref=${REF}`, {
		headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA },
	});
	if (!r.ok) throw new Error(`${p} 拉取失败：raw 与 API 均不可用（HTTP ${r.status}）`);
	const j = await r.json();
	return { text: Buffer.from(j.content, 'base64').toString('utf8'), via: 'api' };
}

/** 取 ref 对应的 commit sha，记进 vendor/ref.json 便于复现 */
async function resolveCommit() {
	try {
		const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${REF}`, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA },
		});
		if (r.ok) return (await r.json()).sha;
	} catch { /* 忽略 */ }
	return null;
}

fs.mkdirSync(OUT, { recursive: true });

const written = [];
for (const [src, dst] of Object.entries(FILES)) {
	const { text, via } = await fetchText(src);
	fs.writeFileSync(new URL(dst, OUT), text);
	written.push({ src, dst, via });
	console.log(`✓ vendor/${dst}  (${src} via ${via})`);
}

// 官方 theme.ts 里 '@@/themes/_light.json5' 是打包器别名，替换成运行时读文件，
// 这样 node 可以直接跑官方 compile() / parseThemeCode()，不需要任何构建步骤。
const tsPath = new URL('misskey-theme.ts', OUT);
const ALIAS = "import lightTheme from '@@/themes/_light.json5';";
const REPLACEMENT = "import fs from 'node:fs';\nconst lightTheme = JSON5.parse(fs.readFileSync(new URL('./_light.json5', import.meta.url), 'utf8'));";
let ts = fs.readFileSync(tsPath, 'utf8');
if (ts.includes(ALIAS)) {
	fs.writeFileSync(tsPath, ts.replace(ALIAS, REPLACEMENT));
	console.log('✓ vendor/misskey-theme.ts 已把 @@ 别名导入改为运行时读文件');
} else if (!ts.includes("new URL('./_light.json5'")) {
	throw new Error('官方 theme.ts 结构已变化：未找到别名导入，请人工检查');
}

const commit = await resolveCommit();
fs.writeFileSync(new URL('ref.json', OUT), JSON.stringify({
	repo: REPO,
	ref: REF,
	commit,
	fetchedAt: new Date().toISOString(),
	files: written,
}, null, '\t') + '\n');
console.log(`✓ vendor/ref.json  (${REPO}@${(commit ?? REF).slice(0, 10)})`);
