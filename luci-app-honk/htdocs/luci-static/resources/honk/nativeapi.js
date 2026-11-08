'use strict';
'require baseclass';

/*
 * The native_api block of honk's configuration is the only switch of the
 * doona web UI: honk-core has no command-line option for it. These functions
 * find that block and flip its `enabled` key without touching any other byte.
 */

/* Same length as the text, so offsets carry over to the original: comments
   become spaces and, unless `keepStrings`, quoted text becomes '_'. A quote
   that is not closed on its line ends there. */
function mask(text, keepStrings) {
	const blank = c => c === '\n' || c === '\r' ? c : '_';
	let out = '', quote = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === '\\' && i + 1 < text.length && text[i + 1] !== '\n') {
				out += keepStrings ? c + text[i + 1] : '__';
				i++;
			}
			else {
				const closing = c === quote || c === '\n';
				if (closing)
					quote = null;
				out += closing || keepStrings ? c : blank(c);
			}
		}
		else if (c === '\'' || c === '"') {
			quote = c;
			out += c;
		}
		else if (c === '#') {
			for (; i < text.length && text[i] !== '\n' && text[i] !== '\r'; i++)
				out += ' ';
			i--;
		}
		else
			out += c;
	}
	return out;
}

/* { open, close }: the positions of the braces of the first `name { ... }` */
function findBlock(code, name) {
	const head = new RegExp('(?:^|[\\s{;}])' + name + '\\s*\\{', 'g');
	const m = head.exec(code);
	if (!m)
		return null;
	const open = m.index + m[0].length - 1;
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === '{')
			depth++;
		else if (code[i] === '}' && --depth === 0)
			return { open, close: i };
	}
	return null;
}

function lineIndent(text, pos) {
	const start = text.lastIndexOf('\n', pos - 1) + 1;
	return /^[ \t]*/.exec(text.slice(start))[0];
}

/* What honk/files/config.dae ships */
function defaultBlock(indent, eol) {
	return [
		'native_api {',
		'    enabled: true',
		'    listen: \'0.0.0.0:9527\'',
		'    password_auth: true',
		'    config_write: true',
		'    ui: \'embedded\'',
		'}'
	].map(line => indent + line).join(eol);
}

return baseclass.extend({
	/* The inside of the first `name` block with comments blanked, or null */
	section(text, name) {
		const block = findBlock(mask(text), name);
		return block ? mask(text, true).slice(block.open + 1, block.close) : null;
	},

	/* The inside of the native_api block with comments blanked, or null */
	body(text) {
		return this.section(text, 'native_api');
	},

	/* The value of `key` in the first `name` block of the files: '' when the
	   key is missing or empty, null when no file has the block */
	value(files, name, key) {
		for (const file of files) {
			const body = this.section(file.text ?? '', name);
			if (body == null)
				continue;
			const match = new RegExp('(?:^|[\\s;,])' + key + '\\s*:\\s*(?:\'([^\']*)\'|"([^"]*)"|([^\\s;,]+))').exec(body);
			return match ? (match[1] ?? match[2] ?? match[3]) : '';
		}
		return null;
	},

	/* What stops `--store db` from starting with these files, one sentence
	   per key to change; honk checks the same when it imports them */
	storeProblems(files, dataDir) {
		const value = (name, key) => this.value(files, name, key) ?? '';
		const slashless = path => path.replace(/\/+$/, '');
		const problems = [];

		if (value('native_api', 'enabled') !== 'true')
			problems.push(_('Set experimental.native_api.enabled to true.'));
		if (value('native_api', 'config_write') !== 'true')
			problems.push(_('Set experimental.native_api.config_write to true.'));
		if (value('native_api', 'password_auth') !== 'true' && !value('native_api', 'secret'))
			problems.push(_('Set experimental.native_api.password_auth to true or set experimental.native_api.secret.'));
		if (slashless(value('global', 'data_dir')) !== slashless(dataDir))
			problems.push(_('Set global.data_dir to %s.').format(dataDir));
		if (value('clash_api', 'external_controller'))
			problems.push(_('Remove experimental.clash_api.external_controller.'));
		return problems;
	},

	/* Whether the files enable the native API */
	isEnabled(files) {
		for (const file of files) {
			const body = this.body(file.text ?? '');
			if (body != null)
				return /(?:^|[\s;,])enabled\s*:\s*(?:'true'|"true"|true)(?=[\s;,]|$)/.test(body);
		}
		return false;
	},

	/* The file `apply` has to change: the one with the block, else the one with
	   an experimental block, else the entry file */
	targetPath(files) {
		const has = name => files.find(file => file.text != null && findBlock(mask(file.text), name));
		return (has('native_api') ?? has('experimental') ?? files[0])?.path;
	},

	/* The text with `enabled` set to `on`; the text itself when nothing changes */
	apply(text, on) {
		const value = on ? 'true' : 'false';
		const eol = text.includes('\r\n') ? '\r\n' : '\n';
		const code = mask(text);
		const api = findBlock(code, 'native_api');

		if (api) {
			const inner = code.slice(api.open + 1, api.close);
			const key = /(^|[\s;,])(enabled\s*:\s*)('[^']*'|"[^"]*"|[^\s;,]+)/.exec(inner);
			if (key) {
				const start = api.open + 1 + key.index + key[1].length + key[2].length;
				const end = start + key[3].length;
				return text.slice(start, end) === value ? text : text.slice(0, start) + value + text.slice(end);
			}
			if (!on)
				return text;
			const rest = text.slice(api.open + 1);
			if (/^[ \t]*\r?\n/.test(inner)) {
				const first = /\n([ \t]*)\S/.exec(inner);
				return text.slice(0, api.open + 1) + eol + (first ? first[1] : lineIndent(text, api.open) + '    ') + 'enabled: true' + rest;
			}
			const indent = lineIndent(text, api.open) + '    ';
			return text.slice(0, api.open + 1) + eol + indent + 'enabled: true' + eol + indent + rest.replace(/^[ \t]+/, '');
		}

		if (!on)
			return text;

		const exp = findBlock(code, 'experimental');
		if (!exp) {
			const lead = text === '' ? '' : text.endsWith('\n') ? eol : eol + eol;
			return text + lead + 'experimental {' + eol + defaultBlock('    ', eol) + eol + '}' + eol;
		}

		const inner = code.slice(exp.open + 1, exp.close);
		const base = lineIndent(text, exp.open);
		const first = /\n([ \t]*)\S/.exec(inner);
		const indent = first ? first[1] : base + '    ';
		const end = exp.open + 1 + inner.trimEnd().length;
		const sameLine = !inner.slice(inner.trimEnd().length).includes('\n');
		return text.slice(0, end) + eol + defaultBlock(indent, eol) + (sameLine ? eol + base : '') + text.slice(end);
	}
});
