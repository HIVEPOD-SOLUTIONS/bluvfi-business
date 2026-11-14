# Deploying Bluvfi Business on EC2 (Docker + GitHub Actions)

Every push to `main` runs **CI** (lint, type check, tests, the demo, a production build, and a Docker build that starts the image and checks `/api/health`). When CI passes, **Deploy** builds the image, pushes it to Docker Hub and runs it on your EC2 Ubuntu server over SSH. Pull requests never deploy.

```
push to main ─▶ CI ─(passed)─▶ Deploy: build image ─▶ Docker Hub ─▶ SSH to EC2 ─▶ docker run ─▶ /api/health ─▶ done
                                                                                              └─(fails)─▶ previous image restored
```

On the server, Caddy holds the HTTPS certificate and forwards to the app, which listens on `127.0.0.1:3000` only. Sign-in needs HTTPS (the session cookie is `Secure`), so the app must be reached through a domain, not the bare IP.

The same image runs the **hosted demo** (`BLUVFI_DEMO=1`: fictional invoices, no keys, no funds) or the **live app**. Run one server for each if you want both.

## 1. Create the server (once)

1. **EC2 instance:** Ubuntu 24.04 (or 22.04), `t3.medium` (2 vCPU, 4 GB) or larger, 20 GB disk. The image is built in GitHub Actions, not on the server.
2. **Security group:** inbound 22 (SSH, ideally only from your IP), 80 and 443 (HTTP and HTTPS, from anywhere). Do not open 3000.
3. **Elastic IP:** attach one, so the address survives a restart.
4. **DNS:** an `A` record for your domain (for example `demo.yourdomain.com`) pointing at the Elastic IP.
5. **Run the setup script** on the server:

   ```bash
   scp -i your-key.pem scripts/ec2-setup.sh ubuntu@<elastic-ip>:~
   ssh -i your-key.pem ubuntu@<elastic-ip>
   bash ec2-setup.sh demo.yourdomain.com --demo     # the hosted demo
   # or: bash ec2-setup.sh app.yourdomain.com       # the live app
   ```

   It installs Docker and Caddy, adds 4 GB of swap, and creates `/home/ubuntu/bluvfi`:

   | Path | What it is |
   |---|---|
   | `/home/ubuntu/bluvfi/docker.env` | Container settings: `BLUVFI_DEMO=1` for the demo, `BLUVFI_TRUSTED_PROXY_HOPS=1` (Caddy) |
   | `/home/ubuntu/bluvfi/.env.local` | The live app's settings and secrets (empty for the demo). Mounted into the container; browser setup (`/setup`) writes to it |
   | `/home/ubuntu/bluvfi/data/` | The records: payments, policies, proofs. Survives every redeploy. **Back it up** |

6. **Live app only:** fill in `/home/ubuntu/bluvfi/.env.local` from [.env.example](../.env.example). At least `BLUVFI_MASTER_KEY` (`openssl rand -hex 32`), `NEAR_AI_API_KEY`, and either `BLUVFI_SIGNERS` or the Privy settings. Keep a copy of `BLUVFI_MASTER_KEY` somewhere safe: the records are sealed with it. Set `BLUVFI_BACKUP_DIR` or the `BLUVFI_BACKUP_S3_*` settings so records are backed up off the server. Never commit this file.

## 2. Connect GitHub (once)

**Docker Hub:** create a repository `bluvfi-business` (private is fine) and an access token (Account settings > Personal access tokens, read and write).

**SSH key for deploys:** on your own computer, make a key used only by GitHub Actions and allow it on the server:

```bash
ssh-keygen -t ed25519 -f bluvfi-deploy -N "" -C "github-actions-deploy"
ssh-copy-id -i bluvfi-deploy.pub -o "IdentityFile=your-key.pem" ubuntu@<elastic-ip>
```

**GitHub > Settings > Secrets and variables > Actions > New repository secret:**

