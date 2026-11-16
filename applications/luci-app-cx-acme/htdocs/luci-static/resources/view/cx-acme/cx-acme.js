'use strict';
'require form';
'require fs';
'require uci';
'require ui';
'require view';
'require view.cx-acme.credentials as creds';
'require view.cx-acme.dnsapi as dnsapi';

return view.extend({
	load() {
		return Promise.all([
			L.resolveDefault(fs.list('/etc/ssl/cx-acme/'), []).then(files => {
				let certs = files.filter(f => f.name.match(/\.fullchain\.crt$/));
				return Promise.all(certs.map(f =>
					L.resolveDefault(fs.stat('/etc/ssl/cx-acme/' + f.name), null).then(st => {
						// stat() follows symlinks on every rpcd version,
						// yielding the real certificate mtime; older rpcd
						// fs.list only returns the link's own lstat data.
						// null means the link target is missing.
						f.target = st;
						return f;
					})
				));
			}),
			L.resolveDefault(fs.exec_direct('/usr/libexec/cx-acme-dnsinfo.sh'), ''),
			L.resolveDefault(fs.list('/usr/lib/cx-acme/client/dnsapi/'), []),
			L.resolveDefault(fs.lines('/proc/sys/kernel/hostname'), ''),
			L.resolveDefault(uci.load('ddns')),
		]);
	},

	render(data) {
		let certs = data[0];
		let apiInfos = dnsapi.parseFile(data[1]);
		let installedIds = (data[2] || [])
			.map(f => f.name)
			.filter(name => /^dns_.+\.sh$/.test(name))
			.map(name => name.replace(/\.sh$/, ''));
		let hasDnsApi = installedIds.length > 0;

		// APIs without structured _info metadata must still be selectable
		let knownIds = new Set(apiInfos.map(info => info.Id));
		for (let id of installedIds) {
			if (!knownIds.has(id))
				apiInfos.push({ Id: id, Name: id, Domains: '', OptsTitle: '', Opts: [], OptsAltTitle: '', OptsAlt: [] });
		}

		let hostname = data[3];
		let systemDomain = _guessDomain(hostname);
		let ddnsDomains = _collectDdnsDomains();
		let wikiUrl = 'https://github.com/acmesh-official/acme.sh/wiki/';
		let wikiInstructionUrl = wikiUrl + 'dnsapi';
		let m, s, o;

		m = new form.Map('cx-acme', 'cx-acme',
			_('This configures ACME (Let\'s Encrypt) automatic certificate installation. ' +
				'Simply fill out this to have the router configured with Let\'s Encrypt-issued ' +
				'certificates for the web interface.') + '<br />' +
			_('Note that the domain names in the certificate must already be configured to ' +
				'point at the router\'s public IP address.') + '<br />' +
			_('Once configured, issuing certificates can take a while. ' +
				'Check the logs for progress and any errors.') + '<br />' +
			_('Cert files are stored in') + ' <em>/etc/ssl/cx-acme</em>' + '<br />' +
			_('Note that renewal reuses the validation parameters stored at issuance time. ' +
				'If you change the validation method or DNS provider and renewal keeps failing, ' +
				'remove the corresponding state directory under /etc/cx-acme to force a fresh issuance.') + '<br />' +
			'<a href="https://openwrt.org/docs/guide-user/services/tls/acmesh" target="_blank">' + _('See more') + '</a>'
		);

		s = m.section(form.TypedSection, 'acme', _('ACME global config'));
		s.anonymous = true;

		o = s.option(form.Value, 'account_email', _('Account email'),
			_('Email address to associate with account key.') + '<br/>' +
			_('If a certificate wasn\'t renewed in time then you\'ll receive a notice at 20 days before expiry.')
		);
		o.rmempty = false;
		o.datatype = 'minlength(1)';

		o = s.option(form.Flag, 'debug', _('Enable debug logging'));
		o.rmempty = false;

		if (ddnsDomains.length > 0) {
			let ddnsDomainsList = ddnsDomains.map(d => d.domains[0]);
			o = s.option(form.Button, '_import_ddns');
			o.title = _('Found DDNS domains');
			o.inputtitle = _('Import') + ': ' + ddnsDomainsList.join();
			o.inputstyle = 'apply';
			o.onclick = function () {
				_importDdns(this.map, ddnsDomains);
			};
		}

		s = m.section(form.GridSection, 'cert', _('Certificate config'));
		s.anonymous = false;
		s.addremove = true;
		s.nodescriptions = true;

		s.tab('general', _('General Settings'));
		s.tab('challenge_dns', _('DNS Challenge Validation'));
		s.tab('advanced', _('Advanced Settings'));

		o = s.taboption('general', form.Flag, 'enabled', _('Enabled'));
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'validation_method', _('Validation method'),
			_('Standalone mode will use the built-in webserver of acme.sh to issue a certificate. ' +
				'Webroot mode will use an existing webserver to issue a certificate. ' +
				'DNS mode will allow you to use the DNS API of your DNS provider to issue a certificate.') + '<br />' +
			_('Validation via TLS ALPN') + ': ' + _('Validate via TLS port 443.') + '<br />' +
			'<a href="https://letsencrypt.org/docs/challenge-types/" target="_blank">' + _('See more') + '</a>'
		);
		o.value('standalone', 'HTTP-01 ' + _('Standalone'));
		o.value('webroot', 'HTTP-01 ' + _('Webroot Challenge Validation'));
		o.value('dns', 'DNS-01 ' + _('DNS Challenge Validation'));
		o.value('alpn', 'TLS-ALPN-01 ' + _('Validation via TLS ALPN'));
		o.default = 'standalone';
		o.rmempty = false;

		if (!hasDnsApi) {
			let dnsApiPkg = 'cx-acme-dnsapi';
			o = s.taboption('general', form.Button, '_install');
			o.depends('validation_method', 'dns');
			o.title = _('Package is not installed');
			o.inputtitle = _('Install package %s').format(dnsApiPkg);
			o.inputstyle = 'apply';
			o.onclick = function () {
				let link = L.url('admin/system/package-manager') + '?query=' + dnsApiPkg;
				window.open(link, '_blank', 'noopener');
			};
		}

		o = s.taboption('general', form.Value, 'listen_port', _('Listen port'),
			_('Port where to listen for ACME challenge requests. The port will be temporarily open during validation.') + '<br />' +
			_('It may be needed to change if your web server is behind reverse proxy and uses a different port.') + '<br />' +
			_('Standalone') + ': ' + _('Default') + ' 80.' + '<br />' +
			_('Webroot Challenge Validation') + ': ' + _('To temporary open port you can specify your web server port e.g. 80.') + '<br />' +
			_('Validation via TLS ALPN') + ': ' + _('Default') + ' 443.'
		);
		o.optional = true;
		o.placeholder = '80';
		o.datatype = 'port';
		o.depends('validation_method', 'standalone');
		o.depends('validation_method', 'webroot');
		o.depends('validation_method', 'alpn');
		o.modalonly = true;

		o = s.taboption('general', form.DummyValue, '_webroot_hint', _('Webroot directory'));
		o.rawhtml = true;
		o.default = _('Your web server must serve ACME challenge requests from') +
			' <em>/var/run/cx-acme/challenge</em> ' +
			_('on port 80. With uhttpd this is set up automatically.');
		o.depends('validation_method', 'webroot');
		o.modalonly = true;

		o = s.taboption('general', form.DynamicList, 'domains', _('Domain names'),
			_('Domain names to include in the certificate. ' +
				'The first name will be the subject name, subsequent names will be alt names. ' +
				'Note that all domain names must point at the router in the global DNS.'));
		o.datatype = 'list(string)';
		if (systemDomain)
			o.default = [systemDomain];
		o.validate = function (section_id, value) {
			if (!value)
				return true;

			if (_isSpecialUse(value.replace(/^\*\./, '')))
				return _('Domain is reserved for local or special use (e.g. home.arpa, .local, .test) and cannot be issued by public CAs');

			let labels = value.split('.');
			if (labels.length < 2)
				return _('Invalid domain. Allowed lowercase a-z, numbers and hyphen -');

			if (labels[0] == '*') {
				let method = this.section.children.filter(o => o.option == 'validation_method')[0].formvalue(section_id);
				if (method && method !== 'dns')
					return _('wildcards * require Validation method: DNS');
				labels = labels.slice(1);
				if (labels.length < 2)
					return _('Invalid wildcard domain');
			}

			for (let label of labels) {
				if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
					return _('Invalid domain. Allowed lowercase a-z, numbers and hyphen -');
			}

			return true;
		};

		o = s.taboption('challenge_dns', form.ListValue, 'dns', _('DNS API'),
			_('To use DNS mode to issue certificates, set this to the name of a DNS API supported by acme.sh. ') + '<br />' +
			_('%s for the list of available APIs. '
				.format(`<a href="https://github.com/acmesh-official/acme.sh/wiki/dnsapi" target="_blank">${_('See more')}</a>`)) + '<br />' +
			_('In DNS mode, the domain name does not have to resolve to the router IP. ') + '<br />' +
			_('DNS mode is also the only mode that supports wildcard certificates. ') + '<br />' +
			_('Using this mode requires the cx-acme-dnsapi package to be installed.'));
		o.depends('validation_method', 'dns');
		o.value('', '');
		for (let info of apiInfos) {
			let title = info.Name;
			if (info.Domains)
				title += ' (' + info.Domains + ')';
			o.value(info.Id, title);
		}
		o.modalonly = true;
		o.onchange = _handleCheckService;

		o = s.taboption('challenge_dns', form.DummyValue, '_wiki_url', _('See instructions'), '');
		o.rawhtml = true;
		o.default = '<a id="wikiInstructionUrl" href="%s" target="_blank" rel="noreferrer">Acme Wiki DNS API</a>'
			.format(wikiInstructionUrl);
		o.depends('validation_method', 'dns');
		o.modalonly = true;

		o = s.taboption('challenge_dns', form.Flag, '_dns_options_alt', _('Alternative DNS API options'), '');
		o.depends('validation_method', 'dns');
		o.modalonly = true;

		for (let info of apiInfos) {
			if (info.OptsTitle) {
				o = s.taboption('challenge_dns', form.DummyValue, '_dns_OptsTitle_' + info.Id, ' ', '');
				o.default = info.OptsTitle;
				o.depends({ 'dns': info.Id, '_dns_options_alt': '0' });
				o.modalonly = true;
			}
			for (let opt of info.Opts)
				_addDnsProviderField(s, info.Id, opt, false);
			if (info.OptsAltTitle) {
				o = s.taboption('challenge_dns', form.DummyValue, '_dns_OptsAltTitle_' + info.Id, ' ', '');
				o.default = info.OptsAltTitle;
				o.depends({ 'dns': info.Id, '_dns_options_alt': '1' });
				o.modalonly = true;
			}
			for (let opt of info.OptsAlt)
				_addDnsProviderField(s, info.Id, opt, true);
		}

		o = s.taboption('challenge_dns', form.DynamicList, 'credentials', _('DNS API credentials'),
			_('The credentials for the DNS API mode selected above. ') + '<br />' +
			_('%s for the format of credentials required by each API. '
				.format(`<a href="https://github.com/acmesh-official/acme.sh/wiki/dnsapi" target="_blank">${_('See more')}</a>`)) + '<br />' +
			_('Add entries in KEY=VAL format, without quotes. Values must not contain single quotes.') + '<br />' +
			_('Add multiple entries here to supply multiple credential variables.'));
		o.datatype = 'list(string)';
		o.depends('validation_method', 'dns');
		o.modalonly = true;
		o.validate = function (section_id, value) {
			if (!value)
				return true;
			return creds.validateEntry(value);
		};

		o = s.taboption('challenge_dns', form.Value, 'calias', _('Challenge Alias'),
			_('The challenge alias to use for ALL domains. ') + '<br />' +
			_("%s for the details of this process. "
				.format(`<a href="https://github.com/acmesh-official/acme.sh/wiki/DNS-alias-mode" target="_blank">${_('See more')}</a>`)) + '<br />' +
			_('LuCI only supports one challenge alias per certificate.'));
		o.depends('validation_method', 'dns');
		o.modalonly = true;

		o = s.taboption('challenge_dns', form.Value, 'dalias', _('Domain Alias'),
			_('The domain alias to use for ALL domains. ') + '<br />' +
			_("%s for the details of this process. "
				.format(`<a href="https://github.com/acmesh-official/acme.sh/wiki/DNS-alias-mode" target="_blank">${_('See more')}</a>`)) + '<br />' +
			_('LuCI only supports one challenge domain per certificate.'));
		o.depends('validation_method', 'dns');
		o.modalonly = true;

		o = s.taboption('challenge_dns', form.Value, 'dns_wait', _('Wait for DNS update'),
			_('Seconds to wait for a DNS record to be updated before continue.') + '<br />' +
			'<a href="https://github.com/acmesh-official/acme.sh/wiki/dnssleep" target="_blank">' + _('See more') + '</a>'
		);
		o.datatype = 'uinteger';
		o.depends('validation_method', 'dns');
		o.modalonly = true;

		o = s.taboption('advanced', form.ListValue, 'key_type', _('Key type'),
			_('Key size (and type) for the generated certificate. ' +
				'Changing this forces a fresh issuance on the next run.')
		);
		o.value('rsa2048', _('RSA 2048 bits'));
		o.value('rsa3072', _('RSA 3072 bits'));
		o.value('rsa4096', _('RSA 4096 bits'));
		o.value('ec256', _('ECC 256 bits'));
		o.value('ec384', _('ECC 384 bits'));
		o.default = 'ec256';
		o.rmempty = false;
		o.modalonly = true;

		o = s.taboption('advanced', form.Value, 'acme_server', _('ACME server URL'),
			_('Use a custom CA instead of Let\'s Encrypt.') + ' ' + _('Custom ACME server directory URL.') + '<br />' +
			'<a href="https://github.com/acmesh-official/acme.sh/wiki/Server" target="_blank">' + _('See more') + '</a>' + '<br />'
			+ _('Default') + ' <code>letsencrypt</code>'
		);
		o.placeholder = 'https://api.buypass.com/acme/directory';
		o.optional = true;
		o.modalonly = true;
		o.write = function (section_id, value) {
			// a custom server overrides staging; don't leave a stale flag behind
			if (value)
				uci.unset('cx-acme', section_id, 'staging');
			return form.Value.prototype.write.call(this, section_id, value);
		};

		o = s.taboption('advanced', form.Flag, 'staging', _('Use staging server'),
			_(
				'Get certificate from the Let\'s Encrypt staging server ' +
				'(use for testing; the certificate won\'t be valid).'
			)
		);
		o.depends('acme_server', '');
		o.optional = true;
		o.modalonly = true;

		o = s.taboption('advanced', form.Value, 'days', _('Days until renewal'));
		o.optional = true;
		o.placeholder = 'acme.sh default (60 days)';
		o.datatype = 'uinteger';
		o.modalonly = true;

		o = s.taboption('advanced', form.Value, 'cert_profile', _('Certificate Profile'));
		o.optional = true;
		o.modalonly = true;

		s = m.section(form.GridSection, '_certificates');
		s.render = L.bind(_renderCerts, this, certs);

		return m.render();
	}
});

