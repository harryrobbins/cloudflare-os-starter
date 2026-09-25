output "origin_url" {
  value = "https://${var.origin_hostname}"
}
output "tunnel_id" {
  value = cloudflare_zero_trust_tunnel_cloudflared.records.id
}
output "origin_access_audience" {
  value = cloudflare_zero_trust_access_application.origin.aud
}
