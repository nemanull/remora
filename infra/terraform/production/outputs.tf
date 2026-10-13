output "core_ip" {
  description = "Public IPv4 of the core"
  value       = vultr_instance.core.main_ip
}

output "collector_ips" {
  description = "Public IPv4 of each collector"
  value       = { for name, instance in vultr_instance.collector : name => instance.main_ip }
}

output "core_domain" {
  description = "Name the collectors and the operator use for the core"
  value       = "${vultr_dns_record.core.name}.${var.domain}"
}

output "ansible_inventory" {
  description = "Ansible inventory for make inventory ENV=production"
  value = templatefile("${path.module}/../inventory.yaml.tftpl", {
    environment    = "production"
    admin_user     = var.admin_user
    ssh_public_key = var.ssh_public_key
    core_domain    = "${vultr_dns_record.core.name}.${var.domain}"
    acme_email     = var.acme_email
    tls_mode       = "acme"
    run_simulator  = false
    ssh_jump_host  = ""
    core_ip        = vultr_instance.core.main_ip
    collectors = {
      for name, instance in vultr_instance.collector :
      name => { ip = instance.main_ip, cluster_id = var.collectors[name].cluster_id }
    }
  })
}
