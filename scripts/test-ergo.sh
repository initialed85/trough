#!/usr/bin/env bash
# Start/stop a throwaway Ergo on 127.0.0.1:16667 for the integration tests, using the
# same config as the Kubernetes manifests (deploy/k8s/base/ergo/ircd.yaml).
set -euo pipefail
name=trough-ergo-test
here="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-up}" in
up)
	docker rm -f "$name" >/dev/null 2>&1 || true
	docker run -d --name "$name" -p 16667:6667 \
		-v "$here/deploy/k8s/base/ergo:/config:ro" --tmpfs /ircd \
		--entrypoint sh ghcr.io/ergochat/ergo:v2.19.1 \
		-c 'cd /ircd && { [ -f /ircd/fullchain.pem ] || /ircd-bin/ergo mkcerts --conf /config/ircd.yaml --quiet; } && exec /ircd-bin/ergo run --conf /config/ircd.yaml' >/dev/null
	for _ in $(seq 1 40); do
		docker logs "$name" 2>&1 | grep -q "Server running" && exit 0
		sleep 0.25
	done
	docker logs "$name" >&2
	echo "ergo didn't come up" >&2
	exit 1
	;;
down) docker rm -f "$name" >/dev/null ;;
*)
	echo "usage: $0 up|down" >&2
	exit 2
	;;
esac
