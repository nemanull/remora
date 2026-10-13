locals {
  ubuntu_2404 = 2284

  cloud_init = templatefile("${path.module}/../cloud-init.yaml.tftpl", {
    admin_user     = var.admin_user
    ssh_public_key = var.ssh_public_key
  })
}

resource "vultr_ssh_key" "admin" {
  name    = "remora-admin"
  ssh_key = var.ssh_public_key
}

resource "vultr_instance" "core" {
  region            = var.region
  plan              = var.core_plan
  os_id             = local.ubuntu_2404
  label             = "core"
  hostname          = "core"
  tags              = ["remora", "core"]
  enable_ipv6       = false
  backups           = "enabled"
  activation_email  = false
  firewall_group_id = vultr_firewall_group.core.id
  ssh_key_ids       = [vultr_ssh_key.admin.id]
  user_data         = local.cloud_init

  backups_schedule {
    type = "daily"
    hour = 5
  }

  # Postgres lives on this disk, so a plan that would destroy or replace the core fails instead.
  lifecycle {
    ignore_changes  = [user_data]
    prevent_destroy = true
  }
}

resource "vultr_instance" "collector" {
  for_each = var.collectors

  region            = coalesce(each.value.region, var.region)
  plan              = each.value.plan
  os_id             = local.ubuntu_2404
  label             = each.key
  hostname          = each.key
  tags              = ["remora", "collector"]
  enable_ipv6       = false
  backups           = "disabled"
  activation_email  = false
  firewall_group_id = vultr_firewall_group.collector.id
  ssh_key_ids       = [vultr_ssh_key.admin.id]
  user_data         = local.cloud_init

  lifecycle {
    ignore_changes = [user_data]
  }
}
