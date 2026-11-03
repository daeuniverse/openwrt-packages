'use strict';
'require baseclass';
'require view';
'require form';
'require fs';
'require ui';
'require uci';
'require rpc';
'require request';
'require poll';

/*
 * The page shared by luci-app-dae and luci-app-honk, in three tabs: the
 * service status with its controls and the Start at boot switch, an editor for
 * the configuration file and every file it includes, and the service log. An
 * app extends `View` and only supplies `app`:
 *
 *   name           service, UCI package and init script
 *   other          the service that cannot run at the same time; starting this
 *                  one stops that one first, and turning Start at boot on here
 *                  turns it off there
 *   defaultConfig  entry file when UCI has none
 *   validate       [ command, args ] that take the entry file and exit non-zero
 *                  on a broken configuration, or null
 *   logIdent       RegExp matching the start of the service's log messages
 *   webUi          optional async hook: loaded files to { url?, note? } or null
 *   webUiFlag      optional { read, path, write }: a checkbox for the web UI
 *                  that lives in the configuration files, not in UCI.
 *                  read(files) is the state, path(files) the file to change
 *                  and write(text, on) the new text of that file. Saving
 *                  writes the file and restarts a running service.
 */

const callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

const callInitAction = rpc.declare({
	object: 'rc',
	method: 'init',
	params: [ 'name', 'action' ]
});

const callRcList = rpc.declare({
	object: 'rc',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

const callLogRead = rpc.declare({
	object: 'log',
	method: 'read',
	params: [ 'lines', 'stream', 'oneshot' ],
	expect: { log: [] }
});

function isRunning(name) {
	return L.resolveDefault(callServiceList(name), {}).then(res =>
		Object.values(res?.[name]?.instances ?? {}).some(i => i.running));
}

// The rc.d link of the init script; false for a service that is not installed
function isBootEnabled(name) {
	return L.resolveDefault(callRcList(name), {}).then(res => res?.[name]?.enabled === true);
}

// A service takes a moment to come up or go down
async function waitRunning(name, wanted, tries = 10) {
	let running = !wanted;
	for (let i = 0; i < tries && running !== wanted; i++) {
		await new Promise(resolve => setTimeout(resolve, 500));
		running = await isRunning(name);
	}
	return running === wanted;
}

function notify(text, type) {
	return ui.addTimeLimitedNotification(null, E('p', text), 8000, type);
}

/* Paths */

function dirname(path) {
	const i = path.lastIndexOf('/');
	return i > 0 ? path.slice(0, i) : '/';
}

function basename(path) {
	return path.slice(path.lastIndexOf('/') + 1);
}

function normalize(path) {
	const out = [];
	for (const seg of path.split('/')) {
		if (seg === '' || seg === '.')
			continue;
		if (seg === '..')
			out.pop();
		else
			out.push(seg);
	}
	return '/' + out.join('/');
}

function globToRegExp(glob) {
	let re = '';
	for (const c of glob) {
		if (c === '*')
			re += '[^/]*';
		else if (c === '?')
			re += '[^/]';
		else
			re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp('^' + re + '$');
}

/* include { ... } */

function stripComments(text) {
	return text.split('\n').map(line => {
		let quote = null;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (quote) {
				if (c === '\\')
					i++;
				else if (c === quote)
					quote = null;
			}
			else if (c === '\'' || c === '"')
				quote = c;
			else if (c === '#')
				return line.slice(0, i);
		}
		return line;
	}).join('\n');
}

function includePatterns(text) {
	const patterns = [];
	const block = /(?:^|[\s}])include\s*\{([^}]*)\}/g;
	const src = stripComments(text);
	let m;
	while ((m = block.exec(src)) != null) {
		const token = /'([^']*)'|"([^"]*)"|([^\s'",;]+)/g;
		let t;
		while ((t = token.exec(m[1])) != null)
			patterns.push(t[1] ?? t[2] ?? t[3]);
	}
	return patterns;
}

/*
 * Both dae and honk resolve relative include paths against the directory of
 * the entry file, refuse files outside of it, only take *.dae and only expand
 * globs in the file name.
 */
function expandPattern(root, pattern) {
	const path = normalize(pattern.startsWith('/') ? pattern : root + '/' + pattern);
	if (!path.startsWith(root + '/'))
		return Promise.resolve([]);
	if (!/[*?]/.test(basename(path)))
		return Promise.resolve(path.endsWith('.dae') ? [ path ] : []);

	const dir = dirname(path), re = globToRegExp(basename(path));
	return L.resolveDefault(fs.list(dir), []).then(entries => entries
		.filter(e => e.type === 'file' && e.name.endsWith('.dae') && re.test(e.name))
		.map(e => dir + '/' + e.name)
		.sort());
}

