mock_provider "cloudflare" {}

variables {
  account_id              = "00000000000000000000000000000001"
  zone_id                 = "00000000000000000000000000000002"
  name                    = "records-test"
  origin_hostname         = "records-origin.example.com"
  access_team_name        = "records-test"
  origin_service_token_id = "00000000-0000-0000-0000-000000000003"
}

run "origin_is_restricted" {
  command = plan
  assert {
    condition     = cloudflare_zero_trust_access_application.origin.policies[0].decision == "non_identity"
    error_message = "Origin must use Service Auth."
  }
  assert {
    condition     = length(cloudflare_zero_trust_access_application.origin.policies) == 1
    error_message = "Origin must have exactly the dedicated service policy."
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.records.config.ingress[0].origin_request.access.required
    error_message = "The connector must validate Access authorization."
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.records.config.ingress[1].service == "http_status:404"
    error_message = "Unmatched hostnames must fail closed."
  }
}

run "wildcard_hostname_rejected" {
  command = plan
  variables { origin_hostname = "*.example.com" }
  expect_failures = [var.origin_hostname]
}
