# Warehouse app (انبار قطعات)
#
# Run `make help` for the command list.
#
# Requires: node 22.13+ for local runs; docker for containers.
# Works from PowerShell, cmd or Git Bash on Windows, and from bash on Linux.

# ------------------------------------------------------------------- shell
# These recipes are bash. On Windows, make defaults to cmd.exe, so point SHELL
# at Git Bash by absolute path. The 8.3 short path (PROGRA~1) is deliberate:
# GNU Make 3.81 (GnuWin32) mis-parses a SHELL containing spaces.
ifeq ($(OS),Windows_NT)
    GIT_BASH_CANDIDATES := \
        C:/PROGRA~1/Git/bin/bash.exe \
        C:/PROGRA~2/Git/bin/bash.exe \
        $(subst \,/,$(LOCALAPPDATA))/Programs/Git/bin/bash.exe

    GIT_BASH := $(firstword $(foreach b,$(GIT_BASH_CANDIDATES),$(wildcard $(b))))

    ifeq ($(GIT_BASH),)
        $(error Git Bash not found. Install Git for Windows, or run make from a \
            Git Bash prompt. Looked in: $(GIT_BASH_CANDIDATES))
    endif

    SHELL := $(GIT_BASH)
else
    SHELL := /bin/bash
endif

.DEFAULT_GOAL := help

# ---------------------------------------------------------------- settings
HTTP_PORT   ?= 8090
API_URL     ?= http://127.0.0.1:$(HTTP_PORT)
ENV_FILE    ?= .env.prod

# Docker Desktop on Windows does not put docker on PATH for the non-login shell
# make spawns; resolve it with $(wildcard) and export the result.
DOCKER ?= docker
ifeq ($(OS),Windows_NT)
    DOCKER_CHECK := $(shell docker version 2>/dev/null)
    ifeq ($(DOCKER_CHECK),)
        DOCKER_CANDIDATES := \
            C:/PROGRA~1/Docker/Docker/resources/bin/docker.exe \
            C:/PROGRA~2/Docker/Docker/resources/bin/docker.exe \
            $(subst \,/,$(LOCALAPPDATA))/Programs/Docker/Docker/resources/bin/docker.exe \
            $(subst \,/,$(LOCALAPPDATA))/Programs/DockerDesktop/resources/bin/docker.exe
        DOCKER := $(firstword $(foreach d,$(DOCKER_CANDIDATES),$(wildcard $(d))))
        ifeq ($(DOCKER),)
            DOCKER := docker
        endif
    endif
endif
export DOCKER

# Git Bash rewrites absolute Linux paths like /data/x into C:/Program Files/Git/data/x when
# calling docker.exe. Recipes that pass such paths to docker prefix $(NOCONV) to switch that
# off for that one command. (Not exported globally: it would break curl's /dev/null and temp files.)
NOCONV := MSYS_NO_PATHCONV=1

# `env -u` strips any same-named variables from the caller's environment so
# that .env.prod is the only source of the compose variables (an empty exported
# variable would otherwise silently override the value from --env-file).
PROD_COMPOSE = env \
	-u VERSION -u HTTP_PORT -u HTTP_BIND -u TRUST_PROXY -u TZ -u APP_DOMAIN \
	$(DOCKER) compose -f docker-compose.prod.yml --env-file $(ENV_FILE)

.PHONY: help install run dev test icons \
        images images-bundle load-images prod-build prod-up up-prebuilt prod-down prod-logs prod-ps \
        prod-shell prod-credentials prod-clear-credentials local-up local-down \
        backup restore bootstrap ssl deploy-check deploy-health health smoke demo-data

# -------------------------------------------------------------------- help
help: ## Show this help
	@echo ""
	@echo "Warehouse app - available targets"
	@echo ""
	@if [ -t 1 ]; then C=$$'\033[36m'; R=$$'\033[0m'; else C=""; R=""; fi; \
	grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk -v c="$$C" -v r="$$R" 'BEGIN {FS = ":.*?## "}; {printf "  %s%-24s%s %s\n", c, $$1, r, $$2}'
	@echo ""
	@echo "Local try-out (no docker):   make install && make run      -> http://localhost:3000"
	@echo "Local container:             make local-up                 -> http://localhost:$(HTTP_PORT)"
	@echo "Deploy to a VPS:             make deploy-check, then ./scripts/bootstrap-vps.sh on the server"
	@echo ""

# --------------------------------------------------------- local development
install: ## Install Node dependencies
	@npm install

run: ## Run the app locally on http://localhost:3000 (data in ./data)
	@npm start

dev: ## Run with auto-restart on file changes
	@npm run dev

test: ## Run the automated tests
	@npm test

icons: ## Regenerate the PWA icons
	@node scripts/make-icons.js

