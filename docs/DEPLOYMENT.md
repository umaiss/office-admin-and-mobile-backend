# Deploying OB Track to AWS EC2

A step-by-step runbook. Commands marked **[local]** run on your machine; **[ec2]** run on the server over SSH.

**Target setup:** Docker Compose on one EC2 instance — API + PostgreSQL + nginx, deployed by `git pull`, over plain HTTP at the instance's public IP.

> ⚠ **This is an HTTP deployment.** Passwords and tokens travel unencrypted and anyone on the network path can read them. That is acceptable for testing and for connecting your own mobile app during development. **It is not safe for real employees' data.** Add a domain and HTTPS before going live — see [Upgrading to HTTPS](#upgrading-to-https).

---

## 0. What you need

- An EC2 instance running **Amazon Linux 2023** (these instructions) or **Ubuntu** (see the Ubuntu note in §2)
- Its **public IP** and your **`.pem` key file**
- Your GitHub repository URL
- **At least 2GB RAM**, or a swap file (§2). A 1GB `t2.micro` will run out of memory during the TypeScript build and fail with a confusing "killed" message.

Check which OS you have:

```bash
cat /etc/os-release
```

`ID="amzn"` means Amazon Linux — use `dnf` and the `ec2-user` account. `ID=ubuntu` means Ubuntu — use `apt` and the `ubuntu` account.

---

## 1. Security group — open the right ports, and only those

In the AWS console: **EC2 → Instances → your instance → Security → Security groups → Edit inbound rules.**

| Type | Port | Source | Why |
|---|---|---|---|
| SSH | 22 | **My IP** | Your admin access. Never `0.0.0.0/0` — open SSH is scanned and brute-forced continuously |
| HTTP | 80 | `0.0.0.0/0` | The API itself |

**Do not open 5432.** The database must never be reachable from the internet. Our compose file deliberately does not publish that port; the API reaches Postgres over a private container network. An exposed Postgres port is found by automated scanners within minutes.

---

## 2. Prepare the server — Amazon Linux 2023

```bash
ssh -i your-key.pem ec2-user@YOUR_EC2_IP
```

**[ec2]** Install Docker and git:

```bash
sudo dnf install -y docker git
```

Start the Docker service and enable it at boot. Unlike the Ubuntu installer, the
`dnf` package does **not** start the daemon for you:

```bash
sudo systemctl enable --now docker
```

Let `ec2-user` talk to Docker without `sudo`:

```bash
sudo usermod -aG docker ec2-user
```

**Log out and back in.** Group membership is read only at login, so the change
does nothing in your current session:

```bash
exit
```

Reconnect, then confirm:

```bash
docker run --rm hello-world
```

### Docker Compose v2

Amazon Linux ships the Docker engine but **not** the Compose plugin, so
`docker compose` will report "is not a docker command" until you install it.

`uname -m` selects the right binary automatically — Graviton instances
(`t4g`, `c7g`, …) are `aarch64`, everything else is `x86_64`. Downloading the
wrong one gives a confusing "cannot execute binary file" error:

```bash
sudo mkdir -p /usr/local/lib/docker/cli-plugins && sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose && sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```

Verify:

```bash
docker compose version
```

> Installed system-wide rather than in `~/.docker/cli-plugins` so it also works
> under `sudo`, which matters the first time you debug something as root.

### buildx

Compose v2 delegates image building to **buildx**, which Amazon Linux also
omits. Without it every build fails with:

```
compose build requires buildx 0.17.0 or later
```

Note the architecture naming differs from Compose — buildx uses `amd64`/`arm64`
where Compose uses `x86_64`/`aarch64`, which is why the command below maps it
rather than reusing `uname -m` directly:

```bash
BX_ARCH=$( [ "$(uname -m)" = "aarch64" ] && echo arm64 || echo amd64 ) && BX_VER=$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) && sudo curl -SL "https://github.com/docker/buildx/releases/download/${BX_VER}/buildx-${BX_VER}.linux-${BX_ARCH}" -o /usr/local/lib/docker/cli-plugins/docker-buildx && sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx
```

Verify:

```bash
docker buildx version
```

> If the GitHub API call is rate-limited (60 unauthenticated requests per hour
> per IP), substitute a fixed version for `${BX_VER}` — for example `v0.20.1` —
> and download that URL directly.

