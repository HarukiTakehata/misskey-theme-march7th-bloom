/**
 * 校验 / 预览生成器
 *
 * compile() / parseThemeCode() 用 Misskey 官方实现（vendor/misskey-theme.ts 由 npm run refs 拉取），
 * 不是本仓库重写的近似算法。先跑 `npm run refs` 准备好 vendor/。
 */
import fs from 'node:fs';
import JSON5 from 'json5';
import tinycolor from 'tinycolor2';

const VENDOR = new URL('../vendor/', import.meta.url);
if (!fs.existsSync(new URL('misskey-theme.ts', VENDOR))) {
	console.error('缺少 vendor/misskey-theme.ts —— 请先运行：npm run refs');
	process.exit(1);
}
const { parseThemeCode, compile } = await import('../vendor/misskey-theme.ts');

const readRef = (f) => JSON5.parse(fs.readFileSync(new URL(f, VENDOR), 'utf8'));
const lightBase = readRef('_light.json5');
const darkBase = readRef('_dark.json5');
const baseProps = new Set(Object.keys(lightBase.props));
const basePropsDark = new Set(Object.keys(darkBase.props));

const themes = [
	{ key: 'march7th-light', mode: 'light', file: '../themes/march7th-bloom-light.json5',
		palette: ['#EDD9E1', '#FBF4F7', '#F3E4EA', '#DB9CB0', '#8E677F', '#B3AAC9', '#4C365E'] },
	{ key: 'march7th-dark', mode: 'dark', file: '../themes/march7th-bloom-dark.json5',
		palette: ['#E7BDCC', '#FEF9FC', '#F7D7E3', '#DB9CB0', '#A17892', '#B3AAC9', '#4C365E'] },
	{ key: 'rose-quartz-light', mode: 'light', file: '../themes/rose-quartz-light.json5',
		palette: ['#FFFFFF', '#FFF7FA', '#FBE4ED', '#DB5C88', '#C43E6E', '#8A2E4C', '#A02A52'] },
	{ key: 'azure-slate-light', mode: 'light', file: '../themes/azure-slate-light.json5',
		palette: ['#4E6294', '#EBF0F7', '#C2D7EE', '#7AA3D4', '#697EAE', '#343E65', '#CEABBC'] },
];