/**
 * Is not an IP or a local domain without TLD
 */
function _isFqdn(domain) {
	let i = domain.lastIndexOf('.');
	if (i < 0)
		return false;
	let tld = domain.substr(i + 1);
	if (tld.length < 2)
		return false;
	return /^[a-z0-9-]+$/.test(tld);
}

// RFC 8375 / RFC 6761 / RFC 2606 special-use and common local suffixes;
// public CAs like Let's Encrypt cannot issue certificates for these
const SPECIAL_USE_SUFFIXES = [
	'home.arpa', 'local', 'localhost', 'invalid', 'test', 'example',
	'internal', 'lan', 'home'
];

function _isSpecialUse(domain) {
	return SPECIAL_USE_SUFFIXES.some(s => domain == s || domain.endsWith('.' + s));
}

function _guessDomain(hostname) {
	if (_isSpecialUse(hostname))
		return '';
	return _isFqdn(hostname) ? hostname : (_isFqdn(window.location.hostname) ? window.location.hostname : '');
}

function _collectDdnsDomains() {
	let ddnsDomains = [];
	let ddnsServices = uci.sections('ddns', 'service');
	for (let ddnsService of ddnsServices) {
		let dnsApi = '';
		let credentials = [];
		switch (ddnsService.service_name) {
			case 'duckdns.org':
				dnsApi = 'dns_duckdns';
				credentials = ['DuckDNS_Token=' + ddnsService['password']];
				break;
			case 'dynv6.com':
				dnsApi = 'dns_dynv6';
				credentials = ['DYNV6_TOKEN=' + ddnsService['password']];
				break;
			case 'afraid.org-v2-basic':
				dnsApi = 'dns_freedns';
				credentials = [
					'FREEDNS_User=' + ddnsService['username'],
					'FREEDNS_Password=' + ddnsService['password'],
				];
				break;
			case 'cloudflare.com-v4':
				dnsApi = 'dns_cf';
				credentials = ['CF_Token=' + ddnsService['password']];
				break;
		}
		if (credentials.length > 0 && ddnsService['domain']) {
			ddnsDomains.push({
				sectionId: ddnsService['.name'],
				domains: [ddnsService['domain']],
				dnsApi: dnsApi,
				credentials: credentials,
			});
		}
	}
	return ddnsDomains;
}

