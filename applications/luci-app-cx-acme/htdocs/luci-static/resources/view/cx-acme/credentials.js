// Credential entries are stored as bare KEY=VAL strings, without shell
// quoting: the backend passes them to procd verbatim (no eval). Legacy
// entries wrapped in paired quotes are accepted on read and normalized
// on write.

function parseKeyValueList(list) {
	let map = new Map();
	if (!list)
		return map;

	for (let entry of list) {
		if (typeof entry != 'string')
			continue;

		let pos = entry.indexOf('=');
		if (pos <= 0)
			continue;

		let key = entry.slice(0, pos);
		let val = entry.slice(pos + 1);

		if (val.length >= 2) {
			let first = val.charAt(0);
			let last = val.charAt(val.length - 1);
			if ((first == '"' && last == '"') || (first == "'" && last == "'"))
				val = val.slice(1, -1);
		}

		map.set(key, val);
	}

	return map;
}

function mapToKeyValueList(map) {
	let list = [];
	for (let [key, val] of map)
		list.push(key + '=' + val);
	return list;
}

function extractParamValue(list, name) {
	return parseKeyValueList(list).get(name) || '';
}

// Returns true when the entry is acceptable, otherwise an error message.
// Mirrors the backend validation in cx-acme.init.
function validateEntry(entry) {
	if (typeof entry != 'string')
		return 'Invalid credential entry';

	let pos = entry.indexOf('=');
	if (pos <= 0)
		return 'Credentials must use KEY=VAL format';

	let key = entry.slice(0, pos);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
		return 'Invalid credential key: ' + key;

	// acme.sh wraps saved values in unescaped single quotes, so a single
	// quote anywhere in the entry would corrupt its account.conf
	if (entry.indexOf("'") >= 0)
		return 'Credential values must not contain single quotes (acme.sh limitation)';

	return true;
}

return L.Class.extend({
	parseKeyValueList: parseKeyValueList,
	mapToKeyValueList: mapToKeyValueList,
	extractParamValue: extractParamValue,
	validateEntry: validateEntry,
});