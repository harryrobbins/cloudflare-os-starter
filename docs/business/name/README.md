# Naming the business

Tools for screening candidate names. `excelcion` is a working name only and cannot be used.

## Setup

Companies House checks need a free REST API key from the
[developer hub](https://developer.company-information.service.gov.uk/) (Your applications → create
application → REST key) and set `COMPANIES_HOUSE_API_KEY_REST` in the repo-root `.env.local`
(git-ignored). `.env` or `.env.local` beside the script also work.
Domain checks need no key.

## Use

```sh
python3 namecheck.py domains Lumora "Brass Lantern"         # registry lookups, default TLDs
python3 namecheck.py companies Lumora                        # Companies House conflicts
python3 namecheck.py all --file candidates.txt --out results.md
python3 namecheck.py domains Lumora --tlds com,co.uk,uk,dev  # choose TLDs
```

Standard library only (Python 3.9+). Multi-word names are tried as `brasslantern` and `brass-lantern`.

## What the results mean

- **Domains** are checked against each registry: RDAP where the TLD publishes it, WHOIS otherwise
  (`.io`, `.co`). *Available* means not registered; a registrar may still price it as premium.
- **Companies House** searches the register and compares names the way the Registrar does, as an
  approximation: case, punctuation, spacing, a leading "the", `&`/`and`, web endings and `Ltd`/`Limited`
  style endings are ignored.
  - *blocked*: a live company has the same name.
  - *at risk*: a live company differs only by a generic ending such as Group, UK or Services, which
    can draw a "too like" objection.
  - *clear*: neither. Dissolved companies are listed but do not block.

These are screening results, not clearance. Before committing to a shortlisted name, confirm it with
the [official name checker](https://find-and-update.company-information.service.gov.uk/company-name-availability),
search [UK IPO trade marks](https://trademarks.ipo.gov.uk/ipo-tmtext) in the classes you'll trade in
(9, 35, 42), and check the "sensitive words" list if the name suggests a regulated or national status.
