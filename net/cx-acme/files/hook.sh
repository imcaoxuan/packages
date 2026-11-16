#!/bin/sh
# shellcheck disable=SC3043,SC2154
# SC3043: busybox ash supports local; SC2154: variables come from procd env
set -u
ACME=/usr/lib/cx-acme/client/acme.sh
LOG_TAG=cx-acme
NOTIFY=/usr/lib/cx-acme/notify

# shellcheck source=net/cx-acme/files/functions.sh
. /usr/lib/cx-acme/functions.sh

# Needed by acme.sh
export CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export NO_TIMESTAMP=1

link_certs() {
	local domain_dir="$1"
	local main_domain="$2"

	(
		umask 077
		cat "$domain_dir/fullchain.cer" "$domain_dir/$main_domain.key" >"$domain_dir/combined.cer"
	)

	# always refresh the links: the target directory changes when key_type
	# is switched (ec vs rsa), and stale links must survive a failed issuance
	ln -sf "$domain_dir/$main_domain.cer" "$CERT_DIR/$main_domain.crt"
	ln -sf "$domain_dir/$main_domain.key" "$CERT_DIR/$main_domain.key"
	ln -sf "$domain_dir/fullchain.cer" "$CERT_DIR/$main_domain.fullchain.crt"
	ln -sf "$domain_dir/combined.cer" "$CERT_DIR/$main_domain.combined.crt"
	ln -sf "$domain_dir/ca.cer" "$CERT_DIR/$main_domain.chain.crt"
}

open_port() {
	if ! add_nft_rule "$main_domain" "$listen_port"; then
		log err "Aborting $1 for $main_domain: could not open firewall port $listen_port"
		$NOTIFY "$1-failed"
		exit 1
	fi
}

