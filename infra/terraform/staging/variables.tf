variable "incus_remote" {
  description = "Name of the home server's Incus remote"
  type        = string
  default     = "home"
}

variable "incus_address" {
  description = "HTTPS address of the home server's Incus API"
  type        = string
}

variable "incus_token" {
  description = "Trust token from incus config trust add, needed only until the client certificate is trusted"
  type        = string
  default     = null
  sensitive   = true
}

variable "image" {
  description = "Cloud image with cloud-init, the same release as production"
  type        = string
  default     = "images:ubuntu/24.04/cloud"
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

variable "ssh_jump_host" {
  description = "SSH destination of the home server, which Ansible jumps through to reach the containers"
  type        = string
}

variable "collectors" {
  description = "Collector containers keyed by a stable name"
  type = map(object({
    cluster_id = number
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
