terraform {
  required_version = "~> 1.14"

  required_providers {
    incus = {
      source  = "lxc/incus"
      version = "~> 1.0"
    }
  }
}

provider "incus" {
  generate_client_certificates = true
  accept_remote_certificate    = true
  default_remote               = var.incus_remote

  remote {
    name    = var.incus_remote
    address = var.incus_address
    token   = var.incus_token
  }

  remote {
    name     = "images"
    address  = "https://images.linuxcontainers.org"
    protocol = "simplestreams"
    public   = true
  }
}
