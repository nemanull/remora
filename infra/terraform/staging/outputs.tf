output "core_ip" {
  description = "Address of the core on the Incus bridge"
  value       = incus_instance.core.ipv4_address
}

output "collector_ips" {
  description = "Address of each collector on the Incus bridge"
  value       = { for name, instance in incus_instance.collector : name => instance.ipv4_address }
}

output "ansible_inventory" {
  description = "Ansible inventory for make inventory ENV=staging"
  value = templatefile("${path.module}/../inventory.yaml.tftpl", {
    admin_user    = var.admin_user
    core_domain   = "${incus_instance.core.name}.incus"
    tls_mode      = "internal"
    run_simulator = true
    ssh_jump_host = var.ssh_jump_host
    core_ip       = incus_instance.core.ipv4_address
    collectors = {
      for name, instance in incus_instance.collector :
      name => { ip = instance.ipv4_address, cluster_id = var.collectors[name].cluster_id }
    }
  })
}