function _importDdns(map, ddnsDomains) {
	let certSections = uci.sections('cx-acme', 'cert');
	let certSectionNames = new Map();
	let certSectionDomains = new Map();
	for (let s of certSections) {
		certSectionNames.set(s['.name'], null);
		if (s.domains) {
			for (let d of s.domains)
				certSectionDomains.set(d, s['.name']);
		}
	}

	let importedDomains = {};
	let importedErrors = [];
	for (let ddnsDomain of ddnsDomains) {
		let sectionId = ddnsDomain.sectionId;
		// ensure unique sectionId
		if (certSectionNames.has(sectionId))
			sectionId += '_' + new Date().getTime();

		for (let d of ddnsDomain.domains) {
			let dupDomainSection = certSectionDomains.get(d);
			if (dupDomainSection) {
				importedErrors.push(_('The domain %s in DDNS %s is already configured in %s. Please check it after the importing.')
					.format(d, sectionId, dupDomainSection));
			}
		}

		importedDomains[sectionId] = {
			'domains': ddnsDomain.domains,
			'validation_method': 'dns',
			'dns': ddnsDomain.dnsApi,
			'credentials': ddnsDomain.credentials,
		};
	}

	ui.showModal(_('Check the configurations of the added domain certificates'), [
		E('pre', { 'style': 'white-space:pre-wrap; max-height:20em; overflow:auto' },
			JSON.stringify(importedDomains, null, 2)),
		E('div', importedErrors.map(e => E('div', { 'class': 'alert-message warning' }, e))),
		E('div', { 'class': 'right' }, [
			E('button', {
				'class': 'btn cbi-button',
				'click': ui.hideModal
			}, _('Cancel')),
			' ',
			E('button', {
				'class': 'btn cbi-button-action',
				'click': ui.createHandlerFn(this, function () {
					// save pending form edits first so they aren't lost,
					// then apply to trigger issuance via config.change
					return map.save().then(function () {
						for (let [sectionId, opts] of Object.entries(importedDomains)) {
							uci.add('cx-acme', 'cert', sectionId);
							for (let [key, val] of Object.entries(opts))
								uci.set('cx-acme', sectionId, key, val);
						}
						return uci.save();
					}).then(function () {
						return uci.apply();
					}).then(function () {
						window.location.reload();
					});
				})
			}, _('Save'))
		])
	]);
}

