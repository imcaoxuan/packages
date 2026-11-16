#!/bin/sh
set -u

event="$1"

# Call hotplug first, giving scripts a chance to modify certificates before
# reloading the services
ACTION=$event hotplug-call cx-acme

case $event in
renewed)
	ubus call service event '{"type":"cx-acme.renew","data":{}}'
	;;
issued)
	ubus call service event '{"type":"cx-acme.issue","data":{}}'
	;;
esac