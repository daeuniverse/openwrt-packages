#!/usr/bin/env python3
"""Write the landing page of the package feed.

Usage: generate.py <site-dir> <base-url> [<rsync-url>] < index-paths

stdin lists the packages.adb files the feed serves, one path per line,
relative to the feed root, so the page covers everything on the mirror and not
only what one run built:
  <series>/packages/<arch>/packages.adb                       e.g. 25.12
  <series>/kmods/<release>/<target>/<subtarget>/packages.adb  e.g. 25.12.6
It writes <lang>/index.html in English, Simplified and Traditional Chinese, with
an rsync URL also <lang>/mirror.html on mirroring the feed, <lang>/thanks.html,
and copies assets/ next to them. Only the standard library is used.
"""

import datetime
import html
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GITHUB = 'https://github.com/daeuniverse/openwrt-packages'
SOURCE = GITHUB + '/blob/main/scripts/feed-site/generate.py'
DOCS = {'dae': 'https://github.com/daeuniverse/dae/tree/main/docs', 'honk': 'https://github.com/daeuniverse/honk'}

LANGS = [
	# directory, html lang, name in the language menu
	('en', 'en', 'English'),
	('zh-cn', 'zh-CN', '简体中文'),
	('zh-tw', 'zh-TW', '繁體中文'),
]

# The mirror is hosted by gentoo-zh; the thanks link to its page in the same language
GENTOOZH = {'en': 'https://gentoozh.org/en/', 'zh-cn': 'https://gentoozh.org/', 'zh-tw': 'https://gentoozh.org/zh-tw/'}

# The thanks page: project and link (per language for gentoo-zh); what each is
# used for is in TEXT['thanks_used']
THANKS = [
	('gentoo-zh', GENTOOZH),
	('QiuSimons/vmlinux-btf', 'https://github.com/QiuSimons/vmlinux-btf'),
	('OpenWrt', 'https://openwrt.org/'),
	('daeuniverse/dae', 'https://github.com/daeuniverse/dae'),
	('daeuniverse/honk', 'https://github.com/daeuniverse/honk'),
	('Zakkaus/doona', 'https://github.com/Zakkaus/doona'),
	('aya-rs/bpf-linker', 'https://github.com/aya-rs/bpf-linker'),
	('Figtree', 'https://github.com/erikdkennedy/figtree'),
	('Lucide', 'https://lucide.dev/'),
]