/* Resolves to [ { path, text } ], entry first; text is null for a missing file. */
function collectFiles(entry, readText) {
	const root = dirname(entry), files = [], seen = new Set();

	const visit = path => {
		if (seen.has(path))
			return Promise.resolve();
		seen.add(path);

		const file = { path, text: null };
		files.push(file);

		return readText(path).then(text => {
			file.text = text;
			if (text == null)
				return;
			return Promise.all(includePatterns(text).map(p => expandPattern(root, p)))
				.then(lists => lists.flat().reduce((chain, child) => chain.then(() => visit(child)), Promise.resolve()));
		});
	};

	return visit(entry).then(() => files);
}

/* null for a missing file; any other error (permission, size) is raised, as
   an editor that showed such a file as new would overwrite it on save. */
function readFromDisk(path) {
	return fs.read(path).catch(err => {
		if (err.name !== 'NotFoundError')
			throw err;
		return null;
	});
}

/* Highlighting */

const TOKEN = new RegExp([
	/(#.*)/.source,                                            // comment
	/('(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?)/.source,           // string
	/(->|&&|\|\||!)/.source,                                   // operator
	/([A-Za-z_][\w-]*)(?=\s*\()/.source,                       // function: domain(, dip(, ...
	/([A-Za-z_][\w-]*)(?=\s*\{)/.source,                       // section: global {, routing {, ...
	/(-?\b\d+(?:\.\d+)*(?:\/\d+)?(?:ms|s|m|h|d)?\b)/.source    // number, duration, IPv4/CIDR
].join('|'), 'g');
const TOKEN_CLASS = [ null, 'c', 's', 'o', 'f', 'k', 'n' ];

function escapeHTML(s) {
	return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function highlightLine(line) {
	let html = '', pos = 0, m;

	// "key: value" at the start of a line
	const key = /^(\s*)([A-Za-z_][\w.-]*)(?=\s*:)/.exec(line);
	if (key) {
		html = escapeHTML(key[1]) + '<span class="du-p">' + escapeHTML(key[2]) + '</span>';
		pos = key[0].length;
	}

	TOKEN.lastIndex = pos;
	while ((m = TOKEN.exec(line)) != null) {
		const group = m.findIndex((v, i) => i > 0 && v !== undefined);
		html += escapeHTML(line.slice(pos, m.index));
		html += '<span class="du-' + TOKEN_CLASS[group] + '">' + escapeHTML(m[0]) + '</span>';
		pos = m.index + m[0].length;
	}

	return html + escapeHTML(line.slice(pos));
}

/*
 * The themes have no shared palette, and no single color reaches 4.5:1 on both
 * white and dark backgrounds. Each hue is mixed with the theme's own text color,
 * which darkens it on light themes and lightens it on dark ones.
 */
const STYLE = `
.du-editor { position: relative; height: 60vh; min-height: 300px; border: 1px solid rgba(128,128,128,.4); border-radius: 4px; overflow: hidden; }
.du-editor pre, .du-editor textarea {
	position: absolute; top: 0; left: 0; width: 100%; height: 100%; margin: 0; padding: 8px; border: 0; box-sizing: border-box;
	font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 4; overflow: auto;
	background: transparent; letter-spacing: normal; word-spacing: normal;
	/* Both layers wrap the same way, and both reserve the textarea's scrollbar,
	   so each line breaks at the same column and the caret stays on its text. */
	white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; scrollbar-gutter: stable;
}
.du-editor pre { pointer-events: none; overflow: hidden; color: inherit; }
/* Themes style code/span inside pre; anything that changes a glyph's box would
   push the colored text away from the caret, so only color is allowed here. */
.du-editor pre * { background: none; padding: 0; margin: 0; border: 0; font: inherit; }
.du-editor textarea { color: transparent; resize: none; outline: none; max-width: none; min-height: 0; }
.du-c { color: color-mix(in srgb, #8a8a8a 60%, currentColor); }
.du-s, .du-running { color: color-mix(in srgb, #2e9e5b 60%, currentColor); }
.du-o, .du-stopped { color: color-mix(in srgb, #d14d4d 60%, currentColor); }
.du-f { color: color-mix(in srgb, #c7841a 60%, currentColor); }
.du-k { color: color-mix(in srgb, #a35bd0 60%, currentColor); }
.du-n { color: color-mix(in srgb, #c4660a 60%, currentColor); }
.du-p { color: color-mix(in srgb, #3d7ed6 60%, currentColor); }
/* The page buttons save the settings of the status tab only; the editor has its own. */
body:has(.du-panes > [data-tab="status"]:not([data-tab-active="true"])) .cbi-page-actions { display: none; }
.du-panes .right { margin: .5em 0; }
.cbi-value:has(.du-web-ui:empty) { display: none; }
/* Bootstrap's warning and error colors, else Argon's: its warning text color
   (--warning itself is close to red) and --danger. A theme with neither
   leaves the line in its text color. */
.du-warn { color: color-mix(in srgb, var(--warn-color-high, var(--warning-heading-color)) 60%, currentColor); }
.du-error { color: color-mix(in srgb, var(--error-color-high, var(--danger)) 60%, currentColor); }
.du-log { max-height: 50vh; overflow: auto; white-space: pre-wrap; word-break: break-all; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
`;

function createEditor(text, onInput) {
	const pre = E('pre', { 'aria-hidden': 'true' });
	const textarea = E('textarea', { 'spellcheck': 'false', 'autocomplete': 'off', 'autocapitalize': 'off' });

	const syncScroll = () => {
		pre.scrollTop = textarea.scrollTop;
		pre.scrollLeft = textarea.scrollLeft;
	};
	const paint = () => {
		pre.innerHTML = textarea.value.split('\n').map(highlightLine).join('\n') + '\n';
		syncScroll();
	};

	textarea.value = text;
	// A theme may force the textarea's font size (Bootstrap uses 16px on phones
	// so that focusing it does not zoom); the highlight has to follow it.
	new ResizeObserver(() => { pre.style.fontSize = getComputedStyle(textarea).fontSize; }).observe(textarea);
	textarea.addEventListener('input', () => { paint(); onInput(); });
	textarea.addEventListener('scroll', syncScroll);
	// The text itself is transparent, so give the caret the color of the theme.
	textarea.addEventListener('focus', () => { textarea.style.caretColor = getComputedStyle(pre).color; });
	textarea.addEventListener('keydown', ev => {
		if (ev.key !== 'Tab' || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey)
			return;
		ev.preventDefault();
		// insertText keeps the browser's undo history; setRangeText does not fire input
		if (!document.execCommand('insertText', false, '    ')) {
			textarea.setRangeText('    ', textarea.selectionStart, textarea.selectionEnd, 'end');
			paint();
			onInput();
		}
	});

	paint();
	return {
		node: E('div', { 'class': 'du-editor' }, [ pre, textarea ]),
		textarea,
		setText(value) {
			if (textarea.value !== value) {
				textarea.value = value;
				paint();
			}
		}
	};
}

/*
 * The level a line states itself wins: honk's tracing (" WARN "), dae's
 * logrus ("level=warning"). Other lines take the syslog priority they were
 * logged with, as logread shows it (daemon.warn, daemon.err).
 */
function logLevelClass(entry) {
	const m = /\s(ERROR|WARN|INFO|DEBUG|TRACE)\s|\blevel=(\w+)/.exec(entry.msg);
	if (m) {
		const level = (m[1] ?? m[2]).toLowerCase();
		return /^(error|fatal|panic)$/.test(level) ? 'du-error' : /^warn/.test(level) ? 'du-warn' : '';
	}
	const severity = (entry.priority ?? 6) & 7;
	return severity <= 3 ? 'du-error' : severity === 4 ? 'du-warn' : '';
}

const ServiceView = view.extend({
	app: null,

	load() {
		return uci.load(this.app.name).then(() => {
			const entry = uci.get(this.app.name, 'config', 'config_file') || this.app.defaultConfig;
			// A file the page may not read leaves the status and the log usable,
			// so config_file can be set back from here.
			return Promise.all([ entry, collectFiles(entry, readFromDisk).catch(err => {
				ui.addNotification(null, E('p', _('Unable to read %s: %s').format(entry, err.message)), 'error');
				return [];
			}), this.queryPackages().catch(error => ({ error })), isBootEnabled(this.app.name) ]);
		});
	},

	/* Editor */

	renderFileTabs() {
		this.fileTabs.replaceChildren(...this.files.map(file => E('li', {
			'class': file.path === this.current ? 'cbi-tab' : 'cbi-tab-disabled'
		}, E('a', {
			'href': '#',
			'click': ev => { ev.preventDefault(); this.showFile(file.path); }
		}, (file.path === this.entry ? basename(file.path) : file.path.slice(dirname(this.entry).length + 1))
			+ (file.text == null ? ' ' + _('(new)') : '')
			+ (file.dirty ? ' *' : '')))));
	},

	showFile(path) {
		this.current = path;
		for (const file of this.files)
			file.editor.node.style.display = file.path === path ? '' : 'none';
		this.renderFileTabs();
	},

	setFiles(files) {
		const previous = new Map((this.files ?? []).map(f => [ f.path, f ]));

		this.files = files.map(file => {
			// Existing editors stay, so the caret and scroll position survive a
			// save or a rescan; unsaved edits are kept as they are.
			const old = previous.get(file.path);
			previous.delete(file.path);
			if (old) {
				if (!old.dirty)
					old.editor.setText(file.text ?? '');
				return Object.assign(old, { text: file.text });
			}

			file.dirty = false;
			file.editor = createEditor(file.text ?? '', () => {
				if (!file.dirty) {
					file.dirty = true;
					this.renderFileTabs();
				}
			});
			return file;
		});

		// Unsaved edits stay even when no include reaches the file any more.
		for (const old of previous.values())
			if (old.dirty)
				this.files.push(old);

		this.editorBox.replaceChildren(...this.files.map(f => f.editor.node));
		this.showFile(this.files.some(f => f.path === this.current) ? this.current : this.entry);
	},

	/* Picks up include lines that were just typed, without saving or losing edits. */
	handleRescan() {
		const buffers = new Map(this.files.filter(f => f.dirty).map(f => [ f.path, f.editor.textarea.value ]));

		return collectFiles(this.entry, path => buffers.has(path) ? Promise.resolve(buffers.get(path)) : readFromDisk(path))
			.then(files => this.setFiles(files));
	},

	handleSaveFiles() {
		const dirty = this.files.filter(f => f.dirty);
		if (!dirty.length)
			return Promise.resolve();

		// dae refuses configuration files that are readable by others; 0600 only
		// applies to new files, existing ones keep their mode. Text typed while
		// saving keeps the file dirty, so the reload below does not drop it.
		return Promise.all(dirty.map(f => {
			const text = f.editor.textarea.value;
			return fs.write(f.path, text, 0o600).then(() => { f.dirty = f.editor.textarea.value !== text; });
		}))
			.then(() => this.applySaved(),
				err => ui.addNotification(null, E('p', _('Unable to save: %s').format(err.message)), 'error'))
			.then(() => collectFiles(this.entry, readFromDisk))
			.then(files => this.setFiles(files));
	},

	/* After a save: a running service has its configuration checked, then the
	   init script reloads or restarts it. A stopped one stays stopped. */
	applySaved() {
		const { name, validate } = this.app;
		const saved = () => ui.addTimeLimitedNotification(null, E('p', _('Saved')), 5000, 'info');

		return isRunning(name).then(running => {
			if (!running)
				return saved();

			return (validate ? fs.exec(validate[0], [ ...validate[1], this.entry ]) : Promise.resolve({ code: 0 }))
				.then(res => {
					if (res.code !== 0) {
						ui.addNotification(_('Configuration is invalid, the service was not reloaded'),
							E('pre', {}, [ res.stderr || '', res.stdout || '' ].join('\n').trim()), 'error');
						return;
					}
					return callInitAction(name, 'reload').then(() =>
						ui.addTimeLimitedNotification(null, E('p', _('Saved, the service is reloading')), 5000, 'info'));
				});
		})
			.catch(err => ui.addNotification(null,
				E('p', _('Saved, but the service could not be reloaded: %s').format(err.message)), 'warning'));
	},

	/* Web UI */

	/* The link or the note of the webUi hook; the row is hidden while there is none (see STYLE) */
	async updateWebUi(files) {
		const webUi = await this.app.webUi(files);
		const nodes = [];
		if (webUi?.url)
			nodes.push(E('a', {
				'class': 'btn cbi-button',
				'href': webUi.url,
				'target': '_blank',
				'rel': 'noopener noreferrer'
			}, _('Open doona')));
		if (webUi?.note)
			nodes.push(webUi.url ? E('div', { 'class': 'cbi-value-description' }, webUi.note) : E('span', {}, webUi.note));
		this.webUiBox.replaceChildren(...nodes);
	},

	/* Unsaved edits in the editor would undo the change, be overwritten by it,
	   or be lost when the page reloads after Save & Apply. */
	webUiFlagConflict() {
		const dirty = this.files.find(file => file.dirty);
		return dirty ? _('Save or discard the unsaved changes of %s first').format(dirty.path) : '';
	},

	/* The webUiFlag is saved with the page: write the file, restart the
	   service when it runs, then show what the files say now. */
	async writeWebUiFlag(on) {
		const { name, webUiFlag } = this.app;
		const files = await collectFiles(this.entry, readFromDisk);
		const path = webUiFlag.path(files);
		const old = files.find(file => file.path === path)?.text ?? '';
		const text = webUiFlag.write(old, on);

		if (text !== old) {
			const conflict = this.webUiFlagConflict();
			if (conflict)
				throw new Error(conflict);

			await fs.write(path, text, 0o600);
			if (await isRunning(name)) {
				try {
					await callInitAction(name, 'restart');
					ui.addTimeLimitedNotification(null, E('p', _('Saved, the service is restarting')), 5000, 'info');
				}
				catch (err) {
					ui.addNotification(null, E('p', _('Saved, but the service could not be restarted: %s').format(err.message)), 'warning');
				}
			}
		}

		this.webUiState = on;
		await collectFiles(this.entry, readFromDisk).then(fresh => {
			this.setFiles(fresh);
			return this.updateWebUi(fresh);
		});
	},

	/* Packages */

	async packageCommand(args) {
		const command = '/usr/libexec/daeuniverse-pkg';
		// rpc.declare has no per-call timeout in LuCI 25.12. Only the index
		// refresh needs longer than the default; the helper bounds it to 25s.
		const result = args[0] === 'check' ? await new Promise((resolve, reject) => {
			const call = { object: 'file', method: 'exec', raise: true, resolve, reject };
			request.post(rpc.getBaseURL(), {
				jsonrpc: '2.0', id: 'daeuniverse-check', method: 'call',
				params: [ rpc.getSessionID(), 'file', 'exec', { command, params: args } ]
			}, { timeout: 28000, nobatch: true, credentials: true })
				.then(response => rpc.parseCallReply(call, response), reject);
		}) : await fs.exec(command, args);
		if (result.code !== 0) {
			const error = new Error(_('apk exited with code %s.').format(result.code));
			error.output = (result.stdout || '') + (result.stderr || '');
			error.exitCode = result.code;
			throw error;
		}
		return JSON.parse(result.stdout);
	},

	queryPackages(app = this.app.name) {
		return this.packageCommand([ 'installed', app ]);
	},

	/* `tag` is 'div' for text in the version field: LuCI's widgets render a
	   field's text in a div, and themes style a p in a section as section
	   prose, which Argon indents away from the value column. */
	packageHint(names, tag = 'p') {
		return E(tag, {}, _('To use this feed\'s version, run %s; other packages can be added to the same command.')
			.format('apk add ' + names.map(name => name + '@daeuniverse').join(' ')));
	},

	packageError(error, tag = 'p') {
		const output = error.output ?? error.message;
		const nodes = [ E(tag, {}, error.message), E('pre', { 'class': 'du-log' }, output) ];
		const pinned = [ 'dae', 'honk', 'luci-app-dae', 'luci-app-honk', 'luci-lib-daeuniverse',
			'v2ray-geoip', 'v2ray-geosite' ].filter(name =>
				new RegExp('breaks: world\\[' + name + '(?=[\\]@<>=~])').test(output));
		if (pinned.length)
			nodes.push(this.packageHint(pinned, tag));
		return nodes;
	},

	async handleCheckUpdates() {
		this.checkButton.disabled = true;
		this.packageStatus.replaceChildren(_('Checking for updates…'));
		try {
			const result = await this.packageCommand([ 'check', this.app.name ]);
			const installed = await this.queryPackages();
			if (!installed.some(pkg => pkg.name === this.app.name))
				throw new Error(_('Not installed'));
			const updates = result.packages.filter(pkg => installed.some(current => current.name === pkg.name));
			const warning = tag => result.warning ? [
				E(tag, {}, _('Package index update failed; using available indexes.')),
				E('pre', { 'class': 'du-log' }, result.warning)
			] : [];
			if (!updates.length) {
				this.packageStatus.replaceChildren(...warning('div'), E('div', {}, _('Up to date')));
				return;
			}
			this.packageStatus.replaceChildren();
			const current = Object.fromEntries(installed.map(pkg => [ pkg.name, pkg.version ]));
			const boxes = updates.map(pkg => E('input', { 'type': 'checkbox', 'checked': true, 'value': pkg.name,
				'change': () => { upgrade.disabled = !boxes.some(box => box.checked); } }));
			const upgrade = E('button', {
				'class': 'btn cbi-button-action',
				'click': () => this.handleUpgrade(boxes.filter(box => box.checked).map(box => box.value))
			}, _('Upgrade'));
			ui.showModal(_('Upgrade'), [
				...warning('p'),
				E('p', {}, _('Select the packages to upgrade:')),
				// Rows, not a list: Bootstrap gives li its muted text color.
				E('div', {}, updates.map((pkg, i) => E('div', {}, E('label', {}, [
					boxes[i], ' ', pkg.name + ': ' + current[pkg.name] + ' → ' + pkg.version
				])))),
				E('p', {}, _('Upgrading restarts the service and interrupts connections for a few seconds. Continue?')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					upgrade
				])
			]);
		}
		catch (error) {
			this.packageStatus.replaceChildren(...this.packageError(error, 'div'));
		}
		finally {
			this.checkButton.disabled = false;
		}
	},

	showPackageJob(status, message) {
		this.packageLog = E('pre', { 'class': 'du-log', 'aria-live': 'polite' }, status.log || '');
		this.packageProgress = E('p', { 'class': 'spinning' }, message || _('Upgrading…'));
		ui.showModal(_('Upgrade'), [ this.packageProgress, this.packageLog ]);
	},

	async handleUpgrade(packages) {
		this.checkButton.disabled = true;
		this.packageLaunchError = null;
		this.showPackageJob({});
		let previous;
		try {
			previous = await this.packageCommand([ 'status' ]);
		}
		catch (error) {
			this.finishPackageJob(this.packageError(error), false);
			return;
		}
		this.packagePreviousJob = previous.id;
		try {
			const status = previous.running ? previous :
				await this.packageCommand([ 'upgrade', this.app.name, ...packages ]);
			this.showPackageJob(status, previous.running || status.already_running ? _('An upgrade is already running.') : null);
		}
		catch (error) {
			if (error.exitCode != null || error.name === 'PermissionError') {
				this.finishPackageJob(this.packageError(error), false);
				return;
			}
			// A reload of rpcd can lose even the launch reply. Observe the job;
			// never submit a second transaction to guess whether it started.
			this.packageLaunchError = error;
		}
		this.packagePolling = true;
		this.packagePollFailure = null;
	},

	async pollPackageJob() {
		if (!this.packagePolling)
			return;
		try {
			const status = await this.packageCommand([ 'status' ]);
			if (this.packageLaunchError && status.id === this.packagePreviousJob)
				throw this.packageLaunchError;
			if (status.running) {
				this.checkButton.disabled = true;
				if (!this.packageProgress)
					this.showPackageJob(status, _('An upgrade is already running.'));
				else if (this.packagePollFailure)
					this.packageProgress.replaceChildren(_('Upgrading…'));
				this.packageLog.textContent = status.log;
				this.packageLog.scrollTop = this.packageLog.scrollHeight;
			}
			else if (status.code != null && this.packageProgress) {
				if (status.code !== 0) {
					const error = new Error(_('apk exited with code %s.').format(status.code));
					error.output = status.log;
					this.finishPackageJob(this.packageError(error), false);
				}
				else {
					// Query again after postinst (and rpcd) have finished. A pinned
					// world entry can make apk return zero without changing anything.
					const installed = (await Promise.all([ this.queryPackages('dae'), this.queryPackages('honk') ])).flat();
					const current = Object.fromEntries(installed.map(pkg => [ pkg.name, pkg.version ]));
					const before = Object.fromEntries(status.before.map(pkg => [ pkg.name, pkg.version ]));
					const unchanged = status.packages.filter(name => !current[name] || current[name] === before[name]);
					this.finishPackageJob([
						E('pre', { 'class': 'du-log' }, status.log),
						...(unchanged.length ? [
							E('p', {}, _('These packages were not upgraded: %s').format(unchanged.join(', '))),
							this.packageHint(unchanged)
						] : [ E('p', {}, _('Upgrade complete.')) ])
					], true);
				}
			}
			else {
				if (this.packageLaunchError)
					throw this.packageLaunchError;
				this.packagePolling = false;
				this.checkButton.disabled = false;
			}
			this.packagePollFailure = null;
			this.packageLaunchError = null;
		}
		catch (error) {
			// rpcd restarts while LuCI packages are installed. Allow two minutes
			// of failed polls, independently of how long the download takes.
			this.packagePollFailure ??= Date.now();
			if (Date.now() - this.packagePollFailure < 120000) {
				if (this.packageProgress)
					this.packageProgress.replaceChildren(_('Waiting for the package manager to reconnect…'));
				return;
			}
			this.finishPackageJob([
				E('p', {}, _('Unable to read upgrade status. The job may still be running; reload to reconnect.')),
				...this.packageError(error)
			], false);
		}
	},

	finishPackageJob(nodes, reload) {
		this.packagePolling = false;
		this.checkButton.disabled = false;
		this.packageProgress = null;
		ui.showModal(_('Upgrade'), [ ...nodes,
			E('div', { 'class': 'right' }, E('button', {
				'class': 'btn', 'click': reload ? () => window.location.reload() : ui.hideModal
			}, _('Close')))
		]);
	},

	/* Status and log */

	updateStatus() {
		const { name } = this.app;
		return isRunning(name).then(running => {
			document.getElementById(name + '-status')?.replaceChildren(
				E('em', { 'class': running ? 'du-running' : 'du-stopped' }, running ? _('Running') : _('Not running')));
			this.showServiceButtons(running);
		});
	},

	/* One button starts or stops, a second restarts a running service */
	showServiceButtons(running) {
		const toggle = this.toggleButton;
		toggle.style.display = '';
		toggle.className = 'btn cbi-button ' + (running ? 'cbi-button-negative' : 'cbi-button-action');
		toggle.textContent = running ? _('Stop') : _('Start');
		toggle.onclick = () => this.handleServiceAction(running ? 'stop' : 'start');
		this.restartButton.style.display = running ? '' : 'none';
	},

	/* Start, stop and restart act now; Start at boot stays as it is. */
	handleServiceAction(action) {
		const question = {
			stop: _('Stopping the service interrupts connections. Continue?'),
			restart: _('Restarting the service interrupts connections for a few seconds. Continue?')
		}[action];
		if (!question)
			return this.runServiceAction(action);

		const title = action === 'stop' ? _('Stop') : _('Restart');
		ui.showModal(title, [
			E('p', {}, question),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn ' + (action === 'stop' ? 'cbi-button-negative' : 'cbi-button-action'),
					'click': () => this.runServiceAction(action)
				}, title)
			])
		]);
	},

	async runServiceAction(action) {
		const { name, other } = this.app;
		const buttons = [ this.toggleButton, this.restartButton ];

		ui.hideModal();
		buttons.forEach(button => { button.disabled = true; });
		try {
			// dae and honk cannot run at the same time: the other one stops first,
			// and the start waits until it has let go of the network.
			let stoppedOther = false;
			if (action === 'start' && await isRunning(other)) {
				await callInitAction(other, 'stop');
				if (!await waitRunning(other, false, 20))
					return notify(_('%s did not stop, the service was not started.').format(other), 'warning');
				stoppedOther = true;
			}

			await callInitAction(name, action);
			const wanted = action !== 'stop';
			if (await waitRunning(name, wanted))
				notify({ start: _('The service started'), stop: _('The service stopped'),
					restart: _('The service restarted') }[action], 'info');
			else
				notify(wanted ? _('The service did not start, see the Log tab.') : _('The service did not stop.'), 'warning');
			if (stoppedOther)
				notify(_('%s was stopped first, because dae and honk cannot run at the same time.').format(other), 'info');
		}
		catch (err) {
			ui.addNotification(null, E('p', _('The service action failed: %s').format(err.message)), 'error');
		}
		finally {
			buttons.forEach(button => { button.disabled = false; });
			await this.updateStatus();
		}
	},

	updateBoot() {
		return isBootEnabled(this.app.name).then(enabled => {
			if (!this.bootBusy)
				this.bootSwitch.checked = enabled;
		});
	},

	/* The switch acts at once through the init script; there is nothing to save.
	   Only one of dae and honk may start at boot, so turning it on here turns it
	   off for the other. */
	async handleBootChange(on) {
		const { name, other } = this.app;

		this.bootBusy = true;
		this.bootSwitch.disabled = true;
		try {
			const turnedOff = on && await isBootEnabled(other);
			if (turnedOff)
				await callInitAction(other, 'disable');
			await callInitAction(name, on ? 'enable' : 'disable');
			notify(turnedOff
				? _('Start at boot is on; %s no longer starts at boot, because dae and honk cannot run at the same time.').format(other)
				: on ? _('Start at boot is on') : _('Start at boot is off'), 'info');
		}
		catch (err) {
			ui.addNotification(null, E('p', _('Unable to change Start at boot: %s').format(err.message)), 'error');
		}
		finally {
			this.bootBusy = false;
			this.bootSwitch.disabled = false;
			await this.updateBoot();
		}
	},

	updateLog() {
		// logd returns nothing for lines=0; 1000 is what LuCI's own log view reads.
		return L.resolveDefault(callLogRead(1000, false, true), []).then(entries => {
			const lines = entries
				.filter(e => this.app.logIdent.test(e.msg))
				.slice(-500)
				.map((e, i) => [ i ? '\n' : '', E('span', { 'class': 'du-p' }, new Date(e.time).toLocaleString()),
					'  ', E('span', { 'class': logLevelClass(e) }, e.msg) ]);
			const log = this.logBox;
			const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
			log.replaceChildren(...(lines.length ? lines.flat() : [ _('No log entries.') ]));
			if (atBottom)
				log.scrollTop = log.scrollHeight;
		});
	},

	async render([ entry, files, installed, bootEnabled ]) {
		const { name, title, defaultConfig } = this.app;

		document.head.appendChild(E('style', {}, STYLE));

		this.entry = entry;
		this.fileTabs = E('ul', { 'class': 'cbi-tabmenu' });
		this.editorBox = E('div');
		this.logBox = E('pre', { 'class': 'du-log' });
		this.setFiles(files);

		const m = new form.Map(name);
		const s = m.section(form.NamedSection, 'config', name);
		s.anonymous = true;

		this.toggleButton = E('button', { 'type': 'button', 'style': 'display: none' });
		this.restartButton = E('button', {
			'class': 'btn cbi-button', 'type': 'button', 'style': 'display: none',
			'click': () => this.handleServiceAction('restart')
		}, _('Restart'));
		let o = s.option(form.DummyValue, '_status', _('Status'));
		o.renderWidget = () => E('div', {}, [
			E('span', { 'id': name + '-status' }, E('em', {}, '…')),
			' ', this.toggleButton, ' ', this.restartButton
		]);

		this.packageStatus = E('div', { 'aria-live': 'polite' });
		this.checkButton = E('button', {
			'class': 'btn cbi-button', 'type': 'button',
			'click': () => this.handleCheckUpdates()
		}, _('Check for updates'));
		o = s.option(form.DummyValue, '_version', _('Version'));
		o.renderWidget = () => E('div', {}, [
			E('span', {}, installed.error ? _('Unable to read version: %s').format(installed.error.message)
				: installed.find(pkg => pkg.name === name)?.version || _('Not installed')),
			' ', this.checkButton, this.packageStatus
		]);

		// Not a UCI option: the rc.d link of the init script, which the switch
		// changes at once
		this.bootSwitch = E('input', {
			'type': 'checkbox', 'id': name + '-boot',
			'change': ev => this.handleBootChange(ev.target.checked)
		});
		this.bootSwitch.checked = bootEnabled;
		o = s.option(form.DummyValue, '_boot', _('Start at boot'),
			_('Starts automatically when the router boots; does not change whether it is running now.'));
		o.renderWidget = () => E('div', { 'class': 'cbi-checkbox' }, [
			this.bootSwitch, E('label', { 'for': name + '-boot' })
		]);

		o = s.option(form.Value, 'config_file', _('Configuration file'));
		o.placeholder = defaultConfig;
		o.rmempty = false;
		// The page may only read and write this directory (see the ACL)
		o.validate = (section_id, value) => {
			const dir = dirname(defaultConfig);
			return (normalize(value) === value && value.startsWith(dir + '/')) || _('Must be a file in %s').format(dir);
		};

		const { webUi, webUiFlag } = this.app;
		if (webUiFlag) {
			this.webUiState = webUiFlag.read(files);
			const flag = s.option(form.Flag, '_web_ui_enabled', _('Enable the doona web UI'),
				_('Unchecked, honk runs without the native API and doona. Saving restarts honk.'));
			flag.rmempty = false;
			flag.cfgvalue = () => this.webUiState ? '1' : '0';
			flag.write = (section_id, value) => this.writeWebUiFlag(value === '1');
			flag.remove = () => {};
			// Only a changed box can conflict. A checkbox widget reports '1' as its
			// value whatever its state, so the form value is read instead.
			flag.validate = section_id => (flag.formvalue(section_id) === '1') === this.webUiState
				|| this.webUiFlagConflict() || true;
		}

		if (webUi) {
			this.webUiBox = E('div', { 'class': 'du-web-ui' });
			o = s.option(form.DummyValue, '_web_ui', _('Web interface'));
			o.renderWidget = () => this.webUiBox;
		}

		return m.render().then(async mapNode => {
			if (webUi)
				await this.updateWebUi(files);

			const logPane = E('div', { 'data-tab': 'log', 'data-tab-title': _('Log') }, [
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'right' }, E('button', {
						'class': 'btn cbi-button',
						'click': ui.createHandlerFn(this, 'updateLog')
					}, _('Refresh'))),
					this.logBox
				])
			]);

			const panes = E('div', { 'class': 'du-panes' }, [
				E('div', { 'data-tab': 'status', 'data-tab-title': _('Service status') }, mapNode),
				E('div', { 'data-tab': 'config', 'data-tab-title': _('Configuration') }, [
					E('div', { 'class': 'cbi-section' }, [
						E('p', { 'class': 'cbi-section-descr' },
							_('Edit the configuration file and every file it includes; each tab is saved to its own file.')),
						this.fileTabs,
						this.editorBox,
						E('div', { 'class': 'right' }, [
							E('button', {
								'class': 'btn cbi-button',
								'click': ui.createHandlerFn(this, 'handleRescan')
							}, _('Re-read includes')),
							' ',
							E('button', {
								'class': 'btn cbi-button cbi-button-save',
								'click': ui.createHandlerFn(this, 'handleSaveFiles')
							}, _('Save files'))
						])
					])
				]),
				logPane
			]);

			// The log is only fetched while its tab is shown; jump to its end when it opens.
			logPane.addEventListener('cbi-tab-active', () =>
				this.updateLog().then(() => { this.logBox.scrollTop = this.logBox.scrollHeight; }));
			poll.add(() => Promise.all([
				this.updateStatus(),
				this.updateBoot(),
				logPane.getAttribute('data-tab-active') === 'true' ? this.updateLog() : null
			]), 5);

			const page = E('div', {}, [ E('h2', { 'name': 'content' }, title), panes ]);
			ui.tabs.initTabGroup(panes.childNodes);
			this.updateStatus();
			this.packagePolling = true;
			this.checkButton.disabled = true;
			poll.add(() => this.pollPackageJob(), 2);
			return page;
		});
	}
});

// LuCI instantiates the class a module returns, so the view is a member.
return baseclass.extend({ View: ServiceView });