// ---- WCAG 相对亮度 / 对比度 ----
const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function lum(color) {
	const { r, g, b, a } = tinycolor(color).toRgb();
	const l = 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
	return a < 1 ? l * a + 0.0 * (1 - a) : l; // 近似：半透明色按叠加在纯黑上估算，仅用于提示
}
function contrast(fg, bg) {
	const l1 = lum(fg), l2 = lum(bg);
	return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const results = {};
let failed = false;

for (const { key, mode, file, palette } of themes) {
	const url = new URL(file, import.meta.url);
	const code = fs.readFileSync(url, 'utf8');
	console.log('\n================ ' + mode.toUpperCase() + ' : ' + url.pathname.split('/').pop() + ' ================');

	let theme;
	try {
		theme = parseThemeCode(code); // Misskey 官方解析 + validateTheme
		console.log('✓ JSON5 解析通过, validateTheme 通过 (id/name/base/props 齐备)');
	} catch (e) {
		console.log('✗ 解析失败: ' + e.message);
		failed = true;
		continue;
	}

	// 键名合法性：compile() 会把不在 base 里的键静默丢弃
	const unknown = Object.keys(theme.props).filter((k) => !k.startsWith('$') && !baseProps.has(k));
	if (unknown.length) { console.log('✗ 无效属性名（会被 Misskey 丢弃）: ' + unknown.join(', ')); failed = true; }
	else console.log('✓ 全部 ' + Object.keys(theme.props).length + ' 个属性名均在官方 62 个合法键内');

	// 复刻 applyTheme()：base 主题 props 合并
	const merged = JSON.parse(JSON.stringify(theme));
	const base = [lightBase, darkBase].find((x) => x.id === merged.base);
	merged.props = Object.assign({}, base.props, merged.props);

	let compiled;
	try {
		compiled = compile(merged);
		console.log('✓ compile() 通过，输出 ' + Object.keys(compiled).length + ' 个 CSS 变量');
	} catch (e) {
		console.log('✗ compile() 失败: ' + e.message); failed = true; continue;
	}

	const missing = Object.keys(base.props).filter((k) => !(k in compiled));
	if (missing.length) { console.log('✗ 缺少变量: ' + missing.join(', ')); failed = true; }
	else console.log('✓ 62 个 CSS 变量全部产出（--MI_THEME-*）');

	// 回环校验：模拟 Misskey 存储/导出(JSON5.stringify)/重新导入(parseThemeCode) 后结果一致
	const roundTrip = parseThemeCode(JSON5.stringify(theme, null, '	'));
	const rtMerged = Object.assign({}, roundTrip, { props: Object.assign({}, base.props, roundTrip.props) });
	const rtCompiled = compile(rtMerged);
	const diff = Object.keys(compiled).filter((k) => compiled[k] !== rtCompiled[k]);
	if (diff.length) { console.log('✗ 回环后变量不一致: ' + diff.join(', ')); failed = true; }
	else console.log('✓ 回环校验通过（导出→再导入 62 个变量完全一致）');

	// 每个非字面量值必须是合法 CSS 颜色（panelBorder 是 CSS 片段，跳过）
	const badColor = [];
	for (const [k, v] of Object.entries(compiled)) {
		if (k === 'panelBorder') continue; // '" solid 1px ...' 形式，编译后为 CSS 片段
		if (!tinycolor(v).isValid()) badColor.push(k + '=' + v);
	}
	if (badColor.length) { console.log('✗ 非法颜色值: ' + badColor.join(', ')); failed = true; }
	else console.log('✓ 所有颜色值合法');

	// 对比度体检（前景 vs 实际承载背景）
	const pairs = mode === 'light' ? [
		['fg', 'fg', 'bg'], ['fg', 'fg', 'panel'], ['link', 'link', 'panel'], ['mention', 'mention', 'panel'],
		['hashtag', 'hashtag', 'panel'], ['renote', 'renote', 'panel'], ['mentionMe', 'mentionMe', 'panel'],
		['navFg', 'navFg', 'navBg'], ['navActive', 'navActive', 'navBg'], ['fgOnAccent', 'fgOnAccent', 'accent'],
		['fgOnAccent', 'fgOnAccent', 'buttonGradateA'], ['fgOnAccent', 'fgOnAccent', 'buttonGradateB'],
		['fgHighlighted', 'fgHighlighted', 'panel'], ['infoFg', 'infoFg', 'infoBg'],
	] : [
		['fg', 'fg', 'bg'], ['fg', 'fg', 'panel'], ['link', 'link', 'panel'], ['mention', 'mention', 'panel'],
		['hashtag', 'hashtag', 'panel'], ['renote', 'renote', 'panel'], ['mentionMe', 'mentionMe', 'panel'],
		['navFg', 'navFg', 'navBg'], ['navActive', 'navActive', 'navBg'], ['fgOnAccent', 'fgOnAccent', 'accent'],
		['fgOnAccent', 'fgOnAccent', 'buttonGradateA'], ['fgOnAccent', 'fgOnAccent', 'buttonGradateB'],
		['fgHighlighted', 'fgHighlighted', 'panel'], ['infoFg', 'infoFg', 'infoBg'],
	];
	console.log('  前景/背景对比度:');
	for (const [, fgKey, bgKey] of pairs) {
		const r = contrast(compiled[fgKey], compiled[bgKey]);
		const flag = r >= 4.5 ? 'AA ' : r >= 3.0 ? 'AA-' : '低 ';
		console.log(`   ${flag} ${r.toFixed(2)}:1  ${fgKey} on ${bgKey}  (${compiled[fgKey]} on ${compiled[bgKey]})`);
	}

	results[key] = { theme, compiled, palette };
}

// ---- id 冲突检查 ----
// Misskey 的 addTheme() 对已存在的 id 抛 'already exists' 拒绝安装，updateTheme() 对同 id 直接跳过，
// 所以「同一主题改了配色」必须换 id，否则用户重装后会以为没生效（面板颜色不变）。
{
	// 只扫交付用的主题文件
	const dirs = ['../themes'];
	const ids = [];
	for (const d of dirs) {
		const dir = new URL(d + '/', import.meta.url);
		if (!fs.existsSync(dir)) continue;
		for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json5'))) {
			const text = fs.readFileSync(new URL(f, dir), 'utf8');
			const m = /^\s*id:\s*'([^']+)'/m.exec(text);
			if (m) ids.push({ f: d.replace('../', '') + '/' + f, id: m[1] });
		}
	}
	const byId = new Map();
	for (const { f, id } of ids) byId.set(id, [...(byId.get(id) ?? []), f]);
	const dup = [...byId.entries()].filter(([, fs_]) => fs_.length > 1);
	if (dup.length) {
		console.log('\n✗ id 重复（会导致 Misskey 拒绝安装 / 静默不更新）:');
		for (const [id, fs_] of dup) console.log('   ' + id + ' ← ' + fs_.join(', '));
		failed = true;
	} else {
		console.log('\n✓ id 唯一性检查通过（' + ids.length + ' 个主题文件互不冲突）');
	}
}