function _addDnsProviderField(s, apiId, opt, isOptsAlt) {
	let desc = '<code>' + opt.Name + '</code> ' + opt.Description;
	if (opt.Default)
		desc += '<br />' + _('Default') + ' <code>' + opt.Default + '</code>';

	let optionName = '_credentials_' + opt.Name;
	if (isOptsAlt)
		optionName += '_OptsAlt';

	let o = s.taboption('challenge_dns', form.Value, optionName, opt.Title, desc);
	o.depends({ 'dns': apiId, '_dns_options_alt': isOptsAlt ? '1' : '0' });
	o.modalonly = true;
	o.placeholder = opt.Default;
	o.cfgvalue = function (section_id) {
		let list = this.map.data.get(this.map.config, section_id, 'credentials');
		return creds.extractParamValue(list, opt.Name);
	};
	o.write = function (section_id, value) { };
	o.onchange = _handleEditChange;
	return o;
}

function _handleEditChange(event, section_id, newVal) {
	// Add the provider field value directly to the credentials DynList,
	// preserving all other entries verbatim
	let credentialsDynList = this.map.lookupOption('credentials', section_id)[0].getUIElement(section_id);
	let credsMap = creds.parseKeyValueList(credentialsDynList.getValue());
	let optName = this.option.substring('_credentials_'.length).replace(/_OptsAlt$/, '');
	if (newVal)
		credsMap.set(optName, newVal);
	else
		credsMap.delete(optName);
	credentialsDynList.setValue(creds.mapToKeyValueList(credsMap));
}