# Translated text, as HTML. {app}, {conf} and {docs} follow the chosen service.
TEXT = {
	'en': {
		'title': 'OpenWrt package feed',
		'subtitle': 'apk packages of dae, honk and their LuCI apps for OpenWrt 25.12 and later.',
		'nav_guide': 'Guide',
		'nav_mirror': 'Mirror',
		'nav_thanks': 'Thanks',
		'nav_files': 'Files',
		'language': 'Language',
		'theme': 'Light or dark',
		'outline': 'On this page',
		'copy': 'Copy',
		'copied': 'Copied',
		'system': 'System',
		'service': 'Service',
		'install': 'Install',
		'key': 'Import the signing key',
		'repos': 'Add the repositories',
		'repos_note': 'The <code>@daeuniverse</code> tag selects this feed; otherwise, system packages take precedence.',
		'add': 'Install the packages',
		'add_note': 'Without LuCI, leave out the <code>luci-</code> packages.',
		'start': 'Enable the service',
		'start_note': 'In LuCI under <kbd>Services</kbd> → <kbd>{app}</kbd>, or from the shell:',
		'config_note': 'Configuration: <code>{conf}</code>, syntax in the {docs}.',
		'docs': 'documentation',
		'versions': 'Supported versions',
		'th_series': 'Version',
		'th_kernel': 'Kernel',
		'th_status': 'Status',
		'version_rows': [
			('25.12', '6.12', 'Supported on OpenWrt and ImmortalWrt.'),
			('24.10', '6.6', 'Unsupported: opkg has no tags, so this feed would replace same-name packages. ImmortalWrt includes dae. honk needs kernel 6.12+.'),
			('23.05 and older', '≤ 5.15', 'Unsupported: kernel too old for either service (dae needs 5.17+).'),
		],
		'builds': 'OpenWrt targets and BTF',
		'builds_note': 'Official OpenWrt has no kernel BTF: dae and honk need <code>vmlinux-btf</code>, available only for the targets and releases below. Other targets are unsupported. Kernels with BTF (ImmortalWrt) use the empty <code>vmlinux-btf-builtin</code> instead.',
		'check': 'Check the release and target of the router:',
		'th_target': 'Target',
		'th_releases': 'Releases',
		'colon': ': ',
		'arches': 'Package architectures (ImmortalWrt only needs a match; no packages or support for 32-bit ARM or MIPS on either system):',
		'no_builds': 'Nothing has been published yet.',
		'errors': 'Common errors',
		'th_error': 'Message',
		'th_cause': 'Cause',
		'error_items': [
			('UNTRUSTED signature', 'The router does not have the public key of this feed yet, so it cannot verify the packages. Run the step <em>Import the signing key</em>, then <code>apk update</code>.'),
			('This kernel has no BTF of its own', 'On official OpenWrt, the kmods repository was not added, so <code>vmlinux-btf-builtin</code> was installed instead of <code>vmlinux-btf</code>. Add both lines of the step <em>Add the repositories</em> for OpenWrt, then run <code>apk update &amp;&amp; apk upgrade vmlinux-btf-builtin</code>. If the target of the router is not in the table above, this feed has no <code>vmlinux-btf</code> for it, so dae and honk cannot run on this router.'),
			('breaks: vmlinux-btf', 'The router does not run the kernel of an official OpenWrt release (for example ImmortalWrt, a self-built or a snapshot firmware), so <code>vmlinux-btf</code> cannot be installed. Such a system needs no kmods repository: delete the line containing <code>kmods</code> from <code>/etc/apk/repositories.d/daeuniverse.list</code>, run <code>apk update</code> and install again.'),
		],
		'edit': 'Edit this page',
		'updated': 'Updated {date}',
		'all_files': 'All files',
		'source': 'Source',
		'thanks': 'Mirror hosted by <a href="{gentoozh}">gentoo-zh</a>',
		'mirror_title': 'Mirror the feed',
		'mirror_subtitle': 'Sync the feed with rsync and serve it over HTTP(S). Packages and indexes are signed; routers verify them with the same key.',
		'sync': 'Sync',
		'sync_note': '<code>--delay-updates</code> and <code>--delete-delay</code> keep indexes consistent with packages. Syncing every few hours is enough.',
		'serve': 'Serve',
		'serve_note': 'Serve the directory unchanged; routers request <code>&lt;series&gt;/packages/&lt;arch&gt;/</code> and <code>&lt;series&gt;/kmods/&lt;release&gt;/&lt;target&gt;/&lt;subtarget&gt;/</code>.',
		'use': 'Use',
		'use_note': 'Follow the <a href="./">guide</a> with the mirror in <code>FEED</code>:',
		'use_key': 'Import the signing key from this site, not from the mirror.',
		'thanks_title': 'Thanks',
		'thanks_subtitle': 'Projects this feed is built on.',
		'th_project': 'Project',
		'th_used': 'Used for',
		'thanks_used': {
			'gentoo-zh': 'Hosting the mirror',
			'QiuSimons/vmlinux-btf': 'The vmlinux-btf approach and stub sources',
			'OpenWrt': 'SDKs, toolchains and kernel headers',
			'daeuniverse/dae': 'Source of dae',
			'daeuniverse/honk': 'Source of honk',
			'Zakkaus/doona': 'honk\'s embedded dashboard',
			'aya-rs/bpf-linker': 'Linking honk\'s eBPF object',
			'Figtree': 'Page font (SIL OFL 1.1)',
			'Lucide': 'Page icons (ISC)',
		},
	},
	'zh-cn': {
		'title': 'OpenWrt 软件源',
		'subtitle': 'dae、honk 及其 LuCI 界面的 apk 软件包，适用于 OpenWrt 25.12 及以上版本。',
		'nav_guide': '说明',
		'nav_mirror': '镜像',
		'nav_thanks': '致谢',
		'nav_files': '文件',
		'language': '语言',
		'theme': '浅色或深色',
		'outline': '本页目录',
		'copy': '复制',
		'copied': '已复制',
		'system': '系统',
		'service': '服务',
		'install': '安装',
		'key': '导入签名公钥',
		'repos': '添加软件源',
		'repos_note': '<code>@daeuniverse</code>标签指定从本源安装；不带标签时优先使用系统软件包。',
		'add': '安装软件包',
		'add_note': '不使用 LuCI 时，省略<code>luci-</code>开头的软件包。',
		'start': '启用服务',
		'start_note': '在 LuCI 的<kbd>服务</kbd> → <kbd>{app}</kbd> 中启用，或在命令行执行：',
		'config_note': '配置文件：<code>{conf}</code>，语法见 {docs}。',
		'docs': '文档',
		'versions': '支持的版本',
		'th_series': '版本',
		'th_kernel': '内核',
		'th_status': '状态',
		'version_rows': [
			('25.12', '6.12', '支持 OpenWrt 和 ImmortalWrt。'),
			('24.10', '6.6', '不支持：opkg 没有标签，本源会取代同名软件包；ImmortalWrt 已自带 dae。honk 需内核 6.12 以上。'),
			('23.05 及更早', '≤ 5.15', '不支持：内核低于两者要求（dae 需 5.17 以上）。'),
		],
		'builds': 'OpenWrt target 与 BTF',
		'builds_note': '官方 OpenWrt 内核不含 BTF，dae 和 honk 需<code>vmlinux-btf</code>，仅提供下表的 target 和版本；其他 target 不支持。内核自带 BTF 时（ImmortalWrt），由空包<code>vmlinux-btf-builtin</code>代替。',
		'check': '查询路由器的版本和 target：',
		'th_target': 'Target',
		'th_releases': '版本',
		'colon': '：',
		'arches': '软件包架构（ImmortalWrt 只需架构相符；32 位 ARM 和 MIPS 无软件包，两种系统均不支持）：',
		'no_builds': '尚未发布。',
		'errors': '常见错误',
		'th_error': '错误信息',
		'th_cause': '原因',
		'error_items': [
			('UNTRUSTED signature', '路由器还没有本源的公钥，无法验证软件包。执行<em>导入签名公钥</em>这一步，再执行<code>apk update</code>。'),
			('This kernel has no BTF of its own', '官方 OpenWrt 没有添加 kmods 软件源，所以安装的是<code>vmlinux-btf-builtin</code>，而不是<code>vmlinux-btf</code>。按<em>添加软件源</em>中 OpenWrt 的写法添加两行软件源，再执行<code>apk update &amp;&amp; apk upgrade vmlinux-btf-builtin</code>。如果路由器的 target 不在上面的表中，本源没有它的<code>vmlinux-btf</code>，dae 和 honk 无法在这台路由器上运行。'),
			('breaks: vmlinux-btf', '路由器的内核不是官方 OpenWrt 正式版的内核（例如 ImmortalWrt、自行编译或快照版固件），所以无法安装<code>vmlinux-btf</code>。这类系统不需要 kmods 软件源：删除<code>/etc/apk/repositories.d/daeuniverse.list</code>中含<code>kmods</code>的那一行，执行<code>apk update</code>后重新安装。'),
		],
		'edit': '编辑此页',
		'updated': '更新于 {date}',
		'all_files': '全部文件',
		'source': '源代码',
		'thanks': '镜像服务器由 <a href="{gentoozh}">gentoo-zh</a> 提供',
		'mirror_title': '镜像本源',
		'mirror_subtitle': '用 rsync 同步本源，通过 HTTP(S) 提供。软件包和索引均已签名，路由器用同一公钥验证。',
		'sync': '同步',
		'sync_note': '<code>--delay-updates</code>和<code>--delete-delay</code>保证索引与软件包一致。每几小时同步一次即可。',
		'serve': '提供',
		'serve_note': '原样提供该目录，路由器访问<code>&lt;series&gt;/packages/&lt;arch&gt;/</code>和<code>&lt;series&gt;/kmods/&lt;release&gt;/&lt;target&gt;/&lt;subtarget&gt;/</code>。',
		'use': '使用',
		'use_note': '按<a href="./">说明</a>操作，<code>FEED</code>改为镜像地址：',
		'use_key': '签名公钥请从本站导入，不要从镜像导入。',
		'thanks_title': '致谢',
		'thanks_subtitle': '本源所依托的项目。',
		'th_project': '项目',
		'th_used': '用途',
		'thanks_used': {
			'gentoo-zh': '镜像托管',
			'QiuSimons/vmlinux-btf': 'vmlinux-btf 的做法与桩代码',
			'OpenWrt': 'SDK、工具链与内核头文件',
			'daeuniverse/dae': 'dae 源码',
			'daeuniverse/honk': 'honk 源码',
			'Zakkaus/doona': 'honk 内置的控制面板',
			'aya-rs/bpf-linker': '链接 honk 的 eBPF 对象',
			'Figtree': '页面字体（SIL OFL 1.1）',
			'Lucide': '页面图标（ISC）',
		},
	},
	'zh-tw': {
		'title': 'OpenWrt 軟體源',
		'subtitle': 'dae、honk 及其 LuCI 介面的 apk 套件，適用於 OpenWrt 25.12 以上版本。',
		'nav_guide': '說明',
		'nav_mirror': '鏡像',
		'nav_thanks': '致謝',
		'nav_files': '檔案',
		'language': '語言',
		'theme': '淺色或深色',
		'outline': '本頁目錄',
		'copy': '複製',
		'copied': '已複製',
		'system': '系統',
		'service': '服務',
		'install': '安裝',
		'key': '匯入簽章公鑰',
		'repos': '加入軟體源',
		'repos_note': '<code>@daeuniverse</code>標籤指定從本源安裝；不帶標籤時優先使用系統套件。',
		'add': '安裝套件',
		'add_note': '不使用 LuCI 時，省略<code>luci-</code>開頭的套件。',
		'start': '啟用服務',
		'start_note': '在 LuCI 的<kbd>服務</kbd> → <kbd>{app}</kbd> 中啟用，或在命令列執行：',
		'config_note': '設定檔：<code>{conf}</code>，語法見 {docs}。',
		'docs': '文件',
		'versions': '支援的版本',
		'th_series': '版本',
		'th_kernel': '核心',
		'th_status': '狀態',
		'version_rows': [
			('25.12', '6.12', '支援 OpenWrt 和 ImmortalWrt。'),
			('24.10', '6.6', '不支援：opkg 沒有標籤，本源會取代同名套件；ImmortalWrt 已內建 dae。honk 需核心 6.12 以上。'),
			('23.05 及更早', '≤ 5.15', '不支援：核心低於兩者要求（dae 需 5.17 以上）。'),
		],
		'builds': 'OpenWrt target 與 BTF',
		'builds_note': '官方 OpenWrt 核心不含 BTF，dae 和 honk 需<code>vmlinux-btf</code>，僅提供下表的 target 和版本；其他 target 不支援。核心自帶 BTF 時（ImmortalWrt），由空套件<code>vmlinux-btf-builtin</code>代替。',
		'check': '查詢路由器的版本和 target：',
		'th_target': 'Target',
		'th_releases': '版本',
		'colon': '：',
		'arches': '套件架構（ImmortalWrt 只需架構相符；32 位元 ARM 和 MIPS 無套件，兩種系統均不支援）：',
		'no_builds': '尚未發布。',
		'errors': '常見錯誤',
		'th_error': '錯誤訊息',
		'th_cause': '原因',
		'error_items': [
			('UNTRUSTED signature', '路由器還沒有本源的公鑰，無法驗證套件。執行<em>匯入簽章公鑰</em>這一步，再執行<code>apk update</code>。'),
			('This kernel has no BTF of its own', '官方 OpenWrt 沒有加入 kmods 軟體源，所以安裝的是<code>vmlinux-btf-builtin</code>，而不是<code>vmlinux-btf</code>。照<em>加入軟體源</em>中 OpenWrt 的寫法加入兩行軟體源，再執行<code>apk update &amp;&amp; apk upgrade vmlinux-btf-builtin</code>。如果路由器的 target 不在上面的表中，本源沒有它的<code>vmlinux-btf</code>，dae 和 honk 無法在這台路由器上運作。'),
			('breaks: vmlinux-btf', '路由器的核心不是官方 OpenWrt 正式版的核心（例如 ImmortalWrt、自行編譯或快照版韌體），所以無法安裝<code>vmlinux-btf</code>。這類系統不需要 kmods 軟體源：刪除<code>/etc/apk/repositories.d/daeuniverse.list</code>中含<code>kmods</code>的那一行，執行<code>apk update</code>後重新安裝。'),
		],
		'edit': '編輯此頁',
		'updated': '更新於 {date}',
		'all_files': '全部檔案',
		'source': '原始碼',
		'thanks': '鏡像伺服器由 <a href="{gentoozh}">gentoo-zh</a> 提供',
		'mirror_title': '鏡像本源',
		'mirror_subtitle': '用 rsync 同步本源，透過 HTTP(S) 提供。套件和索引均已簽章，路由器以同一把公鑰驗證。',
		'sync': '同步',
		'sync_note': '<code>--delay-updates</code>和<code>--delete-delay</code>確保索引與套件一致。每幾小時同步一次即可。',
		'serve': '提供',
		'serve_note': '原樣提供該目錄，路由器存取<code>&lt;series&gt;/packages/&lt;arch&gt;/</code>和<code>&lt;series&gt;/kmods/&lt;release&gt;/&lt;target&gt;/&lt;subtarget&gt;/</code>。',
		'use': '使用',
		'use_note': '依<a href="./">說明</a>操作，<code>FEED</code>改為鏡像位址：',
		'use_key': '簽章公鑰請從本站匯入，不要從鏡像匯入。',
		'thanks_title': '致謝',
		'thanks_subtitle': '本源所依託的專案。',
		'th_project': '專案',
		'th_used': '用途',
		'thanks_used': {
			'gentoo-zh': '鏡像託管',
			'QiuSimons/vmlinux-btf': 'vmlinux-btf 的做法與 stub 原始碼',
			'OpenWrt': 'SDK、工具鏈與核心標頭檔',
			'daeuniverse/dae': 'dae 原始碼',
			'daeuniverse/honk': 'honk 原始碼',
			'Zakkaus/doona': 'honk 內建的控制面板',
			'aya-rs/bpf-linker': '連結 honk 的 eBPF 物件',
			'Figtree': '頁面字型（SIL OFL 1.1）',
			'Lucide': '頁面圖示（ISC）',
		},
	},
}

