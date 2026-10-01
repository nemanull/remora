resource "vultr_dns_record" "core" {
  domain = var.domain
  name   = "core"
  type   = "A"
  data   = vultr_instance.core.main_ip
  ttl    = 300
}