function _handleCheckService(event, section_id, newVal) {
	let el = document.getElementById('wikiInstructionUrl');
	if (el)
		el.href = 'https://github.com/acmesh-official/acme.sh/wiki/dnsapi#' + newVal;
}

function _renderCerts(certs) {
	let table = E('table', { 'class': 'table cbi-section-table', 'id': 'certificates_table' }, [
		E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th' }, _('Main Domain')),
			E('th', { 'class': 'th' }, _('Private Key')),
			E('th', { 'class': 'th' }, _('Public Certificate')),
			E('th', { 'class': 'th' }, _('Issued on')),
		])
	]);

	let rows = certs.map(function (cert) {
		let domain = cert.name.replace(/\.fullchain\.crt$/, '');
		// target holds the stat() result of the link destination
		let mtime = (cert.target && cert.target.mtime != null) ? cert.target.mtime : cert.mtime;
		let issueDate = new Date(mtime * 1000).toLocaleDateString();
		if (!cert.target)
			issueDate += ' (' + _('broken link') + ')';
		return [
			domain,
			'/etc/ssl/cx-acme/' + domain + '.key',
			'/etc/ssl/cx-acme/' + domain + '.fullchain.crt',
			issueDate,
		];
	});

	cbi_update_table(table, rows);

	return E('div', { 'class': 'cbi-section cbi-tblsection' }, [
		E('h3', _('Certificates')), table]);
}