# Lucide icons (ISC license), drawn with the stroke style of style.css
ICONS = {
	'copy': '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
	'check': '<path d="M20 6 9 17l-5-5"/>',
	'languages': '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
	'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
	'moon': '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
	'pen': '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
	'github': '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
}

# Chinese text puts a space between a character and inline code, none next to
# punctuation; the strings are written without it and spaced here.
CJK_CODE = re.compile(r'(?<=[\u4e00-\u9fff])(?=<code>)|(?<=</code>)(?=[\u4e00-\u9fff])')

INDEX = re.compile(r'^(\d+\.\d+)/(?:packages/([^/]+)|kmods/(\d+\.\d+\.\d+)/([^/]+/[^/]+))/packages\.adb$')
esc = html.escape


def icon(name, cls=''):
	return f'<svg class="icon {cls}" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


def version_key(version):
	return tuple(int(part) for part in version.split('.'))


def read_builds(lines):
	"""{series: {'packages': {arch}, 'kmods': {release: {target/subtarget}}}}, newest first."""
	builds = {}
	for line in lines:
		m = INDEX.match(line.strip().removeprefix('./'))
		if not m:
			continue
		entry = builds.setdefault(m[1], {'packages': set(), 'kmods': {}})
		if m[2]:
			entry['packages'].add(m[2])
		else:
			entry['kmods'].setdefault(m[3], set()).add(m[4])
	return dict(sorted(builds.items(), key=lambda kv: version_key(kv[0]), reverse=True))


