#!/bin/sh
set -u

event="$1"

# Call hotplug first, giving scripts a chance to modify certificates before
# reloading the services. Fire both namespaces: cx-acme for new scripts,
# acme for compatibility with existing consumers (e.g. scripts installed in
# /etc/hotplug.d/acme by other packages or by the user).
ACTION=$event hotplug-call cx-acme
ACTION=$event hotplug-call acme

case $event in
renewed)
	ubus call service event '{"type":"cx-acme.renew","data":{}}'
	ubus call service event '{"type":"acme.renew","data":{}}'
	;;
issued)
	ubus call service event '{"type":"cx-acme.issue","data":{}}'
	ubus call service event '{"type":"acme.issue","data":{}}'
	# nginx/haproxy trigger on acme.renew only; emit it on first issuance
	# too so they pick up the new certificate without waiting for renewal
	ubus call service event '{"type":"acme.renew","data":{}}'
	;;
esac