// ---- 预览 HTML ----
function swatch(c) {
	const V = (k) => `var(--MI_THEME-${k})`;
	return `<svg viewBox="0 0 200 150" class="swatch">
	<rect width="200" height="150" fill="${V('bg')}"/>
	<rect width="64" height="150" fill="${V('navBg')}"/>
	<rect x="64" width="136" height="41" fill="${V('pageHeaderBg')}"/>
	<path transform="scale(.26458)" d="m439.77 247.19c-43.673 0-78.832 35.157-78.832 78.83v249.98h407.06v-328.81z" fill="${V('panel')}"/>
	<circle cx="32" cy="83" r="21" fill="${V('accentedBg')}"/>
	<rect x="120" y="88" width="40" height="6" ry="3" fill="${V('fg')}"/>
	<rect x="170" y="88" width="20" height="6" ry="3" fill="${V('mention')}"/>
	<rect x="120" y="108" width="20" height="6" ry="3" fill="${V('hashtag')}"/>
	<rect x="150" y="108" width="40" height="6" ry="3" fill="${V('fg')}"/>
	<rect x="120" y="128" width="40" height="6" ry="3" fill="${V('fg')}"/>
	<rect x="170" y="128" width="20" height="6" ry="3" fill="${V('link')}"/>
	<path d="m65.498 40.892h137.7" stroke="${V('divider')}" stroke-width="0.75"/>
	<circle cx="32" cy="32" r="16" fill="${V('accent')}"/>
	<circle cx="140" cy="20" r="6" fill="${V('success')}"/>
	<circle cx="160" cy="20" r="6" fill="${V('warn')}"/>
	<circle cx="180" cy="20" r="6" fill="${V('error')}"/>
</svg>`;
}

