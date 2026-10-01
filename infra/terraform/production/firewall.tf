locals {
  admin_subnets = {
    for cidr in var.admin_cidrs : cidr => {
      subnet      = split("/", cidr)[0]
      subnet_size = tonumber(split("/", cidr)[1])
    }
  }
}

resource "vultr_firewall_group" "core" {
  description = "remora core"
}

resource "vultr_firewall_group" "collector" {
  description = "remora collectors"
}

resource "vultr_firewall_rule" "core_ssh" {
  for_each = local.admin_subnets

  firewall_group_id = vultr_firewall_group.core.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = each.value.subnet
  subnet_size       = each.value.subnet_size
  port              = "22"
  notes             = "ssh from ${each.key}"
}

resource "vultr_firewall_rule" "core_web" {
  for_each = toset(["80", "443"])

  firewall_group_id = vultr_firewall_group.core.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = each.value
  notes             = "caddy"
}

resource "vultr_firewall_rule" "collector_ssh" {
  for_each = local.admin_subnets

  firewall_group_id = vultr_firewall_group.collector.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = each.value.subnet
  subnet_size       = each.value.subnet_size
  port              = "22"
  notes             = "ssh from ${each.key}"
}