### Swap

Check how much memory you actually have:

```bash
free -h
```

If **total memory is under 2GB**, add swap — otherwise the TypeScript build is
killed partway through by the kernel's out-of-memory killer, and the error
rarely mentions memory:

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

> `dd` rather than `fallocate`: a fallocated file can contain holes that
> `swapon` refuses on some filesystems. `dd` writes real zeroes, which always
> works — slower by a few seconds, and worth it for not having to debug it.

Make it survive a reboot:

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Confirm it is active:

```bash
free -h
```

### If you are on Ubuntu instead

Same steps, different commands: `sudo apt update && sudo apt upgrade -y`, then
`curl -fsSL https://get.docker.com | sudo sh` (this installer *does* start the
daemon and *does* include Compose), then
`sudo usermod -aG docker ubuntu`. The account is `ubuntu`, not `ec2-user`.

---

## 3. Push the deployment files from your machine

**[local]** The Dockerfile, compose file, nginx config and deploy script are new — commit them:

```bash
git add . && git commit -m "Add Docker deployment configuration" && git push
```

Mark the deploy script executable in git (Windows does not track the Unix execute bit, so without this it arrives unrunnable):

```bash
git update-index --chmod=+x deploy.sh && git commit -m "Make deploy.sh executable" && git push
```

---

## 4. Clone and configure

**[ec2]**

```bash
git clone YOUR_REPO_URL obtrack && cd obtrack
```

Generate two strong secrets — do not invent them by hand:

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)"; echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
```

Create the environment file:

```bash
cp .env.production.example .env.production && nano .env.production
```

Fill in every `CHANGE_ME`:

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | the generated password |
| `DATABASE_URL` | `postgresql://obtrack:THAT_PASSWORD@postgres:5432/obtrack?schema=public` |
| `JWT_SECRET` | the generated hex string |
| `SEED_ADMIN_EMAIL` | your real admin email |
| `SEED_ADMIN_PASSWORD` | **at least 12 characters** — the app refuses to seed otherwise |
| `CORS_ORIGINS` | leave empty until the React dashboard exists |

The password appears in **two** places — `POSTGRES_PASSWORD` and inside `DATABASE_URL`. They must match, or the API cannot connect.

**Quote any value containing a space** — write `SEED_ADMIN_NAME="System Administrator"`. Compose itself parses unquoted spaces correctly, but the moment you or a script runs `source .env.production`, bash reads the space as the end of the assignment, tries to run `Administrator` as a command, and fails with "command not found".

Restrict the file so only you can read it:

```bash
chmod 600 .env.production
```

> `.env.production` is gitignored and can never be committed. It is also never copied into the Docker image — secrets are supplied at run time, because anything baked into an image can be extracted from it by anyone who can pull it.

---

## 5. First launch

**[ec2]**

```bash
docker compose --env-file .env.production build
```

Start the database first and wait for it to accept connections:

```bash
docker compose --env-file .env.production up -d postgres
```

Create the schema:

```bash
docker compose --env-file .env.production run --rm migrate
```

Create the first admin account:

```bash
docker compose --env-file .env.production run --rm migrate npx prisma db seed
```

Start everything:

```bash
docker compose --env-file .env.production up -d
```

Verify:

```bash
curl http://localhost/health/ready
```

Expect `{"status":"ok","database":"ok"}`. Then from your own browser: `http://YOUR_EC2_IP/health/ready`.

---

## 6. Confirm it works

**[local]** Log in as the admin you seeded:

```bash
curl -X POST http://YOUR_EC2_IP/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"admin@yourcompany.com","password":"YOUR_SEED_PASSWORD"}'
```

You should get an `accessToken`, a `refreshToken`, and your user object with no password field.

Interactive docs (while `SWAGGER_ENABLED=true`): **`http://YOUR_EC2_IP/api/docs`**

---

## 7. Deploying changes from now on

**[local]**

```bash
git push
```

**[ec2]**

```bash
cd obtrack && ./deploy.sh
```

The script pulls, rebuilds, migrates, restarts, waits for health, and prunes old images. It stops at the first failure rather than continuing — a half-applied deploy is worse than none.

It also **builds before stopping anything**, so a broken build leaves the running version untouched and your users never notice.

---

## Operations