function mock(v) {
	const V = (k) => `var(--MI_THEME-${k})`;
	const navItem = (icon, label, active) => `<div class="navitem${active ? ' active' : ''}"><span class="navicon">${icon}</span><span>${label}</span></div>`;
	const note = (name, handle, text, reactions) => `
	<div class="note">
		<div class="avatar"></div>
		<div class="notebody">
			<div class="notehead"><b>${name}</b> <span class="handle">${handle}</span> <span class="time">3分</span></div>
			<div class="notetext">${text}</div>
			<div class="reactions">${reactions}</div>
			<div class="notefooter">
				<span class="fbtn"><i>↩</i> 返信</span><span class="fbtn renote">🔁 リノート</span><span class="fbtn">⋯</span>
			</div>
		</div>
	</div>`;
	return `
	<div class="app">
		<nav class="nav">
			${navItem('🏠', 'ホーム', true)}
			${navItem('🔔', '通知', false)}
			${navItem('☰', 'タイムライン', false)}
			${navItem('👤', 'プロフィール', false)}
			${navItem('⚙', '設定', false)}
		</nav>
		<div class="main">
			<header class="pageheader"><b>ホーム</b><span class="spacer"></span><span class="pagetab active">タイムライン</span></header>
			<div class="columns">
				<section class="panel timeline">
					<div class="panelheader">
						<span class="tab active">ホーム</span><span class="tab">ソーシャル</span><span class="tab">ローカル</span>
					</div>
					<div class="postform">
						<div class="input"><span class="inputfg">いまどうしてる？ <span class="mention">@murasame</span> <span class="hashtag">#三月七</span></span></div>
						<div class="postactions"><span class="pill">🌙 CW</span><span class="pill">🔒 公開</span><span class="spacer"></span><span class="gradate">投稿</span></div>
					</div>
					${note('murasame', '@murasame', '唔姆——周一的下午已经到了。庭院里的<span class="link">这株樱花</span>开得正好，诸位可要来看看？<br><code class="code"><span class="cstr">"三月七"</span> = <span class="cnum">7</span> <span class="cbool">true</span></code>', '<span class="reaction mine">🌸 3</span><span class="reaction">👍 1</span><span class="addreaction">＋</span>')}
					${note('Yang', '@Yang', '<span class="renote-tag">🔁 Renoted by murasame</span><br>求雨成功！<span class="mention">@murasame</span> <span class="hashtag">#卡拉彼丘</span>', '<span class="reaction">❤ 2</span>')}
					${note('dsy4567', '@dsy4567', '<span class="renote-tag">🔁 リノートされました</span><br>又是掉头发的一天<span class="quote">> 引用：树莓派 zero 2w</span>', '<span class="reaction">👍 2</span>')}
				</section>
				<section class="panel widgets">
					<div class="panelheader folder">📁 ウィジェット</div>
					<div class="folderrow">トレンド <span class="dividerline"></span></div>
					<div class="folderrow">1. <span class="hashtag">#三月七</span></div>
					<div class="folderrow">2. <span class="hashtag">#Misskey</span></div>
					<div class="panelheader folder">🎛 コントロール</div>
					<div class="controls">
						<button class="btn primary">プライマリ</button>
						<button class="btn normal">ノーマル</button>
						<button class="btn gradate">グラデート</button>
						<button class="btn danger">危険</button>
						<div class="switchrow"><span>スイッチ ON</span><span class="switch on"><i></i></span></div>
						<div class="switchrow"><span>スイッチ OFF</span><span class="switch off"><i></i></span></div>
						<div class="input"><span class="inputfg placeholder">テキスト入力…</span></div>
						<div class="info"><b>情報</b> テーマのプレビュー中です</div>
						<div class="infowarn"><b>警告</b> 既定の警告表示色</div>
					</div>
				</section>
			</div>
		</div>
	</div>`;
}

function block(key, r) {
	const vars = Object.entries(r.compiled).map(([k, val]) => `--MI_THEME-${k}: ${val};`).join('\n');
	return `<section class="theme ${key}">
	<style>.${key}-scope { ${vars} }</style>
	<div class="${key}-scope">
		<div class="head">
			<h2>${r.theme.name}</h2>
			<span class="badge">${r.theme.base}</span>
			<div class="palette">
				${(r.palette || []).map((c) => `<span style="background:${c}" title="${c}"></span>`).join('')}
			</div>
		</div>
		<div class="row">${swatch(r)}${mock(r)}</div>
	</div>
</section>`;
}