SH_TOKEN = re.compile(r'(\$\{[^}]*\}|\$\w+)|("[^"]*"|\'[^\']*\')|(<<-?\'?\w+\'?|[|&;>\\])')


def highlight_sh(text):
	"""Shell colouring as Shiki's github themes do it: commands, variables,
	strings, operators; the lines of a here-document are data."""
	out, heredoc, continued = [], None, False
	for line in text.split('\n'):
		if heredoc:
			cls = 'o' if line == heredoc else 's'
			heredoc = None if line == heredoc else heredoc
			out.append(f'<span class="tok-{cls}">{esc(line)}</span>')
			continue
		if line.lstrip().startswith('#'):
			out.append(f'<span class="tok-c">{esc(line)}</span>')
			continue
		html_line, command = '', not continued
		continued = line.endswith('\\')
		for m in re.finditer(r'\S+|\s+', line):
			word = m[0]
			if word.isspace():
				html_line += word
				continue
			if command and not word.startswith(('$', '"', "'")) and '=' not in word:
				html_line += f'<span class="tok-f">{esc(word)}</span>'
				command = False
				continue
			command = command and '=' in word
			last = 0
			for t in SH_TOKEN.finditer(word):
				if t.start() > last:
					html_line += f'<span class="tok-s">{esc(word[last:t.start()])}</span>'
				cls = 'v' if t[1] else 's' if t[2] else 'o'
				html_line += f'<span class="tok-{cls}">{esc(t[0])}</span>'
				if t[3] and t[3].startswith('<<'):
					heredoc = t[3].lstrip('<-').strip("'")
				if t[3] in ('|', '&', ';'):
					command = True
				last = t.end()
			if last < len(word):
				html_line += f'<span class="tok-s">{esc(word[last:])}</span>'
		out.append(html_line)
	return '\n'.join(out)