# ------------------------------------------------------------------ images
images: ## Build the app image locally (VERSION=latest)
	$(DOCKER) build -t warehouse-app:$(or $(VERSION),latest) --build-arg VERSION=$(or $(VERSION),latest) .
	@$(DOCKER) images --format "{{.Repository}}:{{.Tag}}  {{.Size}}" | grep warehouse-app

images-bundle: ## Build the image here and pack dist/warehouse-image.tar.gz for a low-resource VPS
	@bash scripts/build-images.sh

load-images: ## Load an images-bundle tarball built elsewhere (run this ON the server). FILE=path
	@bash scripts/load-images.sh $(FILE)

# ---------------------------------------------------------- containerised prod
prod-build: ## Build the image through compose (needs .env.prod)
	@test -f $(ENV_FILE) || { echo "Create $(ENV_FILE) first: cp .env.prod.example .env.prod"; exit 1; }
	$(PROD_COMPOSE) build

prod-up: ## Build if needed and start the stack
	@test -f $(ENV_FILE) || { echo "Create $(ENV_FILE) first: cp .env.prod.example .env.prod"; exit 1; }
	$(PROD_COMPOSE) up -d --build
	@echo ""
	@echo "Starting. Check it with: make prod-ps && make health"

up-prebuilt: ## Start from an already-built/loaded image, without building
	@test -f $(ENV_FILE) || { echo "Create $(ENV_FILE) first: cp .env.prod.example .env.prod"; exit 1; }
	$(PROD_COMPOSE) up -d
	@echo ""
	@echo "Starting. Check it with: make prod-ps && make health"

prod-down: ## Stop the stack (data is kept in the warehouse-data volume)
	$(PROD_COMPOSE) down

prod-logs: ## Tail logs
	$(PROD_COMPOSE) logs -f --tail=200 app

prod-ps: ## Container status
	$(PROD_COMPOSE) ps

prod-shell: ## Run the admin CLI in the container. CMD="list-users" | "reset-password mokhtar" | "stats"
	$(NOCONV) $(DOCKER) exec -i warehouse-app node scripts/cli.js $(or $(CMD),list-users)

prod-credentials: ## Show the first-run usernames/passwords (if still present)
	@$(NOCONV) $(DOCKER) exec warehouse-app cat /data/FIRST-RUN-PASSWORDS.txt 2>/dev/null \
		|| echo "No credentials file (already removed). Reset one with: make prod-shell CMD='reset-password mokhtar'"

prod-clear-credentials: ## Delete the first-run credentials file from the volume
	@$(NOCONV) $(DOCKER) exec warehouse-app rm -f /data/FIRST-RUN-PASSWORDS.txt && echo "Removed."

local-up: ## Run the container on THIS machine for testing, using .env.prod.example (no TLS)
	@$(MAKE) up-prebuilt ENV_FILE=$(if $(wildcard .env.prod),.env.prod,.env.prod.example) || true
	@echo "If the image is missing, run: make images"

local-down: ## Stop the local test container
	@$(MAKE) prod-down ENV_FILE=$(if $(wildcard .env.prod),.env.prod,.env.prod.example)

# ----------------------------------------------------------------- data care
backup: ## Snapshot the database into ./backups (keeps the newest 30)
	@bash scripts/backup-prod.sh

restore: ## Restore a snapshot. FILE=backups/warehouse-YYYYMMDD-HHMM.db
	@test -n "$(FILE)" || { echo "FILE is required: make restore FILE=backups/warehouse-20261010-0230.db"; exit 1; }
	@bash scripts/restore-prod.sh "$(FILE)"

# ------------------------------------------------------------ easy deploy
bootstrap: ## One-shot setup on a fresh Ubuntu/Debian VPS: Docker, .env.prod, TLS. DOMAIN= LETSENCRYPT_EMAIL=
	@bash scripts/bootstrap-vps.sh

ssl: ## Configure host nginx + Let's Encrypt in front of the container
	@bash scripts/deploy-host-nginx.sh

# --------------------------------------------------------------- verification
deploy-check: ## Pre-flight checks before deploying
	@bash scripts/deploy-check.sh

health: ## Check the running instance (container + HTTP)
	@API_URL="$(API_URL)" bash scripts/health.sh

deploy-health: ## Check a deployed instance (HOST=https://your.domain)
	@test -n "$(HOST)" || { echo "HOST is required: make deploy-health HOST=https://warehouse.example.com"; exit 1; }
	@API_URL="$(HOST)" REMOTE=1 bash scripts/health.sh

smoke: ## Read-only end-to-end test. API_URL=... [SMOKE_USER= SMOKE_PASSWORD=]
	@API_URL="$(API_URL)" bash scripts/smoke-test.sh

demo-data: ## Load demo data over the API. API_URL= ADMIN_USER= ADMIN_PASSWORD= [KEEPER_USER= KEEPER_PASSWORD=]
	@API_URL="$(API_URL)" bash scripts/demo-data.sh
