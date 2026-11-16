#!/bin/ash
# shellcheck disable=SC2154
# info is assigned via eval from the sourced dnsapi script
[ -d /usr/lib/cx-acme/client/dnsapi/ ] || exit 0
for f in /usr/lib/cx-acme/client/dnsapi/dns_*.sh; do
	[ -e "$f" ] || continue
	filename=$(basename -- "$f")
	dns_api="${filename%.*}"
	printf '%s\n' "$dns_api"
	info_var="${dns_api}_info"
	# shellcheck source=/dev/null
	. "$f"
	eval "info=\${${info_var}:-}"
	printf '%s\n\n' "$info"
done