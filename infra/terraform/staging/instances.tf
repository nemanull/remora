locals {
  cloud_init = templatefile("${path.module}/../cloud-init.yaml.tftpl", {
    admin_user     = var.admin_user
    ssh_public_key = var.ssh_public_key
  })

  docker_ready_config = {
    "boot.autostart"                       = "true"
    "security.nesting"                     = "true"
    "security.syscalls.intercept.mknod"    = "true"
    "security.syscalls.intercept.setxattr" = "true"
    "cloud-init.user-data"                 = local.cloud_init
  }
}

resource "incus_instance" "core" {
  name  = "core"
  image = var.image

  config = merge(local.docker_ready_config, {
    "limits.cpu"    = "2"
    "limits.memory" = "4GiB"
  })

  wait_for {
    type = "ipv4"
  }

  wait_for {
    type = "cloud-init"
  }
}

resource "incus_instance" "collector" {
  for_each = var.collectors

  name  = each.key
  image = var.image

  config = merge(local.docker_ready_config, {
    "limits.cpu"    = "1"
    "limits.memory" = "1GiB"
  })

  wait_for {
    type = "ipv4"
  }

  wait_for {
    type = "cloud-init"
  }
}
