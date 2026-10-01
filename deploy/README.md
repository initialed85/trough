# Deploying trough

`k8s/base` is environment-neutral. `k8s/local` is only for a local cluster (Docker Desktop, or colima with
k3s on the docker runtime). For a real cluster, copy `k8s/local` to a new overlay (or another repo, e.g.
an ArgoCD-managed one) and change the following.

| Concern | Local overlay | Real cluster |
| --- | --- | --- |
| Steward image | `trough-steward:dev`, built locally, `imagePullPolicy: Never` | Push to your registry; set `images:` in the overlay and drop the `Never` patch |
| Steward password | Literal in a `secretGenerator` | A real Secret (sealed, external-secrets, ...) named `trough-steward`, key `password` |
| Account registration | Open, and the steward self-registers (`TROUGH_STEWARD_REGISTER=1`) | Close it: set `accounts.registration.enabled: false` in `scripts/gen-ergo-config.py` (or an overlay config), create accounts as an oper (`NS SAREGISTER`), and drop `TROUGH_STEWARD_REGISTER` |
| Require SASL | Off | Turn on `accounts.require-sasl.enabled` so unauthenticated clients can't connect |
| Exposure | `LoadBalancer` on 6667 (plaintext) | Only 6697 (TLS) outside the cluster. Mount a real cert over `/ircd/fullchain.pem` + `/ircd/privkey.pem` (cert-manager), or terminate TLS at a TCP proxy. Keep 6667 cluster-internal for the steward |
| Storage | Default StorageClass, 1Gi each | Whatever your cluster prefers; both Deployments are single-replica `Recreate` with RWO PVCs |
| Model for relevance | None | Optional Secret `trough-llm` with `url`, `model`, `key` (any OpenAI-compatible endpoint) |
| Opers | Disabled (placeholder hash) | Set an oper password with `ergo genpasswd` if you need admin commands |

Clients then use `trough init` with the external host, port 6697, TLS on.
