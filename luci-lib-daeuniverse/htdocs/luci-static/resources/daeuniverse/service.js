'use strict';
'require baseclass';
'require view';
'require form';
'require fs';
'require ui';
'require uci';
'require rpc';
'require poll';

/*
 * The page shared by luci-app-dae and luci-app-honk, in three tabs: the
 * service status with the UCI switch, an editor for the configuration file and
 * every file it includes, and the service log. An app extends `View` and only
 * supplies `app`:
 *
 *   name           service, UCI package and init script
 *   other          the service that cannot run at the same time; turning this
 *                  one on here turns that one off in the same apply
 *   defaultConfig  entry file when UCI has none
 *   validate       [ command, args ] that take the entry file and exit non-zero
 *                  on a broken configuration, or null
 *   logIdent       RegExp matching the start of the service's log messages
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

// An option of a UCI package that may not exist: '' instead of an exception
// when it does not
const callUciGet = rpc.declare({
	object: 'uci',
	method: 'get',
	params: [ 'config', 'section', 'option' ],
	expect: { value: '' },
	reject: false
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
 * Mid-tone colors that stay readable on the light and dark variants of the
 * bundled themes; the themes have no shared palette to borrow from.
 */
const STYLE = `
.du-editor { position: relative; height: 60vh; min-height: 300px; border: 1px solid rgba(128,128,128,.4); border-radius: 4px; overflow: hidden; }
.du-editor pre, .du-editor textarea {
	position: absolute; top: 0; left: 0; width: 100%; height: 100%; margin: 0; padding: 8px; border: 0; box-sizing: border-box;
	font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 4; white-space: pre; overflow: auto;
	background: transparent; letter-spacing: normal; word-spacing: normal;
}
.du-editor pre { pointer-events: none; overflow: hidden; color: inherit; }
/* Themes style code/span inside pre; anything that changes a glyph's box would
   push the colored text away from the caret, so only color is allowed here. */
.du-editor pre * { background: none; padding: 0; margin: 0; border: 0; font: inherit; }
.du-editor textarea { color: transparent; resize: none; outline: none; max-width: none; min-height: 0; }
.du-c { color: #8a8a8a; }
.du-s, .du-running { color: #2e9e5b; }
.du-o, .du-stopped { color: #d14d4d; }
.du-f { color: #c7841a; }
.du-k { color: #a35bd0; }
.du-n { color: #c4660a; }
.du-p { color: #3d7ed6; }
/* The page buttons save the settings of the status tab only; the editor has its own. */
body:has(.du-panes > [data-tab="status"]:not([data-tab-active="true"])) .cbi-page-actions { display: none; }
.du-panes .right { margin: .5em 0; }
.du-log { max-height: 50vh; overflow: auto; white-space: pre-wrap; word-break: break-all; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
`;

