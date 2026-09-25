variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "Supply the reviewed Cloudflare account ID."
  }
}
variable "zone_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.zone_id))
    error_message = "Supply the reviewed Cloudflare zone ID."
  }
}
variable "name" {
  type = string
  validation {
    condition     = can(regex("^records-[a-z0-9-]+$", var.name))
    error_message = "Use a distinct records- environment name."
  }
}
variable "origin_hostname" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]+\\.[a-z]{2,}$", var.origin_hostname))
    error_message = "Supply an exact hostname without wildcard, scheme or path."
  }
}
variable "access_team_name" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.access_team_name))
    error_message = "Supply the team subdomain only, without .cloudflareaccess.com."
  }
}
variable "origin_service_token_id" {
  description = "Existing dedicated edge-to-origin Access service token UUID (not client ID or secret)."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.origin_service_token_id))
    error_message = "Supply the dedicated service token resource UUID."
  }
}