| Secret | Value |
|---|---|
| `DOCKER_USERNAME` | Your Docker Hub username |
| `DOCKER_HUB_ACCESS_TOKEN` | The Docker Hub access token |
| `SSH_HOST` | The Elastic IP (or the domain) |
| `SSH_USERNAME` | `ubuntu` |
| `SSH_PRIVATE_KEY` | The whole contents of `bluvfi-deploy` (the private key file, not `.pub`) |

Optional **variables** (same page, Variables tab): `APP_DIR` (default `/home/ubuntu/bluvfi`) and `APP_PORT` (default `3000`; change it only if you also change the port in `/etc/caddy/Caddyfile`).

**Optional approval gate:** Settings > Environments > `production` > Required reviewers. Each deploy then waits for a click.

## 3. Deploy

- **Automatically:** push to `main`. Deploy starts when CI passes (CI takes about 15 minutes, mostly the tests).
- **By hand:** Actions > Deploy > Run workflow. It skips CI, so use it only for a commit that already passed.

The job prints the image it deployed and the app's last log lines. If `/api/health` does not answer 200 within 3 minutes, it prints the logs, starts the previous image again and fails.

Check it yourself:

```bash
curl https://demo.yourdomain.com/api/health     # {"ok":true,"mode":"demo",...}
```

The hosted demo signs in with `demo-signer-maya-token` (or `demo-signer-devon-token`), like `npm run demo:ui`. It rebuilds its fictional records each time the container starts.

## Reaching it on the public IP and port 3000 (no domain)

By default the app listens on 127.0.0.1 only, behind Caddy. To open `http://<public-ip>:3000` as well:

1. **GitHub > Settings > Secrets and variables > Actions > Variables:** add `APP_BIND` = `0.0.0.0`.
2. **Security group:** allow inbound TCP 3000 (from your IP, or from anywhere for a public demo).
3. **Sign-in over plain HTTP:** the session cookie is HTTPS-only, so add `BLUVFI_ALLOW_HTTP=1` to `/home/ubuntu/bluvfi/docker.env`. Without it, pages load but signing in does nothing.
4. **Rate limits:** if visitors reach the app on port 3000 only (no Caddy), set `BLUVFI_TRUSTED_PROXY_HOPS=0` in `docker.env`, so a visitor cannot pick their own address with an `X-Forwarded-For` header.
5. Run **Actions > Deploy > Run workflow** (or push to `main`).

Plain HTTP sends the session unencrypted: fine for the hosted demo, not for a live app with real money. For that, use a domain and Caddy (HTTPS).

## Operating it

```bash
sudo docker logs -f bluvfi-business                 # live logs
sudo docker ps                                      # status, including the health check
sudo docker restart bluvfi-business                 # after editing .env.local
sudo docker images                                  # images kept for rollback (unused ones go after 3 days)
```

**Roll back by hand** to an earlier commit's image:

```bash
sudo docker rm -f bluvfi-business
sudo docker run -d --name bluvfi-business --restart unless-stopped -p 127.0.0.1:3000:3000 \
  --env-file /home/ubuntu/bluvfi/docker.env \
  -v /home/ubuntu/bluvfi/.env.local:/app/.env.local -v /home/ubuntu/bluvfi/data:/app/.data \
  <dockerhub-user>/bluvfi-business:<commit-sha>
```

**Records:** they are sealed with `BLUVFI_MASTER_KEY` and live in `/home/ubuntu/bluvfi/data`. The app's own backups (Settings, or `BLUVFI_BACKUP_*`) copy them off the server, encrypted; an EBS snapshot of the volume is a second safety net. Losing the master key makes the records unreadable.

**Security notes:**
- The container runs as an unprivileged user and listens on 127.0.0.1 only; only Caddy is public.
- Secrets live in `/home/ubuntu/bluvfi/.env.local` (mode 600) on the server, never in the image or the repository.
- The deploy key can only log in as `ubuntu`. Restrict SSH in the security group to your IP if you can; GitHub's runners use many addresses, so leaving 22 open to them relies on key-only login (Ubuntu's default on EC2).
- `docker.env` and `.env.local` survive redeploys; the image is replaced each time.
