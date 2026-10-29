'use strict';
'require daeuniverse.service as service';
'require rpc';

const callLanAddress = rpc.declare({
	object: 'uci',
	method: 'get',
	params: [ 'config', 'section', 'option' ],
	expect: { '': {} }
});

function isIp(host) {
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host))
		return host.split('.').every(part => Number(part) <= 255);
	if (!host.includes(':'))
		return false;
	try {
		return new URL('http://[' + host + ']/').hostname !== '';
	}
	catch (_) {
		return false;
	}
}

async function webUi(files) {
	for (const file of files) {
		const text = (file.text ?? '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|#[^\n]*/g,
			match => match.startsWith('#') ? '' : match);
		const block = /(?:^|[\s{;}])native_api\s*\{([^{}]*)\}/.exec(text);
		if (!block)
			continue;
		const value = key => {
			const match = new RegExp('(?:^|[\\s;,])' + key + '\\s*:\\s*(?:\'([^\']*)\'|"([^"]*)"|([^\\s;,]+))').exec(block[1]);
			return match ? (match[1] ?? match[2] ?? match[3]) : '';
		};
		if (value('enabled') !== 'true' || !value('ui'))
			return null;
		const listen = /^(?:\[([^\]]+)\]|(.+)):(\d+)$/.exec(value('listen'));
		if (!listen || Number(listen[3]) < 1 || Number(listen[3]) > 65535)
			return null;
		let host = listen[1] ?? listen[2];
		if (!isIp(host))
			return null;
		const port = listen[3];
		const luciHost = window.location.hostname.replace(/^\[|\]$/g, '');
		if (host.startsWith('127.') || host === '::1') {
			const destination = host.includes(':') ? '[' + host + ']' : host;
			return { note: E('span', {}, [
				_('doona listens on %s; open it through an SSH tunnel:').format(host),
				' ',
				E('code', {}, 'ssh -L ' + port + ':' + destination + ':' + port + ' root@' + luciHost),
				E('br'),
				_('To open it from the LAN instead, set %s and restart honk.').format('listen: \'0.0.0.0:' + port + '\'')
			]) };
		}
		let note;
		if (host === '0.0.0.0' || host === '::') {
			host = luciHost;
			if (!isIp(host)) {
				const reply = await L.resolveDefault(callLanAddress('network', 'lan', 'ipaddr'), {});
				const address = reply.value ?? '';
				const lan = (Array.isArray(address) ? address[0] ?? '' : address).split('/')[0];
				if (isIp(lan) && !lan.includes(':'))
					host = lan;
				else
					note = _('honk only accepts IP addresses; open LuCI by IP address.');
			}
		}
		return { url: 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port + '/', note };
	}
	return null;
}

return service.View.extend({
	app: {
		name: 'honk',
		title: 'honk',
		webUi,
		// Both create dae0/daens and hook the same interfaces: only one may run.
		other: 'dae',
		defaultConfig: '/etc/honk/config.dae',
		// honk-core has no offline check; a broken file is reported in the log.
		validate: null,
		// procd forwards stdout as "honk-core[pid]:", the init script logs as "honk:".
		logIdent: /^honk(-core)?(\[\d+\])?: /
	}
});