const title = 'Misskey 主题预览';
const blocks = themes.map(({ key }) => block(key, results[key])).join('\n');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
body { margin: 0; padding: 24px; background: #23202b; font: 14px/1.6 system-ui, "Noto Sans CJK SC", sans-serif; color: #ddd; }
h1 { font-size: 18px; margin: 0 0 4px; }
.sub { color: #999; font-size: 12px; margin-bottom: 18px; }
.theme { margin-bottom: 28px; }
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.head h2 { font-size: 15px; margin: 0; color: #fff; }
.badge { font-size: 11px; padding: 1px 8px; border-radius: 99px; background: #3c3748; color: #bbb; }
.palette { display: flex; gap: 4px; margin-left: auto; }
.palette span { width: 18px; height: 18px; border-radius: 5px; display: inline-block; }
.row { display: flex; gap: 16px; align-items: flex-start; }
.swatch { width: 200px; height: 150px; border-radius: 10px; overflow: hidden; flex: none; }
* { box-sizing: border-box; }
.app { flex: 1; display: flex; min-height: 430px; background: var(--MI_THEME-bg); border-radius: 12px; overflow: hidden; color: var(--MI_THEME-fg); box-shadow: 0 8px 30px rgba(0,0,0,.35); }
.nav { width: 132px; flex: none; background: var(--MI_THEME-navBg); padding: 10px 8px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.navitem { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 7px; color: var(--MI_THEME-navFg); }
.navitem.active { color: var(--MI_THEME-navActive); background: var(--MI_THEME-accentedBg); font-weight: 700; }
.navitem:hover { color: var(--MI_THEME-fgHighlighted); background: var(--MI_THEME-panelHighlight); }
.navicon { width: 16px; text-align: center; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.pageheader { background: var(--MI_THEME-pageHeaderBg); color: var(--MI_THEME-pageHeaderFg); display: flex; align-items: center; gap: 12px; padding: 9px 14px; font-size: 13px; border-bottom: 1px solid var(--MI_THEME-divider); }
.spacer { flex: 1; }
.pagetab { color: var(--MI_THEME-fg); opacity: .7; font-size: 12px; }
.pagetab.active { opacity: 1; color: var(--MI_THEME-navActive); font-weight: 700; }
.columns { flex: 1; display: flex; gap: 10px; padding: 10px; align-items: flex-start; }
.panel { background: var(--MI_THEME-panel); border-radius: 8px; box-shadow: 0 1px 4px var(--MI_THEME-shadow); overflow: hidden; }
.timeline { flex: 1.5; min-width: 0; }
.widgets { flex: 1; min-width: 0; }
.panelheader { background: var(--MI_THEME-panelHeaderBg); color: var(--MI_THEME-panelHeaderFg); padding: 6px 10px; font-size: 12px; display: flex; gap: 12px; }
.panelheader.folder { background: var(--MI_THEME-folderHeaderBg); font-weight: 700; }
.tab { opacity: .7; padding: 3px 4px; border-radius: 6px; }
.tab.active { opacity: 1; font-weight: 700; color: var(--MI_THEME-navActive); }
.tab:hover { color: var(--MI_THEME-fgHighlighted); background: var(--MI_THEME-panelHighlight); }
.postform { padding: 10px; border-bottom: 1px solid var(--MI_THEME-divider); }
.input { border: 1px solid var(--MI_THEME-inputBorder); border-radius: 7px; padding: 8px 10px; min-height: 34px; background: var(--MI_THEME-panel); }
.input:hover { border-color: var(--MI_THEME-inputBorderHover); }
.inputfg { font-size: 12px; }
.placeholder { opacity: .5; }
.postactions { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.pill { font-size: 11px; color: var(--MI_THEME-navActive); background: var(--MI_THEME-accentedBg); border-radius: 99px; padding: 2px 9px; }
.gradate { font-size: 12px; font-weight: 700; color: var(--MI_THEME-fgOnAccent); background: linear-gradient(90deg, var(--MI_THEME-buttonGradateA), var(--MI_THEME-buttonGradateB)); border-radius: 99px; padding: 5px 16px; }
.note { display: flex; gap: 9px; padding: 10px; border-bottom: 1px solid var(--MI_THEME-divider); }
.avatar { width: 38px; height: 38px; border-radius: 99px; background: var(--MI_THEME-buttonHoverBg); flex: none; }
.notebody { min-width: 0; flex: 1; }
.notehead { font-size: 12px; }
.handle { color: var(--MI_THEME-fg); opacity: .6; }
.time { color: var(--MI_THEME-dateLabelFg); opacity: .45; font-size: 11px; }
.notetext { font-size: 12.5px; margin: 3px 0 6px; }
.link { color: var(--MI_THEME-link); }
.mention { color: var(--MI_THEME-mention); }
.hashtag { color: var(--MI_THEME-hashtag); }
.renote-tag { color: var(--MI_THEME-renote); font-size: 11.5px; font-weight: 700; }
.quote { display: block; margin-top: 5px; padding: 5px 8px; border-left: 3px solid var(--MI_THEME-divider); background: var(--MI_THEME-folderHeaderBg); border-radius: 4px; font-size: 11.5px; opacity: .85; }
.code { display: block; margin-top: 6px; padding: 6px 8px; border-radius: 6px; font: 11px/1.7 ui-monospace, monospace; background: var(--MI_THEME-folderHeaderBg); }
.cstr { color: var(--MI_THEME-codeString); } .cnum { color: var(--MI_THEME-codeNumber); } .cbool { color: var(--MI_THEME-codeBoolean); }
.reactions { display: flex; gap: 5px; align-items: center; }
.reaction { font-size: 11px; border: 1px solid var(--MI_THEME-divider); border-radius: 99px; padding: 1px 8px; }
.reaction.mine { border-color: var(--MI_THEME-accent); color: var(--MI_THEME-accent); background: var(--MI_THEME-accentedBg); }
.addreaction { font-size: 11px; opacity: .5; }
.notefooter { display: flex; gap: 16px; margin-top: 7px; font-size: 11px; opacity: .75; }
.fbtn.renote { color: var(--MI_THEME-renote); opacity: 1; }
.folderrow { padding: 6px 10px; font-size: 12px; border-bottom: 1px solid var(--MI_THEME-divider); }
.dividerline { display: inline-block; width: 40px; height: 1px; background: var(--MI_THEME-divider); vertical-align: middle; }
.controls { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.btn { font: inherit; font-size: 12px; border: none; border-radius: 7px; padding: 7px 12px; cursor: pointer; }
.btn.primary { background: var(--MI_THEME-accent); color: var(--MI_THEME-fgOnAccent); }
.btn.normal { background: var(--MI_THEME-buttonBg); color: var(--MI_THEME-fg); }
.btn.normal:hover { background: var(--MI_THEME-buttonHoverBg); }
.btn.gradate { background: linear-gradient(90deg, var(--MI_THEME-buttonGradateA), var(--MI_THEME-buttonGradateB)); color: var(--MI_THEME-fgOnAccent); font-weight: 700; }
.btn.danger { background: var(--MI_THEME-error); color: #fff; }
.switchrow { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.switch { width: 38px; height: 20px; border-radius: 99px; display: inline-flex; align-items: center; padding: 2px; }
.switch i { width: 16px; height: 16px; border-radius: 99px; background: var(--MI_THEME-switchOffFg); display: block; }
.switch.on { background: var(--MI_THEME-switchOnBg); justify-content: flex-end; }
.switch.on i { background: var(--MI_THEME-switchOnFg); }
.switch.off { background: var(--MI_THEME-switchOffBg); }
.info, .infowarn { font-size: 11.5px; padding: 6px 9px; border-radius: 6px; }
.info { background: var(--MI_THEME-infoBg); color: var(--MI_THEME-infoFg); }
.infowarn { background: var(--MI_THEME-infoWarnBg); color: var(--MI_THEME-infoWarnFg); }
</style>
<h1>Misskey 主题预览</h1>
<div class="sub">CSS 变量由 Misskey 官方 compile()（frontend-shared/js/theme.ts）在 Node 中实际计算得出 · 每块右上为对应调色板</div>
${blocks}
</html>`;

fs.writeFileSync(new URL('../preview/theme-preview.html', import.meta.url), html);
console.log('\n预览已生成: preview/theme-preview.html');
if (failed) { console.log('==== 校验未全部通过 ===='); process.exit(1); }
console.log('==== 全部校验通过 ====');
