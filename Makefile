# Convenience targets. Windows users without `make` can run the docker compose commands directly.
.DEFAULT_GOAL := help
SHELL := /bin/bash

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n",$$1,$$2}'

verify-pins: ## M0 gate: confirm every pinned image tag resolves in the registry
	@for img in pgvector/pgvector:pg16 redis:7.4-alpine directus/directus:11.17.0 chatwoot/chatwoot:v4.13.0 caddy:2.8-alpine; do \
		docker manifest inspect $$img >/dev/null 2>&1 && echo "OK   $$img" || echo "FAIL $$img"; \
	done

setup: ## One-command idempotent install: secrets, stack, DB prep, HUMAN_AGENT flag, seed, bot wiring
	bash setup/bootstrap.sh

wire-bot: ## (Re)attach the AgentBot to every inbox — run after connecting the Facebook page
	bash setup/wire-bot.sh

up: ## Bring the stack up (detached)
	docker compose up -d

seed: ## Build schema + pg_trgm GIN index + idempotent catalog seed (re-runnable, no dupes)
	docker compose run --rm seed

verify-seed: ## Assert CAT-01: collections, GIN index, real SIRINE catalog, trigram, catalog_ro
	bash directus/seed/verify.sh

test: ## Offline unit tests for the agent helpers (no Docker needed)
	cd agent-handler && node --test

smoke: ## Live synthetic /agentbot test (run after `make setup`, needs GEMINI_API_KEY)
	bash setup/smoke-agent.sh

down: ## Stop the stack (keep volumes)
	docker compose down

nuke: ## Stop and DELETE volumes (wipes all local data)
	docker compose down -v

ps: ## Show service status
	docker compose ps

logs: ## Tail logs (all services)
	docker compose logs -f --tail=100

health: ## Show health state of each service
	docker compose ps --format 'table {{.Service}}\t{{.Status}}'
