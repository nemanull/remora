variable "region" {
  description = "Vultr region of every host"
  type        = string
  default     = "nrt"
}

variable "admin_cidrs" {
  description = "IPv4 ranges allowed to reach SSH on every host"
  type        = list(string)

  validation {
    condition     = length(var.admin_cidrs) > 0 && alltrue([for cidr in var.admin_cidrs : can(cidrnetmask(cidr))])
    error_message = "List at least one IPv4 CIDR such as 203.0.113.7/32."
  }
}

variable "ssh_public_key" {
  description = "Public key installed for the admin user"
  type        = string
}

variable "admin_user" {
  description = "Sudo user that Ansible connects as"
  type        = string
  default     = "deploy"
}

variable "domain" {
  description = "Domain hosted in Vultr DNS, the core answers on core.<domain>"
  type        = string
}

variable "acme_email" {
  description = "Contact address of the ACME account that Caddy opens for the core's certificate"
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.acme_email)) && !can(regex("[@.]example\\.(com|net|org)$", lower(var.acme_email)))
    error_message = "Set a real contact address such as ops@your-domain.com, not one at an example domain."
  }
}

variable "core_plan" {
  description = "Vultr plan of the core host"
  type        = string
  default     = "vc2-2c-4gb"
}

variable "collectors" {
  description = "Collector hosts keyed by a stable name"
  type = map(object({
    cluster_id = number
    plan       = optional(string, "vc2-1c-1gb")
    region     = optional(string)
  }))

  validation {
    condition     = length(var.collectors) > 0
    error_message = "Define at least one collector."
  }

  validation {
    condition     = length(distinct([for collector in values(var.collectors) : collector.cluster_id])) == length(var.collectors)
    error_message = "Every collector needs its own cluster_id."
  }

  validation {
    condition     = alltrue([for collector in values(var.collectors) : collector.cluster_id >= 1 && floor(collector.cluster_id) == collector.cluster_id])
    error_message = "A cluster_id is a positive integer."
  }
}