def code(text, T, attrs=''):
	return (f'<div class="code"{attrs}><div class="code-title"><span>sh</span>'
	        f'<button class="button square copy" type="button" aria-label="{T["copy"]}" '
	        f'data-copy="{T["copy"]}" data-done="{T["copied"]}">'
	        f'{icon("copy", "icon-copy")}{icon("check", "icon-done")}</button></div>'
	        f'<pre><code>{highlight_sh(text)}</code></pre></div>')


def variants(key, **values):
	"""One inline span per variant; CSS shows the one that is chosen."""
	return ''.join(f'<span data-{key}="{v}">{text}</span>' for v, text in values.items())


def tabs(name, legend, options):
	"""A radio group drawn as tabs; style.css hides the variants not chosen."""
	radios = ''.join(
		f'<input type="radio" name="{name}" id="{name}-{value}" value="{value}"' + (' checked' if i == 0 else '') + '>'
		f'<label for="{name}-{value}">{label}</label>'
		for i, (value, label) in enumerate(options))
	return f'<fieldset class="choice"><legend>{legend}</legend><div class="tabs">{radios}</div></fieldset>'


def texts(lang, t):
	fill = {
		'gentoozh': GENTOOZH[lang],
		'date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d'),
		'app': variants('app', dae='dae', honk='honk'),
		'conf': variants('app', dae='/etc/dae/config.dae', honk='/etc/honk/config.dae'),
		'docs': variants('app', **{app: f'<a href="{url}">{app} {t["docs"]}</a>' for app, url in DOCS.items()}),
	}
	T = {k: v.format(**fill) if isinstance(v, str) else v for k, v in t.items()}
	if lang.startswith('zh'):
		T = {k: CJK_CODE.sub(' ', v) if isinstance(v, str) else v for k, v in T.items()}
	return T


