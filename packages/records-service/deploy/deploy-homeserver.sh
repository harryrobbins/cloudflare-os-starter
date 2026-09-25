#!/bin/sh
# Deploy an explicitly packaged Records release only to the authorised homeserver stack.
set -eu
archive=${1:?Usage: deploy-homeserver.sh /path/records-RELEASE.tar.gz}
case "$archive" in /*) ;; *) echo 'Use an absolute archive path' >&2; exit 2;; esac
release=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release"])' "$archive.manifest.json")
case "$release" in *[!a-f0-9]*|'') echo 'Invalid release ID' >&2; exit 2;; esac
[ ${#release} -eq 64 ] || exit 2
checksum=$(sha256sum "$archive" | cut -d ' ' -f 1)
ssh ms 'umask 077; mkdir -p "$HOME/containers/records/incoming" "$HOME/containers/records/releases"'
scp "$archive" "ms:containers/records/incoming/$release.tar.gz"
ssh ms sh -s -- "$release" "$checksum" <<'REMOTE'
set -eu
release=$1
checksum=$2
root="$HOME/containers/records"
cd "$root"
printf '%s  %s\n' "$checksum" "incoming/$release.tar.gz" | sha256sum -c -
destination="$root/releases/$release"
if [ ! -d "$destination" ]; then
 mkdir "$destination"
 tar -xzf "incoming/$release.tar.gz" -C "$destination"
fi
python3 - "$destination" "$release" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);manifest=json.loads((root/'release.json').read_text())
assert manifest['release']==sys.argv[2]
for name,digest in manifest['files'].items():
 path=(root/name).resolve();assert path.is_relative_to(root)
 assert hashlib.sha256(path.read_bytes()).hexdigest()==digest,name
print('Release file checksums verified:',len(manifest['files']))
PY
image="records-server:$release"
docker build -f "$destination/packages/records-service/Dockerfile" -t "$image" "$destination"
if [ ! -d "$root/secrets" ]; then
 docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$root:/records" "$image" node deploy/prepare-secrets.ts /records/secrets
fi
# Keep user-added environment settings; update only this release's known nonsecret settings.
python3 - "$root" "$image" <<'PY'
import os,pathlib,sys
root=pathlib.Path(sys.argv[1]);path=root/'.env';lines=path.read_text().splitlines() if path.exists() else []
settings={'RECORDS_SECRETS_DIR':str(root/'secrets'),'RECORDS_IMAGE':sys.argv[2], 'CLOUDFLARED_IMAGE':'cloudflare/cloudflared@sha256:b7a6db450ae2e2f773d4fbe9ffb48e7b5fc451e17329daab1b4dda5a2487e2cc'}
lines=[line for line in lines if line.split('=',1)[0] not in settings]+[k+'='+v for k,v in settings.items()]
path.write_text('\n'.join(lines)+'\n');os.chmod(path,0o600)
PY
compose="$destination/packages/records-service/deploy/compose.yaml"
run_compose() {
 if [ -f "$root/secrets/tunnel_token" ]; then
  docker compose --env-file "$root/.env" -f "$compose" -f "$destination/packages/records-service/deploy/homeserver.compose.yaml" -f "$destination/packages/records-service/deploy/tunnel.compose.yaml" "$@"
 else
  docker compose --env-file "$root/.env" -f "$compose" -f "$destination/packages/records-service/deploy/homeserver.compose.yaml" "$@"
 fi
}
run_compose config --quiet
run_compose up -d
attempt=0
until curl --fail --silent --max-time 3 http://127.0.0.1:8789/healthz >/dev/null; do
 attempt=$((attempt+1)); [ "$attempt" -lt 30 ] || { echo 'Gateway failed health check; inspect scoped compose logs' >&2; exit 1; }
 sleep 2
done
ln -sfn "releases/$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
cat > "$root/compose" <<'WRAPPER'
#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$root/secrets/tunnel_token" ]; then
 exec docker compose --env-file "$root/.env" -f "$root/current/packages/records-service/deploy/compose.yaml" -f "$root/current/packages/records-service/deploy/homeserver.compose.yaml" -f "$root/current/packages/records-service/deploy/tunnel.compose.yaml" "$@"
fi
exec docker compose --env-file "$root/.env" -f "$root/current/packages/records-service/deploy/compose.yaml" -f "$root/current/packages/records-service/deploy/homeserver.compose.yaml" "$@"
WRAPPER
chmod 700 "$root/compose"
docker image inspect "$image" --format '{{.Id}}' > "$destination/image-id.txt"
run_compose ps --format '{{.Service}} {{.Status}}'
printf 'Release deployed: %s\n' "$release"
REMOTE
