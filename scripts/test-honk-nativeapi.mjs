// Tests for the native_api edit behind the doona switch of the honk LuCI page.
// Run: node --test scripts/test-honk-nativeapi.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../luci-app-honk/htdocs/luci-static/resources/honk/nativeapi.js', import.meta.url), 'utf8');
const nativeApi = new Function('baseclass', source)({ extend: object => object });

const defaults = readFileSync(new URL('../honk/files/config.dae', import.meta.url), 'utf8');
const on = text => nativeApi.apply(text, true);
const off = text => nativeApi.apply(text, false);
const enabled = text => nativeApi.isEnabled([ { path: '/x', text } ]);

test('the shipped configuration enables the native API', () => {
	assert.equal(enabled(defaults), true);
});

test('turning it off changes only the value', () => {
	const result = off(defaults);
	assert.equal(result, defaults.replace('        enabled: true\n        listen', '        enabled: false\n        listen'));
	assert.equal(enabled(result), false);
});

test('turning it on again restores the file byte for byte', () => {
	assert.equal(on(off(defaults)), defaults);
});

test('a state that already holds changes nothing', () => {
	assert.equal(on(defaults), defaults);
	assert.equal(off(off(defaults)), off(defaults));
});

test('quoted values are replaced as a whole', () => {
	assert.equal(on('experimental {\n  native_api {\n    enabled: \'false\'\n  }\n}\n'),
		'experimental {\n  native_api {\n    enabled: true\n  }\n}\n');
});

test('a block without the key gets it with the indentation of its neighbours', () => {
	assert.equal(on('experimental {\n    native_api {\n        ui: \'embedded\'\n    }\n}\n'),
		'experimental {\n    native_api {\n        enabled: true\n        ui: \'embedded\'\n    }\n}\n');
	assert.equal(off('native_api { ui: \'embedded\' }'), 'native_api { ui: \'embedded\' }');
	assert.equal(on('native_api { ui: \'embedded\' }'), 'native_api {\n    enabled: true\n    ui: \'embedded\' }');
});

test('a missing block goes into experimental with the shipped settings', () => {
	const text = 'experimental {\n    cache_file {\n        enabled: true\n    }\n}\n';
	const result = on(text);
	assert.equal(result, 'experimental {\n    cache_file {\n        enabled: true\n    }\n'
		+ '    native_api {\n        enabled: true\n        listen: \'0.0.0.0:9527\'\n        password_auth: true\n'
		+ '        config_write: true\n        ui: \'embedded\'\n    }\n}\n');
	assert.equal(enabled(result), true);
	assert.equal(off(text), text);
});

test('an empty experimental block is filled', () => {
	assert.equal(on('experimental {\n}\n'),
		'experimental {\n    native_api {\n        enabled: true\n        listen: \'0.0.0.0:9527\'\n'
		+ '        password_auth: true\n        config_write: true\n        ui: \'embedded\'\n    }\n}\n');
});

test('without experimental a new block is appended', () => {
	const text = 'global {\n    log_level: info\n}\n';
	const result = on(text);
	assert.ok(result.startsWith(text + '\nexperimental {\n    native_api {\n        enabled: true\n'));
	assert.ok(result.endsWith('    }\n}\n'));
	assert.equal(enabled(result), true);
	assert.equal(on('').startsWith('experimental {\n'), true);
	assert.equal(off(text), text);
});

test('comments and strings that mention the block or the key are skipped', () => {
	const text = [
		'# native_api { enabled: true }',
		'global {',
		'    note: \'native_api { enabled: true }\'  # enabled: true',
		'}',
		'experimental {',
		'    # native_api { enabled: false }',
		'    native_api {',
		'        # enabled: false',
		'        listen: \'enabled: false\'',
		'        enabled: false # was true',
		'    }',
		'}',
		''
	].join('\n');
	assert.equal(enabled(text), false);
	const result = on(text);
	assert.equal(result, text.replace('        enabled: false # was true', '        enabled: true # was true'));
	assert.equal(enabled(result), true);
	assert.equal(off(result), text);
});

test('only a mention in comments or strings counts as no block', () => {
	const text = '# native_api { enabled: true }\nglobal {\n    note: \'native_api { enabled: true }\'\n}\n';
	assert.equal(enabled(text), false);
	assert.equal(nativeApi.body(text), null);
	assert.equal(enabled(on(text)), true);
	assert.equal(on(text).split('experimental {').length, 2);
});

test('an apostrophe in a comment does not open a string', () => {
	const text = 'experimental {\n    # don\'t touch\n    native_api {\n        enabled: false\n    }\n}\n';
	assert.equal(on(text), text.replace('false', 'true'));
});

test('CRLF files stay CRLF', () => {
	const crlf = defaults.replace(/\n/g, '\r\n');
	const result = off(crlf);
	assert.equal(result, crlf.replace('enabled: true\r\n        listen', 'enabled: false\r\n        listen'));
	assert.equal(on(result), crlf);
	const added = on('experimental {\r\n    cache_file {\r\n    }\r\n}\r\n');
	assert.ok(!/[^\r]\n/.test(added));
	assert.equal(enabled(added), true);
	assert.ok(!/[^\r]\n/.test(on('global {\r\n}\r\n')));
});

test('the block is found across included files, the first one wins', () => {
	const files = [
		{ path: '/etc/honk/config.dae', text: 'global {}\ninclude { extra.dae }\n' },
		{ path: '/etc/honk/extra.dae', text: 'experimental {\n    native_api {\n        enabled: true\n    }\n}\n' }
	];
	assert.equal(nativeApi.isEnabled(files), true);
	assert.equal(nativeApi.targetPath(files), '/etc/honk/extra.dae');
	assert.equal(nativeApi.targetPath([ files[0], { path: '/etc/honk/x.dae', text: 'experimental {}\n' } ]), '/etc/honk/x.dae');
	assert.equal(nativeApi.targetPath([ files[0], { path: '/etc/honk/x.dae', text: null } ]), '/etc/honk/config.dae');
});

test('body() blanks comments and keeps strings', () => {
	assert.equal(nativeApi.body('native_api { listen: \'a#b\' # c\n}').replace(/\s+/g, ' '), ' listen: \'a#b\' ');
});