# The release series (25.12) from /etc/openwrt_release; cut keeps it whether
# DISTRIB_RELEASE reads 25.12.6 or only 25.12.
SERIES = '$(echo "$DISTRIB_RELEASE" | cut -d. -f1-2)'


def heading(key, title):
	return f'<h2 id="{key}">{title}<a class="anchor" href="#{key}" aria-hidden="true">#</a></h2>'


def guide(lang, T, builds, base):
	# The packages are shared by a release series (25.12), vmlinux-btf belongs
	# to one release (25.12.6) and target
	repo = lambda kmods: (
		'. /etc/openwrt_release\n'
		f'FEED={base}/{SERIES}\n'
		'cat > /etc/apk/repositories.d/daeuniverse.list <<EOF\n'
		'@daeuniverse $FEED/packages/$DISTRIB_ARCH/packages.adb\n'
		+ ('@daeuniverse $FEED/kmods/$DISTRIB_RELEASE/$DISTRIB_TARGET/packages.adb\n' if kmods else '')
		+ 'EOF\n'
		'apk update')
	i18n = {'zh-cn': ' \\\n    luci-i18n-daeuniverse-zh-cn@daeuniverse', 'zh-tw': ' \\\n    luci-i18n-daeuniverse-zh-tw@daeuniverse'}.get(lang, '')
	per_app = lambda make: ''.join(code(make(app), T, f' data-app="{app}"') for app in DOCS)
	# A dependency the system also has comes from the system unless it is
	# named with the tag, so the service is named as well: ImmortalWrt has a
	# dae of its own, which would be picked otherwise. vmlinux-btf, which
	# neither system has, comes along: the real one from the kmods repository,
	# vmlinux-btf-builtin on ImmortalWrt.

	if builds:
		releases = {}
		for series, entry in builds.items():
			for release, targets in entry['kmods'].items():
				for target in targets:
					releases.setdefault(target, []).append((series, release))
		link = lambda path, text: f'<a href="../{esc(path)}/">{esc(text)}</a>'
		common = next(iter(releases.values()), [])
		if len(common) == 1 and all(found == common for found in releases.values()):
			series, release = common[0]
			rows = ''.join(
				f'<tr><td class="mono">{link(f"{series}/kmods/{release}/{target}", target)}</td></tr>'
				for target in sorted(releases))
			table = (f'<div class="table"><table class="stack"><caption>{T["th_releases"]}{T["colon"]}{esc(release)}</caption>'
			         f'<thead><tr><th>{T["th_target"]}</th></tr></thead><tbody>{rows}</tbody></table></div>')
		else:
			rows = ''.join(
				f'<tr><td class="mono">{esc(target)}</td><td class="mono" data-label="{T["th_releases"]}">'
				+ ' '.join(link(f'{s}/kmods/{r}/{target}', r) for s, r in sorted(found, key=lambda sr: version_key(sr[1]), reverse=True))
				+ '</td></tr>'
				for target, found in sorted(releases.items()))
			table = (f'<div class="table"><table class="stack"><thead><tr><th>{T["th_target"]}</th><th>{T["th_releases"]}</th></tr></thead>'
			         f'<tbody>{rows}</tbody></table></div>' if rows else '')
		arches = ''.join(
			f'<li>{esc(series)}{T["colon"]}<span class="mono">'
			+ ' '.join(link(f'{series}/packages/{arch}', arch) for arch in sorted(entry['packages']))
			+ '</span></li>'
			for series, entry in builds.items() if entry['packages'])
		arches = f'<ul class="architectures">{arches}</ul>' if arches else ''
	else:
		table = f'<p>{T["no_builds"]}</p>'
		arches = ''

	errors = ''.join(
		f'<details class="reference"><summary class="mono">{esc(e)}</summary><p>{c}</p></details>'
		for e, c in T['error_items'])
	kernel = T['th_kernel']
	versions = ''.join(f'<tr><td>{esc(v)}</td><td data-label="{kernel}">{esc(k)}</td><td>{status}</td></tr>' for v, k, status in T['version_rows'])
	sections = [('versions', T['versions']), ('install', T['install']), ('errors', T['errors'])]
	h2 = {key: heading(key, title) for key, title in sections}

	return sections, f'''
{h2["versions"]}
<div class="table"><table class="stack"><thead><tr><th>{T["th_series"]}</th><th>{T["th_kernel"]}</th><th>{T["th_status"]}</th></tr></thead><tbody>{versions}</tbody></table></div>
<p>{T["check"]}</p>
{code(". /etc/openwrt_release\necho $DISTRIB_RELEASE $DISTRIB_ARCH $DISTRIB_TARGET", T)}
<p>{T["arches"]}</p>
{arches}
<details class="reference"><summary>{T["builds"]}</summary>
<p>{T["builds_note"]}</p>
{table}
</details>

{h2["install"]}
<div class="choices">
{tabs("os", T["system"], [("openwrt", "OpenWrt"), ("immortalwrt", "ImmortalWrt")])}
{tabs("app", T["service"], [("dae", "dae"), ("honk", "honk")])}
</div>
<ol class="steps">
<li><h3>{T["key"]}</h3>
{code(f"wget -O /etc/apk/keys/daeuniverse.pem \\\n    {base}/public-key.pem", T)}</li>
<li><h3>{T["repos"]}</h3>
{code(repo(True), T, ' data-os="openwrt"')}
{code(repo(False), T, ' data-os="immortalwrt"')}
<p>{T["repos_note"]}</p>
</li>
<li><h3>{T["add"]}</h3>
{per_app(lambda app: f"apk add {app}@daeuniverse luci-app-{app}@daeuniverse{i18n}")}
<p>{T["add_note"]}</p></li>
<li><h3>{T["start"]}</h3>
<p>{T["start_note"]}</p>
{per_app(lambda app: f"uci set {app}.config.enabled=1\nuci commit {app}\n/etc/init.d/{app} enable\n/etc/init.d/{app} start")}
<p>{T["config_note"]}</p></li>
</ol>

{h2["errors"]}
{errors}
'''