| Task | Command |
|---|---|
| Follow API logs | `docker compose --env-file .env.production logs -f api` |
| Last 100 log lines | `docker compose --env-file .env.production logs --tail=100 api` |
| Service status | `docker compose --env-file .env.production ps` |
| Restart just the API | `docker compose --env-file .env.production restart api` |
| Stop everything | `docker compose --env-file .env.production down` |
| Database shell | `docker compose --env-file .env.production exec postgres psql -U obtrack -d obtrack` |
| Disk usage | `df -h && docker system df` |

### Connecting DBeaver (or any SQL client) to the server database

**Never open port 5432 in the security group.** Tunnel over SSH instead: the
connection travels over port 22, is encrypted, and requires your private key.
An exposed Postgres port is found by scanners within minutes of being opened.

Postgres is published on `127.0.0.1:5432` on the instance — the loopback
interface only — which is what an SSH tunnel can reach and the internet cannot.

**[ec2]** Get the password you set:

```bash
grep POSTGRES_PASSWORD .env.production
```

Then in DBeaver, create a **PostgreSQL** connection:

*Main* tab — note these describe the database **as seen from the EC2 instance**,
because the tunnel terminates there:

| Field | Value |
|---|---|
| Host | `localhost` |
| Port | `5432` |
| Database | `obtrack` |
| Username | `obtrack` |
| Password | from the command above |

*SSH* tab — tick **Use SSH Tunnel**:

| Field | Value |
|---|---|
| Host/IP | your EC2 public IP |
| Port | `22` |
| User Name | `ec2-user` |
| Authentication Method | Public Key |
| Private Key | your `.pem` file |

Click **Test Connection**. If it fails at the SSH step, the security group is
not allowing port 22 from your current IP — a home connection's IP changes,
so a rule added last week may no longer match.

Prefer the command line? Same tunnel, run from your own machine:

```bash
ssh -i your-key.pem -L 5432:localhost:5432 ec2-user@YOUR_EC2_IP
```

Leave that running and point any client at `localhost:5432`. If your own
machine already runs Postgres on 5432, use `-L 5433:localhost:5432` and connect
to port 5433 instead.

### Back up the database

Nothing else in this setup protects your data. **Run this before every risky change**, and set up a cron job for it.

```bash
docker compose exec -T postgres pg_dump -U obtrack obtrack | gzip > ~/obtrack-$(date +%F).sql.gz
```

Restore:

```bash
gunzip -c ~/obtrack-2026-07-29.sql.gz | docker compose exec -T postgres psql -U obtrack -d obtrack
```

> Backups stored on the same instance disappear with the instance. Copy them to S3 (`aws s3 cp`) once you hold real data.

### Back up the uploaded receipts

The database is not the only stateful thing on this box. Receipt images live on
the `uploads_data` volume, and `pg_dump` does not touch them — a restore from a
database backup alone gives you rows describing files that no longer exist.

```bash
docker run --rm -v obtrack_uploads_data:/data -v ~:/backup alpine \
  tar czf /backup/obtrack-uploads-$(date +%F).tar.gz -C /data .
```

Restore:

```bash
docker run --rm -v obtrack_uploads_data:/data -v ~:/backup alpine \
  tar xzf /backup/obtrack-uploads-2026-08-05.tar.gz -C /data
```

> Check the volume's real name with `docker volume ls` — Compose prefixes it with
> the project directory name.

---

## Receipt storage

Office boys attach a photo of the receipt when they submit a task, and the admin
reads it to book the expense. Two backends are supported, selected by
`STORAGE_DRIVER`.

Nothing above the `StorageService` abstract class in `src/storage/` knows which
one is running — the tasks service, the controller and the `TaskReceipt` row are
written against four methods. Switching is an environment change, not a code
change, and both drivers generate identical storage keys so the values already in
the database keep resolving.

### Option A — S3 (recommended in production)

Receipts survive container replacement with no volume to manage or back up, and
it is the only option that still works if this ever runs on more than one
instance.

**1. Create a private bucket.** Region should match the EC2 instance, so
transfer stays free and latency low.

```bash
aws s3api create-bucket --bucket obtrack-receipts --region eu-north-1 --create-bucket-configuration LocationConstraint=eu-north-1
```

**2. Block all public access.** The app streams receipts through its own
authorised endpoint, so nothing needs public read. A receipt is somebody's
expense record.