function createEditor(text, onInput) {
	const pre = E('pre', { 'aria-hidden': 'true' });
	const textarea = E('textarea', { 'spellcheck': 'false', 'wrap': 'off', 'autocomplete': 'off', 'autocapitalize': 'off' });

	const syncScroll = () => {
		pre.scrollTop = textarea.scrollTop;
		pre.scrollLeft = textarea.scrollLeft;
	};
	const paint = () => {
		pre.innerHTML = textarea.value.split('\n').map(highlightLine).join('\n') + '\n';
		syncScroll();
	};

	textarea.value = text;
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

const ServiceView = view.extend({
	app: null,

	load() {
		// The other service may not be installed; its switch is then left alone
		return callUciGet(this.app.other, 'config', 'enabled').then(value =>
			uci.load(value !== '' ? [ this.app.name, this.app.other ] : this.app.name)
		).then(() => {
			const entry = uci.get(this.app.name, 'config', 'config_file') || this.app.defaultConfig;
			// A file the page may not read leaves the status and the log usable,
			// so config_file can be set back from here.
			return Promise.all([ entry, collectFiles(entry, readFromDisk).catch(err => {
				ui.addNotification(null, E('p', _('Unable to read %s: %s').format(entry, err.message)), 'error');
				return [];
			}) ]);
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

	/* After a save: check the configuration, then let the init script reload,
	   start or restart the service as its settings say. */
	applySaved() {
		const { name, validate } = this.app;
		const saved = () => ui.addTimeLimitedNotification(null, E('p', _('Saved')), 5000, 'info');

		if (uci.get(name, 'config', 'enabled') !== '1')
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
			})
			.catch(err => ui.addNotification(null,
				E('p', _('Saved, but the service could not be reloaded: %s').format(err.message)), 'warning'));
	},

	/* Status and log */

	updateStatus() {
		const { name } = this.app;
		return isRunning(name).then(running => {
			document.getElementById(name + '-status')?.replaceChildren(
				E('em', { 'class': running ? 'du-running' : 'du-stopped' }, running ? _('Running') : _('Not running')));
		});
	},

	updateLog() {
		// logd returns nothing for lines=0; 1000 is what LuCI's own log view reads.
		return L.resolveDefault(callLogRead(1000, false, true), []).then(entries => {
			const lines = entries
				.filter(e => this.app.logIdent.test(e.msg))
				.slice(-500)
				.map((e, i) => [ i ? '\n' : '', E('span', { 'class': 'du-p' }, new Date(e.time).toLocaleString()), '  ' + e.msg ]);
			const log = this.logBox;
			const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
			log.replaceChildren(...(lines.length ? lines.flat() : [ _('No log entries.') ]));
			if (atBottom)
				log.scrollTop = log.scrollHeight;
		});
	},

	render([ entry, files ]) {
		const { name, title, other, defaultConfig } = this.app;

		document.head.appendChild(E('style', {}, STYLE));

		this.entry = entry;
		this.fileTabs = E('ul', { 'class': 'cbi-tabmenu' });
		this.editorBox = E('div');
		this.logBox = E('pre', { 'class': 'du-log' });
		this.setFiles(files);

		const m = new form.Map(name);
		const s = m.section(form.NamedSection, 'config', name);
		s.anonymous = true;

		let o = s.option(form.DummyValue, '_status', _('Status'));
		o.rawhtml = true;
		o.cfgvalue = () => '<span id="' + name + '-status"><em>…</em></span>';

		o = s.option(form.Flag, 'enabled', _('Enable'),
			_('dae and honk cannot run at the same time; enabling %s turns %s off.').format(name, other));
		o.rmempty = false;
		// Both changes go out in one apply, and each init script follows its own
		// switch. A missing package has no enabled option and is left alone.
		o.write = function(section_id, value) {
			if (value === '1' && uci.get(other, 'config', 'enabled') === '1')
				uci.set(other, 'config', 'enabled', '0');
			return form.Flag.prototype.write.apply(this, arguments);
		};

		o = s.option(form.Value, 'config_file', _('Configuration file'));
		o.placeholder = defaultConfig;
		o.rmempty = false;
		// The page may only read and write this directory (see the ACL)
		o.validate = (section_id, value) => {
			const dir = dirname(defaultConfig);
			return (normalize(value) === value && value.startsWith(dir + '/')) || _('Must be a file in %s').format(dir);
		};

		return m.render().then(mapNode => {
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
				E('div', { 'data-tab': 'status', 'data-tab-title': _('Service status') }, [ mapNode ]),
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
				logPane.getAttribute('data-tab-active') === 'true' ? this.updateLog() : null
			]), 5);

			const page = E('div', {}, [ E('h2', { 'name': 'content' }, title), panes ]);
			ui.tabs.initTabGroup(panes.childNodes);
			this.updateStatus();
			return page;
		});
	}
});

// LuCI instantiates the class a module returns, so the view is a member.
return baseclass.extend({ View: ServiceView });