def mirror(T, rsync):
	sections = [('sync', T['sync']), ('serve', T['serve']), ('use', T['use'])]
	return sections, f'''
{heading("sync", T["sync"])}
{code(f"rsync -av --delete-delay --delay-updates \\\n    {rsync}/ \\\n    /srv/mirror/openwrt-daeuniverse/", T)}
<p>{T["sync_note"]}</p>

{heading("serve", T["serve"])}
<p>{T["serve_note"]}</p>

{heading("use", T["use"])}
<p>{T["use_note"]}</p>
{code(f"FEED=https://mirror.example.org/openwrt-daeuniverse/{SERIES}", T)}
<p>{T["use_key"]}</p>
'''


def thanks(lang, T):
	rows = ''.join(
		f'<tr><td><a href="{esc(url[lang] if isinstance(url, dict) else url)}">{esc(name)}</a></td><td>{T["thanks_used"][name]}</td></tr>'
		for name, url in THANKS)
	return [], f'''
<div class="table"><table class="stack"><thead><tr><th>{T["th_project"]}</th><th>{T["th_used"]}</th></tr></thead><tbody>{rows}</tbody></table></div>
'''


# The pages of a language directory, in the order of the top bar: file name,
# nav text, title and subtitle
PAGES = [
	('index.html', 'nav_guide', 'title', 'subtitle'),
	('mirror.html', 'nav_mirror', 'mirror_title', 'mirror_subtitle'),
	('thanks.html', 'nav_thanks', 'thanks_title', 'thanks_subtitle'),
]