handle_signal() {
	local notify_op="$1"
	local label_op="$2"
	wait_notify() {
		# wait for acme.sh child job to die, *then* notify about status
		wait
		log warn "$label_op aborted: $main_domain"
		$NOTIFY "${notify_op}-failed"
		exit 1
	}

	trap wait_notify TERM
	# try to kill the cgroup
	local cgroup
	cgroup=$(cut -d : -f 3 "/proc/$$/cgroup")
	case "$cgroup" in
	/services/cx-acme/*)
		# send SIGTERM to all processes in this process's cgroup. this
		# relies on procd's having set up the cgroup for the instance.
		local pids
		pids=$(cat "/sys/fs/cgroup${cgroup}/cgroup.procs" 2>/dev/null)
		if [ -n "$pids" ]; then
			# shellcheck disable=SC2086
			kill -TERM $pids 2>/dev/null
		fi
		;;
	esac

	# If we're here, either the cgroup wasn't as expected to be set up by
	# procd or killing the cgroup PIDs failed. Try to kill the process
	# group, assuming this process is the group leader. This is actually
	# unlikely since procd doesn't set service PGIDs (so they aren't group
	# leaders).
	kill -TERM -$$ 2>/dev/null

	# If we're here, cgroup-based killing was avoided or didn't work and
	# PGID-based killing didn't work. Fall back to the raciest option.
	trap "" TERM
	term_descendants() {
		local pid
		# `pgrep -P` returns nothing if given a non-existent PID
		# (even if it has live children), so children must be killed first
		for pid in "$@"; do
			# shellcheck disable=SC2046
			term_descendants $(pgrep -P "$pid")
			kill -TERM "$pid" 2>/dev/null
		done
	}
	# shellcheck disable=SC2046
	term_descendants $(jobs -p)

	del_nft_rule
	wait_notify
}

case $1 in
get)
	set --
	[ "$debug" = 1 ] && set -- "$@" --debug

	case $key_type in
	ec256)
		keylength=ec-256
		domain_dir="$state_dir/${main_domain}_ecc"
		set -- "$@" --ecc
		;;
	ec384)
		keylength=ec-384
		domain_dir="$state_dir/${main_domain}_ecc"
		set -- "$@" --ecc
		;;
	rsa2048 | rsa3072 | rsa4096)
		keylength=${key_type#rsa}
		domain_dir="$state_dir/$main_domain"
		;;
	*)
		log err "Unsupported key_type $key_type for $main_domain"
		exit 1
		;;
	esac

	log info "Running ACME for $main_domain with validation_method $validation_method"
	lock_file="$state_dir/acme-sh.lock"

	staging_moved=0
	if [ -e "$domain_dir" ]; then
		if [ "$staging" = 0 ] && grep -q "acme-staging" "$domain_dir/$main_domain.conf"; then
			mv "$domain_dir" "$domain_dir.staging"
			log info "Certificates are previously issued from a staging server, but staging option is disabled, moved to $domain_dir.staging."
			staging_moved=1
		else
			# state copied from the old acme package may reference legacy
			# hook/webroot paths in the saved domain conf; acme.sh reuses
			# those saved hooks on renewal, so rewrite them in place
			if [ -f "$domain_dir/$main_domain.conf" ]; then
				sed -i -e 's|/usr/lib/acme/|/usr/lib/cx-acme/|g' \
					-e 's|/var/run/acme/|/var/run/cx-acme/|g' \
					"$domain_dir/$main_domain.conf"
			fi
			set -- "$@" --renew --home "$state_dir" -d "$main_domain"
			log info "$ACME $*"
			trap "handle_signal renew Renewal" INT TERM
			open_port renew
			flock "$lock_file" "$ACME" "$@" &
			wait $!
			status=$?
			trap - INT TERM
			del_nft_rule

			case $status in
			0)
				link_certs "$domain_dir" "$main_domain"
				exit 0
				;;
			2)
				# renew skipped, but ensure the links exist (e.g. after
				# state migration) so services and the UI find the cert
				if [ -f "$domain_dir/fullchain.cer" ]; then
					link_certs "$domain_dir" "$main_domain"
				fi
				exit 0
				;;
			*)
				$NOTIFY renew-failed
				exit 1
				;;
			esac
		fi
	fi

	for d in $domains; do
		set -- "$@" -d "$d"
	done
	set -- "$@" --keylength "$keylength" --accountemail "$account_email"

	if [ "$acme_server" ]; then
		set -- "$@" --server "$acme_server"
	# default to letsencrypt because the upstream default may change
	elif [ "$staging" = 1 ]; then
		set -- "$@" --server letsencrypt_test
	else
		set -- "$@" --server letsencrypt
	fi

	if [ "$days" ]; then
		set -- "$@" --days "$days"
	fi

	if [ "$cert_profile" ]; then
		set -- "$@" --cert-profile "$cert_profile"
	fi

	case "$validation_method" in
	dns)
		set -- "$@" --dns "$dns"
		if [ "$dalias" ]; then
			set -- "$@" --domain-alias "$dalias"
			if [ "$calias" ]; then
				log err "Both domain and challenge aliases are defined. Ignoring the challenge alias."
			fi
		elif [ "$calias" ]; then
			set -- "$@" --challenge-alias "$calias"
		fi
		if [ "$dns_wait" ]; then
			set -- "$@" --dnssleep "$dns_wait"
		fi
		;;
	standalone)
		open_port issue
		set -- "$@" --standalone --listen-v6 --httpport "$listen_port"
		;;
	alpn)
		open_port issue
		set -- "$@" --alpn --listen-v6 --tlsport "$listen_port"
		;;
	webroot)
		mkdir -p "$CHALLENGE_DIR"
		open_port issue
		set -- "$@" --webroot "$CHALLENGE_DIR"
		;;
	esac

	set -- "$@" --issue --home "$state_dir"

	log info "$ACME $*"
	trap "handle_signal issue Issuance" INT TERM
	flock "$lock_file" "$ACME" "$@" \
		--pre-hook "$NOTIFY prepare" \
		--renew-hook "$NOTIFY renewed" &
	wait $!
	status=$?
	trap - INT TERM
	del_nft_rule

	case $status in
	0)
		link_certs "$domain_dir" "$main_domain"
		$NOTIFY issued
		;;
	*)
		if [ "$staging_moved" = 1 ]; then
			mv "$domain_dir.staging" "$domain_dir"
			log err "Staging certificate restored"
		elif [ -d "$domain_dir" ]; then
			failed_dir="$domain_dir.failed-$(date +%s)"
			mv "$domain_dir" "$failed_dir"
			log err "State moved to $failed_dir"
		fi
		$NOTIFY issue-failed
		exit 1
		;;
	esac
	;;
esac