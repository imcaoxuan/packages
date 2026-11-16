# shellcheck disable=SC3043,SC2154
# SC3043: busybox ash supports local; SC2154: debug is set by the caller
log() {
	prio="$1"
	shift
	if [ "$prio" != debug ] || [ "$debug" = 1 ]; then
		logger -t "$LOG_TAG" -p "daemon.$prio" -- "$@"
	fi
}

NFT_HANDLE=

valid_port() {
	case "$1" in
	'' | *[!0-9]*)
		return 1
		;;
	esac
	[ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

add_nft_rule() {
	local main_domain
	local listen_port
	main_domain="$1"
	listen_port="$2"

	[ -n "$listen_port" ] || return 0
	if ! valid_port "$listen_port"; then
		log err "Invalid listen port $listen_port for $main_domain"
		return 1
	fi

	if ! NFT_HANDLE=$(nft -a -e insert rule inet fw4 input tcp dport "$listen_port" counter accept comment \"ACME "$main_domain"\" | grep -o 'handle [0-9]\+'); then
		log err "Failed to add nftables rule for port $listen_port"
		return 1
	fi
	log debug "Added nftables rule for port $listen_port with $NFT_HANDLE"
}

del_nft_rule() {
	if [ "$NFT_HANDLE" ]; then
		# $NFT_HANDLE contains the string 'handle XX' so pass it unquoted to nft
		# shellcheck disable=SC2086
		if ! nft delete rule inet fw4 input $NFT_HANDLE; then
			log err "Failed to delete nftables rule $NFT_HANDLE"
		else
			log debug "Deleted nftables rule with $NFT_HANDLE"
		fi
		NFT_HANDLE=""
	fi
}