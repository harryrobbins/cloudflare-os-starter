# Separate origin boundary. Never adopt the existing OS Access application implicitly.
resource "cloudflare_zero_trust_access_application" "origin" {
  account_id                = var.account_id
  name                      = "${var.name}-origin"
  type                      = "self_hosted"
  domain                    = var.origin_hostname
  destinations              = [{ type = "public", uri = var.origin_hostname }]
  app_launcher_visible      = false
  service_auth_401_redirect = true
  policies = [{
    name       = "Only the Records edge service"
    decision   = "non_identity"
    precedence = 1
    include    = [{ service_token = { token_id = var.origin_service_token_id } }]
  }]
  lifecycle { prevent_destroy = true }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "records" {
  account_id = var.account_id
  name       = var.name
  config_src = "cloudflare"
  lifecycle { prevent_destroy = true }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "records" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.records.id
  config = {
    ingress = [
      {
        hostname = var.origin_hostname
        service  = "http://gateway:8788"
        origin_request = {
          access = {
            required  = true
            team_name = var.access_team_name
            aud_tag   = [cloudflare_zero_trust_access_application.origin.aud]
          }
        }
      },
      { service = "http_status:404" }
    ]
  }
  lifecycle { prevent_destroy = true }
}

# Publish DNS only after both policy and tunnel ingress exist.
resource "cloudflare_dns_record" "origin" {
  zone_id    = var.zone_id
  name       = var.origin_hostname
  type       = "CNAME"
  content    = "${cloudflare_zero_trust_tunnel_cloudflared.records.id}.cfargotunnel.com"
  proxied    = true
  ttl        = 1
  depends_on = [cloudflare_zero_trust_tunnel_cloudflared_config.records]
  lifecycle { prevent_destroy = true }
}
