// Parser for the structured DNS API info emitted by cx-acme-dnsinfo.sh.
// See https://github.com/acmesh-official/acme.sh/wiki/DNS-API-Structural-Info-description
// Blocks are separated by blank lines; the final block is flushed at EOF
// so a missing trailing blank line does not drop the last API.

class DnsApiInfo {
	Id = '';
	Name = '';
	Domains = '';
	OptsTitle = '';
	Opts = [];
	OptsAltTitle = '';
	OptsAlt = [];
}

class DnsApiInfoOpt {
	Name = '';
	Title = '';
	Description = '';
	Default = '';
}

function parseFile(infoFileText) {
	let infos = [];
	if (!infoFileText)
		return infos;

	let lines = infoFileText.replace(/\r/g, '').split('\n');
	let block = [];

	let flush = function () {
		if (block.length >= 2) {
			let info = parseInfoLines(block);
			if (info.Id)
				infos.push(info);
		}
		block = [];
	};

	for (let line of lines) {
		if (line == '')
			flush();
		else
			block.push(line);
	}
	flush();

	return infos;
}

function parseInfoLines(lines) {
	let info = new DnsApiInfo();
	info.Id = lines[0];
	info.Name = lines[1] || '';

	let rest = lines.slice(2);
	let optsField = getFieldVal(rest, 'Options:');
	[info.OptsTitle, info.Opts] = parseOpts(optsField);
	let optsAltField = getFieldVal(rest, 'OptionsAlt:');
	[info.OptsAltTitle, info.OptsAlt] = parseOpts(optsAltField);
	info.Domains = getFieldVal(rest, 'Domains:');

	return info;
}

function parseOpts(options) {
	if (!options)
		return ['', []];

	let optLines = options.split('\n');
	let optsTitle = optLines.shift();
	let opts = [];

	for (let optLine of optLines) {
		let posName = optLine.indexOf(' ');
		if (posName <= 0)
			continue;

		let opt = new DnsApiInfoOpt();
		opt.Name = optLine.slice(0, posName);

		let remainder = optLine.slice(posName + 1);
		let posTitle = remainder.indexOf('.');
		if (posTitle < 0) {
			opt.Title = remainder;
		} else {
			opt.Title = remainder.slice(0, posTitle);
			opt.Description = remainder.slice(posTitle);

			let defaultMarker = ' Default: "';
			let defaultPos = opt.Description.indexOf(defaultMarker);
			if (defaultPos >= 0) {
				let valStart = defaultPos + defaultMarker.length;
				let valEnd = opt.Description.indexOf('"', valStart);
				if (valEnd < 0)
					valEnd = opt.Description.length;
				opt.Default = opt.Description.slice(valStart, valEnd);
				opt.Description = opt.Description.slice(0, defaultPos);
			}

			if (opt.Description.startsWith('. '))
				opt.Description = opt.Description.slice(2);
			else if (opt.Description == '.')
				opt.Description = '';
		}

		opts.push(opt);
	}

	return [optsTitle, opts];
}

function getFieldVal(lines, fieldName) {
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(fieldName)) {
			let firstVal = lines[i].substring(fieldName.length).trim();
			return fieldMultiLines(lines.slice(i + 1), firstVal);
		}
	}
	return '';
}

function fieldMultiLines(lines, fieldVal) {
	while (lines.length > 0) {
		if (!lines[0].startsWith(' '))
			break;
		fieldVal += '\n' + lines.shift().trim();
	}
	return fieldVal;
}

return L.Class.extend({
	parseFile: parseFile,
});