def page(lang, html_lang, T, base, pages, name, sections, body):
	"""Wraps a page body in what every page shares: head, top bar, outline and
	footer. pages are the file names this language has, name the current one."""
	href = lambda file: './' if file == 'index.html' else file
	_, _, title, subtitle = next(p for p in PAGES if p[0] == name)
	nav = ''.join(
		f'<a class="button" href="{href(file)}"' + (' aria-current="page"' if file == name else '') + f'>{T[text]}</a>'
		for file, text, _, _ in PAGES if file in pages)
	outline = ''.join(f'<li><a href="#{key}">{text}</a></li>' for key, text in sections)
	path = '' if name == 'index.html' else name
	languages = ''.join(
		f'<li><a href="../{d}/{path}" hreflang="{h}" lang="{h}"' + (' aria-current="true"' if d == lang else '') + f'>{esc(n)}</a></li>'
		for d, h, n in LANGS)
	alternates = '\n'.join(f'<link rel="alternate" hreflang="{h}" href="{base}/{d}/{path}">' for d, h, _ in LANGS)

	return f'''<!doctype html>
<html lang="{html_lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{T[title]} · daeuniverse</title>
<meta name="description" content="{T[subtitle]}">
<link rel="icon" href="../assets/daeuniverse.png">
<link rel="stylesheet" href="../assets/style.css">
<script src="../assets/site.js"></script>
{alternates}
</head>
<body>
<header class="topbar">
<a class="brand" href="./"><img src="../assets/daeuniverse.png" alt="" width="28" height="28">daeuniverse</a>
<nav class="topbar-nav">{nav}<a class="button" href="../files/">{T["nav_files"]}</a></nav>
<div class="topbar-actions">
<details class="lang"><summary class="button square" aria-label="{T["language"]}" title="{T["language"]}">{icon("languages")}</summary><ul>{languages}</ul></details>
<button class="button square theme-toggle" type="button" aria-label="{T["theme"]}" title="{T["theme"]}">{icon("moon", "icon-dark")}{icon("sun", "icon-light")}</button>
<a class="button square" href="{GITHUB}" aria-label="GitHub" title="GitHub">{icon("github")}</a>
</div>
</header>
<div class="page">
<main class="article">
<h1>{T[title]}</h1>
<p class="subtitle">{T[subtitle]}</p>
{body}
<p class="edit"><a class="button" href="{SOURCE}">{icon("pen")}{T["edit"]}</a></p>
</main>
<nav class="outline" aria-label="{T["outline"]}"><ul>{outline}</ul></nav>
</div>
<footer class="footer">
<span>{T["updated"]}</span>
<span>{T["thanks"]}</span>
<nav><a href="../files/">{T["all_files"]}</a><a href="../public-key.pem">public-key.pem</a><a href="{GITHUB}">{T["source"]}</a></nav>
</footer>
</body>
</html>
'''


def main():
	site, base = Path(sys.argv[1]), sys.argv[2].rstrip('/')
	rsync = sys.argv[3].rstrip('/') if len(sys.argv) > 3 else ''
	builds = read_builds(sys.stdin)
	for lang, html_lang, _ in LANGS:
		T = texts(lang, TEXT[lang])
		bodies = {'index.html': guide(lang, T, builds, base)}
		if rsync:
			bodies['mirror.html'] = mirror(T, rsync)
		bodies['thanks.html'] = thanks(lang, T)
		(site / lang).mkdir(parents=True, exist_ok=True)
		for name, (sections, body) in bodies.items():
			html_text = page(lang, html_lang, T, base, bodies, name, sections, body)
			(site / lang / name).write_text(html_text, encoding='utf-8')
	shutil.copytree(HERE / 'assets', site / 'assets', dirs_exist_ok=True)


if __name__ == '__main__':
	main()