```bash
aws s3api put-public-access-block --bucket obtrack-receipts --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

**3. Turn on default encryption and versioning.** Versioning is what lets you
recover a receipt deleted by mistake — the app's replace-receipt path deletes
the old object.

```bash
aws s3api put-bucket-encryption --bucket obtrack-receipts --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

```bash
aws s3api put-bucket-versioning --bucket obtrack-receipts --versioning-configuration Status=Enabled
```

**4. Grant the EC2 instance access via an IAM role — not access keys.**

An instance role hands the SDK short-lived credentials that rotate on their own.
Long-lived `AWS_ACCESS_KEY_ID`/`SECRET` in `.env.production` is the thing that
leaks, and the app deliberately does not read them from config.

Save this as `obtrack-receipts-policy.json` — it is the complete set of
permissions the app uses, and nothing more:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::obtrack-receipts/*"
    }
  ]
}
```

Note there is no `s3:ListBucket`. The app never lists the bucket, and its
boot-time write check is a put-then-delete probe precisely so that a minimal
policy like this one passes.

Create the policy, attach it to a role the EC2 service can assume, and attach
that role to the instance — via the console (**EC2 → Instance → Actions →
Security → Modify IAM role**) or the CLI. No restart of the instance is needed;
the SDK picks the role up from the instance metadata service.

**5. Point the app at it** in `.env.production`:

```bash
STORAGE_DRIVER=s3
S3_BUCKET=obtrack-receipts
S3_REGION=eu-north-1
```

Then deploy. On boot the app writes and deletes a probe object; if the role is
wrong the container **refuses to start** with a message naming the bucket and
the missing permissions, rather than failing on the first office boy's upload.

Once S3 is live the `uploads_data` volume and its tar backup are no longer
needed — though leaving the volume in place costs nothing and keeps any
already-uploaded local receipts recoverable. See "Migrating existing receipts"
below.

### Option B — local disk

Files are stored on the **`uploads_data` named volume**, mounted at
`/app/uploads` in the api container.

Two settings have to agree, and there is no error if they do not:

| Where | Value |
|---|---|
| `docker-compose.yml` → `api.volumes` | `uploads_data:/app/uploads` |
| `.env.production` → `UPLOADS_DIR` | `/app/uploads` |

**Why a volume, and what happens without one.** A container's filesystem is
destroyed and recreated on every deploy. If `UPLOADS_DIR` points anywhere outside
the volume, every receipt uploaded since the last deploy is silently gone — and
unlike a database failure there is no crash and no log line, just downloads that
start returning `404` and an admin who cannot reconcile last week's petty cash.

One more trap: the container runs as the non-root `node` user. The Dockerfile
creates `/app/uploads` owned by `node` **before** dropping privileges, because
Docker seeds a fresh named volume from whatever is at that path in the image —
ownership included. Without that line the volume is created owned by root and
the app cannot write a single receipt. If you are adopting this on an instance
whose volume predates the fix, Docker will not re-seed it; correct it once:

```bash
docker compose --env-file .env.production run --rm --user root api chown -R node:node /app/uploads
```

### Settings shared by both drivers

- `MAX_RECEIPT_BYTES` (default `5242880`, 5 MB) caps a single upload. multer
  aborts an oversized request mid-transfer rather than buffering it.
- Accepted types are JPEG, PNG, WebP and PDF, verified by reading the file's
  leading bytes — not the `Content-Type` the client claims.

### Migrating existing receipts from local disk to S3

Storage keys are identical across drivers, so the `TaskReceipt.storageKey`
values in the database need no rewriting — copy the objects across and flip the
setting.

```bash
docker compose --env-file .env.production cp api:/app/uploads ./uploads-export
```

```bash
aws s3 sync ./uploads-export s3://obtrack-receipts/ --exclude ".obtrack-write-probe"
```

Then set `STORAGE_DRIVER=s3` and redeploy. Verify a download before deleting the
local copy.

---

## Reporting timezone

`REPORT_TZ_OFFSET_MINUTES` decides where the calendar day boundary sits for
"completed today" on both dashboards.

The container runs UTC. Left at `0`, the reporting day rolls over at 5am local
time in Pakistan, splitting one working day across two report buckets. Set it to
`300` (UTC+5) so "today" means the office's today.

It only affects day-bucketing; every stored timestamp stays UTC.

---

## Troubleshooting

**Build killed / "signal 9"** — out of memory. Add swap (§2).

**API unhealthy, and the logs show a config error** — the app validates every environment variable at startup and refuses to boot on a bad one. The message names the offending variable. This is deliberate: better a deploy that does not start than one that fails at 2am on the first login.

**`Can't reach database server`** — `POSTGRES_PASSWORD` and the password inside `DATABASE_URL` disagree, or the host in `DATABASE_URL` is not `postgres`. It must be the compose service name, not `localhost` — inside a container, `localhost` is the container itself.

**429 on every request from every user** — `TRUST_PROXY_HOPS` is not `1`. Behind nginx, all requests appear to come from one address and the rate limiter counts everyone as a single client.

**Browser CORS errors from the dashboard** — add its exact origin (scheme + host + port, no trailing slash) to `CORS_ORIGINS` and redeploy.

**Port 80 already in use** — something else is running: find it with `sudo ss -lptn 'sport = :80'`, then stop it (`sudo systemctl stop httpd && sudo systemctl disable httpd` on Amazon Linux).

---

## Upgrading to HTTPS

Do this before real users. You need a domain with an **A record pointing at the instance's IP**.

1. Open port **443** in the security group.
2. Install Certbot and obtain a certificate:

```bash
sudo dnf install -y certbot && sudo certbot certonly --standalone -d api.yourdomain.com
```

(Stop nginx first: `docker compose stop nginx`.)

3. Mount the certificates into the nginx container by adding to its `volumes:` in `docker-compose.yml`:

```
- /etc/letsencrypt:/etc/letsencrypt:ro
```

4. Add a TLS server block to `nginx/nginx.conf` listening on 443 with `ssl_certificate` / `ssl_certificate_key` pointing at `/etc/letsencrypt/live/api.yourdomain.com/`, and redirect port 80 to it.
5. Set `SWAGGER_ENABLED=false` and add your dashboard origin to `CORS_ORIGINS`.
6. Automate renewal — certificates last 90 days:

```bash
echo "0 3 * * * certbot renew --quiet --deploy-hook 'docker compose -f /home/ec2-user/obtrack/docker-compose.yml restart nginx'" | sudo crontab -
```

---

## Adding the React admin portal later

When the dashboard exists, you have two options. **Serve it from the same origin as the API** — it is meaningfully simpler:

| | Same origin (recommended) | Separate origin |
|---|---|---|
| Setup | Portal at `/`, API at `/api` on this same nginx | Separate host or port |
| CORS | **None needed** — same origin, so the browser never sends a preflight | Must maintain `CORS_ORIGINS` |
| HTTPS | One certificate | Two, or a wildcard |
| Cookies | Work naturally if you ever move tokens into cookies | Cross-site cookie rules make this painful |

The nginx config is already shaped for it. The portal is a static build (`npm run build` → a `dist/` of HTML, CSS and JS), so it needs no Node process at all — nginx serves the files directly. Roughly:

```
location / {
    root /usr/share/nginx/html;
    try_files $uri $uri/ /index.html;   # so React Router deep links work
}

location /api { proxy_pass http://obtrack_api; ... }
```

`try_files ... /index.html` is the part people miss: a single-page app has only one real HTML file, so a refresh on `/dashboard/tasks` must still return `index.html` or the user gets a 404 from nginx.

If you do end up on a separate origin, set `CORS_ORIGINS` to its exact origin — scheme, host and port, no trailing slash — and redeploy.

---

## Known limitations of this setup

| Limitation | Impact | When to fix |
|---|---|---|
| **No HTTPS** | Credentials sent in clear text | Before real users |
| **Swagger public** | Hands attackers a full API map | Set `SWAGGER_ENABLED=false` before launch |
| **Database on the same instance** | Losing the instance loses the data | Move to RDS when data matters |
| **No automated backups** | Data loss is permanent | Add the cron job above, ship to S3 |
| **In-memory rate limiting** | Resets on restart; per-instance | Move to Redis if you run more than one server |
| **Single instance** | Any deploy or crash is downtime | Add a load balancer when uptime matters |
| **No monitoring** | You learn about outages from users | CloudWatch alarms on CPU, disk, and health check |
