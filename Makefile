ENV ?= production
TAG ?=
VAULT_PASSWORD_FILE ?= $(HOME)/.config/remora/vault-password-$(ENV)
HOME_SERVER_DOCKER_HOST ?= ssh://admin@192.168.1.20

ifeq ($(filter $(ENV),production staging),)
$(error ENV must be production or staging)
endif

TERRAFORM = terraform -chdir=infra/terraform/$(ENV)
INVENTORY = inventory/$(ENV).yml
PLAYBOOK = cd infra/ansible && ANSIBLE_INVENTORY_UNPARSED_FAILED=True ANSIBLE_HOST_PATTERN_MISMATCH=error ansible-playbook -i $(INVENTORY) --vault-id $(ENV)@$(VAULT_PASSWORD_FILE)

.PHONY: up down logs infra-plan infra-apply inventory site deploy-core deploy-collectors deploy lab lab-home check-tag check-vault

up:
	docker compose --profile app up --build --detach

down:
	docker compose --profile app --profile monitoring down

logs:
	docker compose --profile app logs --follow --tail 100

infra-plan:
	$(TERRAFORM) init -input=false
	$(TERRAFORM) plan

infra-apply:
	$(TERRAFORM) init -input=false
	$(TERRAFORM) apply

inventory:
	$(TERRAFORM) output -raw ansible_inventory > infra/ansible/$(INVENTORY).tmp || { rm -f infra/ansible/$(INVENTORY).tmp; exit 1; }
	mv infra/ansible/$(INVENTORY).tmp infra/ansible/$(INVENTORY)

site: check-vault
	$(PLAYBOOK) site.yml

deploy-core: check-tag check-vault
	$(PLAYBOOK) deploy-core.yml -e image_tag=$(TAG)

deploy-collectors: check-tag check-vault
	$(PLAYBOOK) deploy-collectors.yml -e image_tag=$(TAG)

deploy: check-tag check-vault
	$(PLAYBOOK) deploy-core.yml -e image_tag=$(TAG)
	$(PLAYBOOK) deploy-collectors.yml -e image_tag=$(TAG)

lab:
	pnpm --filter scale-lab lab

lab-home:
	DOCKER_HOST=$(HOME_SERVER_DOCKER_HOST) pnpm --filter scale-lab lab

check-tag:
	$(if $(TAG),,$(error Set TAG to the full commit SHA of the images, for example make deploy TAG=$$(git rev-parse HEAD)))

check-vault:
	$(if $(wildcard infra/ansible/group_vars/all/vault.yml),$(error Move infra/ansible/group_vars/all/vault.yml to infra/ansible/group_vars/$(ENV)/vault.yml, because a vault in group_vars/all reaches the hosts of every environment))
